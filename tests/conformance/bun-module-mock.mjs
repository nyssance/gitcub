import { mock } from "bun:test"

// Suites run in separate processes, so module replacements cannot leak across suites.
export function mockModule(specifier, options) {
  const exports = { ...options.namedExports }
  if (Object.hasOwn(options, "defaultExport")) exports.default = options.defaultExport
  mock.module(specifier, () => exports)
}
