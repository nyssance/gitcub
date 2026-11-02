// Desktop MIT port of ui/lib/parse-files-to-be-overwritten.ts.
export function parseFilesToBeOverwritten(errorMessage: string) {
  const files = new Array<string>()
  const lines = errorMessage.split("\n")

  let inFilesList = false

  for (const line of lines) {
    if (inFilesList) {
      if (!line.startsWith("\t")) {
        break
      } else {
        files.push(line.trimStart())
      }
    } else {
      if (line.startsWith("error:") && line.includes("files would be overwritten") && line.endsWith(":")) {
        inFilesList = true
      }
    }
  }

  return files
}
