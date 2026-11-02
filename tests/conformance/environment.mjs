// Same DOM package as Desktop test globals, without Electron IPC stubs. Desktop's IndexedDB
// databases now live in the Rust named store; tests use the in-memory stub in tauri.ts.
import "global-jsdom/register"
globalThis.log = console

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage })
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage })
Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator })

Object.assign(globalThis, {
  __DEV__: false,
  __RELEASE_CHANNEL__: "production",
  __DARWIN__: process.platform === "darwin",
  __WIN32__: process.platform === "win32",
  __LINUX__: process.platform === "linux"
})

// Browser event-target globals used by xterm inside the WebView.
for (const name of ["addEventListener", "removeEventListener", "dispatchEvent", "postMessage"]) {
  globalThis[name] = window[name].bind(window)
}

Object.assign(globalThis, { Event: window.Event, CustomEvent: window.CustomEvent })
