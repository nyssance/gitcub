// Narrow adapter for the immutable native-module build test's TS 6 API calls.
// Compilation, diagnostics, and emitted-file discovery run the installed TS 7 CLI.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
const configPath = Symbol("configPath")
function run(args) {
  const result = spawnSync(process.execPath, [compiler, ...args, "--pretty", "false"], { encoding: "utf8" })
  if (result.error) throw result.error
  return result
}
export default {
  sys: {},
  flattenDiagnosticMessageText: message => String(message),
  getParsedCommandLineOfConfigFile(file, _options, host) {
    const result = run(["--project", file, "--showConfig"])
    if (result.status !== 0) {
      host.onUnRecoverableConfigFileDiagnostic({ messageText: result.stdout + result.stderr })
      return undefined
    }
    const parsed = JSON.parse(result.stdout)
    const options = { ...parsed.compilerOptions, [configPath]: file }
    return { fileNames: parsed.files.map(name => resolve(dirname(file), name)), options, errors: [] }
  },
  createProgram(_files, options) {
    const file = options[configPath]
    if (!file) throw new Error("Missing native module tsconfig")
    return {
      diagnostics: [],
      emit(_sourceFile, writeFile) {
        const output = mkdtempSync(join(tmpdir(), "gitcub-ts7-emit-"))
        try {
          const result = run(["--project", file, "--outDir", output, "--listEmittedFiles"])
          const diagnostics = (result.stdout + result.stderr)
            .split(/\r?\n/)
            .filter(line => line.trim() && !line.startsWith("TSFILE: "))
            .map(messageText => ({ messageText }))
          if (result.status !== 0 && diagnostics.length === 0) {
            diagnostics.push({ messageText: `TypeScript compiler exited ${result.status ?? result.signal}` })
          }
          for (const line of result.stdout.split(/\r?\n/)) {
            if (!line.startsWith("TSFILE: ")) continue
            const emitted = line.slice(8).trim()
            writeFile(
              resolve(dirname(file), options.outDir ?? ".", relative(output, emitted)),
              readFileSync(emitted, "utf8")
            )
          }
          this.diagnostics = diagnostics
          return { emitSkipped: result.status !== 0, diagnostics }
        } finally {
          rmSync(output, { recursive: true, force: true })
        }
      }
    }
  },
  getPreEmitDiagnostics: program => program.diagnostics
}
