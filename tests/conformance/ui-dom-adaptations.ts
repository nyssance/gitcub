// Original snapshots remain byte-exact. These explicit DOM translations preserve
// state assertions while exercising the actual shadcn controls and native inputs.
export function adaptUIDom(file: string, source: string, helper: string): string {
  if (file === "desktop/ui/copy-button-test.ts") {
    // Clipboard IPC resolves asynchronously. Flush it before starting the
    // announcement clock; lodash debounce reads Date as well as setTimeout.
    source = source
      .replace("enableTestTimers(['setTimeout'])", "enableTestTimers(['setTimeout', 'Date'])")
      .replace("fireEvent.click(button)", "await React.act(async () => { fireEvent.click(button) })")
      .replace("advanceTimersBy(2000)", "await React.act(async () => { advanceTimersBy(2000) })")
  }
  if (file === "desktop/ui/visual-helper-surfaces-test.ts") {
    // Preserve the null assertion without serializing a React DOM tree on failure.
    source = source.replace(
      "assert.strictEqual(screen.queryByRole('tooltip', { hidden: true }), null)",
      "assert.ok(screen.queryByRole('tooltip', { hidden: true }) === null, 'Tooltip must be removed on mouse leave')"
    )
  }
  // Base UI portals move overlays outside RTL's container; baseElement includes
  // the portal while keeping every content/state/callback assertion intact.
  const portalSuites = new Set([
    "desktop/ui/clone-repository-test.ts",
    "desktop/ui/delete-worktree-dialogs-test.ts",
    "desktop/ui/test-token-expiration-dialog-test.ts",
    "desktop/ui/repository-directory-exceptions-test.ts"
  ])
  if (portalSuites.has(file)) {
    source = source.replaceAll("view.container", "view.baseElement")
  }
  if (file === "desktop/ui/clone-repository-test.ts") {
    source = source.replace("return { ...view, directory", "return { ...view, container: view.baseElement, directory")
  }
  if (file === "desktop/ui/dialog-focus-test.ts") {
    // Compare exactly the same element identities without Node inspecting a
    // cyclic React DOM tree when an assertion fails.
    source = source
      .replaceAll(
        "assert.strictEqual(document.activeElement, trigger)",
        "assert.ok(document.activeElement === trigger, 'Expected focus on trigger; got ' + document.activeElement?.outerHTML)"
      )
      .replaceAll(
        "assert.strictEqual(document.activeElement, firstAction)",
        "assert.ok(document.activeElement === firstAction, 'Expected focus on first action; got ' + document.activeElement?.outerHTML)"
      )
  }
  if (file === "desktop/ui/control-primitives-test.ts" || file === "desktop/ui/appearance-test.ts") {
    source = source
      .replaceAll("checkbox.checked", "controlState(checkbox).checked")
      .replaceAll("checkbox instanceof HTMLInputElement", "controlState(checkbox) instanceof HTMLInputElement")
      .replaceAll("checkbox.indeterminate", "controlState(checkbox).indeterminate")
      .replaceAll("(radio as HTMLInputElement).checked", "controlState(radio).checked")
    return `import { controlState } from ${JSON.stringify(helper)};\n${source}`
  }
  if (file === "desktop/ui/tab-bar-item-test.ts") {
    // Base UI makes the selected tab explicitly tabbable; native buttons were
    // implicitly tabbable. Both mean tabIndex === 0.
    return source.replace("button.getAttribute('tabindex'), null", "button.tabIndex, 0")
  }
  return source
}
