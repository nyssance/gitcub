import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useMemo, useRef, useState } from "react"

import { useAccountsStore } from "../../features/accounts/store"
import { useChangesStore } from "../../features/changes/store"
import { useDialogsStore } from "../../features/dialogs/store"
import { usePreferencesStore } from "../../features/preferences/store"
import { useRepositoryStore } from "../../features/repository/store"
import { getHTMLURL } from "../../lib/api"
import { getCommits } from "../../lib/commit-history"
import { getPlaceholderMessage } from "../../lib/commit-placeholder"
import type { IMentionableUser } from "../../lib/databases/github-user-database"
import { getDesktopRuntime } from "../../lib/desktop-runtime"
import { appStatus } from "../../lib/desktop-status"
import { EMOJI } from "../../lib/emoji"
import i18n from "../../lib/i18n"
import { ipc } from "../../lib/ipc"
import { completionRepository, mentionableUsersSource } from "../../lib/mentionable-users"
import { emitMenuEvent } from "../../lib/menu/native-menu"
import { useRepositoryPolicy } from "../../lib/use-repository-policy"
import type { CommitOptions, Issue, Remote } from "../../models/app-state"
import type { Commit, ICommitContext } from "../../models/commit"
import type { FileChange } from "../../models/repo-status"
import type { Author, UnknownAuthor } from "../../upstream/models/author"
import { CommitIdentity } from "../../upstream/models/commit-identity"
import type { ICommitMessage } from "../../upstream/models/commit-message"
import { DiffSelection, DiffSelectionType } from "../../upstream/models/diff"
import { WorkingDirectoryFileChange } from "../../upstream/models/status"
import { EmojiAutocompletionProvider } from "../autocompletion/emoji-autocompletion-provider"
import type { IAutocompletionProvider } from "../autocompletion/provider-contract"
import {
  CoAuthorAutocompletionProvider,
  UserAutocompletionProvider
} from "../autocompletion/user-autocompletion-provider"
import { InlineError } from "../shared/inline-error"
import { UnknownAuthors } from "../unknown-authors/unknown-authors-dialog"
import { CommitMessage } from "./commit-message"

interface Props {
  /** 历史页「Amend Commit…」请求进入修订（Desktop startAmendingRepository）；处理后调 onAmendRequestHandled 清掉 */
  amendRequested: boolean
  onAmendRequestHandled: () => void
  repo: string
  branch: string | null
  changes: FileChange[]
  includeOf(path: string): DiffSelectionType
  selectionOf(path: string): DiffSelection | null
  author?: { name: string; email: string }
  issues: Issue[]
  mentionables: IMentionableUser[]
  remote: Remote | null
  hiddenSelected: boolean
  unresolved: boolean
  onCommit(summary: string, description: string, options: CommitOptions): Promise<boolean>
  onAmend(summary: string, description: string): Promise<boolean>
  /** 侧栏的撤销栏要知道：修订中不显示、提交中禁用（Desktop commitToAmend / isCommitting） */
  onAmendingChange?: (amending: boolean) => void
  onCommittingChange?: (committing: boolean) => void
}
export function DesktopCommitForm(props: Props) {
  const runtime = getDesktopRuntime()
  const [accounts, setAccounts] = useState(runtime.appStore.getState().accounts)
  const platformAccounts = useAccountsStore(s => s.accounts)
  const policy = useRepositoryPolicy(props.repo, props.branch, accounts)
  // Desktop 的 aheadBehind 来自仓库状态（commit-message.tsx 的 props 由 repositoryState 给出），不另读一次 status
  const hasUpstream = useRepositoryStore(s => s.status.hasUpstream)
  const ahead = useRepositoryStore(s => s.status.ahead)
  const behind = useRepositoryStore(s => s.status.behind)
  const aheadBehind = useMemo(() => (hasUpstream ? { ahead, behind } : null), [hasUpstream, ahead, behind])
  const repository = policy.repository
  const currentRepository = useRef(repository)
  currentRepository.current = repository
  const [author, setAuthor] = useState(props.author)
  const [coAuthors, setCoAuthors] = useState<readonly Author[]>([])
  const [showCoAuthors, setShowCoAuthors] = useState(false)
  const [spellcheck, setSpellcheck] = useState(true)
  const showCommitLengthWarning = usePreferencesStore(s => s.showCommitLengthWarning)
  const [options, setOptions] = useState({ skipCommitHooks: false, signOffCommits: false, allowEmptyCommit: false })
  const [busy, setBusy] = useState(false)
  const hookProgress = useChangesStore(s => s.hookProgress)
  const subscribeToCommitOutput = useChangesStore(s => s.subscribeToCommitOutput)
  const setCommitProgress = useDialogsStore(s => s.setCommitProgress)

  const [message, setMessage] = useState<ICommitMessage | null>(null)
  const [amending, setAmending] = useState<Commit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { onAmendingChange, onCommittingChange } = props
  useEffect(() => onAmendingChange?.(amending !== null), [amending, onAmendingChange])
  useEffect(() => onCommittingChange?.(busy), [busy, onCommittingChange])
  const [unknownAuthors, setUnknownAuthors] = useState<{
    authors: readonly UnknownAuthor[]
    proceed: () => void
  } | null>(null)

  useEffect(() => {
    const subscription = runtime.accountsStore.onDidUpdate(setAccounts)
    return () => {
      subscription.dispose()
    }
  }, [runtime])
  useEffect(() => setAuthor(props.author), [props.author])
  const files = props.changes
    .filter(file => props.includeOf(file.path) !== DiffSelectionType.None)
    .map(
      file =>
        new WorkingDirectoryFileChange(
          file.path,
          appStatus(file),
          props.selectionOf(file.path) ?? DiffSelection.fromInitialSelection(DiffSelectionType.All)
        )
    )
  const prepopulate = files.length === 1
  const providers = useMemo(() => {
    const issues: IAutocompletionProvider<Issue> = {
      kind: "issue",
      getRegExp: () => /(?:^|\n| )(?:#)([a-z\d\\+-][a-z\d_]*)?/g,
      getAutocompletionItems: async text =>
        props.issues
          .filter(issue => `${issue.number} ${issue.title}`.toLowerCase().includes(text.toLowerCase()))
          .slice(0, 20),
      getCompletionText: issue => `#${issue.number}`,
      getItemAriaLabel: issue => `#${issue.number} ${issue.title}`,
      renderItem: issue => (
        <div className="issue">
          <span className="number">#{issue.number}</span> {issue.title}
        </div>
      )
    }
    const providers: IAutocompletionProvider<object>[] = [
      issues,
      new EmojiAutocompletionProvider(
        new Map(Object.entries(EMOJI).map(([name, emoji]) => [name, { emoji, aliases: [name], url: "" }]))
      )
    ]
    // Desktop buildAutocompletionProviders：托管仓库再加 `@` 用户与共同作者补全，账号按仓库所在实例找
    if (props.remote) {
      const remote = props.remote
      const gitlab = platformAccounts[remote.host]?.kind === "gitlab"
      const repository = completionRepository(remote, gitlab)
      const account = gitlab
        ? undefined
        : accounts.find(account => new URL(getHTMLURL(account.endpoint)).host === remote.host)
      const source = mentionableUsersSource(
        props.mentionables,
        runtime.gitHubUserStore,
        gitlab ? login => ipc.mentionableUser(remote.host, login).catch(() => null) : undefined
      )
      providers.push(
        new UserAutocompletionProvider(source, repository, account),
        new CoAuthorAutocompletionProvider(source, repository, account)
      )
    }
    return providers
  }, [props.issues, props.mentionables, props.remote, accounts, platformAccounts, runtime])
  async function commit(context: ICommitContext) {
    if (props.unresolved || busy) return false
    setBusy(true)
    setError(null)
    try {
      if (context.amend) {
        const result = await props.onAmend(context.summary, context.description ?? "")
        if (result) setAmending(null)
        return result
      }
      const result = await props.onCommit(context.summary, context.description ?? "", {
        skipHooks: options.skipCommitHooks,
        signOff: options.signOffCommits,
        allowEmpty: options.allowEmptyCommit,
        coAuthors:
          context.trailers
            ?.filter(trailer => trailer.token.toLowerCase() === "co-authored-by")
            .map(trailer => trailer.value) ?? []
      })
      if (result) setOptions(previous => ({ ...previous, allowEmptyCommit: false }))
      return result
    } catch (error) {
      setError(String(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  const { amendRequested, onAmendRequestHandled } = props
  useEffect(() => {
    if (!amendRequested) return
    onAmendRequestHandled()
    // 请求清掉会让这个 effect 重跑，不能拿它来作废结果；换了仓库才作废
    void getCommits(repository, "HEAD", 1)
      .then(([commit]) => {
        if (currentRepository.current === repository && commit) {
          setAmending(commit)
          setMessage({ summary: commit.summary, description: commit.bodyNoCoAuthors, timestamp: Date.now() })
        }
      })
      .catch(error => {
        if (currentRepository.current === repository) setError(String(error))
      })
  }, [amendRequested, onAmendRequestHandled, repository])
  return (
    <>
      {error && <InlineError error={error} />}
      <CommitMessage
        onCreateCommit={commit}
        repository={repository}
        repositoryAccount={policy.account}
        accounts={accounts}
        branch={props.branch}
        commitAuthor={author ? new CommitIdentity(author.name, author.email, new Date()) : null}
        anyFilesSelected={!props.unresolved && files.length > 0}
        anyFilesAvailable={props.changes.length > 0}
        filesSelected={files}
        filesToBeCommittedCount={files.length}
        showPromptForCommittingFileHiddenByFilter={props.hiddenSelected}
        submitButtonAriaDescribedBy="hidden-changes-warning"
        isShowingModal={false}
        isShowingFoldout={false}
        focusCommitMessage={false}
        commitMessage={message}
        autocompletionProviders={providers}
        isCommitting={busy}
        hookProgress={hookProgress}
        onShowCommitProgress={subscribeToCommitOutput ? () => setCommitProgress(subscribeToCommitOutput) : undefined}

        commitToAmend={amending}
        mostRecentLocalCommit={amending}
        placeholder={getPlaceholderMessage(files, prepopulate)}
        prepopulateCommitSummary={prepopulate && !props.unresolved}
        showBranchProtected={policy.protected}
        repoRulesInfo={policy.rules}
        aheadBehind={aheadBehind}
        showNoWriteAccess={policy.noWrite}
        coAuthors={coAuthors}
        showCoAuthoredBy={showCoAuthors}
        onCoAuthorsUpdated={setCoAuthors}
        onShowCoAuthoredByChanged={setShowCoAuthors}
        commitSpellcheckEnabled={spellcheck}
        onCommitSpellcheckEnabledChanged={setSpellcheck}
        showCommitLengthWarning={showCommitLengthWarning}
        {...options}
        showAllowEmptyCommitOption={true}
        onUpdateCommitOptions={(_repo, next) => setOptions(previous => ({ ...previous, ...next }))}
        onPersistCommitMessage={setMessage}
        onCommitMessageFocusSet={() => {
          document.activeElement?.scrollIntoView({ block: "nearest" })
        }}
        onRefreshAuthor={() => {
          void ipc.gitIdentity(props.repo).then(setAuthor)
        }}
        onShowPopup={() => {
          void emitMenuEvent("show-preferences")
        }}
        onShowFoldout={() => {
          void emitMenuEvent("show-branches")
        }}
        onStopAmending={() => {
          setAmending(null)
          setMessage(null)
        }}
        onShowCreateForkDialog={() => {
          if (policy.forkUrl) void openUrl(policy.forkUrl).catch(e => setError(String(e)))
        }}
        onConfirmCommitWithUnknownCoAuthors={(authors, proceed) => setUnknownAuthors({ authors, proceed })}
        onFilesToCommitNotVisible={proceed => {
          // Desktop ConfirmCommitFilteredChanges：可在「提示」里关掉
          void useDialogsStore
            .getState()
            .ask(i18n.t("desktopUI.youHaveAFilterApplied"), "confirmCommitFilteredChanges")
            .then(ok => {
              if (ok) proceed()
            })
        }}
      />
      {unknownAuthors && (
        <UnknownAuthors
          authors={unknownAuthors.authors}
          onCommit={unknownAuthors.proceed}
          onDismissed={() => setUnknownAuthors(null)}
        />
      )}
    </>
  )
}
