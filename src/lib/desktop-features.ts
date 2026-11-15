// Desktop feature opt-ins, with a Tauri environment boundary.
import { development, previewFeatures, releaseChannel } from "./build-environment"

const Disable = false

/**
 * Opt in new OAuth authorizations for beta and development features.
 * Other builds use Central's rollout; existing credentials keep renewing.
 */
export const enableShortLivedTokens = () => enableBetaFeatures()

/**
 * Enables the application to opt-in for preview features based on runtime
 * checks. This is backed by the GITHUB_DESKTOP_PREVIEW_FEATURES environment
 * variable, which is checked for non-development environments.
 */
function enableDevelopmentFeatures(): boolean {
  if (Disable) {
    return false
  }

  if (development) {
    return true
  }

  if (previewFeatures() === "1") {
    return true
  }

  return false
}

/** Should the app enable beta features? */
function enableBetaFeatures(): boolean {
  return enableDevelopmentFeatures() || releaseChannel === "beta"
}

/**
 * Should the app show menu items that are used for testing various parts of the
 * UI
 *
 * For our own testing purposes, this will likely remain enabled. But, sometimes
 * we may want to create a test release for a user to test a fix in which case
 * they should not need access to the test menu items.
 */
export const enableTestMenuItems = () => enableDevelopmentFeatures() || releaseChannel === "test"

export const enableFormattingPreferences = () => true

export function enableAccessibleListToolTips(): boolean {
  return enableBetaFeatures()
}

export const enableHooksEnvironment = () => true
export const enableHooksByDefault = enableBetaFeatures
export const enableNewStatsEndpoint = () => true

export const enableWorktreeSupport = () => true

import { __DARWIN__, __WIN32__ } from "./platform-flags"

export const enableUpdateFromEmulatedX64ToARM64 = () => __DARWIN__ || enableBetaFeatures()
