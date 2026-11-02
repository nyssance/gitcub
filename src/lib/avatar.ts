/** 邮箱 → 头像 URL。
 *
 * 照原版 ui/lib/avatar.tsx 的 getEmailAvatarUrl / getAvatarUrlCandidates：
 * github.com 提供了按邮箱取头像的端点，邮箱对不上任何账号时它自己回退成
 * identicon，所以不需要先查 API，也不需要 token。 */
export function avatarUrl(email: string | undefined, size = 64): string | undefined {
  if (!email) return undefined
  const url = new URL("https://avatars.githubusercontent.com/u/e")
  url.searchParams.set("email", email)
  url.searchParams.set("s", String(size))
  return url.toString()
}
