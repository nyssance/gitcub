// Run the platform-independent Rust initialization guard on every host.
import { it as original } from "node:test"
export const it = (name, options, fn) => original(name, { ...options, skip: false }, fn)
