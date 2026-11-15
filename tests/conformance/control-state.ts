import assert from "node:assert/strict"

/** Read Base UI's real form input and additionally verify the accessible root agrees. */
export function controlState(control: HTMLElement): HTMLInputElement {
  if (control instanceof HTMLInputElement) return control
  const input = control.nextElementSibling
  assert.ok(input instanceof HTMLInputElement, "Base UI control must have a native form input")
  assert.equal(control.getAttribute("aria-checked"), input.indeterminate ? "mixed" : String(input.checked))
  return input
}
