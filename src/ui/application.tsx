import { listen } from "@tauri-apps/api/event"
import { openUrl } from "@tauri-apps/plugin-opener"
import { arch } from "@tauri-apps/plugin-os"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button as StandardButton } from "@/ui/base/button"

import { getVersion } from "../lib/app-version"
import { releaseChannel } from "../lib/build-environment"
import { getDesktopRuntime } from "../lib/desktop-runtime"
import { ipc } from "../lib/ipc"
import { cancelQuittingApp, getUpdatesEndpoint, quitApp } from "../lib/native-updater"
import { SignInStep } from "../lib/stores/sign-in-store"
import { applyTheme } from "../lib/theme"
import { updateStore } from "../lib/ui/update-store"
import type { Accounts, AppState } from "../models/app-state"
import type { Popup } from "../models/popup"
import { hasShownWelcomeFlow, markWelcomeFlowComplete } from "../upstream/lib/welcome"
import { About } from "./about/about"
import { App } from "./app"
import { DialogStackContext } from "./desktop/dialog/dialog"
import { InstallingUpdate } from "./installing-update/installing-update"
import { Preferences } from "./preferences/preferences"
import type { WelcomeDispatcher } from "./welcome-dispatcher"
import { DesktopImportWelcome } from "./welcome/desktop-import"
import { Welcome } from "./welcome/welcome"

let startupUpdateCheck: Promise<void> | undefined
export function Application() {
  const { i18n } = useTranslation()
  const runtime = getDesktopRuntime()
  // null = 还没读到 Rust 侧状态。欢迎流程只在「没走完过、也没登录过账号」时进：有登录账号就是配置过。
  // 完成标记存在 state.json 的 welcomed；Desktop 用的 localStorage 在 macOS 的 tauri:// 页面不落盘，每次启动都会再进。
  const [welcome, setWelcome] = useState<boolean | null>(null)
  const [signIn, setSignIn] = useState(runtime.signInStore.getState())
  const [accounts, setAccounts] = useState(runtime.appStore.getState().accounts)
  const [welcomeKey, setWelcomeKey] = useState(0)
  const [accountDialog, setAccountDialog] = useState(false)
  const [nativeState, setNativeState] = useState<AppState | null>(null)
  const [nativeAccounts, setNativeAccounts] = useState<Accounts>({})
  const accountHosts = [...new Set(["github.com", "gitlab.com", ...(nativeState?.accountHosts ?? [])])]
  const openAccounts = useCallback(() => {
    void ipc
      .loadState()
      .then(state => {
        setNativeState(state)
        setAccountDialog(true)
        return ipc.accountInfo([...new Set(["github.com", "gitlab.com", ...state.accountHosts])], true)
      })
      .then(setNativeAccounts)
      .catch(error => setError(String(error)))
  }, [])
  const [about, setAbout] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [updateState, setUpdateState] = useState(updateStore.state)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (welcome) return applyTheme(nativeState?.theme ?? "system")
  }, [welcome, nativeState?.theme])

  useEffect(() => {
    let active = true
    void ipc
      .loadState()
      .then(state => {
        if (!active) return
        setNativeState(state)
        void i18n.changeLanguage(state.language || (navigator.language.startsWith("zh") ? "zh-CN" : "en"))
        // 先按本地信息决定，不让首屏等网络；账号查询在后台进行，查到已登录就收起欢迎页并补记标记
        const configured = state.welcomed || hasShownWelcomeFlow() || runtime.appStore.getState().accounts.length > 0
        setWelcome(!configured)
        const persist = () => ipc.saveState({ ...state, welcomed: true }).catch(() => undefined)
        if (configured) {
          // 已配置但标记没落盘（旧版本或 localStorage 丢失）：补记一次
          if (!state.welcomed) void persist()
          return
        }
        void ipc
          .accountInfo([...new Set(["github.com", "gitlab.com", ...state.accountHosts])], false)
          .then(accounts => {
            if (!active || !Object.values(accounts).some(account => !!account.login)) return
            setWelcome(false)
            void persist()
          })
          .catch(() => undefined)
      })
      .catch(error => {
        if (active) setError(String(error))
      })
    return () => {
      active = false
    }
  }, [i18n, runtime])

  useEffect(() => {
    const subscriptions = [
      runtime.signInStore.onDidUpdate(setSignIn),
      runtime.accountsStore.onDidUpdate(setAccounts),
      updateStore.onDidChange(setUpdateState),
      updateStore.onError(error => {
        setError(error.message)
        setUpdateState(updateStore.state)
      })
    ]
    const menu = listen<readonly string[]>("menu-event", ({ payload }) => {
      if (payload[0] === "show-about") setAbout(true)
    })
    const install = listen("show-installing-update", () => setInstalling(true))
    if (releaseChannel !== "development" && releaseChannel !== "test" && startupUpdateCheck === undefined) {
      startupUpdateCheck = getUpdatesEndpoint()
        .then(endpoint => {
          if (endpoint) return updateStore.checkForUpdates(true, false)
        })
        .catch(error => log.error("Unable to check for updates", error))
    }
    return () => {
      subscriptions.forEach(subscription => {
        subscription.dispose()
      })
      void menu.then(dispose => dispose())
      void install.then(dispose => dispose())
    }
  }, [runtime])

  const dispatcher = useMemo<WelcomeDispatcher>(
    () => ({
      recordWelcomeWizardInitiated: () => runtime.statsStore.recordWelcomeWizardInitiated(),
      endWelcomeFlow: () => {
        markWelcomeFlowComplete()
        runtime.statsStore.recordWelcomeWizardTerminated()
        // 先落盘再切到主界面：App 挂载时读到的状态里就带着 welcomed，不会再进一次欢迎页
        void ipc
          .loadState()
          .then(state => ipc.saveState({ ...state, welcomed: true }))
          .catch(error => log.warn("Unable to persist the welcome flag", String(error)))
          .finally(() => setWelcome(false))
      },
      requestBrowserAuthenticationToDotcom: () => {
        runtime.signInStore.beginDotComSignIn()
        openAccounts()
      },
      requestBrowserAuthentication: () => {
        openAccounts()
      },
      beginDotComSignIn: callback => runtime.signInStore.beginDotComSignIn(callback),
      beginEnterpriseSignIn: callback => {
        runtime.signInStore.beginEnterpriseSignIn(callback)
        openAccounts()
      },
      resetSignInState: () => runtime.signInStore.reset(),
      setSignInEndpoint: (url, fromGit) => runtime.signInStore.setEndpoint(url, fromGit),
      removeAccount: async account => {
        await runtime.accountsStore.removeAccount(account)
      },
      showPopup: (popup: Popup) => {
        if ("error" in popup) setError(String(popup.error))
      },
      closePopup: () => setError(null)
    }),
    [runtime, openAccounts]
  )

  return (
    <div id="desktop-app-container">
      <DialogStackContext.Provider value={{ isTopMost: true }}>
        {welcome === null ? null : welcome ? (
          <DesktopImportWelcome onImported={setNativeState}>
            <Welcome key={welcomeKey} accounts={accounts} dispatcher={dispatcher} signInState={signIn} />
          </DesktopImportWelcome>
        ) : (
          <App />
        )}
        {nativeState && (
          <Preferences
            open={accountDialog}
            onOpenChange={open => {
              setAccountDialog(open)
              if (!open) {
                runtime.signInStore.reset()
                setWelcomeKey(key => key + 1)
              }
            }}
            state={nativeState}
            onPatch={patch => {
              const next = { ...nativeState, ...patch }
              setNativeState(next)
              if (patch.language !== undefined)
                void i18n.changeLanguage(patch.language || (navigator.language.startsWith("zh") ? "zh-CN" : "en"))
              void ipc.saveState(next).catch(error => setError(String(error)))
            }}
            repo={null}
            hosts={accountHosts}
            accounts={nativeAccounts}
            onAccountsChanged={() => {
              void ipc
                .accountInfo(accountHosts, true)
                .then(accounts => {
                  setNativeAccounts(accounts)
                  if (Object.values(accounts).some(account => account.login && !account.ignored)) {
                    setSignIn({ kind: SignInStep.Success, resultCallback: () => {} })
                    setAccountDialog(false)
                  }
                })
                .catch(error => setError(String(error)))
            }}
          />
        )}
        {about && (
          <About
            applicationName="GitCub"
            applicationVersion={getVersion()}
            applicationArchitecture={arch()}
            onDismissed={() => setAbout(false)}
            updateState={updateState}
            onCheckForNonStaggeredUpdates={() => {
              setError(null)
              void updateStore.checkForUpdates(false, true)
            }}
            onQuitAndInstall={() => updateStore.quitAndInstallUpdate()}
            onShowAcknowledgements={() => {
              void openUrl("https://github.com/nyssance/gitcub/blob/main/NOTICE.md")
            }}
            onShowTermsAndConditions={() => {
              void openUrl("https://github.com/nyssance/gitcub/blob/main/LICENSE")
            }}
          />
        )}
        {installing && (
          <InstallingUpdate
            onDismissed={() => {
              setInstalling(false)
              void cancelQuittingApp()
            }}
            dispatcher={{
              quitApp: force => {
                void quitApp(force)
              },
              cancelQuittingApp: () => {
                void cancelQuittingApp()
              }
            }}
          />
        )}
        {error && (
          <div role="alert" className="application-error">
            {error}
            <StandardButton variant="ghost" type="button" onClick={() => setError(null)}>
              Dismiss
            </StandardButton>
          </div>
        )}
      </DialogStackContext.Provider>
    </div>
  )
}
