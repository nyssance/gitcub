// Node-compatible lexical path functions. File-system resolution remains native.

import { platform } from "@tauri-apps/plugin-os"
import posix from "path-browserify"
import win32 from "path-win32"

const selected = platform() === "windows" ? win32 : posix

export { posix, win32 }
export const { basename, dirname, extname, normalize, join, isAbsolute, parse, format, sep, delimiter } = selected

import { getWorkingDirectory } from "./platform-environment"
export const resolve = (...segments: string[]) =>
  selected.resolve(...(segments.some(selected.isAbsolute) ? segments : [getWorkingDirectory(), ...segments]))
