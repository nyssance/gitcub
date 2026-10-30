import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { getSHA } from "./scripts/git-info.ts"

// Tauri 要求固定端口，且 dev 时不能用随机端口
export default defineConfig({
  define: { "import.meta.env.VITE_GIT_SHA": JSON.stringify(getSHA(fileURLToPath(new URL("./.git", import.meta.url)))) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "byline-browser-buffer",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/byline/lib/byline.js")) return `var Buffer = require('buffer').Buffer;\n${code}`
      }
    }
  ],
  resolve: {
    alias: {
      "node:buffer": fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)),
      "node:process": fileURLToPath(new URL("./node_modules/process/browser.js", import.meta.url)),
      "node:events": fileURLToPath(new URL("./node_modules/events/events.js", import.meta.url)),
      "node:timers": fileURLToPath(new URL("./node_modules/timers-browserify/main.js", import.meta.url)),
      stream: fileURLToPath(new URL("./node_modules/readable-stream/lib/ours/browser.js", import.meta.url)),
      events: fileURLToPath(new URL("./node_modules/events/events.js", import.meta.url)),
      timers: fileURLToPath(new URL("./node_modules/timers-browserify/main.js", import.meta.url)),
      buffer: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      util: fileURLToPath(new URL("./node_modules/util/util.js", import.meta.url))
    }
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "esnext", sourcemap: true, outDir: "dist", emptyOutDir: true }
})
