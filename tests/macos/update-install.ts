// Real signed updater verification against a disposable .app. No release keys,
// installed applications, accounts or remote repositories are used.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
const exec = promisify(execFile)
if (process.platform !== "darwin") throw new Error("This test requires macOS")
const root = resolve(import.meta.dirname, "../..")
const directory = await mkdtemp("/private/tmp/gitcub-update-")
const bundle = join(directory, "GitCub Update Test.app")
const payloadRoot = join(directory, "payload")
const socket = join(directory, "hasgard.sock")
const artifactDir = join(root, "test-results/macos-update")
await mkdir(artifactDir, { recursive: true })
await cp(join(root, "src-tauri/target/debug/bundle/macos/GitCub.app"), bundle, { recursive: true })
const keyPath = join(directory, "test-key")
await exec(process.execPath, [
  join(root, "node_modules/@tauri-apps/cli/tauri.js"),
  "signer",
  "generate",
  "--ci",
  "-p",
  "",
  "-w",
  keyPath
])
const key = (await readFile(`${keyPath}.pub`, "utf8")).trim()
let mode: "none" | "tampered" | "valid" = "none"
const server = createServer((req, res) => {
  if (req.url === "/artifact") {
    res.writeHead(200, { "Content-Type": "application/octet-stream" })
    const bytes = Buffer.from(archive)
    if (mode === "tampered") bytes[bytes.length - 10] ^= 1
    res.end(bytes)
  } else if (mode === "none") {
    res.writeHead(204)
    res.end()
  } else {
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        version: "99.0.0",
        notes: "Isolated signed update test",
        url: endpoint.replace("/update", "/artifact"),
        signature
      })
    )
  }
})
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/update`
const environment = {
  TAURI_HASGARD_SOCKET: socket,
  GITCUB_TEST_DATA_DIR: directory,
  GITCUB_TEST_UPDATE_ENDPOINT: endpoint,
  GITCUB_TEST_UPDATE_PUBLIC_KEY: key,
  GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
  GIT_CONFIG_SYSTEM: join(directory, "gitconfig")
}
await writeFile(environment.GIT_CONFIG_GLOBAL, "[user]\nname = Test\nemail = test@example.invalid\n")
await writeFile(join(directory, "environment.json"), JSON.stringify(environment))
// LaunchServices preserves LSEnvironment when the real updater restarts the app.
await exec("python3", [
  "-c",
  `import plistlib,json,sys
p=sys.argv[1]
with open(p,'rb') as f: d=plistlib.load(f)
with open(sys.argv[2]) as f: d['LSEnvironment']=json.load(f)
d['CFBundleIdentifier']='day.dreamer.gitcub.update-test'
with open(p,'wb') as f: plistlib.dump(d,f)`,
  join(bundle, "Contents/Info.plist"),
  join(directory, "environment.json")
])
await mkdir(payloadRoot)
const payload = join(payloadRoot, "GitCub Update Test.app")
await cp(bundle, payload, { recursive: true })
await writeFile(join(payload, "Contents/Resources/update-test-marker"), "verified update payload")
await exec("codesign", ["--force", "--deep", "--sign", "-", payload])
const archivePath = join(directory, "update.app.tar.gz")
await exec("tar", ["-czf", archivePath, "-C", payloadRoot, "GitCub Update Test.app"], {
  env: { ...process.env, COPYFILE_DISABLE: "1" }
})
await exec(process.execPath, [
  join(root, "node_modules/@tauri-apps/cli/tauri.js"),
  "signer",
  "sign",
  "-f",
  keyPath,
  "-p",
  "",
  "--app-version",
  "99.0.0",
  archivePath
])
const archive = await readFile(archivePath)
const signature = (await readFile(`${archivePath}.sig`, "utf8")).trim()
const app = spawn(join(bundle, "Contents/MacOS/gitcub"), [], {
  env: { ...process.env, ...environment },
  stdio: ["ignore", "pipe", "pipe"]
})
const logs: string[] = []
app.stdout.on("data", data => logs.push(String(data)))
app.stderr.on("data", data => logs.push(String(data)))
async function hasgard(...args: string[]) {
  const { stdout } = await exec("tauri-hasgard", ["--socket", socket, "--json", ...args], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const result = JSON.parse(stdout)
  if (result?.error && !("events" in result)) throw new Error(JSON.stringify(result.error))
  return result
}
async function until(check: () => Promise<void>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let error: unknown
  do {
    try {
      await check()
      return
    } catch (e) {
      error = e
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw error
}
async function checkUpdate() {
  return hasgard(
    "eval",
    `(async () => {
    const events = [];
    const api = window.__TAURI_INTERNALS__;
    const id = api.transformCallback(message => { if (message.message) events.push(message.message); });
    try { await api.invoke('updater_check', { events: '__CHANNEL__:' + id }); return { events }; }
    catch (error) { return { error: String(error), events }; }
    finally { api.unregisterCallback(id); }
  })()`
  )
}
try {
  await until(async () => {
    assert.ok(await hasgard("ping"))
  })
  // Wait for the normal startup check before issuing another request.
  await new Promise(resolve => setTimeout(resolve, 1000))
  mode = "tampered"
  const rejected = await checkUpdate()
  assert.ok(rejected.error, "A corrupted signed payload must be rejected")
  assert.ok(!rejected.events.some((e: { kind: string }) => e.kind === "downloaded"))
  mode = "valid"
  const accepted = await checkUpdate()
  assert.equal(accepted.error, undefined)
  assert.ok(
    accepted.events.some((e: { kind: string }) => e.kind === "downloaded"),
    JSON.stringify(accepted)
  )
  mode = "none"
  await hasgard(
    "eval",
    `window.__TAURI_INTERNALS__.invoke('install_update').catch(error => { window.__updateTestError = String(error); console.error(error); }); true`
  )
  await until(async () => {
    const failure = await hasgard("eval", "window.__updateTestError ?? null").catch(() => null)
    if (failure) throw new Error(`Update installation failed: ${failure}`)
    assert.equal(
      await readFile(join(bundle, "Contents/Resources/update-test-marker"), "utf8"),
      "verified update payload"
    )
    assert.notEqual(app.exitCode, null, "Old process has not exited")
  })
  await until(async () => {
    assert.ok(await hasgard("ping"))
  }, 45_000)
  await until(async () => {
    assert.ok(await hasgard("state"))
  }, 45000)
  assert.equal((await stat(bundle)).mode & 0o777, 0o755)
  await writeFile(
    join(artifactDir, "report.json"),
    JSON.stringify(
      {
        platform: "macOS",
        at: new Date().toISOString(),
        corruptedSignatureRejected: true,
        signedDownloadVerified: true,
        packageInstalled: true,
        restarted: true,
        publicDistributionSigning: false,
        directory
      },
      null,
      2
    )
  )
  console.log("Signed updater: tamper rejection, verified download, package installation and restart passed")
} finally {
  await writeFile(join(artifactDir, "console.json"), JSON.stringify(await hasgard("logs").catch(String), null, 2))
  await hasgard("eval", "window.__TAURI_INTERNALS__.invoke('request_quit', {force:true}); true").catch(() => {})
  if (app.exitCode === null) app.kill("SIGTERM")
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await writeFile(join(artifactDir, "native.log"), logs.join(""))
}
