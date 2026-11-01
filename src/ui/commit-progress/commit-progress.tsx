// Desktop MIT port of ui/commit-progress/commit-progress.tsx; written as a function component.

import * as React from "react"

import type { TerminalOutputListener } from "../../lib/git-execution"
import { Spinner } from "../base/spinner"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"
import type { Terminal as TerminalComponent } from "../terminal"

const Terminal = React.lazy(() => import("../terminal").then(module => ({ default: module.Terminal })))

interface ICommitProgressProps {
  readonly subscribeToCommitOutput: TerminalOutputListener
  readonly onDismissed: () => void
}

/** A component to confirm and then discard changes. */
export function CommitProgress({ subscribeToCommitOutput, onDismissed }: ICommitProgressProps) {
  const unsubscribe = React.useRef<(() => unknown) | null>(null)

  // The lazy terminal mounts after the first render; subscribing from its ref keeps the original
  // componentDidMount order (replayed output first, then live chunks).
  const terminalRef = React.useCallback(
    (terminal: TerminalComponent | null) => {
      unsubscribe.current?.()
      unsubscribe.current = null
      if (terminal) {
        unsubscribe.current = subscribeToCommitOutput(chunk => terminal.write(chunk)).unsubscribe
      }
    },
    [subscribeToCommitOutput]
  )

  React.useEffect(
    () => () => {
      unsubscribe.current?.()
      unsubscribe.current = null
    },
    []
  )

  const onClose = () => {
    unsubscribe.current?.()
    unsubscribe.current = null
    onDismissed()
  }

  return (
    <Dialog
      id="commit-progress-dialog"
      className="sm:max-w-[800px]"
      title={`Committing changes`}
      onDismissed={onClose}
      onSubmit={onClose}>
      <DialogContent>
        <React.Suspense fallback={<Spinner />}>
          <Terminal ref={terminalRef} hideCursor={true} cols={80} rows={20} />
        </React.Suspense>
      </DialogContent>
      <DialogFooter>
        <OkCancelButtonGroup okButtonText={"Close"} cancelButtonVisible={false} />
      </DialogFooter>
    </Dialog>
  )
}
