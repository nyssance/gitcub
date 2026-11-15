// Desktop MIT implementation extracted unchanged from ui/repository-settings/repository-settings.tsx.
export const RepositorySettingsTab = {
  Remote: 0,
  IgnoredFiles: 1,
  GitConfig: 2,
  ForkSettings: 3
} as const
export type RepositorySettingsTab = (typeof RepositorySettingsTab)[keyof typeof RepositorySettingsTab]
