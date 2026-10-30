import { getHomeDirectory } from "./platform-environment"
export default function untildify(path: string) {
  return path.replace(/^~(?=$|[/\\])/, () => getHomeDirectory())
}
