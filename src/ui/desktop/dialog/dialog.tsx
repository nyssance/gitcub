// Desktop dialog contracts backed by the standard shadcn/Base UI dialog.

import { platform } from "@tauri-apps/plugin-os"
import * as React from "react"

import { cn } from "../../../lib/utils"
import { Dialog as StandardDialog, DialogContent as StandardDialogContent, DialogTitle } from "../../base/dialog"
import { sendDialogDidOpen } from "../../native-dialogs"
import { DialogHeader } from "./header"

export const DialogPreferredFocusClassName = "dialog-preferred-focus"
export interface IDialogStackContext {
  isTopMost: boolean
}
export const DialogStackContext = React.createContext<IDialogStackContext>({ isTopMost: true })

interface IDialogProps {
  /**
   * An optional dialog title. Most, if not all dialogs should have
   * this. When present the Dialog renders a DialogHeader element
   * containing an icon (if the type prop warrants it), the title itself
   * and a close button (if the dialog is dismissable).
   *
   * By omitting this consumers may use their own custom DialogHeader
   * for when the default component doesn't cut it.
   */
  readonly title?: string | React.JSX.Element

  /**
   * Typically, a titleId is automatically generated based on the title
   * attribute if it is a string. If it is not provided, we must assume the
   * responsibility of providing a titleID that is used as the id of the h1 in
   * the custom header and used in the aria attributes in this dialog component.
   * By providing this titleID, the state.titleID will be set to this value and
   * used in the aria attributes.
   * */
  readonly titleId?: string

  /**
   * An optional element to render to the right of the dialog title.
   * This can be used to render additional controls that don't belong to the
   * heading element itself, but are still part of the header (visually).
   */
  readonly renderHeaderAccessory?: () => React.JSX.Element

  /**
   * Whether or not the dialog should be dismissable by clicking on the
   * backdrop. Dismissal will trigger the onDismissed event which callers
   * must handle and pass on to the dispatcher in order to close the dialog.
   *
   * Defaults to true if omitted.
   */
  readonly backdropDismissable?: boolean

  /**
   * Whether or not the dialog should be dismissable by any built-in means
   * (like pressing Escape, clicking on the close button, or clicking on the
   * backdrop -if enabled-).
   *
   * Defaults to false if omitted.
   */
  readonly dismissDisabled?: boolean

  /**
   * Event triggered when the dialog is dismissed by the user in the
   * ways described in the dismissable prop.
   */
  readonly onDismissed?: () => void

  /**
   * An optional id for the rendered dialog element.
   */
  readonly id?: string

  /**
   * An optional dialog type. A warning or error dialog type triggers custom
   * styling of the dialog, see _dialog.scss for more detail.
   *
   * Defaults to 'normal' if omitted
   */
  readonly type?: "normal" | "warning" | "error"

  /**
   * An event triggered when the dialog form is submitted. All dialogs contain
   * a top-level form element which can be triggered through a submit button.
   *
   * Consumers should handle this rather than subscribing to the onClick event
   * on the button itself since there may be other ways of submitting a specific
   * form (such as Ctrl+Enter).
   */
  readonly onSubmit?: () => void

  /**
   * An optional className to be applied to the rendered dialog element.
   */
  readonly className?: string

  /**
   * Whether or not the dialog should be disabled. All dialogs wrap their
   * content in a <fieldset> element which, when disabled, causes all descendant
   * form elements and buttons to also become disabled. This is useful for
   * consumers implementing a typical save dialog where the save action isn't
   * instantaneous (such as a sign in dialog) and they need to ensure that the
   * user doesn't continue mutating the form state or click buttons while the
   * save/submit action is in progress. Note that this does not prevent the
   * dialog from being dismissed.
   */
  readonly disabled?: boolean

  /**
   * Whether or not the dialog contents are currently involved in processing
   * data, executing an asynchronous operation or by other means working.
   * Setting this value will render a spinning progress icon in the dialog
   * header (if the dialog has a header). Note that the spinning icon
   * will temporarily replace the dialog icon (if present) for the duration
   * of the loading operation.
   */
  readonly loading?: boolean

  /** Whether or not to override focus of first element with close button */
  readonly focusCloseButtonOnOpen?: boolean

  readonly onDialogRef?: (ref: HTMLDivElement | null) => void
}

/**
 * If role is alertdialog, ariaDescribedBy is required.
 */
interface IAlertDialogProps extends IDialogProps {
  /** This is used to point to an element containing content pertinent to the
   * users workflow. This should be provided for dialogs that are alerts or
   * confirmations so that that the information that is interrupting the user's
   * workflow is screen reader announced and acquire a response */
  readonly ariaDescribedBy: string

  /** By default, a dialog has role of "dialog" and requires the use of an
   * "aria-label" or "aria-labelledby" to accessibily announce the title or
   * purpose of the header. This is typically accomplished by providing the
   * `title` prop and the dialog component will take care of adding the
   * `aria-labelledby` attribute.
   *
   * However, if the dialog is an alert or confirmation dialog we should use the
   * role of `alertdialog` AND the `ariaDescribedBy` prop should be provided
   * containing the id of the element with the information required by the user
   * to proceed or be made aware of to ensure it is also read by screen readers.
   *
   *
   * https://www.w3.org/TR/wai-aria-1.1/#alertdialog
   * "An alert dialog is a modal dialog that interrupts the user's workflow to
   * communicate an important message and acquire a response. Examples include
   * action confirmation prompts and error message confirmations. The
   * alertdialog role enables assistive technologies and browsers to distinguish
   * alert dialogs from other dialogs so they have the option of giving alert
   * dialogs special treatment, such as playing a system alert sound."
   * */
  readonly role: "alertdialog"
}

/**
 * If role is undefined or dialog, ariaDescribedBy is optional.
 */
interface IDescribedByDialogProps extends IDialogProps {
  /** This is used to point to an element containing content pertinent to the
   * users workflow. This should be provided for dialogs that are alerts or
   * confirmations so that that the information that is interrupting the user's
   * workflow is screen reader announced and acquire a response */
  readonly ariaDescribedBy?: string

  /** By default, a dialog has role of "dialog". This is only required for a
   * role of 'alertdialog' in which case  `ariaDescribedBy` must also be
   * provided */
  readonly role?: "dialog"
}

/** Interface union to force usage of `ariaDescribedBy` if role of `alertdialog`
 * is used */
type DialogProps = IAlertDialogProps | IDescribedByDialogProps

function focusFirstSuitableChild(dialog: HTMLElement, focusCloseButtonOnOpen?: boolean) {
  const selector = [
    'input:not([type=hidden]):not(:disabled):not([tabindex="-1"])',
    'textarea:not(:disabled):not([tabindex="-1"])',
    'button:not(:disabled):not([tabindex="-1"])',
    '[tabindex]:not(:disabled):not([tabindex="-1"])'
  ].join(", ")

  // Element marked as "preferred" to have the focus when dialog is shown
  let firstPreferred: HTMLElement | null = null

  // The element which has the lowest explicit tab index (i.e. greater than 0)
  let firstExplicit: { 0: number; 1: HTMLElement | null } = [Infinity, null]

  // First submit button
  let firstSubmitButton: HTMLElement | null = null

  // The first button-like element (input, submit, reset etc)
  let firstButton: HTMLElement | null = null

  // The first element which is either implicitly keyboard focusable (like a
  // text input field) or explicitly focusable through tabIndex=0 (like an
  // anchor tag masquerading as a button)
  let firstTabbable: HTMLElement | null = null

  const closeButton = dialog.querySelector(":scope > .dialog-header button.close")

  if (closeButton instanceof HTMLElement && focusCloseButtonOnOpen) {
    closeButton.focus()
    return
  }

  const excludedInputTypes = [
    ":not([type=button])",
    ":not([type=submit])",
    ":not([type=reset])",
    ":not([type=hidden])",
    ":not([type=radio])"
  ]

  const preferredFirstSelector = `.${DialogPreferredFocusClassName}`
  const inputSelector = `input${excludedInputTypes.join("")}, textarea`
  const buttonSelector = "input[type=button], input[type=submit] input[type=reset], button"

  const submitSelector = "input[type=submit], button[type=submit]"

  for (const candidate of dialog.querySelectorAll(selector)) {
    if (!(candidate instanceof HTMLElement)) {
      continue
    }
    if (candidate === closeButton) continue

    const tabIndex = Number.parseInt(candidate.getAttribute("tabindex") || "", 10)

    if (firstPreferred === null && candidate.matches(preferredFirstSelector)) {
      firstPreferred = candidate
    } else if (tabIndex > 0 && tabIndex < firstExplicit[0]) {
      firstExplicit = [tabIndex, candidate]
    } else if (firstTabbable === null && (tabIndex === 0 || candidate.matches(inputSelector))) {
      firstTabbable = candidate
    } else if (firstSubmitButton === null && candidate.matches(submitSelector)) {
      firstSubmitButton = candidate
    } else if (firstButton === null && candidate.matches(buttonSelector) && candidate !== closeButton) {
      firstButton = candidate
    }
  }

  const focusCandidates = [firstPreferred, firstExplicit[1], firstTabbable, firstSubmitButton, firstButton, closeButton]

  for (const focusCandidate of focusCandidates) {
    if (focusCandidate instanceof HTMLElement) {
      focusCandidate.focus()
      break
    }
  }
}

export interface Dialog {
  focusFirstSuitableChild(): void
}

export function Dialog(props: React.PropsWithChildren<DialogProps> & { ref?: React.Ref<Dialog> }) {
  const { isTopMost } = React.useContext(DialogStackContext)
  const dialogRef = React.useRef<HTMLDivElement | null>(null)
  const lastFocused = React.useRef<HTMLElement | null>(null)
  const appearedAt = React.useRef(Date.now())
  const generatedId = React.useId()
  const titleId = props.titleId ?? generatedId
  const dismiss = () => {
    if (!props.dismissDisabled && Date.now() - appearedAt.current >= 250) props.onDismissed?.()
  }
  const restoreFocus = React.useCallback(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = lastFocused.current
    const canRestore = previous && dialog.contains(previous) && !previous.matches(":disabled")
    if (canRestore) previous.focus()
    if (!canRestore || document.activeElement !== previous)
      focusFirstSuitableChild(dialog, props.focusCloseButtonOnOpen)
  }, [props.focusCloseButtonOnOpen])
  const { onDialogRef } = props
  const setDialogRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      dialogRef.current = element
      onDialogRef?.(element)
      if (element && isTopMost) restoreFocus()
    },
    [onDialogRef, isTopMost, restoreFocus]
  )
  React.useImperativeHandle(props.ref, () => ({
    focusFirstSuitableChild: () => {
      if (dialogRef.current) focusFirstSuitableChild(dialogRef.current, props.focusCloseButtonOnOpen)
    }
  }))
  React.useEffect(() => {
    sendDialogDidOpen()
  }, [])
  React.useLayoutEffect(() => {
    if (!isTopMost) return
    appearedAt.current = Date.now()
    restoreFocus()
    dialogRef.current?.dispatchEvent(new CustomEvent("dialog-show", { bubbles: true }))
    const timer = window.setTimeout(
      () => dialogRef.current?.dispatchEvent(new CustomEvent("dialog-appeared", { bubbles: true })),
      250
    )
    return () => window.clearTimeout(timer)
  }, [isTopMost, restoreFocus])
  return (
    <StandardDialog
      open
      modal={isTopMost}
      onOpenChange={(open, details) => {
        if (open) return
        if (
          props.dismissDisabled ||
          (!props.backdropDismissable && props.backdropDismissable !== undefined && details.reason === "outside-press")
        ) {
          details.cancel()
          return
        }
        dismiss()
      }}>
      <StandardDialogContent
        keepMounted
        hidden={!isTopMost}
        inert={!isTopMost}
        finalFocus={false}
        ref={setDialogRef}
        id={props.id}
        role={props.role ?? "dialog"}
        aria-labelledby={titleId}
        aria-describedby={props.ariaDescribedBy}
        showCloseButton={false}
        className={cn("max-h-[calc(100vh-3rem)] overflow-y-auto", props.className)}
        initialFocus={false}
        onFocusCapture={event => {
          if (isTopMost && event.target instanceof HTMLElement && event.target !== dialogRef.current)
            lastFocused.current = event.target
        }}
        onKeyDown={event => {
          const shortcut = platform() === "macos" ? event.metaKey : event.ctrlKey
          if (shortcut && event.key === "w") {
            event.preventDefault()
            dismiss()
          }
        }}>
        {props.title ? (
          <DialogHeader
            inDialog
            title={props.title}
            titleId={titleId}
            showCloseButton={!props.dismissDisabled}
            onCloseButtonClick={dismiss}
            renderAccessory={props.renderHeaderAccessory}
            loading={props.loading}
          />
        ) : !props.titleId ? (
          <DialogTitle id={titleId} className="sr-only">
            GitCub
          </DialogTitle>
        ) : null}
        <form
          onSubmit={event => {
            event.preventDefault()
            if (!props.disabled) {
              if (props.onSubmit) props.onSubmit()
              else dismiss()
            }
          }}
          onReset={event => {
            event.preventDefault()
            dismiss()
          }}>
          <fieldset disabled={props.disabled} className="flex min-w-0 flex-col gap-4">
            {props.children}
          </fieldset>
        </form>
      </StandardDialogContent>
    </StandardDialog>
  )
}
