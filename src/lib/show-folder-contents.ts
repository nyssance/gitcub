// Desktop MIT implementation extracted unchanged from ui/main-process-proxy.ts.

import { confirm } from "@tauri-apps/plugin-dialog"
import { openPath, revealItemsInDir } from "@tauri-apps/plugin-opener"
import { platform } from "@tauri-apps/plugin-os"

import { isApplicationBundle } from "./is-application-bundle"
import { stat } from "./native-files"

const confirmRevealDirectory = () =>
  confirm("This folder is an application. Reveal it in Finder?", { title: "Reveal application", kind: "warning" })
const UNSAFE_openDirectory = (path: string) => {
  void openPath(path).catch(error => log.error("Unable to open directory", error))
}
const _showItemInFolder = (path: string) => revealItemsInDir(path)
interface IFileInformation {
  readonly isDirectory: () => boolean
}

/** Platform operations used to safely show the contents of a folder. */
export interface IShowFolderContentsDependencies {
  /** Whether the current platform is macOS. */
  readonly isDarwin: boolean
  /** Reads file information for the target path. */
  readonly stat: (path: string) => Promise<IFileInformation>
  /** Determines whether a path is a macOS application bundle. */
  readonly isApplicationBundle: (path: string) => Promise<boolean>
  /** Requests confirmation before revealing a potentially executable path. */
  readonly confirmReveal: () => Promise<boolean>
  /** Opens a directory directly in the platform file manager. */
  readonly openDirectory: (path: string) => void
  /** Reveals and selects a path in the platform file manager. */
  readonly revealItem: (path: string) => Promise<void>
}

const defaultShowFolderContentsDependencies: IShowFolderContentsDependencies = {
  isDarwin: platform() === "macos",
  stat,
  isApplicationBundle,
  confirmReveal: confirmRevealDirectory,
  openDirectory: UNSAFE_openDirectory,
  revealItem: _showItemInFolder
}

async function revealAfterConfirmation(path: string, dependencies: IShowFolderContentsDependencies) {
  const confirmed = await dependencies.confirmReveal().catch(err => {
    // If the warning cannot be shown, leave the path untouched.
    log.error(`Unable to confirm revealing folder '${path}'`, err)
    return false
  })

  if (confirmed) {
    await dependencies.revealItem(path).catch(err => log.error(`Unable to reveal folder '${path}'`, err))
  }
}

/**
 * Shows a folder's contents, warning for identified application bundles on macOS.
 *
 * Dependencies default to the platform implementations and can be supplied
 * for isolated testing of the classification and confirmation flow.
 */
export async function showFolderContents(path: string, dependencies = defaultShowFolderContentsDependencies) {
  const stats = await dependencies.stat(path).catch(err => {
    log.error(`Unable to retrieve file information for ${path}`, err)
    return null
  })

  if (!stats) {
    if (dependencies.isDarwin) {
      await dependencies.revealItem(path).catch(err => log.error(`Unable to reveal folder '${path}'`, err))
    }
    return
  }

  if (!stats.isDirectory()) {
    log.error(`Trying to get the folder contents of a non-folder at '${path}'`)
    await dependencies.revealItem(path).catch(err => log.error(`Unable to reveal folder '${path}'`, err))
    return
  }

  // On Windows and Linux we can count on a directory being just a
  // directory.
  if (!dependencies.isDarwin) {
    dependencies.openDirectory(path)
    return
  }

  // Warn only when metadata identifies an application bundle. Spotlight may
  // have no metadata for ordinary folders while indexing or on excluded volumes.
  const isBundle = await dependencies.isApplicationBundle(path).catch(err => {
    log.error(`Failed to load metadata for path '${path}'`, err)
    return false
  })

  if (isBundle) {
    log.info(`Preventing direct open of path '${path}' because it was identified as an application bundle`)

    await revealAfterConfirmation(path, dependencies)
  } else {
    dependencies.openDirectory(path)
  }
}
