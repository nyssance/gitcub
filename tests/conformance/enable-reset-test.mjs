// Run Desktop's disabled reset regression without altering its source/assertions.
export { describe, before, after, beforeEach, afterEach, mock, test } from "node:test"
import { it as originalIt } from "node:test"
export const it = Object.assign((...args) => originalIt(...args), originalIt, {
  skip(name, ...args) {
    return name === "resets discarded staged file" ? originalIt(name, ...args) : originalIt.skip(name, ...args)
  }
})
