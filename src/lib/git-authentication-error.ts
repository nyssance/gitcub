// Desktop MIT authentication error presentation, extracted unchanged from git/core.ts.
import { __DARWIN__ } from "./platform-flags"
export function getAuthenticationFailureDescription(): string {
  const menuHint = __DARWIN__ ? "GitHub Desktop > Settings." : "File > Options."
  return `Authentication failed. Some common reasons include:

- You are not logged in to your account: see ${menuHint}
- You may need to log out and log back in to refresh your token.
- You do not have permission to access this repository.
- The repository is archived on GitHub. Check the repository settings to confirm you are still permitted to push commits.
- If you use SSH authentication, check that your key is added to the ssh-agent and associated with your account.
- If you use SSH authentication, ensure the host key verification passes for your repository hosting service.
- If you used username / password authentication, you might need to use a Personal Access Token instead of your account password. Check the documentation of your repository hosting service.`
}
