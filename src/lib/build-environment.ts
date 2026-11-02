/** Build/runtime boundary for feature flags. */
export const development = Boolean(import.meta.env?.DEV)
export const releaseChannel = import.meta.env?.VITE_RELEASE_CHANNEL ?? "production"
export const previewFeatures = () => import.meta.env?.VITE_PREVIEW_FEATURES
