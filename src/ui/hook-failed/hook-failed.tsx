// Desktop MIT port of ui/hook-failed/hook-failed.tsx; written as a function component.

import { platform } from "@tauri-apps/plugin-os"
import * as React from "react"

import type { TerminalOutput } from "../../lib/git-execution"
import { Spinner } from "@/components/ui/spinner"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"

const Terminal = React.lazy(() => import("../terminal").then(module => ({ default: module.Terminal })))

interface IHookFailedProps {
  readonly hookName: string
  readonly terminalOutput: TerminalOutput
  readonly resolve: (value: "abort" | "ignore") => void
  readonly onDismissed: () => void
}

/** A component to confirm and then discard changes. */
export function HookFailed({ hookName, terminalOutput, resolve, onDismissed }: IHookFailedProps) {
  const title = `${hookName} ${platform() === "macos" ? "Failed" : "failed"}`

  const onAbort = () => {
    resolve("abort")
    onDismissed()
  }

  const onIgnore = () => {
    resolve("ignore")
    onDismissed()
  }

  return (
    <Dialog
      id="hook-failed-dialog"
      className="sm:max-w-[800px]"
      title={title}
      onDismissed={onAbort}
      onSubmit={onIgnore}
      type="warning"
      role="alertdialog"
      ariaDescribedBy="hook-failure-message">
      <DialogContent>
        <p id="hook-failure-message">The {hookName} hook failed. What would you like to do?</p>
        <React.Suspense fallback={<Spinner />}>
          <Terminal terminalOutput={terminalOutput} rows={15} cols={80} />
        </React.Suspense>
      </DialogContent>
      <DialogFooter>
        <OkCancelButtonGroup destructive={true} okButtonText={"Ignore and Continue"} cancelButtonText={"Abort"} />
      </DialogFooter>
    </Dialog>
  )
}
