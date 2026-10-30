// Desktop MIT implementation extracted unchanged from lib/is-application-bundle.ts.
import { invoke } from "@tauri-apps/api/core"
export function isApplicationBundleFromMetadata(metadata: string): boolean {
  const probableBundleIdentifiers = ["com.apple.application-bundle", "com.apple.application", "public.executable"]

  if (probableBundleIdentifiers.some(id => metadata.includes(`"${id}"`))) {
    return true
  }

  const primaryContentType = metadata.match(/^[ \t]*kMDItemContentType\s*=\s*"([^"]+)"\s*$/m)?.[1]

  if (primaryContentType === "public.folder") {
    return false
  }

  throw new Error("Metadata did not conclusively identify a directory")
}

export const isApplicationBundle = (path: string) => invoke<boolean>("is_application_bundle", { path })
