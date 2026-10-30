import { existsSync, readFileSync } from "node:fs"
// Load suites which use node:test mock.module without bundling away their module
// boundaries. Only TypeScript/JSX syntax and platform import paths are adapted.
import * as module from "node:module"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { transformSync } from "oxc-transform"

import { resolveGitLensModule } from "./gitlens-modules.ts"
const index = process.env.GITCUB_SOURCE_TEST_INDEX
const configurations = index ? JSON.parse(readFileSync(index, "utf8")) : {}
const entry = process.argv.find(value => configurations[value])
const config = entry ? configurations[entry] : undefined
if (config) {
  // `mocks` maps a mock.module() specifier separately from `imports`: Node keeps a
  // suite's already-imported module instance apart from the one production code
  // loads afterwards, while Bun rebinds every importer of the mocked file.
  const { root, imports, mocks = {} } = config
  const desktopUIPaths = JSON.parse(readFileSync(join(root, "desktop-ui-paths.json"), "utf8"))
  const overrides = {
    "focus-trap-react": join(root, "focus-trap.tsx"),
    "@tauri-apps/api/path": join(root, "native-path.ts"),
    electron: join(root, "electron.ts"),
    "desktop-notifications/dist/notification-support.js": join(root, "../../src/lib/notifications/native-support.ts"),
    "desktop-notifications/build/Release/desktop-notifications.node": join(root, "native-notification-binding.cjs"),
    "desktop-notifications": join(root, "../../src/lib/notifications/native-module.ts"),
    typescript: join(root, "typescript-native-build.mjs"),
    "fs-admin": join(root, "admin-files.mjs"),
    "@tauri-apps/api/core": join(root, "tauri.ts"),
    "@tauri-apps/plugin-os": join(root, "os.ts"),
    "@tauri-apps/plugin-opener": join(root, "opener.ts")
  }
  function existing(path) {
    return [
      path,
      `${path}.ts`,
      `${path}.tsx`,
      `${path}.mjs`,
      join(path, "index.ts"),
      join(path, "index.tsx"),
      // TypeScript-style `./module.js` specifiers in the GitLens snapshots name `.ts` sources.
      path.replace(/\.js$/, ".ts")
    ].find(candidate => existsSync(candidate) && extname(candidate))
  }
  const hooks = {
    resolve(specifier, context, next) {
      if (entry.includes("desktop-tailer-test.") && specifier === "./native-file-streams")
        return next("node:fs", context)
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : ""
      if (specifier === "../../../src/lib/path-exists")
        return next(join(root, "../../src/lib/native-path-exists.ts"), context)

      if (
        entry.includes("desktop-native-notifications-test.") &&
        parent.endsWith("/notifications/native-module.ts") &&
        specifier === "./native-binding"
      )
        return next(pathToFileURL(join(root, "native-notification-binding.cjs")).href, context)
      if (
        entry.includes("desktop-native-notifications-windows-test.") &&
        specifier === "node:test" &&
        !parent.endsWith("enable-native-notification-test.mjs")
      )
        return next(pathToFileURL(join(root, "enable-native-notification-test.mjs")).href, context)
      if (specifier.endsWith("/platform-environment")) return next(join(root, "platform-environment.ts"), context)
      if (specifier === "../../../src/lib/git/index.ts")
        return next(pathToFileURL(join(root, "../../src/lib/repository-access.ts")).href, context)
      if (specifier === "../../../src/ui/main-process-proxy.ts")
        return next(pathToFileURL(join(root, "../../src/ui/native-dialogs.ts")).href, context)
      if (specifier.startsWith("lodash/") && !specifier.endsWith(".js")) return next(`${specifier}.js`, context)
      if (specifier === "focus-trap-react" && parent.endsWith("/focus-trap.tsx")) return next(specifier, context)
      if (specifier in overrides) return next(overrides[specifier], context)
      if (specifier in imports) return next(pathToFileURL(imports[specifier]).href, context)
      const gitlens = resolveGitLensModule(specifier, parent, root)
      if (gitlens) return next(pathToFileURL(gitlens).href, context)
      if (specifier.startsWith("dom-helpers/") && !specifier.endsWith(".js"))
        return next(`dom-helpers/cjs/${specifier.slice("dom-helpers/".length)}.js`, context)
      if (parent.includes("/node_modules/") && parent !== entry) return next(specifier, context)
      if (parent.endsWith("/src/ui/preferences/config-lock-file-exists.tsx") && specifier === "../../lib/native-files")
        return next("node:fs/promises", context)
      if (
        (parent.endsWith("/src/lib/desktop-features.ts") || parent.endsWith("/src/lib/stats/stats-store.ts")) &&
        (specifier === "./build-environment" || specifier === "../build-environment")
      )
        return next(
          pathToFileURL(
            join(root, parent.endsWith("/stats/stats-store.ts") ? "stats-build-environment.ts" : "build-environment.ts")
          ).href,
          context
        )
      if (specifier.startsWith("@/")) {
        const path = existing(join(root, "../../src", specifier.slice(2)))
        if (path && /\.(ts|tsx|mjs)$/.test(path)) return next(pathToFileURL(path).href, context)
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const path = existing(resolve(dirname(parent), specifier))
        if (path && /\.(ts|tsx|mjs)$/.test(path)) return next(pathToFileURL(path).href, context)
      }
      if (/^(?:\.\.\/){2,4}src\//.test(specifier)) {
        const original = specifier.split("/src/")[1]
        const relative = desktopUIPaths[original.replace(/\.(tsx?|jsx?)$/, "")] ?? original
        const path = existing(join(root, "../../src", relative)) ?? existing(join(root, "../../src/upstream", relative))
        if (path && /\.(ts|tsx|mjs)$/.test(path)) return next(pathToFileURL(path).href, context)
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (
        (url.startsWith("file:") && /\.(ts|tsx)$/.test(url) && !url.includes("/node_modules/")) ||
        url === pathToFileURL(entry).href
      ) {
        const path = fileURLToPath(url)
        let source = readFileSync(path, "utf8").replaceAll(
          "app/src/lib/stats/stats-store.ts",
          "src/lib/stats/stats-store.ts"
        )
        if (process.versions.bun) {
          source = source.replaceAll(
            /(\bfrom\s+|\bimport\s*|\b(?:import|require|mock\.module)\(\s*)(['"])([^'"\n]+)\2/g,
            (_match, prefix, _quote, specifier) => {
              const mapped =
                prefix.startsWith("mock.module(") && specifier in mocks
                  ? pathToFileURL(mocks[specifier]).href
                  : hooks.resolve(specifier, { parentURL: url }, value => value)
              return prefix + JSON.stringify(mapped.startsWith("file:") ? fileURLToPath(mapped) : mapped)
            }
          )
        }
        if (process.versions.bun && /\bmock\.module\(/.test(source)) {
          source = `import { mockModule as __mockModule } from ${JSON.stringify(join(root, "bun-module-mock.mjs"))};\n${source.replaceAll(/\bmock\.module\(/g, "__mockModule(")}`
        }
        const adapted = source.replaceAll(
          /from (['"])([^'"\n]+\.json)\1(?!\s*(?:with|assert)\b)/g,
          '$& with { type: "json" }'
        )
        // The GitLens model snapshots use TypeScript's experimentalDecorators; nothing else here is decorated.
        const result = transformSync(path, adapted, {
          lang: path.endsWith(".tsx") ? "tsx" : "ts",
          jsx: { runtime: "automatic" },
          typescript: { onlyRemoveTypeImports: false },
          decorator: { legacy: true }
        })
        if (result.errors.length) throw new Error(result.errors.map(error => error.message).join("\n"))
        return { format: "module", source: result.code, shortCircuit: true }
      }
      return next(url, context)
    }
  }
  if (process.versions.bun) {
    const { plugin } = await import("bun")
    plugin({
      name: "conformance-source-mapping",
      setup(build) {
        let resolving = false
        build.onResolve({ filter: /.*/ }, args => {
          if (resolving) return undefined
          const context = { parentURL: args.importer ? pathToFileURL(args.importer).href : "" }
          return hooks.resolve(args.path, context, mapped => {
            if (mapped === args.path) return undefined
            if (mapped.startsWith("node:")) return { path: mapped, external: true }
            const path = mapped.startsWith("file:") ? fileURLToPath(mapped) : mapped
            resolving = true
            try {
              return { path: Bun.resolveSync(path, args.importer ? dirname(args.importer) : root) }
            } finally {
              resolving = false
            }
          })
        })
        build.onLoad({ filter: /\.(?:ts|tsx|mjs)$/ }, args => {
          const loaded = hooks.load(pathToFileURL(args.path).href, {}, () => undefined)
          if (loaded) return { contents: loaded.source, loader: "js" }
          return {
            contents: readFileSync(args.path, "utf8"),
            loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".ts") ? "ts" : "js"
          }
        })
      }
    })
  } else {
    module.registerHooks(hooks)
  }
}
