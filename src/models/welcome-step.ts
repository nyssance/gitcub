// Desktop MIT implementation extracted unchanged from ui/welcome/welcome.tsx.
export const WelcomeStep = {
  Start: "Start",
  SignInToDotComWithBrowser: "SignInToDotComWithBrowser",
  SignInToEnterprise: "SignInToEnterprise",
  ConfigureGit: "ConfigureGit"
} as const
export type WelcomeStep = (typeof WelcomeStep)[keyof typeof WelcomeStep]
