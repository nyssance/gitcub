/** GitLens 原版套件里不能合法运行在 GitCub 生产代码上的块：快照保持原字节，加载时按标题删除
 * suite/test 块及只被这些块使用的导入，与 hosted-search-adaptations.ts 同一做法。每项理由登记在
 * tests/gitlens/manifest.json 对应条目的 adaptation 里；布局一变（标题或导入找不到、不唯一）就报错。 */
type Unported = { imports?: string[]; text?: string[]; suites?: string[]; tests?: string[] }

const unported: Record<string, Unported> = {
  // search_query 只移植了搜索用到的无选项形态：search.utils.ts 只导入 isSha / shortenRevision（第 16 行），
  // 调用处不带选项（第 27、33、150 行）；shortenRevision 内部再用无选项的 isUncommitted(Staged)、isRevisionRange、
  // isShaWithOptionalRevisionSuffix 与固定 7 位缩写。其余选项与辅助函数搜索不用，GitCub 也没有别的调用方。
  "gitlens/revision.utils.test.ts": {
    imports: [
      "\tcreateRevisionRange,\n",
      "\tgetRevisionRangeParts,\n",
      "\tisRevisionWithSuffix,\n",
      "\tisShaWithParentSuffix,\n",
      "\tresetAbbreviatedShaLength,\n",
      "\tsetAbbreviatedShaLength,\n",
      "\tstripOrigin,\n"
    ],
    text: ["\t\tteardown(() => {\n\t\t\tresetAbbreviatedShaLength();\n\t\t});\n\n"],
    suites: ["isShaWithParentSuffix", "isRevisionWithSuffix", "getRevisionRangeParts", "stripOrigin"],
    tests: [
      "accepts a 7-char short SHA when allowShort is true",
      "rejects a 6-char SHA even with allowShort true",
      "returns false for zero-sha with suffix when exact is true",
      "returns true for exact uncommittedStaged when exact is true",
      "returns false for zero-sha with ^ and trailing colon when exact is true",
      "returns custom working string for undefined when provided",
      "returns custom uncommitted string when provided",
      "returns custom uncommittedStaged string when provided",
      "respects custom abbreviated length via setAbbreviatedShaLength",
      "enforces minimum length of 5 even if abbreviatedShaLength is smaller",
      "qualified requires both sides",
      "qualified-double-dot only matches ..",
      "qualified-triple-dot only matches ..."
    ]
  },
  // branch::split_remote_branch_name 的输入是 refs/remotes/ 之下的名字；其余是 GitLens 模型辅助。
  "gitlens/branch.utils.test.ts": {
    imports: [
      "import { getRemoteNameSlashIndex } from '@gitlens/utils/gitRefs.js';\n",
      "import { GitBranch } from '../../models/branch.js';\n",
      "\tgetBranchNameAndRemote,\n",
      "\tgetBranchTrackingWithoutRemote,\n",
      "\tisDetachedHead,\n",
      "\tparseRefName,\n",
      "\tparseUpstream,\n"
    ],
    suites: ["parseUpstream", "parseRefName", "getRemoteNameSlashIndex", "isDetachedHead", "upstream remote"],
    tests: ["strips a leading remotes/", "keeps a leading remotes/ that belongs to the remote name"]
  },
  // 缓存、空树 sha 与限定路径的文件/树列表在 GitCub 没有对应 API。空树只有 Desktop 的 SHA-1 常量
  // NullTreeSHA（Desktop app/src/lib/git/diff-index.ts:71，GitCub src/lib/git/diff-index.ts:71），不按仓库对象格式求值。
  "gitlens/revision.test.ts": {
    imports: ["import { isCancellationError } from '@gitlens/utils/cancellation.js';\n"],
    suites: [
      "RevisionSubProvider.resolveRevision — force bypasses the cache",
      "RevisionSubProvider.getEmptyTreeSha",
      "RevisionSubProvider scoped listings"
    ]
  },
  // Desktop getRepositoryType 把 git 退出码 128（含无权进入目录）一律当作 missing。
  "gitlens/revParseGitDir.test.ts": { tests: ["rejects when git cannot read the directory"] }
}

function remove(file: string, source: string, text: string): string {
  if (source.split(text).length !== 2) throw new Error(`GitLens suite layout changed: ${file}: ${JSON.stringify(text)}`)
  return source.replace(text, "")
}

function removeBlock(file: string, source: string, kind: "suite" | "test", title: string): string {
  const lines = source.split("\n")
  const needle = `${kind}('${title}',`
  const starts = lines.flatMap((line, index) => (line.trimStart().startsWith(needle) ? [index] : []))
  if (starts.length !== 1) throw new Error(`GitLens suite layout changed: ${file}: ${kind} '${title}'`)
  const [start] = starts
  const indent = lines[start].slice(0, lines[start].length - lines[start].trimStart().length)
  const end = lines.findIndex((line, index) => index > start && line === `${indent}});`)
  if (end === -1) throw new Error(`GitLens suite layout changed: ${file}: unterminated ${kind} '${title}'`)
  let [from, to] = [start, end]
  if (lines[to + 1] === "") to++
  else if (lines[from - 1] === "") from--
  lines.splice(from, to - from + 1)
  return lines.join("\n")
}

export function withoutUnportedGitLensBlocks(file: string, source: string): string {
  const blocks = unported[file]
  if (!blocks) return source
  for (const text of [...(blocks.imports ?? []), ...(blocks.text ?? [])]) source = remove(file, source, text)
  for (const title of blocks.suites ?? []) source = removeBlock(file, source, "suite", title)
  for (const title of blocks.tests ?? []) source = removeBlock(file, source, "test", title)
  return source
}
