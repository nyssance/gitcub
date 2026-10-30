import FocusTrap from "focus-trap-react"
import * as React from "react"

/** jsdom has no layout boxes. Retain the real focus trap and keyboard handling,
 * using its supported non-layout tabbability check for this DOM test harness. */
export default function LayoutlessFocusTrap(props: React.ComponentProps<typeof FocusTrap>) {
  return (
    <FocusTrap
      {...props}
      focusTrapOptions={{
        ...props.focusTrapOptions,
        tabbableOptions: { ...props.focusTrapOptions?.tabbableOptions, displayCheck: "none" }
      }}
    />
  )
}
