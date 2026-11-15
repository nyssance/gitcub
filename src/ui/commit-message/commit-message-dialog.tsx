// Desktop MIT port of ui/commit-message/commit-message-dialog.tsx; written as a function component.
// 原版经 dispatcher 拿作者、补全与仓库规则；这里与提交表单一样从各 store 与 useRepositoryPolicy 取
import { openUrl } from "@tauri-apps/plugin-opener"
import noop from "lodash/noop"
import { useEffect, useMemo, useState } from "react"

import { usePreferencesStore } from "../../features/preferences/store"
import { useRepositoryStore } from "../../features/repository/store"
import { getDesktopRuntime } from "../../lib/desktop-runtime"
import { ipc } from "../../lib/ipc"
import { emitMenuEvent } from "../../lib/menu/native-menu"
import { useRepositoryPolicy } from "../../lib/use-repository-policy"
import type { Remote } from "../../models/app-state"
import type { ICommitContext } from "../../models/commit"
import type { Author, UnknownAuthor } from "../../upstream/models/author"
import { CommitIdentity } from "../../upstream/models/commit-identity"
import type { ICommitMessage } from "../../upstream/models/commit-message"
import { CommitMessage } from "../changes/commit-message"
import { useAutocompletionProviders } from "../changes/use-autocompletion-providers"
import { Dialog, DialogContent } from "../desktop/dialog"
import { UnknownAuthors } from "../unknown-authors/unknown-authors-dialog"

interface ICommitMessageDialogProps {
  readonly repo: string

  /**
   * The branch that will be modified by the commit
   */
  readonly branch: string | null

  /** 托管远端；有它才有 `@` 用户与共同作者补全 */
  readonly remote: Remote | null

  /**
   * A list of authors (name, email pairs) which have been entered into the
   * co-authors input box in the commit form and which _may_ be used in the
   * subsequent commit to add Co-Authored-By commit message trailers depending
   * on whether the user has chosen to do so.
   */
  readonly coAuthors: ReadonlyArray<Author>

  /** The commit message for a work-in-progress commit. */
  readonly commitMessage: ICommitMessage | null

  /** Text for the ok button */
  readonly dialogButtonText: string

  /** The title to be displayed in the dialog */
  readonly dialogTitle: string

  /** Whether to prepopulate the commit summary with the placeholder or summary*/
  readonly prepopulateCommitSummary: boolean

  /**
   * Whether or not to show a field for adding co-authors to a commit
   * (currently only supported for GH/GHE repositories)
   */
  readonly showCoAuthoredBy: boolean

  /** Method to run when dialog is dismissed */
  readonly onDismissed: () => void

  /** Method to run when dialog is submitted */
  readonly onSubmitCommitMessage: (context: ICommitContext) => Promise<boolean>
}

export function CommitMessageDialog(props: ICommitMessageDialogProps) {
  const runtime = getDesktopRuntime()
  const [accounts, setAccounts] = useState(runtime.appStore.getState().accounts)
  useEffect(() => {
    const subscription = runtime.accountsStore.onDidUpdate(setAccounts)
    return () => subscription.dispose()
  }, [runtime])
  const policy = useRepositoryPolicy(props.repo, props.branch, accounts)
  const hasUpstream = useRepositoryStore(s => s.status.hasUpstream)
  const ahead = useRepositoryStore(s => s.status.ahead)
  const behind = useRepositoryStore(s => s.status.behind)
  const aheadBehind = useMemo(() => (hasUpstream ? { ahead, behind } : null), [hasUpstream, ahead, behind])
  const issues = useRepositoryStore(s => s.issues)
  const mentionables = useRepositoryStore(s => s.mentionables)
  const storedAuthor = useRepositoryStore(s => s.author)
  const [author, setAuthor] = useState(storedAuthor)
  useEffect(() => setAuthor(storedAuthor), [storedAuthor])
  const providers = useAutocompletionProviders(issues, mentionables, props.remote, accounts)
  const showCommitLengthWarning = usePreferencesStore(s => s.showCommitLengthWarning)
  const [spellcheck, setSpellcheck] = useState(true)
  const [options, setOptions] = useState({ skipCommitHooks: false, signOffCommits: false, allowEmptyCommit: false })
  const [showCoAuthoredBy, setShowCoAuthoredBy] = useState(props.showCoAuthoredBy)
  const [coAuthors, setCoAuthors] = useState(props.coAuthors)
  const [unknownAuthors, setUnknownAuthors] = useState<{
    authors: readonly UnknownAuthor[]
    proceed: () => void
  } | null>(null)

  return (
    <>
      <Dialog id="commit-message-dialog" title={props.dialogTitle} onDismissed={props.onDismissed}>
        <DialogContent>
          <CommitMessage
            showInputLabels={true}
            branch={props.branch}
            mostRecentLocalCommit={null}
            commitAuthor={author ? new CommitIdentity(author.name, author.email, new Date()) : null}
            isShowingModal={true}
            isShowingFoldout={false}
            commitButtonText={props.dialogButtonText}
            commitToAmend={null}
            repository={policy.repository}
            commitMessage={props.commitMessage}
            focusCommitMessage={false}
            autocompletionProviders={providers}
            showCoAuthoredBy={showCoAuthoredBy}
            coAuthors={coAuthors}
            placeholder={""}
            prepopulateCommitSummary={props.prepopulateCommitSummary}
            key={props.repo}
            showBranchProtected={policy.protected}
            repoRulesInfo={policy.rules}
            aheadBehind={aheadBehind}
            showNoWriteAccess={policy.noWrite}
            commitSpellcheckEnabled={spellcheck}
            showCommitLengthWarning={showCommitLengthWarning}
            onCoAuthorsUpdated={setCoAuthors}
            onShowCoAuthoredByChanged={setShowCoAuthoredBy}
            onConfirmCommitWithUnknownCoAuthors={(authors, proceed) => setUnknownAuthors({ authors, proceed })}
            onCreateCommit={props.onSubmitCommitMessage}
            anyFilesAvailable={true}
            anyFilesSelected={true}
            filesSelected={[]}
            onCommitMessageFocusSet={noop}
            onRefreshAuthor={() => {
              void ipc.gitIdentity(props.repo).then(setAuthor)
            }}
            onShowPopup={() => {
              void emitMenuEvent("show-preferences")
            }}
            onShowFoldout={() => {
              void emitMenuEvent("show-branches")
            }}
            onCommitSpellcheckEnabledChanged={setSpellcheck}
            repositoryAccount={policy.account}
            onStopAmending={noop}
            onShowCreateForkDialog={() => {
              if (policy.forkUrl) void openUrl(policy.forkUrl)
            }}
            accounts={accounts}
            isCommitting={false}
            hookProgress={null}
            onShowCommitProgress={undefined}
            {...options}
            showAllowEmptyCommitOption={false}
            onUpdateCommitOptions={(_repo, next) => setOptions(previous => ({ ...previous, ...next }))}
          />
        </DialogContent>
      </Dialog>
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
