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
  if (file === "desktop/e2e/app-launch-test.ts") {
    // User decision 2026-11-03: updates follow ALwith Desktop (@alwith/module-desktop-shell) — first
    // check 30 s after launch, automatic download, a card at the foot of the repository rail and one
    // relaunch question. There is no About "Check for Updates", `.update-status` text or Desktop
    // installing-update quit guard, so the original Auto-update block cannot apply.
    const start = source.indexOf("test.describe('Auto-update'")
    if (start === -1) throw new Error("app-launch-test: Auto-update block not found")
    return source.slice(0, start)
  }
  if (file === "desktop/repositories-list-grouping-test.ts") {
    // User decision 2026-11-24: the repository list is never split into per-account groups. The rail
    // is tabbed by platform (GitHub / GitLab / other) and does not fold into groups, so the seven
    // account-qualifier cases cannot apply. The owner / Enterprise / Other cases stay.
    const start = source.indexOf("  it('splits an owner by retained account assignments")
    const end = source.indexOf("  it('groups repositories by owners/Enterprise/Other'")
    if (start === -1 || end === -1 || end < start)
      throw new Error("repositories-list-grouping-test: account grouping block not found")
    return source.slice(0, start) + source.slice(end)
  }
  return source
}
