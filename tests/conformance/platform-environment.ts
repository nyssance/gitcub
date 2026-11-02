// Real Node process environment replaces the native startup IPC boundary.
export const getWorkingDirectory = () => process.cwd()

import { homedir } from "node:os"
export const getHomeDirectory = () => homedir()
