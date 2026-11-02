// The mocked Node spawn is the original test transport; native production
// launch uses exactly this Rust command plan, including all inherited variables.
import childProcess from "node:child_process"

import { call } from "./bridge"
export const Shell = { Cygwin: "Cygwin" }
export function launch(found: { shell: string; path: string }, path: string) {
  const plan = call("shell/cygwin-plan", { executable: found.path, path })
  return childProcess.spawn(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env })
}
