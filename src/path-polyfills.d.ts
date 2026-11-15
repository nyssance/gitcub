declare module "path-browserify" {
  const path: typeof import("node:path").posix
  export default path
}
declare module "path-win32" {
  const path: typeof import("node:path").win32
  export default path
}
