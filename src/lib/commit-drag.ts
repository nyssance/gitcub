/** Native drag transport for the production history list. Never accept SHAs
 * supplied by an external application. The source repository owns the session.
 * Desktop orders selected commits by history before cherry-picking (bebc062c,
 * AppStore.orderCommitsByHistory), independent of selection order.
 */
const mime = "application/x-gitcub-commits"
let session: { repo: string; shas: string[]; token: string } | null = null

export function startCommitDrag(data: DataTransfer, repo: string, shas: string[]) {
  const token = crypto.randomUUID()
  session = { repo, shas: [...shas], token }
  data.effectAllowed = "copyMove"
  data.setData(mime, token)
}

export function canDropCommits(data: DataTransfer, repo: string) {
  return session?.repo === repo && session.shas.length > 0 && [...data.types].includes(mime)
}

export function takeCommitDrag(data: DataTransfer, repo: string): string[] | null {
  if (!canDropCommits(data, repo) || data.getData(mime) !== session?.token) return null
  const shas = session.shas
  session = null
  return shas
}

export function endCommitDrag() {
  session = null
}
