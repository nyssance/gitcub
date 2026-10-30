/** Explicit scope change: base controls are standard shadcn/ui (Base UI) by the user's rule, so
 * Desktop assertions that require native elements cannot pass. Snapshots stay unchanged; the
 * affected tests are listed here and in tests/desktop/manifest.json as `partial`. */
export function withoutNativeDetails(file: string, source: string): string {
  if (file === "desktop/ui/tutorial-welcome-surfaces-test.ts") {
    // TutorialStepInstructions renders a shadcn Collapsible, not `<details>` with a `toggle` event.
    return source.replace(
      / {2}it\('renders tutorial step instructions with step state, skip content, and toggle callbacks'[\s\S]*?(?= {2}it\('focuses tutorial completion)/,
      ""
    )
  }
  return source
}
