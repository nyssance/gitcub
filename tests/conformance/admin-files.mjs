// OS privilege boundary only; the original suite mocks this dependency.
const unavailable = () => {
  throw new Error("Administrative filesystem operations are unavailable in this runner")
}
export const unlink = unavailable,
  makeTree = unavailable,
  symlink = unavailable
