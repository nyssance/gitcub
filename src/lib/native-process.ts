import { invoke } from "@tauri-apps/api/core"
export async function execFile(
  executable: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: "utf8"; killSignal: "SIGKILL"; windowsHide: boolean }
) {
  try {
    return await invoke<{ stdout: string; stderr: string }>("execute_process", {
      executable,
      args,
      timeoutMs: options.timeout,
      maxBuffer: options.maxBuffer
    })
  } catch (failure) {
    if (failure instanceof Error) throw failure
    if (typeof failure === "object" && failure !== null && "message" in failure)
      throw Object.assign(new Error(String(failure.message), { cause: failure }), failure)
    throw new Error(String(failure), { cause: failure })
  }
}
