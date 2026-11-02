// Desktop's usage-data helper. TS7's synchronous API drives tsgo through Node-only pipe
// internals; usage-data-generate.ts computes the example over the async API in a child process
// and the unchanged upstream test consumes it synchronously here.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { buildStatsPayload } from "../../src/lib/stats/stats-store"

export function generateUsageDataExample(): ReturnType<typeof buildStatsPayload> {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("usage-data-generate.ts", import.meta.url)), "--print"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    }
  )
  if (result.status !== 0) throw new Error(result.stderr || `Usage data generator exited ${result.status}`)
  return buildStatsPayload(JSON.parse(result.stdout) as Parameters<typeof buildStatsPayload>[0])
}
