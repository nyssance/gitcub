import { confirm } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useMemo, useState } from "react"

import { getCommits } from "../../lib/commit-history"
import { getPlaceholderMessage } from "../../lib/commit-placeholder"
import { getDesktopRuntime } from "../../lib/desktop-runtime"
import { appStatus } from "../../lib/desktop-status"
import { EMOJI } from "../../lib/emoji"
import { ipc } from "../../lib/ipc"
import { emitMenuEvent } from "../../lib/menu/native-menu"
import { useRepositoryPolicy } from "../../lib/use-repository-policy"
import type { CommitOptions, Issue } from "../../models/app-state"
import type { Commit, ICommitContext } from "../../models/commit"
import type { FileChange } from "../../models/repo-status"
import type { Author } from "../../upstream/models/author"
import { CommitIdentity } from "../../upstream/models/commit-identity"
import type { ICommitMessage } from "../../upstream/models/commit-message"
import { DiffSelection, DiffSelectionType } from "../../upstream/models/diff"
import { WorkingDirectoryFileChange } from "../../upstream/models/status"
import { EmojiAutocompletionProvider } from "../autocompletion/emoji-autocompletion-provider"
import type { IAutocompletionProvider } from "../autocompletion/provider-contract"
import { InlineError } from "../shared/inline-error"
import { CommitMessage } from "./commit-message"

interface Props {
  amendRequest: number
  repo: string
  branch: string | null
  changes: FileChange[]
  includeOf(path: string): DiffSelectionType
  selectionOf(path: string): DiffSelection | null
  author?: { name: string; email: string }
  issues: Issue[]
  hiddenSelected: boolean
  unresolved: boolean
  onCommit(summary: string, description: string, options: CommitOptions): Promise<boolean>
  onAmend(summary: string, description: string): Promise<boolean>
}
export function DesktopCommitForm(props: Props) {
  const runtime = getDesktopRuntime()
  const [accounts, setAccounts] = useState(runtime.appStore.getState().accounts)
  const policy = useRepositoryPolicy(props.repo, props.branch, accounts)
  const repository = policy.repository
  const [author, setAuthor] = useState(props.author)
  const [coAuthors, setCoAuthors] = useState<readonly Author[]>([])
  const [showCoAuthors, setShowCoAuthors] = useState(false)
  const [spellcheck, setSpellcheck] = useState(true)
  const [options, setOptions] = useState({ skipCommitHooks: false, signOffCommits: false, allowEmptyCommit: false })
  const [busy, setBusy] = useState(false)

  const [message, setMessage] = useState<ICommitMessage | null>(null)
  const [amending, setAmending] = useState<Commit | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    return [
      issues,
      new EmojiAutocompletionProvider(
        new Map(Object.entries(EMOJI).map(([name, emoji]) => [name, { emoji, aliases: [name], url: "" }]))
      )
    ]
  }, [props.issues])
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
  useEffect(() => {
    if (props.amendRequest === 0) return
    let active = true
    void getCommits(repository, "HEAD", 1)
      .then(([commit]) => {
        if (active && commit) {
          setAmending(commit)
          setMessage({ summary: commit.summary, description: commit.bodyNoCoAuthors, timestamp: Date.now() })
        }
      })
      .catch(error => {
        if (active) setError(String(error))
      })
    return () => {
      active = false
    }
  }, [props.amendRequest, repository])
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
        hookProgress={null}
        onShowCommitProgress={undefined}

        commitToAmend={amending}
        mostRecentLocalCommit={amending}
        placeholder={getPlaceholderMessage(files, prepopulate)}
        prepopulateCommitSummary={prepopulate && !props.unresolved}
        showBranchProtected={policy.protected}
        repoRulesInfo={policy.rules}
        aheadBehind={policy.aheadBehind}
        showNoWriteAccess={policy.noWrite}
        coAuthors={coAuthors}
        showCoAuthoredBy={showCoAuthors}
        onCoAuthorsUpdated={setCoAuthors}
        onShowCoAuthoredByChanged={setShowCoAuthors}
        commitSpellcheckEnabled={spellcheck}
        onCommitSpellcheckEnabledChanged={setSpellcheck}
        showCommitLengthWarning={true}
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
        onConfirmCommitWithUnknownCoAuthors={(_authors, proceed) => {
          void confirm("Some co-authors could not be resolved. Commit without their attribution?", {
            kind: "warning"
          }).then(ok => {
            if (ok) proceed()
          })
        }}
        onFilesToCommitNotVisible={proceed => {
          void confirm("Commit the selected files hidden by the current filter?", { kind: "warning" }).then(ok => {
            if (ok) proceed()
          })
        }}
      />
    </>
  )
}
