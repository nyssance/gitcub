# 热路径基准

`bun run bench` 对比 GitCub 的 Rust/gix 热路径与 Desktop 在同一仓库上执行的等价 git 命令。
结论只对测过的仓库和机器成立；数据来自 `test-results/benchmark/report.json`（不入库）。

## 方法

- `src-tauri/examples/benchmark.rs`（release 构建）在同一进程里交替执行两侧，每项 10 次，取中位数与最小值。
- GitCub 一侧直接调用生产函数：`status::status`、`history::query_details`（Desktop 移植的 git-store、
  分支比较、PR 分支和提交表单读历史的入口；不带 revision、单个修订号、`A..B` 与 `<rev> --not --remotes` 走 gix 快速路径，
  其中有排除端时照搬 git 的 `limit_list` 受限遍历）、
  `history::commit_files`、`graph::graph`（History 标签页的列表本身：git `--date-order` 的一比一移植把起点能到的
  整条序列排好并按起点集合缓存，之后每页取切片、泳道分配、缓存的装饰索引；2026-10-27 起按页加载并携带泳道游标，
  同日改为从全部分支、远端跟踪分支、标签、HEAD 与贮藏遍历，2026-10-29 改为精确的 `--date-order`，结果表的 graph 行
  来自改完后的那次运行，git 一侧是 GitLens 提交图的 `log --date-order --all`）。
- Desktop 一侧直接起系统 git（不经过本项目封装），参数照搬 `Vendor/desktop`：
  - status：`git --no-optional-locks status --untracked-files=all --branch --porcelain=2 -z`（`app/src/lib/git/status.ts` `getStatus`）
  - history：`git log --date=raw --max-count=100 [--skip=2000] -z --format=<createLogParser 字段> --no-show-signature --no-color --`（`app/src/lib/git/log.ts` `getCommits`）
  - 带修订号的 history：同一条命令加附加参数与 `--end-of-options <rev>`，三种形状对应 Desktop 的
    `getCommit`（单个 SHA、1 条）、`git-store` 的 `upstream..branch` 和无上游时的 `HEAD --not --remotes`；
    范围下界有 `origin/main` 时用它，否则用 `HEAD~5` 的 SHA（Desktop 检出没有 `origin/main`）
  - ahead-behind：Desktop `getAheadBehind` 的 `git rev-list --left-right --count <range 的 ... 形式> --`，
    GitCub 一侧是 `history::left_right_counts`（分支比较列表对每个分支各调一次）
  - lfs-state：GitCub `lfs::state`（选中仓库和每次 Git 操作后都会调用）对 Desktop `isUsingLFS` 的
    `git lfs track --json`（Desktop 只在添加仓库时调用；git-lfs 内部还会再起十来个 git 进程）
  - branch-details：GitCub `branch::list`（分支详情、上游与 PR 目标；原生菜单、分支策略、推送前都会调用）
    对 Desktop `getBranches` 的 `for-each-ref`（`for-each-ref.ts`）；计时前先断言进程内记录与 GitCub 原来的
    `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream)…` 去掉 symref 行后逐字节相同
  - local-config：Desktop `getConfigValue(repository, key, true)` 的 `git config -z --local user.name`
    （打开仓库时读本地身份），GitCub 一侧是 `git_config::get`
  - stashes：Desktop `getStashes`（`app/src/lib/git/stash.ts`，每次刷新都调用）的
    `git log -g --format=%gD%x00%H%x00%gs%x00%T%x00%P refs/stash --`，GitCub 一侧是 `ops::stashes`；
    合成仓库用 `stash create` 与 `stash store` 放 3 条（不动工作区），两个真实仓库没有贮藏，测的是空列表
  - remotes：Desktop `getRemotes`（`app/src/lib/git/remote.ts`，`_refreshRepository` 每次刷新都调用）的
    `rev-parse --git-dir`、`config --null --get-regexp ^remote\..+\.url$` 与每个远端一次 `ls-remote --get-url`，
    GitCub 一侧是 `remote_ops::list`；origin-url 是 GitCub 每次刷新读 origin 的 `remote_ops::get_url`
    对 `git remote get-url -- origin`。两侧结果在计时前先断言相同
  - commit-files：Desktop `getChangedFiles`（`app/src/lib/git/log.ts`）的 `git log -C -M -m -1 --first-parent --raw
    --numstat -z <sha> --`，只数 raw 记录。commit-files 是 HEAD 那个提交；commit-files-recent 是最近 20 个提交逐个
    选中（History 里点一串提交的样子），比单个提交更能代表快速路径作答与让位的混合。计时前先断言进程内结果与
    `commit_files_via_git` 解析出的列表相同，并对最近 200 个提交逐个比对；能在进程内作答的提交还把 raw 段与
    numstat 段的完整输出与 git 逐字节对照（git 一侧设 `GIT_NO_LAZY_FETCH=1`，缺 blob 时跳过而不是去网络上取）
  - commit-file-diff / commit-file-diff-recent：Desktop `getCommitDiff`（`app/src/lib/git/diff.ts`）的
    `git log <sha> -m -1 --no-show-signature --first-parent --patch-with-raw --format= -z --no-color -- <file> [<oldPath>]`，
    文件取该提交文件列表里的第一个（选中提交时默认选中的那个）；commit-file-diff 是 HEAD，recent 是最近 20 个提交。
    计时前对最近 200 个提交逐个断言进程内字节与 git 输出相同
  - blob-read：Desktop `getBlobContents`（`app/src/lib/git/show.ts`，图片预览、语法高亮取两侧内容）的
    `git show <rev>:<file>`，文件取 HEAD 文件列表里第一个仍存在的文件；计时前断言 `<sha>` 与 `<sha>^` 两侧的
    进程内字节与 git 输出相同
  - history 第一页（刚移动过一个分支）：提交、fetch 之后的第一页历史。被测仓库不能写，所以在临时目录里照搬它的 `HEAD`、
    `packed-refs` 与 `refs/` 树（松散文件保持松散），对象经 alternates 借用；每次计时前（不计时）把一个分支在 HEAD 与
    HEAD~1 之间来回移动，两侧都在移动之后计时，命令同 history 第一页
  - 报告里另有 `refs_breakdown`（脚本输出的 refs phase 表）：打开仓库、`references().all()` 与只遍历 `refs/heads/`、
    `refs/remotes/` 的对比、逐个读松散文件（串行与 4 线程）、只 stat、`branch::records_in_process` / `branch::list`、
    引用索引命中与整表重建；`benchmark --refs-only` 只跑这一组
  - tag-index：GitCub `history::tag_index`（翻页时给提交挂标签的那张表）对 Desktop `tag.ts` `getAllTags` 的 `git show-ref --tags -d`
  - working-diff / working-diff-new：Desktop `getWorkingDirectoryDiff`（`app/src/lib/git/diff.ts`，选中工作区文件时调用）的
    `git diff --no-ext-diff --patch-with-raw -z --no-color HEAD -- <file>` 与新文件的 `--no-index -- /dev/null <file>`，
    GitCub 一侧是 `raw_diff::working_directory_diff`（进程内快速路径，见解读）。计时前先断言进程内字节与 git 输出相同、
    `working_directory_diff` 的文本与 git 输出相同。合成仓库用第一个有改动的跟踪文件和第一个未跟踪文件；两个真实仓库
    工作区干净、没有未跟踪文件，测的是「内容与 HEAD 相同」的空 diff，只有 working-diff 一行
  - blame / blame-sample：Desktop `getBlame` 的 `git blame --porcelain -- <file>`（工作区版本，带 `Not Committed Yet`
    假提交），GitCub 一侧是 `blame::blame`（进程内 `blame_engine`，不能保证一致时让位给同一条 git 命令，见解读）。
    blame 是 `tracked` 那一个文件，blame-sample 是下面 8 个抽样文件合计。计时前对这 9 个文件分别按 HEAD
    （`blame --porcelain HEAD --`）与工作区两种形状断言进程内输出与 git 逐字节相同（工作区形状比较前把两侧
    `author-time`/`committer-time` 的「现在」抹平），结果与让位原因记在报告的 `blame_engine` 里
  - blame-old：同一条命令对 4 个「老文件」合计。老文件的选法（`benchmark.rs` `old_files`）：一次
    `git -c core.quotePath=false log --format=%x01 --name-only --no-renames HEAD` 按遍历顺序记下每个路径第一次出现
    （即最后一次改动）的位置，跟踪文件按这个位置从最旧到最新排序（同位置按路径），每个目录只取一个（同一次导入的
    文件历史形状相同），跳过进程内 blame 在 HEAD 形状下会让位的，取前 4 个。这些文件很早加入、之后几乎没改过：
    blame 要沿几万个提交逐个确认路径没变、几乎不做 diff，是路径查找最重的形状。它们也并入上面的逐字节断言
    （每个仓库 13 个文件 × 两种形状共 26 份输出）。
  - 报告里另有 `blame_breakdown`（脚本输出的 old-file blame 表）：同样 4 个老文件逐个计时，进程内一侧用
    `blame_engine::porcelain_profiled` 分段——setup（打开仓库、读设置与 commit-graph 过滤器）、lookup（批量与单个的
    路径查找，即读树）、diff（先算与现算的 diff 加读两版 blob）、rename（`find_rename`）、output（`emit_porcelain`）
    和 other（总时间减去各段：优先队列、`get_origin`、属性检查、提交节点与过滤器查询）——并记 origin 数与
    (提交, 路径) 查找数，与 Desktop 的 `git blame --porcelain -- <file>` 交替跑。`benchmark --blame-only
    [--blame-file <f>]… [--blame-revision <rev>]` 只跑这一组
  - blame-gix-candidate（未上线，只为评估，对照用）：gix 自带的 gix-blame（`Repository::blame_file`，Myers、默认整文件重命名跟踪）
    对 `git blame --porcelain HEAD --`。按 `ls-files` 等距取 8 个两侧都能离线完成的文件（git 一侧设
    `GIT_NO_LAZY_FETCH=1`，blobless 克隆缺历史 blob 时失败而不是走网络），计时前逐行比对（提交、原始行号、原始路径），
    不一致的文件数与行数记在报告的 `blame_gix_candidate` 里
  - open-repository：热缓存下打开仓库要做的四件事串起来（分支列表、状态、第一页历史、远端列表），
    Desktop 一侧是 `for-each-ref`（`for-each-ref.ts` 字段）、status、log、`git remote -v` 四个进程
  - file-history / file-history-second-page / file-history-second-page-rewalk / file-history-third-page /
    file-history-full：History 的「查看文件历史」，GitCub 一侧是 `file_history::file_history`（一页 100 条，
    多取一条判断 hasMore）与 `file_history::follow`。second-page / third-page 和前端一样带着上一页返回的续走游标
    （翻到那一页之前的几页不计时），second-page-rewalk 不带游标、按前 skip+limit+1 条从 HEAD 重走（游标之前的做法，
    也是游标失效时的回退），两行在同一次运行里比。Desktop 没有文件历史，
    git 一侧照搬 GitLens `getLogForPath` → `getLogCore`（`packages/git-cli/src/providers/commits.ts`）的原样命令：
    `git -c log.showSignature=false -c diff.renameLimit=0 log --format=<GitLens 字段> --numstat --raw -M --use-mailmap
    --no-merges -n101 --follow -- <file>`；第二、三页是 GitLens「加载更多」的 `<上一页最后一个提交>^ -- <它的原路径>`
    （历史不够两页、三页的不测）；full 对照 GitCub 回退用的同参数 git 命令（Desktop 提交格式）。文件取最近 200 个
    非合并提交里改得最多的跟踪文件（2026-10-28 文件历史游标那次运行：Desktop 检出 `app/package.json`，1 228 个提交；
    Homebrew `Library/Homebrew/test/formula_installer_spec.rb`，145 个提交）。计时前断言进程内全量与 git 逐字节相同，
    带游标逐页翻到底（最多 50 页）每一页和 hasMore 都与 git 全量的对应切片相同，前三页再与不带游标的从头走相同
- git 一侧只计进程启动、执行和读完输出，不含 dugite 的 JavaScript 解析，因此是 Desktop 耗时的**下界**；
  表中的倍数是保守值。
- 两侧结果数量（文件数、提交数）一并记录在报告里，保证比的是同样的工作量。
- `scripts/synthetic-repository.ts`（`bun run bench` 与 `bun run bench:app` 共用）用一条 `git fast-import` 流生成确定性的合成仓库：50 000 个跟踪文件、201 次提交，
  工作区含 100 个已暂存、200 个未暂存改动、300 个未跟踪文件和 20 个删除，
  `refs/remotes/origin/main` 指向 `main~5`。真实仓库通过命令行参数传入。
- 同一脚本再生成一个停在合并冲突里的仓库：5 000 个跟踪文件、10 次提交，30 个带冲突标记的文本冲突、
  2 个二进制冲突和 1 个 `merge=binary` 冲突（`deps.lock`），对面分支另改了 200 个不冲突的文件。冲突两行只在
  有冲突的仓库里测：
  - conflict-details：Desktop `getBinaryPaths`（`app/src/lib/git/diff.ts`）的 `git diff --numstat -z <MERGE_HEAD>` 加
    `git check-attr --stdin -z merge`，以及 `getFilesWithConflictMarkers`（`diff-check.ts`）的 `git diff --check`，
    三个进程；GitCub 一侧是 `status::conflict_details`。计时前断言冲突路径上的二进制集合与标记数和这三条命令一致
  - conflict-stage-read：`getResolutionDiff` 预览「用我们的」时的 `git show :2:<file> --`，取第一个冲突文件

## 结果（2026-10-29）

机器：Apple M4 Pro（Mac16,11）、24 GB、macOS 27.2、git 2.54.0（Apple Git-157）、rustc 1.99.1。
下面四张表和两个真实仓库的老文件 blame 分段全部来自 2026-10-29 18:20 的同一次
`bun run bench -- test-results/bench-repos/desktop /opt/homebrew`（main 提交 3812f18，脚本先在本机 release 构建
`benchmark` 示例再运行；每项 10 次，中位数，单位 ms；倍数 = git CLI ÷ GitCub）。启动时 load 3.3（1 分钟），
运行期间机器上另有 Spotlight 索引与别的任务，load 升到 9 到 10，所以绝对值只和同一行的另一侧比。
两侧在同一次运行里交替执行同样的工作量。只有四张表里的三行 graph 行来自同日 20:10 的另一次运行（提交图顺序改为
`--date-order` 之后，引擎提交 abc392e，同一条命令，启动时 load 3.2）：graph 的 git 一侧从那次起改为 GitLens 提交图的
命令形状 `log --date-order --exclude=refs/pull/* --all`（Desktop 的输出格式），两侧遍历同一组引用、排同一种序；
「第一页冷」每次先丢掉缓存的整条序列再取第一页，就是打开仓库后第一次看 History 标签页的开销。其余各行仍是 18:20 那次。

### 合成仓库 — 201 次提交，50 000 个跟踪文件，603 处改动，无标签，3 条贮藏，origin/main 落后 5 个提交

| 负载 | GitCub | git CLI | 倍数 |
|---|---:|---:|---:|
| status（未跟踪缓存冷） | 40.8 | 89.6 | 2.20× |
| status（未跟踪缓存热） | 34.4 | 88.4 | 2.57× |
| history 第一页（100 条） | 2.4 | 15.0 | 6.2× |
| history 第一页（刚移动过一个分支） | 3.1 | 14.5 | 4.7× |
| History 标签页第一页冷（graph，整条序列重排） | 1.3 | 13.8 | 10× |
| History 标签页一页（graph，100 条） | 0.9 | 14.1 | 16× |
| history 深翻页（skip 2000） | 0.8 | 12.2 | 15× |
| History 标签页翻到第 2000 行（graph） | 0.8 | 12.7 | 16× |
| history 单个提交（getCommit，1 条） | 0.5 | 12.8 | 27× |
| history 本地提交范围（upstream..branch） | 1.3 | 14.9 | 12× |
| history 未推送提交（HEAD --not --remotes） | 1.2 | 14.8 | 13× |
| ahead-behind（getAheadBehind，A...B） | 1.0 | 13.4 | 13× |
| lfs-state（打开仓库与每次 Git 操作后） | 38.2 | 109.1 | 2.86× |
| branch-details（分支与上游，对 getBranches） | 0.4 | 11.8 | 28× |
| local-config（config --local user.name，打开仓库） | 0.2 | 10.4 | 58× |
| stashes（getStashes，每次刷新） | 0.4 | 12.5 | 34× |
| remotes（getRemotes，每次刷新） | 0.2 | 32.1 | 199× |
| origin-url（remote get-url origin，每次刷新） | 0.2 | 12.0 | 73× |
| commit-files（HEAD 那个提交） | 0.7 | 14.3 | 20× |
| commit-files-recent（最近 20 个提交逐个选中） | 16.2 | 281.3 | 17× |
| commit-file-diff（HEAD 的第一个文件） | 3.9 | 12.5 | 3.2× |
| commit-file-diff-recent（最近 20 个提交各自的第一个文件） | 82.7 | 232.9 | 2.82× |
| blob-read（git show rev:path，HEAD 的第一个文件） | 0.4 | 11.8 | 31× |
| tag-index | 0.2 | 11.6 | 48× |
| blame-gix-candidate（gix-blame，未上线，8 个抽样文件合计） | 121.7 | 130.9 | 1.08× |
| working-diff（工作区选中文件的 diff） | 4.2 | 14.6 | 3.5× |
| working-diff-new（未跟踪文件的 diff） | 3.8 | 11.9 | 3.2× |
| blame（`tracked` 那个文件，工作区版本） | 8.9 | 17.3 | 1.94× |
| blame-sample（8 个抽样文件合计，工作区版本） | 71.2 | 161.2 | 2.26× |
| blame-old（4 个老文件合计，工作区版本） | 34.4 | 69.8 | 2.03× |
| file-history（文件历史第一页，100 条） | 3.1 | 28.9 | 9.4× |
| file-history-full（文件全部历史） | 3.0 | 29.0 | 9.7× |
| open-repository | 41.1 | 126.8 | 3.1× |

### 合并冲突中的仓库（脚本生成）— 10 次提交，5 070 个文件，33 个冲突路径，MERGE_HEAD 存在

| 负载 | GitCub | git CLI | 倍数 |
|---|---:|---:|---:|
| status（未跟踪缓存冷） | 9.0 | 19.5 | 2.17× |
| status（未跟踪缓存热） | 8.6 | 19.8 | 2.31× |
| history 第一页（100 条） | 1.1 | 12.0 | 11× |
| history 第一页（刚移动过一个分支） | 1.7 | 13.8 | 8.1× |
| History 标签页第一页冷（graph，整条序列重排） | 1.0 | 13.1 | 13× |
| History 标签页一页（graph，100 条） | 0.9 | 11.7 | 12× |
| history 深翻页（skip 2000） | 1.1 | 12.0 | 11× |
| History 标签页翻到第 2000 行（graph） | 1.0 | 10.6 | 10× |
| history 单个提交（getCommit，1 条） | 1.1 | 11.9 | 11× |
| history 本地提交范围（upstream..branch） | 1.1 | 11.6 | 10× |
| history 未推送提交（HEAD --not --remotes） | 1.1 | 11.9 | 11× |
| ahead-behind（getAheadBehind，A...B） | 0.8 | 11.5 | 15× |
| lfs-state（打开仓库与每次 Git 操作后） | 3.8 | 68.0 | 18× |
| branch-details（分支与上游，对 getBranches） | 0.8 | 10.9 | 14× |
| local-config（config --local user.name，打开仓库） | 0.4 | 10.2 | 27× |
| stashes（getStashes，每次刷新） | 0.4 | 10.1 | 26× |
| remotes（getRemotes，每次刷新） | 0.4 | 20.4 | 57× |
| origin-url（remote get-url origin，每次刷新） | 0.4 | 10.4 | 28× |
| commit-files（HEAD 那个提交） | 0.9 | 12.9 | 15× |
| commit-files-recent（最近 20 个提交逐个选中） | 9.6 | 157.4 | 16× |
| commit-file-diff（HEAD 的第一个文件） | 1.5 | 13.2 | 8.6× |
| commit-file-diff-recent（最近 20 个提交各自的第一个文件） | 16.5 | 132.6 | 8.1× |
| blob-read（git show rev:path，HEAD 的第一个文件） | 0.7 | 12.3 | 17× |
| tag-index | 0.4 | 12.4 | 30× |
| blame-gix-candidate（gix-blame，未上线，8 个抽样文件合计） | 11.7 | 107.5 | 9.2× |
| working-diff（工作区选中文件的 diff，冲突文件） | 1.7 | 14.3 | 8.6× |
| conflict-details（冲突文件的二进制判定与标记数） | 4.6 | 53.3 | 12× |
| conflict-stage-read（git show :2:<file>） | 1.0 | 12.2 | 12× |
| blame（`tracked` 那个文件，工作区版本） | 2.9 | 13.7 | 4.7× |
| blame-sample（8 个抽样文件合计，工作区版本） | 21.7 | 115.8 | 5.3× |
| blame-old（4 个老文件合计，工作区版本） | 11.6 | 60.5 | 5.2× |
| file-history（文件历史第一页，100 条） | 1.3 | 14.3 | 11× |
| file-history-full（文件全部历史） | 1.3 | 15.0 | 12× |
| open-repository | 13.2 | 57.6 | 4.4× |

### GitHub Desktop 源码检出（c3a5c51ea）— 40 388 次提交，2 615 个文件，689 个标签，1 个 pack，完整单分支克隆（691 个松散引用，未打包），3 个子模块（未初始化），工作区干净

| 负载 | GitCub | git CLI | 倍数 |
|---|---:|---:|---:|
| status（未跟踪缓存冷） | 16.5 | 33.9 | 2.06× |
| status（未跟踪缓存热） | 3.5 | 34.1 | 9.7× |
| history 第一页（100 条） | 3.3 | 32.6 | 9.9× |
| history 第一页（刚移动过一个分支） | 7.3 | 35.0 | 4.8× |
| History 标签页第一页冷（graph，整条序列重排） | 10.2 | 33.1 | 3.2× |
| History 标签页一页（graph，100 条） | 2.7 | 33.4 | 13× |
| history 深翻页（skip 2000） | 3.8 | 27.7 | 7.3× |
| History 标签页翻到第 2000 行（graph） | 2.7 | 33.1 | 12× |
| history 单个提交（getCommit，1 条） | 2.3 | 24.2 | 11× |
| history 本地提交范围（upstream..branch） | 2.2 | 25.0 | 11× |
| history 未推送提交（HEAD --not --remotes） | 3.0 | 25.3 | 8.4× |
| ahead-behind（getAheadBehind，A...B） | 2.3 | 13.8 | 6.0× |
| lfs-state（打开仓库与每次 Git 操作后） | 17.7 | 90.5 | 5.1× |
| branch-details（分支与上游，对 getBranches） | 0.4 | 12.7 | 34× |
| local-config（config --local user.name，打开仓库） | 0.2 | 11.5 | 61× |
| stashes（getStashes，每次刷新） | 0.2 | 12.2 | 64× |
| remotes（getRemotes，每次刷新） | 0.2 | 37.4 | 231× |
| origin-url（remote get-url origin，每次刷新） | 0.2 | 12.4 | 79× |
| commit-files（HEAD 那个提交） | 0.6 | 14.1 | 22× |
| commit-files-recent（最近 20 个提交逐个选中） | 12.9 | 267.7 | 21× |
| commit-file-diff（HEAD 的第一个文件） | 1.0 | 13.3 | 13× |
| commit-file-diff-recent（最近 20 个提交各自的第一个文件） | 21.4 | 256.6 | 12× |
| blob-read（git show rev:path，HEAD 的第一个文件） | 0.6 | 13.1 | 22× |
| tag-index | 1.7 | 24.4 | 14× |
| blame-gix-candidate（gix-blame，未上线，8 个抽样文件合计） | 1919.2 | 943.2 | 0.49× |
| working-diff（工作区选中文件的 diff） | 1.0 | 14.7 | 15× |
| blame（`tracked` 那个文件，工作区版本） | 2.6 | 14.5 | 5.6× |
| blame-sample（8 个抽样文件合计，工作区版本） | 193.5 | 924.5 | 4.8× |
| blame-old（4 个老文件合计，工作区版本） | 58.3 | 179.9 | 3.1× |
| file-history（文件历史第一页，100 条） | 9.6 | 34.4 | 3.6× |
| file-history-second-page（文件历史第二页，接着游标） | 4.2 | 34.3 | 8.2× |
| file-history-second-page-rewalk（第二页，不带游标从头走） | 9.7 | 33.9 | 3.5× |
| file-history-third-page（文件历史第三页，接着游标） | 8.2 | 35.6 | 4.3× |
| file-history-full（文件全部历史） | 53.7 | 176.4 | 3.3× |
| open-repository | 34.6 | 112.9 | 3.3× |

老文件 blame 分段（同一次运行，`blame_breakdown`，中位数 ms；分段含义见「方法」）：

| 老文件 | GitCub | git CLI | 倍数 | setup | lookup | diff | rename | output | other | origin 数 | 路径查找数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `app/styles/mixins/_ellipsis.scss` | 12.0 | 45.9 | 3.8× | 2.8 | 4.1 | 0.1 | 0.7 | 0.02 | 4.2 | 5654 | 5663 |
| `app/test/fixtures/test-repo/_git/HEAD` | 10.9 | 45.6 | 4.2× | 2.8 | 3.9 | 0.0 | 0.1 | 0.01 | 4.1 | 5625 | 5629 |
| `app/test/fixtures/test-repo/_git/info/exclude` | 11.2 | 44.5 | 4.0× | 2.9 | 4.0 | 0.0 | 0.1 | 0.01 | 4.1 | 5625 | 5628 |
| `app/test/fixtures/test-repo/_git/objects/7c/d6640e5b6ca8dbfd0b33d0281ebe702127079c` | 11.0 | 45.8 | 4.2× | 2.9 | 3.9 | 0.0 | 0.1 | 0.01 | 4.1 | 5625 | 5629 |

### Homebrew 安装目录仓库（2833c25c11）— 53 371 次提交，3 449 个文件，543 个标签，3 个 pack 加 multi-pack-index，工作区干净

| 负载 | GitCub | git CLI | 倍数 |
|---|---:|---:|---:|
| status（未跟踪缓存冷） | 8.0 | 29.4 | 3.7× |
| status（未跟踪缓存热） | 3.4 | 28.9 | 8.6× |
| history 第一页（100 条） | 2.8 | 18.0 | 6.4× |
| history 第一页（刚移动过一个分支） | 4.1 | 18.2 | 4.4× |
| History 标签页第一页冷（graph，整条序列重排） | 13.0 | 31.7 | 2.4× |
| History 标签页一页（graph，100 条） | 1.8 | 31.8 | 17× |
| history 深翻页（skip 2000） | 3.3 | 18.3 | 5.5× |
| History 标签页翻到第 2000 行（graph） | 1.7 | 31.0 | 18× |
| history 单个提交（getCommit，1 条） | 0.6 | 14.8 | 26× |
| history 本地提交范围（upstream..branch） | 0.6 | 15.3 | 24× |
| history 未推送提交（HEAD --not --remotes） | 0.9 | 15.0 | 17× |
| ahead-behind（getAheadBehind，A...B） | 0.9 | 12.8 | 14× |
| lfs-state（打开仓库与每次 Git 操作后） | 8.7 | 86.1 | 9.9× |
| branch-details（分支与上游，对 getBranches） | 0.5 | 12.1 | 24× |
| local-config（config --local user.name，打开仓库） | 0.2 | 11.6 | 63× |
| stashes（getStashes，每次刷新） | 0.2 | 10.7 | 55× |
| remotes（getRemotes，每次刷新） | 0.2 | 34.3 | 212× |
| origin-url（remote get-url origin，每次刷新） | 0.2 | 11.0 | 64× |
| commit-files（HEAD 那个提交） | 0.5 | 12.5 | 23× |
| commit-files-recent（最近 20 个提交逐个选中） | 11.7 | 260.2 | 22× |
| commit-file-diff（HEAD 的第一个文件） | 0.9 | 12.7 | 14× |
| commit-file-diff-recent（最近 20 个提交各自的第一个文件） | 20.9 | 269.2 | 13× |
| blob-read（git show rev:path，HEAD 的第一个文件） | 0.4 | 12.2 | 33× |
| tag-index | 0.3 | 13.6 | 43× |
| blame-gix-candidate（gix-blame，未上线，8 个抽样文件合计） | 1640.2 | 969.0 | 0.59× |
| working-diff（工作区选中文件的 diff） | 1.1 | 16.6 | 16× |
| blame（`tracked` 那个文件，工作区版本） | 7.8 | 21.3 | 2.73× |
| blame-sample（8 个抽样文件合计，工作区版本） | 208.9 | 1007.5 | 4.8× |
| blame-old（4 个老文件合计，工作区版本） | 195.1 | 1098.9 | 5.6× |
| file-history（文件历史第一页，100 条） | 46.7 | 175.6 | 3.8× |
| file-history-second-page（文件历史第二页，接着游标） | 88.0 | 319.8 | 3.6× |
| file-history-second-page-rewalk（第二页，不带游标从头走） | 131.8 | 321.8 | 2.44× |
| file-history-full（文件全部历史） | 131.6 | 474.7 | 3.6× |
| open-repository | 12.2 | 70.2 | 5.8× |

老文件 blame 分段（同一次运行）：

| 老文件 | GitCub | git CLI | 倍数 | setup | lookup | diff | rename | output | other | origin 数 | 路径查找数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `Library/Homebrew/shims/super/c++` | 43.9 | 236.4 | 5.4× | 4.7 | 21.2 | 0.0 | 1.0 | 0.02 | 17.1 | 23081 | 23089 |
| `Library/Homebrew/test/support/fixtures/bottles/testball_bottle-0.1.el_capitan.bottle.tar.gz` | 44.8 | 266.3 | 5.9× | 5.3 | 23.4 | 0.0 | 1.0 | 0.01 | 14.9 | 17574 | 17588 |
| `Library/Homebrew/test/support/fixtures/cask/AppWithBinary.zip` | 42.7 | 250.6 | 5.9× | 5.2 | 22.1 | 0.0 | 1.4 | 0.01 | 13.7 | 15710 | 15745 |
| `Library/Homebrew/test/support/fixtures/mach/a.out` | 53.7 | 318.1 | 5.9× | 5.2 | 30.0 | 0.0 | 1.0 | 0.02 | 17.9 | 23413 | 23429 |

这次运行的 blame 引擎断言：四个仓库各 13 个文件 × 两种形状共 52 份输出全部与 git 逐字节相同，0 次让位。
gix-blame 候选行的归属比对：合成与冲突仓库全部相同，Desktop 检出 1 个文件 1 183 行、Homebrew 1 个文件 152 行与 git 不同。

### 一个私有仓库（更早的一次运行，未含带修订号的三行、ahead-behind、lfs-state、branch-details、local-config、贮藏与远端两行） — 14 917 次提交，4 121 个文件，75 个标签，9 个 pack 加 multi-pack-index，131 个松散对象，工作区干净

| 负载 | GitCub | git CLI | 倍数 |
|---|---:|---:|---:|
| status | 16.2 | 27.4 | 1.69× |
| history 第一页 | 1.8 | 12.5 | 7.0× |
| History 标签页一页（graph） | 2.6 | 13.3 | 5.0× |
| history 深翻页（skip 2000） | 2.0 | 12.8 | 6.5× |
| commit-files | 9.9 | 10.1 | 1.02× |
| tag-index | 0.4 | 9.5 | 26× |
| working-diff | 10.1 | 10.0 | 0.99× |
| blame | 18.2 | 19.5 | 1.07× |
| open-repository | 46.9 | 66.0 | 1.41× |

## 解读

- 提交历史翻页是最大差距：gix 直接遍历对象库，没有进程启动和文本格式化。三个真实仓库都带 commit-graph，
  排序日期和父提交从图里读，翻 2000 条和翻第一页一样快。History 标签页实际走的 `graph::graph`（含泳道分配和装饰）
  一页 0.9 到 2.7 ms，和 `query_details` 的快速路径同一量级；graph 行的 git 一侧是 GitLens 提交图的
  `log --date-order --exclude=refs/pull/* --all`（Desktop 的输出格式），Desktop 没有提交图。
  `--date-order` 要先把起点能到的整条序列排完（父提交等所有子提交出完才能出），引擎排一次整条按起点集合缓存：
  第一页冷（含整条排序）Desktop 检出 10.2 ms、Homebrew 13.0 ms（40 388 / 53 371 个提交，日期和父提交全从 commit-graph 读），
  仍比 git 的 `log --date-order -n 100`（33.1 / 31.7 ms，git 有世代号时只把入度算到需要的世代，但进程启动与格式化占大头）快；
  之后每页只取切片，1.8 到 2.7 ms。起点（引用、贮藏）一变就重排一次，所以每次提交、fetch 后第一页多付这 10 到 13 ms。
- `history::query_details` 改成 gix 快速路径后第一次测量反而比 git 慢（Desktop 检出 28.1 对 13.8 ms，
  深翻页 39.6 对 13.6；Homebrew 深翻页 19.5 对 15.3；私有仓库 15.0 对 13.3）。分段计时找到两处：
  - `%h` 缩写占 Desktop 检出 27 ms、私有仓库 9 ms：gix 对象库句柄默认在每次前缀查找走完全部索引后重新扫描
    `objects/pack` 目录（Desktop 检出 39 个 pack、156 个文件），一页 100 个提交就是 100 次扫描；私有仓库还要
    逐个遍历松散对象目录。现在每次调用只在首次访问时扫描一次（`refresh_never`），和 git 一个进程只准备一次
    pack 列表相同；缩写降到 0.1 到 0.6 ms。
  - 排序遍历给跳过的 2000 个提交也解码对象，占 Desktop 检出 9 ms、Homebrew 12 ms、私有仓库 6 ms。现在和
    git 的 `parse_commit_in_graph` 一样，在 commit-graph 里的提交只取图里的 34 位时间戳和父提交，只有返回的
    100 条才解码；图之后新增的提交仍读对象，`core.commitGraph=false` 时整条路径读对象。
- 现在每页剩下的开销（Desktop 检出）：打开仓库 0.4 ms，首次访问对象库并加载 39 个 pack 索引约 1 ms
  （`%h` 要在全部索引里确认唯一，git 同样要打开全部 `.idx`），解码 100 个提交 0.5 ms，引用指纹 0.1 ms，
  格式化 0.15 ms。索引加载只能靠跨调用缓存对象库省掉，但那会让 `%h` 在 `git gc` 之后和 git 不一致、
  配置改动也看不到，所以没做。引用指纹在私有仓库（30 个松散引用、11 个目录）是 0.17 ms，只 stat 目录
  能省不到 0.1 ms，但会漏掉原地改写引用文件的情况，保留逐文件指纹。
- 多标签仓库的翻页原本慢 4 倍（Desktop 检出 4.6 ms，Homebrew 4.3 ms，私有仓库 1.0 ms）：每翻一页都把全部标签
  遍历并 peel 一遍，Desktop 检出上这一步占 4.3 ms。装饰索引现在按仓库缓存，以 `packed-refs`、`HEAD` 与
  `refs` 树的修改时间、大小和 inode 做指纹，新建、删除、改写引用、切换分支和 pack-refs 都会失效；表中 tag-index
  行是命中缓存的数值（指纹开销）。同一进程里第一次翻页约 6 ms（含首次加载 pack 索引和建装饰索引），之后 2 ms 左右。
- 带修订号的三种查询（单个提交、`upstream..branch`、`HEAD --not --remotes`）以前每次起一个 git 进程，
  现在快 7× 到 36×；两侧返回的提交数相同（合成仓库 1/5/5，Desktop 检出 1/14/0，Homebrew 1/0/0）。
  有排除端时 git 先用 `limit_list` 求出全部感兴趣的提交再输出（含 SLOP 5 的时钟倒错容忍），快速路径逐步照搬，
  以合成的时钟倒错夹具和四个真实仓库逐字节比对；悬空的远端符号引用、`HEAD~n` 等其余写法让位给 git。
- ahead-behind 以前每个分支起一个 `git rev-list`，现在快 9× 到 16×，计数相同（5/14/0）。
  照 `handle_dotdot_1` 的对称差：gix 求合并基作为排除端，A 带 SYMMETRIC_LEFT 走同一个受限遍历；
  合成夹具里八个引用两两组合、无共同祖先的两条历史，以及五个真实仓库都与 git 的计数一致。
- lfs-state 以前每次都跑 `git lfs version` 和 `git lfs track --json`（约 110 ms，含 git-lfs 内部的
  `config -l`、`ls-files --others`、`check-attr` 等），现在先在进程内确认 git-lfs 会读的属性文件（已跟踪与未忽略的
  `.gitattributes`、`info/attributes`、全局与系统属性文件）都不含 `lfs`，就直接得出「未使用」；含 `lfs` 时才问 git-lfs。
  快 2× 到 10×，剩下的主要是 gix 的未跟踪文件遍历（合成仓库 5 万个文件）。
- 上一轮 status 优化（并行遍历与步骤重叠）测于 2026-10-28 16:51 的另一次 `bun run bench`（合成、冲突、Desktop 检出、Homebrew 同一次运行），
  快 1.6× 到 3.5×；同一次运行里改动前的做法（下面的「previous」阶段）是 65.6 / 12.5 / 42.7 / 12.2 ms，
  现在 55.4 / 11.1 / 21.6 / 8.3 ms。旧、新两个 release 构建在同机交替跑三轮（每轮各 10 次，机器负载 5–9）：
  合成仓库旧 1.52–1.60×、新 1.91–2.37×，Desktop 检出旧 1.17–1.31×、新 1.56–1.75×，Homebrew 旧 2.32–2.43×、新 3.55–3.81×。
  基准里的 status phase 分段表（每段都从新打开的仓库开始）给出改动依据：
  - 合成仓库（5 万个跟踪文件）的关键路径是已跟踪文件的 lstat（单线程 103 ms，6 线程 53 ms，12 线程反而 60 ms），
    目录遍历 37 ms、HEAD 与索引比较 13 ms 和它并行。macOS 内核的 lstat 只能扩到 4–6 个线程，
    gix 默认用全部核心，所以线程数固定为 `min(核数, 6)`。
  - Desktop 检出和 Homebrew 的关键路径是未跟踪文件的目录遍历（gix 单线程，Homebrew 9.2 ms，占整体的大半；
    剖析里 64% 是 `opendir`、19% 是 `getdirentries`）。现在在已跟踪且下面至少有 32 个已跟踪父目录的子树处切分，
    最多 4 个线程并行遍历（`status::untracked::Walk`，Homebrew 9.2 → 6.4 ms）。只发未跟踪文件、不发被忽略文件时
    gix-dir 不会折叠目录，子树的输出只取决于子树本身，所以切分不改变结果；每个子树要重新分类一次根（约 0.1–0.25 ms），
    所以只切大子树。Desktop 检出的遍历受 `app/test/fixtures` 这一棵大子树和内核读目录吞吐所限，并行几乎没有收益。
  - 其余步骤改为与遍历重叠：已跟踪比较在主线程、遍历在另一线程，领先/落后、冲突检查（复用已读的索引，不再重开）
    在等待遍历时完成；HEAD 与上游相同时领先/落后直接返回 0/0。改动前这些步骤串行，Desktop 检出上合计约 4 ms。
  - 结果不变：并行遍历与 gix 单线程遍历逐字相同（基准计时前断言），Rust 测试在带嵌套与否定忽略规则、info/exclude、
    被忽略目录里强制加入的文件、嵌套仓库、符号链接、FIFO、中文路径的夹具与 6 轮随机目录树上，以 1/2/4/8 线程、
    每个目录都切分和默认阈值两种设置，与 gix 单线程遍历和 `git status --porcelain=2 --untracked-files=all` 对照。
    遍历出错时回退到 gix 自己的单线程遍历。
  - 剩余开销：合成仓库剩 lstat，Desktop 检出与 Homebrew 剩目录遍历（`app/test/fixtures` 这类大子树受读目录速度限制），
    后者由下面的未跟踪缓存处理。
- 未跟踪缓存（`src-tauri/src/status/untracked_cache.rs`）：下面的分段来自 2026-10-28 18:16 的
  同一次 `bun run bench`（结果表的冷 / 热两行已换成 2026-10-29 的运行）（机器负载 10–13，另有并行任务在跑基准；18:12 的另一次运行倍数相近：Desktop 检出热 7.5×、Homebrew 热 6.9×）。
  「冷」每次调用前丢掉缓存，等于打开仓库后的第一次调用；「热」先调一次，之后是文件监听触发的那种重复调用。
  - 做法同 git dir.c 的 untracked cache（`valid_cached_dir`），但只存在进程内存，不写 `.git/index` 扩展、不碰用户仓库。
    遍历时 gix-dir 读每个目录之前先记下它的 lstat 签名（dev、inode、mode、nlink、size、mtime 与 ctime 纳秒）、
    `.gitignore` 的 lstat（符号链接再加目标的 stat）、是否含 `.git`；另记索引里该目录整棵子树条目（路径、mode、flags，
    `.gitignore` 加对象 id）的 128 位哈希加和（按 ASCII 小写归并，和 gix 忽略大小写的查找一致），以及遍历报出的直接子项。
    全局输入（`core.excludesFile`、XDG 全局 ignore、`info/exclude` 的内容，完整配置，遍历选项，HOME/XDG 环境）合成一个签名，
    在 gix 构建忽略规则栈之前读，变了就整个作废。
  - 失效规则：目录签名、`.gitignore`、索引子树都没变且不「易变」才复用它的直接子项，子目录逐个校验；目录签名变了，它和父目录都重读
    （子项分类在父目录里做，例如出现 `.git`）；某目录的 `.gitignore` 变了，整棵子树作废；含嵌套仓库或含 `.git` 子目录的目录每次都重读
    （嵌套仓库判定要读 `.git` 内部，目录签名覆盖不到）。重读用同一个 gix-dir 从该目录起遍历，遇到仍有效的子目录不进去、改用记录；
    要重读的起点超过 16 个就整体遍历。racy：签名时间离本次调用开始不到「粒度 + 1 秒」的目录与 `.gitignore` 不可信，下次必定重读
    （参照 git `is_racy_timestamp`）；时钟回拨整体作废。只在 `statfs` 判定为本地 APFS（纳秒）/ HFS+（秒）的卷上启用，
    网络卷、FAT/exFAT 和判断不了的都退回完整遍历；跨设备的目录不信任。缓存只留一个仓库（工作区 + 公共目录 + 索引路径），
    换仓库或出错即丢弃，路径总量超过 64 MiB 不留。
  - 首次调用的成本：整体并行遍历外加每个读过的目录三次 lstat（目录、`.git`、`.gitignore`）和建记录。同一次运行里
    「parallel dirwalk 4 threads」对「untracked cache, cold」：合成仓库 37.1 → 39.1 ms、冲突仓库 4.3 → 4.4 ms、
    Desktop 检出 13.8 → 15.9 ms、Homebrew 7.3 → 9.5 ms（另一次运行 36.2 → 38.7、4.2 → 4.3、14.1 → 15.5、6.4 → 7.3），
    即冷路径多 5–30%。热路径的遍历只剩并行 lstat 所有记录的目录（Desktop 检出 912 个、Homebrew 428 个）：
    6.0 / 1.1 / 2.1 / 1.5 ms。status 总耗时热 4.0–4.5 ms（Desktop 检出）、3.9–4.3 ms（Homebrew），这时关键路径变成
    已跟踪文件的 lstat（约 3 ms）和 HEAD 与索引比较（约 2 ms）。合成仓库与冲突仓库的关键路径本来就是已跟踪文件的 lstat，
    缓存热时总耗时不变（54.6 / 10.6 ms）。
  - 正确性依据：`untracked_cache` 的 11 个 Rust 测试每一步都把缓存结果与不用缓存的并行遍历和
    `git status --porcelain=2 --untracked-files=all` 三方对照，并断言稳定后确实复用了缓存：增删改名文件与目录、空目录、
    改名后把目录 mtime 设回原值（只有 ctime 记下改动）、根与嵌套 `.gitignore` 原地改写 / 新增 / 删除 / 符号链接及其目标改写、
    info/exclude、core.excludesFile（绝对 / 相对路径、换路径、改内容、取消）、add / rm --cached（含整个目录）/ add -f /
    skip-worktree / 提交 / reset、嵌套仓库出现、`.git` 失效、消失、空 `.git`、`.git` 文件、已跟踪目录里的嵌套仓库 HEAD 被删又恢复、
    符号链接与目录互换、已跟踪文件换成目录 / 悬空链接、core.ignoreCase 开关下目录与文件只改大小写、索引里改名、只改配置、
    40 层深目录、按秒截断时间戳（模拟 HFS+）的同一秒内连续改动，以及 150 步随机操作序列。13 个变异（不校验 `.gitignore`、
    不做 racy 判定、不比索引子树、不看易变、子目录变了不重读父目录、不读 info/exclude、只记 excludesFile 路径、目录没变就不查
    `.gitignore`、含 `.git` 的子目录不让父目录易变、`.gitignore` 变了不作废子树、不记配置与选项、嵌套仓库不让父目录易变、
    签名不含 ctime）都至少让一个测试失败。
  - 仍有的风险：正确性建立在「目录条目增删改名必然更新目录 ctime」这一 APFS/HFS+ 语义和系统时钟不大幅回拨上（与 git 的 untracked
    cache 相同的前提）；在别的进程刚好改目录的同一时间粒度内取的签名靠 racy 余量兜底，余量取 1 秒。
- stat 预检、cache-tree 与宽目录切片（`src-tauri/src/status/preload.rs`、`tree_index.rs`、`status.rs` 的 `untracked::Task`）：
  下列分段来自 19:53 那次运行，括号里是 19:56 那次（结果表的 status 行已换成 2026-10-29 的运行）。先测再改，依据如下：
  - git 自己为什么快（`GIT_TRACE2_PERF`，Homebrew）：preload-index 3.3 ms（多线程 lstat 打上 CE_UPTODATE），
    HEAD 与索引的比较只有 0.1 ms，因为 diff-index 信任索引里的 cache-tree（TREE 扩展），根记录和 HEAD 树相同就整棵跳过；
    剩下 12.8 ms 是 read_directory。合成仓库上 preload-index 40–48 ms、diff-index 2.5 ms。
  - 已跟踪比较：gix 的 `index_as_worktree` 每个条目都要 lstat 路径上的每一级目录（防符号链接替换）再 lstat 文件，
    合成仓库 4 线程 66.0 ms（66.0）。改为先做一遍与 git preload-index 同样的 stat 预检：最多 4 个线程按索引顺序分块，
    同一目录的连续条目只确认一次各级目录（逐级 lstat 必须是目录），一个目录里待查条目不少于 16 个时打开目录、用
    `fstatat(AT_SYMLINK_NOFOLLOW)`，否则直接 lstat 全路径；stat 与索引相符（gix 的 `Stat::matches` 与同样的
    trust_ctime / check_stat / use_nsec 选项）、类型与可执行位没变、不 racy、对象不是空 blob（或 size 为 0）的条目算没变，
    其余条目原样组成一个小索引交给 gix，一个都不剩就不调用 gix。skip-worktree、assume-valid、fsmonitor-valid、
    intent-to-add、冲突 stage、gitlink、稀疏索引一律交给 gix。合成仓库 stat 预检 37.6 ms（38.2），
    加上 gix 处理剩下的条目共 39.4 ms（38.6）；冲突仓库 7.3 → 4.7 ms（7.4 → 5.6，200 个 racy 条目留给 gix 读内容）；
    Desktop 检出 3.1 → 2.0 ms（3.6 → 2.9）；Homebrew 3.4 → 1.8 ms（3.6 → 2.6，留给 gix 0 个条目）。
    阈值的依据在分段表里：每目录都打开（从 1 个条目起）Desktop 检出 6.1 ms，从不打开 1.7 ms，合成仓库从不打开 59.3 ms。
    getattrlistbulk 也测过（C 微基准）：合成仓库 50k 文件 4 线程 lstat 39 ms、fstatat 18.7 ms、getattrlistbulk 13.2 ms，
    但它返回目录里的全部条目，Homebrew 这种已跟踪文件稀疏分布在大目录里的仓库上 7.7 ms 对 lstat 1.0 ms，没有采用。
    线程数 8 以上反而变慢（12 线程 48.4 ms），固定为 `min(核数, 4)`。
  - HEAD 与索引：gix `tree_index_status` 先把 HEAD 整棵树展开成一个索引再逐条比较，合成仓库 12.3 ms（12.5）。
    改为照 git diff-index 的做法用 cache-tree：某个目录的记录有效、记录的树 id 与 HEAD 中对应的树相同、记录的条目数与索引里
    该前缀下的条目数相同，就跳过这棵子树；其余树逐层读出与索引条目归并。合成仓库 5.6 ms（5.8，跳过 411 棵树），
    Desktop 检出 2.1 → 0.8 ms，Homebrew 2.5 → 0.6 ms（根记录与 HEAD 相同，一棵树都不读）。
    稀疏索引、有冲突或 intent-to-add 条目、同时有新增与删除（要做改名检测）、配置了复制检测且有新增时整体交给 gix，
    冲突仓库因此不变（1.8 ms）。
  - 宽目录切片：合成仓库 `src` 下 500 个模块目录，原来的切分只能把 `src` 整个交给一个线程，并行遍历 1–8 线程都是 33 ms。
    现在排进队列的目录有至少 64 个已跟踪子目录时切成每线程一片：各片都读这个目录，只进入按名字哈希分给自己的已跟踪子目录，
    目录本身的直接子项与记录只由第 0 片报出。合成仓库 4 线程遍历 24.0 ms（19.4），未跟踪缓存冷 28.7 ms（21.0），
    改动前同机单独测是 33.0 / 37.4 ms；Homebrew 遍历 6.5 → 4.9 ms。
  - 仍是瓶颈：Desktop 检出与 Homebrew 缓存热时总耗时 3.5–3.9 ms 基本没变。分开测时预检 1.8 ms、未跟踪缓存的目录校验
    1.3–1.6 ms，两者并行时争用内核 lstat 吞吐（单独串行跑合计约 3 ms，并行时预检一段就到 3.1 ms），换线程数也不改变。
    合成仓库的瓶颈仍是 5 万次 stat，git 一侧也一样（preload-index 40–48 ms）。
  - 正确性依据：`preload` 12 个测试、`tree_index` 7 个测试。每个预检测试都断言「预检后交给 gix」与「整份索引交给 gix」逐条相同、
    与 `git status --porcelain=2` 的工作区一列相同，以及默认设置与关闭两项优化的 `status` 结果相同；覆盖干净工作区、
    racy 写入（mtime 设到将来、trustctime=false）、同 size 同 mtime 只有 ctime 不同的改写、assume-unchanged / skip-worktree /
    intent-to-add、chmod 与类型变化、core.fileMode=false、已跟踪符号链接、路径上的目录被换成符号链接、CRLF 与 filter 属性、
    子模块与冲突、稀疏检出（非 cone 模式与稀疏索引，后者回退），120 步随机操作序列，以及直接构造的
    intent-to-add / 各 stage / 空 blob / 可执行位 / gitlink / 目录条目。cache-tree 测试与 gix 的完整比较和 git 的暂存一列
    对照：干净时一棵树不读、深层暂存只展开路径上的目录、reset --soft 后记录有效但与 HEAD 不同、没有扩展、各种回退、冲突、
    记录的条目数与索引对不上、150 步随机暂存序列。并行遍历测试与未跟踪缓存测试都加了「每个排进队列的目录都切片」的设置。
  - 变异：预检 11 个变异（不做 racy 判定、不确认各级目录、不比 ctime、不看类型与可执行位、不看 skip-worktree 等标记、
    冲突条目也预检、inode 换算丢失、fstatat 用错名字、去掉空 blob 条件……）中 9 个被测试抓到；「gitlink 也预检」「目录也算没变」
    两个存活，是等价变异：工作区里是目录时 `change_to_match_fs` 与目录判断互为冗余，任一保留都不会放过。cache-tree 10 个变异
    （根 / 子目录记录不比 id、不比条目数、不比 mode、各项回退去掉、索引侧不跳过区间）全部被抓到；宽目录切片 5 个变异
    （其余各片也报子项 / 也记录根目录、未跟踪子目录按哈希分片、不按片过滤、只排一片）全部被抓到。
  - 与 git 的差异：core.checkStat=minimal 时 git 不比 ctime，gix 仍比较 ctime 的秒数，预检沿用 gix 的判定（结果更保守，
    只会多交给 gix 读内容，不会漏报），测试里这一步不与 git 对照。
- 预检与未跟踪缓存共享目录 lstat、冲突时的 cache-tree（`preload.rs` 的 `unresolved_with_dirs`、`untracked_cache.rs` 的
  `check`、`tree_index.rs`）：下列分段来自 2026-10-28 20:38 那次运行，括号里是 20:42 那次；结果表的 status 行是 2026-10-29 的运行。
  - 先测：上一轮的判断是「预检与目录校验并行、争内核 lstat 吞吐」。把两者从已打开的仓库开始分开计时（status 分段表
    `warm:` 各行）：Desktop 检出预检单跑 1.4 ms（2.2）、校验单跑 0.5 ms（0.8）、并跑 3.0 ms（2.9）、先后跑 2.4 ms（3.0）、
    合并 2.5 ms（2.4）；Homebrew 预检 2.4（2.1）、校验 0.3（0.3）、并跑 2.8（2.8）、先后 2.6（2.7）、合并 2.7（2.6）。
    并跑确实比单跑之和还慢，单纯错开（先后跑）收益不稳定。再给 `status::status` 各段打点（临时插桩，300 次中位数）看关键路径：
    主线程是打开与读索引 0.6 ms → 预检 2.9 ms（并跑时被校验拖慢，单跑约 2.3）→ gix 处理剩下的 3 个子模块条目 0.2 ms →
    领先/落后 0.1 ms；遍历线程的校验 1.5 ms 之后还有大小写不敏感查找表 0.3 ms、逐个搬记录 0.2 ms。合并后校验要等预检，
    这 0.5 ms 尾巴会落到关键路径上，所以只合并不够（实测 Desktop 4.1 ms，比不合并的 3.8 ms 还慢）。
  - 改动：预检确认各级目录时把 lstat 结果收集起来（每个目录约一次，Desktop 检出 926 个、Homebrew 457 个），经通道交给
    遍历线程；校验时根目录、未跟踪目录和已有 `.gitignore` 的 lstat 在等的同时做完，索引里有条目的目录等预检送来，
    缺的收到后再自己 lstat；预检没做（稀疏索引、关掉预检、gix 兜底遍历）时发送端被丢掉，校验全部自己 lstat。签名不可信
    的记录照旧直接重读，不等。全部记录都能复用时记录原样留着，不再逐个搬到新表；大小写不敏感查找表只在真要重读目录时建。
    `status::status` 缓存热：Desktop 检出 3.2 ms（3.1），同一次运行里关掉共享 3.9 ms（3.7）；Homebrew 3.0（3.2）对 3.1（3.4）；
    合成仓库 40.9（45.8）对 49.0（45.1）、冲突仓库 8.7（8.4）对 8.8（8.5），这两个仓库的关键路径是 5 万次 stat / 200 个 racy
    条目读内容，两次运行方向不一致，算持平。关掉共享的那一行已经带上「全部复用不搬记录」「按需建查找表」，不是改动前的代码。
  - 仍是瓶颈：缓存热时 Desktop 检出与 Homebrew 的总耗时现在就是预检本身（约 2 ms）加打开、读索引（约 0.6 ms）；Desktop
    检出还有 gix 处理 3 个未初始化子模块条目的 0.2 ms 固定开销。代价：缓存热但有目录要重读时，增量重读要等预检做完才开始
    （以前与预检并行），重读的目录很少时这段很短。
  - HEAD 与索引：索引里有冲突条目时不再整体交给 gix。照 gix `diff::index` 的规则逐条归并：冲突的各个 stage 与
    intent-to-add 条目不报改动，与 HEAD 同一路径的条目对上时一起消耗一次；区间里有这类条目的目录不按记录跳过，其余子树
    照常跳过；同时有新增与删除时仍交给 gix 做改名检测。冲突仓库 `tree_index::changes` 1.2 ms（1.1）对 gix 1.9 ms（1.7）；
    冲突仓库的 status 总耗时由预检里 200 个 racy 条目读内容决定，总体倍数 2.16×（2.12×），改动前 2.09×，在噪声范围内。
  - 正确性：`tree_index` 9 个测试与 gix 的完整比较和 `git status --porcelain=2` 的暂存一列对照，新增：七种冲突形状
    （两边都改、两边都加、删对改、改对删、两边改成不同名字、文件对目录、深处冲突加别处的干净改动）各在 merge 与
    cherry-pick 下、再暂存一处修改、刷新索引后对照（42 步里 36 步没交给 gix，共跳过 84 个目录）；冲突中只有删除、
    有新增、新增加删除（仍回退）、解决冲突；随机序列里加入「把路径换成随机几个 stage」（`update-index --index-info`）；
    在内存里构造覆盖冲突条目、条目数也对得上的有效记录（含「删掉别的路径、新路径只有一个 stage」这种跳过就漏报删除的情形）。
    intent-to-add 原来的回退测试改为断言不回退且其余目录照常跳过。未跟踪缓存测试的每次调用在「用预检送来的 lstat」
    「预检没送」「不等预检」之间轮换，另加两个测试：四种方式各自确认没改动时一个目录都不重读、已跟踪与未跟踪目录里改名后把
    mtime 设回（只有 ctime 记下改动）都能发现；同一秒内只改名、按秒截断签名完全相同时由预检送 lstat 也能发现。
  - 变异：18 个，16 个被抓到。cache-tree：相等时不看冲突、新增一侧不跳过冲突、含冲突的目录也跳过、根记录跳过不看冲突、
    只认冲突不认 intent-to-add、只认 intent-to-add 不认冲突、区间判断少算最后一个条目、跳过的冲突仍记作新增（多回退）8 个
    全部被抓到（后两个和第三个最初存活，补了上面的内存构造用例与「冲突中只有删除」一步后被抓到）。共享 lstat：原始 stat
    换算丢 ctime、丢纳秒，目录变了也不查原来不在的 `.gitignore`，收尾只补等预检的目录，预检记成父目录的路径，`.gitignore`
    变了不作废子树，子目录变了不让父目录重读，送来的 lstat 覆盖已有结论，8 个被抓到（丢 ctime、记成父目录最初存活，补了
    固定方式的测试后被抓到）。存活 2 个：「签名不可信的记录也等预检」是等价变异（不可信的记录在判断等不等之前就定为重读，
    多出来的条件已删掉）；「全部复用时不核对能否从根走到每个记录」也是等价的（走不到的记录原来会被丢掉、现在留着，
    结果相同，`build` 保证每个记录都挂在父目录下）。
- 第一次测量时 Desktop 检出上 GitCub 的 status 反而慢一倍（61 ms 对 29 ms）：
  当时 `status::status` 每次都另起 `git rev-list` 算领先/落后，仓库有子模块时还再起一次完整的 `git status`
  取子模块脏法。两处已改为 gix（隐藏起点的 rev walk、gix 自带的子模块状态）。
- 合成仓库的 status 绝对值在两次运行间从 170 ms 变到 78 ms，git 一侧同步从 246 ms 变到 89 ms，
  倍数稳定；5 万个新文件刚生成时系统索引还在扫描，绝对值只能和同一次运行里的另一侧比。
- 工作区 diff 以前每选中一个文件起一个 `git diff`，现在在进程内生成同样的字节：合成仓库 3.3×（改动文件）和
  2.6×（未跟踪文件），两个真实仓库的空 diff 2.4× 和 18×（Desktop 一行在几次运行里是 1.9× 到 5.6×）。补丁正文来自 git v2.54 xdiff 的逐行移植（`src-tauri/src/xdiff.rs`：
  Myers 不带 `--minimal`、`xdl_cleanup_records`、`xdl_change_compact` 的缩进启发、3 行上下文、`def_ff` 函数名与
  `sane_truncate_line` 的 UTF-8 截断），头部照 `builtin_diff` / `fill_metainfo` / `diff_flush_raw`：raw 记录的第二个对象
  按 `ie_match_stat` 判断工作区是否「脏」（`USE_NSEC`、`USE_STDEV` 四种编译组合结论不一致时让位），缩写照
  `odb_find_abbrev_len` 对不在库里的对象同样加长，路径照 `quote_two` 转义。`-w`、重命名、符号链接、子模块、
  模式变化、带特殊标志的索引条目、稀疏索引、会改变转换或驱动的属性（text/crlf/eol/filter/ident/
  working-tree-encoding/diff/binary 与非空的系统属性文件）、`core.autocrlf`/`core.eol`/`core.bigFileThreshold`/
  `core.checkStat`/非默认的 `core.trustctime`、`core.filemode`、`core.fsmonitor`，任何改变输出的 `diff.*` 设置、
  `GIT_DIFF_OPTS` 等环境变量、子目录与 glob 路径、超过 16 MiB 的文件都交给 git。差分测试覆盖 40 多种形状、
  600 次随机对照、四个四万行级的大文件（只有这种规模 `xdl_split` 的蛇形启发才会生效）和前缀冲突的缩写，
  并用变异（改缩进权重、蛇长、代价上限、函数名长度、INVESTIGATE 阈值、U+FFFF 校验）确认测试能抓到偏差。
  剩余开销主要是读索引、属性栈和 pack 索引；真实仓库只测到了空 diff，改动文件的倍数只来自合成仓库。
- 提交文件列表在进程内用 gix 做第一父（根提交为空树）对提交树的递归差异，再照 git v2.54 diffcore-rename 做重命名检测
  （`src-tauri/src/rename.rs`）。Desktop 的 `-C -M` 里 `-M` 在后，diff.c 把检测模式改回 `DIFF_DETECT_RENAME`，
  所以实际只做重命名、从不报复制：目标是新增，来源只有删除。移植的步骤：`find_exact_renames` 按对象 id 配对，
  候选按 git 哈希表链表的顺序遍历（插入逆序、扩容时链表反转，205 个相同来源恰好在最后一次插入时扩容）、同名优先、
  最多看 100 个；`find_basename_matches` 对来源与目标里各自唯一的文件名比较，门槛 75%；剩下的进 4 候选的相似度矩阵
  （`record_if_better` 同分不替换、`score_compare` 同分时同名优先、稳定排序后贪心配对，门槛 50% 含等号）；
  相似度照 `estimate_similarity`：只比普通文件、大小预筛，`hash_chars` 按换行或 64 字节切块、文本里 CRLF 的 CR 不算。
  raw 记录照 `diff_flush_raw` 拼出来交给同一个解析器。让位：目标数 × 来源数超过 1000²（git 放弃模糊检测并警告）、
  配了 `diff.renameLimit`、`GIT_BASENAME_FACTOR` 与 `GIT_CONFIG_*` 等环境变量、要算相似度的路径带 diff/binary/text 等属性
  （文本与否取决于 `diff` 属性）、裸仓库与稀疏索引里需要算相似度、缺对象（部分克隆 git 会去懒加载）、超过 16 MiB、
  子模块，以及原有的浅克隆、`info/grafts`、`refs/replace/*`、`log.showRoot=false` 的根提交、`log.diffMerges`、短 SHA。
  文件与目录互换现在也作答（gix 与 git 一样报一删一增，树序里 `x` 在 `x/…` 前）。
  差分测试把 raw 段的状态与分数、numstat 段的增删行数（`builtin_diffstat`：二进制 `-\t-\t`，对象相同 0/0，重命名的
  `\0旧\0新\0`）整段与 git 逐字节对照：精确/相似/同名优先/多来源并列/目录移动/二进制/CRLF/空文件/符号链接/模式变化/
  类型变化/文件名阶段命中与不命中/41 档相似度梯度/正好 50%/4 候选上限/1000² 边界、200 个随机提交（128 个重命名，
  56 个带修改），以及 Homebrew 最近 1000 个提交全部逐字节一致（24 个含重命名）、Desktop 最近 1000 个提交里 340 个
  完整输出一致、另 657 个 git 自己缺 blob 算不了 numstat 时对照 raw 段解析结果一致（1 个让位，2 个 git 也读不了）。
  变异测试 19 个变异抓到 16 个，剩下 3 个是等价变异：去掉大小预筛（被筛掉的对分数必然低于门槛）、spanhash 乘数
  0x61 改 0x62（只在哈希碰撞时有差别）、numstat 跳过 0/0 修改（不忽略空白时不会出现）。
  最近 200 个提交里快速路径作答从 Desktop 157 个、Homebrew 168 个变成两边都是 200 个（分别含 3 个、5 个重命名提交）；
  HEAD 两个仓库都是「新增加修改」，以前让位，现在 Homebrew 0.95× → 20×，最近 20 个提交 2.6× → 23×；合成仓库 19×。
  Desktop 检出在完整克隆上复测：HEAD 一行 0.81× → 20×，最近 20 个提交 3.1× → 20×。
- 历史里选中文件的 diff 复用工作区 diff 的 xdiff 移植与头部拼装，比较第一父（根提交为空树）与提交里这一个路径：
  Desktop 与 Homebrew 最近 200 个提交的第一个文件全部 200 个由进程内作答且与 git 逐字节相同（Homebrew 含 1 个重命名）。
  Homebrew HEAD 一行 11×，最近 20 个提交 11×，合成仓库 3.2×；冲突仓库 HEAD 的第一个文件是二进制图片，以前让位（0.84×，
  让位前白花约 0.9 ms：打开仓库、读 5 070 条索引、属性栈与两个 blob），现在两侧照 diff.c `builtin_diff` 判定
  （前 8000 字节有 NUL；diff/binary 属性让位）后输出补丁头加 `Binary files <a> and <b> differ`（标签照 `quote_two`，
  新增或删除的一侧是 `/dev/null`，没有 `---`/`+++`），6.7×，最近 20 个提交 4.0× → 7.0×；二进制的重命名仍让位。
  Desktop 检出（完整克隆）HEAD 一行 11×、最近 20 个提交 9.4×。带旧路径时（Desktop 对重命名文件传 `oldPath`）pathspec 只留这两个路径，旧路径被删、新路径新增就是
  一对一的 diffcore-rename：对象相同满分，否则分数只取决于这一对，过 50% 就输出 `similarity index`、`rename from`、
  `rename to`（`quote_c_style`）、对象不同时才有的 index 行与 `a/旧`、`b/新` 标签；没配上（git 分别输出删除与新增）、
  旧路径只是修改、模式变化、二进制、`diff.renames`/`diff.renameLimit`、旧路径带属性都让位。提交没改这个路径
  （带 pathspec 的 `git log -1` 会顺着第一父往前找最近一次改它的提交）、`-w`、符号链接、子模块、目录、超过 16 MiB，
  以及工作区 diff 那一套属性、配置与环境变量检查（另加 `diff.external`、`GIT_EXTERNAL_DIFF`，`git log -p` 会用它们）
  都交给 git。差分测试覆盖 40 多种形状在普通提交、根提交与合并提交里的 diff、600 次随机对照、重命名的 10 种形状与
  150 个随机一删一增（115 个被 git 配成重命名，全部进程内作答且逐字节相同）、`core.quotePath` 与 `core.abbrev`，以及让位的各种形状。
- blob 读取在进程内按 `<完整 SHA 或 HEAD>[^]:<路径>` 找树条目、读对象：Desktop 5.4×，Homebrew 25×，合成仓库 27×。
  `git show` 输出 blob 时只有命令行给了 `--textconv` 才转换（builtin/log.c `show_blob_object`），不做 textconv、
  行尾或 filter 转换；差分测试在配了 textconv、smudge filter、`eol=crlf` 与 `core.autocrlf=true` 的仓库里对照
  `git show` 的字节确认这一点，并覆盖符号链接、空文件、二进制、中文路径、`HEAD`、`^` 与 partial 读取的前缀长度。
  路径不存在、目录、子模块、根提交的 `^`、短 SHA 或其他修订号写法、缺失对象（部分克隆要懒加载）、替换对象、
  浅克隆与移植都交给 git，错误与退出码仍是 git 的。partial 读取命中快速路径时也省掉了先跑的 `rev-parse --verify`。
- 冲突细节以前每次刷新状态起三个进程（`diff --numstat <rev>` 要把工作区和 `<rev>` 整棵比一遍），现在只对
  冲突路径在进程内作答：冲突仓库 12.8×，读索引阶段 9.8×。git 自己算这两件事时，
  diff-index 对冲突路径比较 `<rev>` 里的 blob 与工作区文件（内容相同就被 skip_stat_unmatch 丢掉，任一侧前 8000
  字节有 NUL 就记 `-\t-\t`）；diff-files 对冲突路径只比 stage 2 与工作区（`diff_unmerged_stage` 默认 2，`--check`
  不走 combined diff），builtin_checkdiff 只看新的一侧是否二进制，对每条 `+` 行调用 `is_conflict_marker`
  （默认长度 7，xdiff 给不完整的末行补了换行）。组的上下滑动只在相同的行之间移动，`+` 行的多重集合不变，
  所以 checkdiff 不开缩进启发也不影响条数；`merge` 属性取 gix 属性栈里优先级最高的那条，`Value("binary")`
  才算（宏 `binary` 是 `-merge`，不算）。`<rev>` 里没有这个路径或工作区缺这个文件（新增或删除可能被配成重命名）、
  模式变化、符号链接或子模块、`.gitattributes` 自身冲突、`conflict-marker-size` 和会改变转换或驱动的属性、
  `attr.tree`、`GIT_ATTR_SOURCE`、冲突条目的 stat 恰好与工作区一致、超过 16 MiB，以及工作区 diff 那一套配置检查，
  都让位给原来的三条命令。差分测试覆盖合并、变基（REBASE_HEAD）和弹出贮藏（HEAD）三种冲突，
  modify/delete、delete/modify、add/add、CRLF、不完整的末行、基线里本来就有的标记行、部分解决与全部解决、
  `info/attributes` 与宏，另有 60 个文件 × 9 轮随机改动的对照。冲突仓库里 working-diff 选中的是冲突文件。
- 冲突文件的工作区 diff 以前一律让位（0.92×，让位前白花约 0.6 ms）。Desktop 对冲突文件跑的就是普通的
  `git diff --no-ext-diff --patch-with-raw -z --no-color HEAD -- <file>`：app-store.ts
  `updateChangesWorkingDirectoryDiff` 不区分冲突，diff.ts `getWorkingDirectoryDiff` 里 `Conflicted` 落在 `else` 分支。
  这条命令是 diff-index（不带 `--cached`，也没有 `-c`/`--cc`），不是 combined diff：unpack_trees 把这个路径
  阶段最小的条目交给 `do_oneway_diff`（`find_cache_entry`，其余阶段 `mark_ce_used_same_name`），`show_modified` /
  `show_new_file` 的 `get_stat_data` 拿它的 stat 对工作区做 `ie_match_stat`（preload 跳过有阶段的条目），脏了比工作区
  内容、raw 第二个对象全零，干净时比这个条目的对象。进程内照此作答，同时补上 HEAD 里没有（新增）、索引里没有
  （报 HEAD 一侧删除）、两边都没有（空）三种形状，二进制照 `builtin_diff` 输出；HEAD blob 推迟到确认内容不同之后才读。
  条目带 CE_VALID/skip-worktree（git 改走 `diff_unmerge`）、阶段 0 与冲突阶段并存仍让位。冲突仓库 7.2×（前一次运行 8.8×）。
  差分测试覆盖合并、变基、弹出贮藏、拣选四种冲突里的 modify/delete、delete/modify、add/add、二进制、
  文本对二进制、CRLF、不完整的末行、基线已有标记行、部分解决、全部解决（回到 ours 时输出为空）、删掉工作区文件、
  `git add` 与 `git rm --cached` 之后、`core.abbrev`/`core.quotePath`，以及 stage 1 的 stat 恰好与工作区一致
  （raw 第二个对象变成 stage 1 的对象）；二进制另测 8000 字节边界、需要转义的标签、新增删除与根提交。
  14 个变异（标签的 `/dev/null` 一侧、不转义、少换行、只看一侧的二进制判定、阈值 8001、取最后一个阶段、
  未跟踪与删掉工作区文件的空输出、干净条目的 raw、索引缺失时的删除、新增一侧的 index 行与二进制）全部被抓到。
- blame 改成进程内实现（`src-tauri/src/blame_engine.rs`），照 git v2.54 `blame.c` 自己写，不用 gix-blame。
  上线那次运行（2026-10-28）：blame-sample 在 Desktop 检出 500.3 对 891.1 ms（1.78×），Homebrew 291.9 对 929.7 ms（3.2×），
  合成仓库 2.0×，合并冲突仓库 4.3×。加上 commit-graph 过滤器、逐路径属性检查、异步先算 diff、支链跨批次预取与
  xdiff 共同开头只分类一次之后，2026-10-29 结果表那次运行（GitCub / git CLI 中位数 ms，括号里是倍数）：

  | 仓库 | blame-sample | blame-old | blame（单个文件） |
  |---|---:|---:|---:|
  | Desktop 检出 | 193.5 / 924.5（4.8×） | 58.3 / 179.9（3.1×） | 2.6 / 14.5（5.6×） |
  | Homebrew | 208.9 / 1007.5（4.8×） | 195.1 / 1098.9（5.6×） | 7.8 / 21.3（2.73×） |
  | 合成仓库 | 71.2 / 161.2（2.26×） | 34.4 / 69.8（2.03×） | 8.9 / 17.3（1.94×） |
  | 合并冲突仓库 | 21.7 / 115.8（5.3×） | 11.6 / 60.5（5.2×） | 2.9 / 13.7（4.7×） |

  这次运行里四个仓库各 13 个文件 × 两种形状共 52 份输出全部与 git 逐字节相同，没有让位。
  - 算法：`assign_blame` 的优先队列（提交时间，同时间先入先出）；`pass_blame` 两遍找父提交（同一路径，再对整棵树
    做 diffcore-rename，复用 `crate::rename`），与子提交 blob 相同的父提交整份接手，与更早父提交 blob 相同的跳过；
    `pass_blame_to_parent` 照 `xdi_diff` 先 `trim_common_tail` 再 Myers + 缩进启发（`crate::xdiff`）；
    根提交是 `boundary`；不带修订号时照 `fake_working_tree_commit` 造假提交（父提交是 HEAD，合并中接上 MERGE_HEAD，
    lstat 得到的模式，未合并的文件也照样取工作区内容）；输出照 `emit_porcelain`（`previous`、`MORE_THAN_ONE_PATH`
    时的 `filename`、`core.quotePath`）。
  - 让位（`Err` 交回 `git blame --porcelain -- <file>`）：mailmap、`blame.ignoreRevsFile` 等改变归属的配置、
    改了 diff 算法或缩进启发、会改变工作区内容的属性与 `core.autocrlf` 的 CRLF、filter/ident/working-tree-encoding、
    浅克隆、移植、替换对象、非 UTF-8 提交编码、路径在某个版本里是目录或子模块、工作区与 HEAD 类型不同、
    上级目录是符号链接、稀疏索引、超过 16 MiB 的 blob、缺对象（部分克隆），以及 `crate::rename` 让位的重命名设置。
  - 快的来源（每一步都先加计时找出来，再改）：
    1. 沿第一父链批量预取路径条目（批量 64 起翻倍到 1024），合并提交的其余父链在同一次调用里接着查；
       大批次交给本次调用常驻的线程池（至多 8 线程）分段并行。路径缓存键是（树，路径名编号），重命名不重读整棵树。
    2. 预取后把 `pass_blame` 会做的相邻两版 diff 先算（diff 只取决于两份内容，结果与串行相同）：交给按需启动的
       另一组线程、发出去不等，用到时还没开始的由本线程认领现算（见下面 Desktop 检出 blame-sample 一条）。
    3. 自己解 pack（`src-tauri/src/pack_reader.rs`）：gix 只缓存链末对象，深 delta 链每次都要从链根重新解压；
       现在像 git 的 delta base cache 一样把链上每一级放进按内存限额淘汰的缓存（每个读者 16 MiB）。
       对 Desktop 检出 274 837 个、Homebrew 369 117 个 pack 内对象逐个与 gix 读到的字节对照，全部相同。
    4. xdiff 的行哈希从 SipHash 换成按 8 字节块的乘法哈希，按行切分用 memchr。
  - 验证：差分测试覆盖根提交边界、工作区改动与无末尾换行、CRLF、NUL 与空文件、整文件重命名与复制、
    合并（两侧都改、一侧改名、父提交顺序、整份让给同 blob 的父提交、合并进行中的工作区与冲突文件）、
    同一提交两个路径负责行、时钟回拨、类型变化、删除后重建、尾部裁剪改变滑动位置、路径引号与非 ASCII、
    符号链接与可执行位、属性与行尾，以及随机历史（每轮随机增删改、合并、改名，奇数轮 `repack -f --depth=50`
    让对象走深 delta 链）。真实仓库抽样（被忽略的测试，手动跑）：Homebrew 与 Desktop 检出各等距取 400 个文件，
    HEAD 与工作区两种形状共 1 600 份输出全部逐字节相同，没有让位；合计耗时 Homebrew 23.5 对 91.5 s，
    Desktop 10.8 对 30.7 s（与 git 交替跑，不是 bench 数据，只说明抽样里没有大面积变慢）。
  - 变异测试：对算法与 pack 解码植入 17 处单点错误（不裁尾、父提交倒序、队列反序、delta 偏移错位等），
    15 处被测试杀死。存活的两处是等价变异：队列按时间反序只会让同一提交被多处理几次，每行沿哪条父链、
    每一步 diff 都不变；跳过「与更早父提交 blob 相同」的判断时，后一个父提交拿到的 diff 与前一个相同，分不到行。
  - 过滤器的差分测试（`bloom过滤器与git逐字节一致`，6 轮随机历史，含非 ASCII 路径 `目录é`、改名与合并）：
    版本 1 与 2、把版本 2 的文件头改成 1（非 ASCII 路径上出现漏报）、配置要版本 2 时不用版本 1 的过滤器、
    BDAT 全清零（每个提交都说没变）、`core.commitGraph=false` 与 `readChangedPaths=false`、CDAT 世代号清零配
    `generationVersion=1`、随机清字节与乱写 BIDX（越界、递减）、两层链（正常、上层清零、下层版本不同）、
    commit-graph 之后的新提交；每轮把所有跟踪文件的 HEAD 形状与 git 比对，断言过滤器确实改变了 git 的输出
    （最近一次 115 个文件的输出被错误过滤器改变，全部一致、0 次让位）。另有 t0095 的 murmur3 与过滤器字节向量、
    高位字节路径两个版本的哈希，以及删掉又加回的路径被漏报带进没有它的提交时 git 失败、我们让位的用例。
    对过滤器代码植入 17 处单点错误（版本检查、版本 1 按无符号、越界与递减偏移照用、混合层不停用、不看世代号、
    忽略两个配置、键不乘 hash1、位序反了、任一键改成所有键、改名不加键、按 origin 比而不是按子提交的条目比、
    缓存不随键数失效、子提交缺路径不让位等），15 处被杀死；存活两处是等价的：非第一父提交也查过滤器（第一父
    提交 blob 相同时 git 先把整份交给它）、层内偏移不加基数（那个字段只用于校验，已删掉）。
  - 老文件（2026-10-28 晚，先加 blame-old 与分段再改）：此前「Desktop 夹具 `COMMIT_EDITMSG` 约 92 对 59 ms」
    是抽样比对程序里的单次计时，在 `--blame-only` 下复现不出来：同一时段改动前已是 1.8 到 1.9×。分段显示老文件的
    大头不在读树（lookup），而在 other：每个 origin 进 `get_origin` 都对路径做一次属性检查（`.gitattributes` 栈），
    几万个提交就是几万次。属性只取决于路径，改成每个路径查一次后，Desktop 老文件约 13.8 → 10.2 ms（同一时段
    git 约 40 ms，2.9× → 4×），Homebrew 4.3 到 4.9× → 5.3 到 6.3×。提交节点的父提交改用 commit-graph 位置直接取
    （不在 commit-graph 里的提交仍按对象名查，否则会退回逐个解析提交对象），按对象名做键的表换成 Fx 哈希。
  - commit-graph changed-path Bloom 过滤器：git 的 `find_origin` 在第一父提交上先问 `maybe_changed_path`，过滤器说
    没变就不比树，直接把父提交的 blob 设成子提交的。两个被测仓库都**没有**过滤器：Desktop 检出是单文件
    commit-graph（OIDF、OIDL、CDAT、GDA2 四个块），Homebrew 是三层链，都没有 BIDX/BDAT。git 只在
    `commit-graph write --changed-paths` 或已有的 commit-graph 带过滤器时才写；`gc`、`fetch.writeCommitGraph`、
    `maintenance` 默认都不加，所以普通 Desktop 用户的仓库多半没有，git 在这两个仓库上也是逐个比树——它不是靠
    过滤器快。对照：在借用 Homebrew 对象的临时仓库里写一份带过滤器的 commit-graph（`--reachable --changed-paths`，
    版本 1，k=7），git blame `a.out` 从关掉过滤器（`commitGraph.changedPathsVersion=0`）的 354 ms 降到 25 ms。
    现在 `src-tauri/src/changed_paths.rs` 照 git v2.54 `bloom.c`/`commit-graph.c` 读过滤器：单文件与分层链
    （链文件逐层校验 BASE 与尾部哈希）、`core.commitGraph`、`commitGraph.generationVersion`、
    `commitGraph.readChangedPaths` 与 `changedPathsVersion`（-1 时跟随最上层带设置的层，层间设置不同的停用，
    世代号混用时照 `validate_mixed_generation_chain`）、长度为 0 与越界或递减的 BIDX 偏移不用、世代号为
    `GENERATION_NUMBER_INFINITY` 的提交不查；murmur3 版本 1 照 git 把字节当平台的 `char`（macOS arm64 上有符号，
    高位字节符号扩展），版本 2 无符号；键在重命名时追加来源路径，任一键可能变了就比树。过滤器的结论照 git 原样
    采信：即使过滤器错了（漏报）输出也与 git 相同；漏报把路径带进一个其实没有它的提交、git 会
    `die("internal error in blame::find_origin")` 时让位。有过滤器时预取只查会比较到的提交。`GIT_TEST_COMMIT_GRAPH`、
    `GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`、SHA-256 仓库、没有 commit-graph 但有 alternates 时让位。
    同一个带过滤器的临时仓库，HEAD 形状 4 个老文件（`--blame-only --blame-revision HEAD`，同一次运行交替）：
    `shims/super/c++` 17.5 对 30.1 ms（1.72×）、`AppWithBinary.zip` 21.2 对 53.8（2.54×）、`a.out` 17.8 对 28.2（1.59×）、
    `testball_bottle` 15.3 对 28.6（1.87×）；没有过滤器的同样 4 个文件是 5.4 到 6.3×。过滤器让 git 快了十倍，
    我们只快两到三倍：剩下的约 10 ms 在 other（每个提交仍要经过优先队列和 `pass_blame`，2 万多个 origin），
    setup 约 4 ms 里包括读 4 MB 的 commit-graph。读 alternates 里的 pack 也是这次补上的（`pack_reader::Packs::open`）。
  - Desktop 检出 blame-sample 曾偏低（2026-10-28 两次运行 2.0 到 2.1×，其它仓库 4 到 5×）的原因：8 个文件里 7 个是 3.7 到 5.5×，
    `app/src/lib/stores/app-store.ts` 一个就占 git 一侧约 680 ms 里的大半，单独只有 1.6 到 1.7×。blame 它要做
    4 100 多次 diff（如今 1.1 万行、35 万字节），时间几乎全在 diff：单线程时我们的 diff 一段约 545 ms，git 的整个 blame 约 680 ms，
    每份 diff 的工作量（切行、行分类、Myers）两边相当，只能靠并行先算拉开。Desktop 的历史是大量短分支合并，
    预取每次只碰到一个分支（原来 622 批、平均 6 对 diff），刚发现就要用，并行度上不去。改成：父提交还没查到的
    提交记在父提交名下、查到后再决定要不要先算；先算的 diff 交给按需启动的另一组线程、发出去不等，
    `pass_blame_to_parent` 用到时还没有线程开始的由本线程认领现算。原来先算 3 797 次（每批同步等齐）、
    到时候现算 312 次；现在后台先算约 3 450 次、本线程认领约 700 次，没有重复计算。app-store.ts 同一时段
    1.58 到 1.65× → 1.70 到 1.71×。试过但没有效果、已撤回的：线程按小段轮流领活
    （1.37×，delta 基缓存分散到各线程）、两版内容先在本线程读好再并行算（持平）、xdiff 首尾相同段不查表与
    8 字节一组切行（单线程 diff 段 545 → 555 ms，不变）。
  - 2026-10-29 再改两处（`benchmark --blame-only --blame-file app/src/lib/stores/app-store.ts`，Desktop 完整克隆，
    5 次中位数，同一次运行逐字节断言）：预取的批次在主线上满了时，合并带出来的支链记在 `frontier` 里下一批
    先走，不再等主线程走到它才单独查一小批（`profile.carried` 计数，测试 `大量短分支合并时支链跨批次预取`）；
    xdiff 分类时两份内容逐字节相同的开头每行只分类一次、两边各记一次（类号与 git 先 a 后 b 的顺序相同，
    `共同开头只分类一次与两边完整分类相同` 与原顺序逐条对照），切行改为 8 字节一组找换行。2026-10-29 18:53
    单独一次 `benchmark --blame-only --blame-file app/src/lib/stores/app-store.ts --blame-file app/src/ui/repository.tsx`
    （main 3812f18 的 release 示例，Desktop 完整克隆，10 次中位数，两侧在这一次运行里交替，load 2.8）：
    app-store.ts GitCub 122.2 ms 对 git 638.1 ms（5.2×；分段 setup 3.1、lookup 35.5、diff 54.4、rename 2.4、other 19.7 ms，
    13 211 个 origin、18 233 次路径查找），repository.tsx 21.0 对 81.2 ms（3.9×；lookup 9.2、other 6.1）。
    改动前后没有同一次运行的对比数据，这里只给改动后的两侧同次对比；它与结果表的 blame-sample（含 app-store.ts）
    来自不同的运行，互不换算。
  - 仍不如 git 的地方：没有哪个被测文件比 git 慢；最接近的是有过滤器时的老文件（1.6 到 2.5×）。`-C`/`-M` 行移动与复制检测、`--first-parent`、忽略提交都不在 Desktop 参数里，没有实现。
- gix 自带的 gix-blame 仍**没有采用**：同一次运行 Desktop 检出 0.46×、Homebrew 0.59×，归属也不总与 git 相同
  （2026-10-27 等距 200 个文件的比对：Homebrew 16 个不同，Desktop 检出 2 个不同）。不同的原因有三类：
  xdiff 先 `trim_common_tail` 再 diff（不裁尾滑动位置会变），整文件重命名有多个来源时选源与 diffcore-rename 不同，
  含 NUL 的 blob 被当作二进制；gix-blame 都没有可以接入的点。报告里保留候选行以便升级 gix 后复测。
- 远端读取以前每次刷新起 3 个以上进程（远端列表）加 1 个（origin），现在在进程内照 remote.c 的
  `handle_config`、`add_url`（空值清空）与 `alias_url`（最长 `insteadOf` 前缀，等长取先出现的）读配置，
  快 103× 到 254×（列表）和 20× 到 70×（origin）。`get-url` 只认本仓库或工作树配置里出现过的远端，
  或没有配置 URL 时的旧式 `.git/remotes`、`.git/branches` 文件（`configured_in_repo`），其余都是「没有这个远端」；
  旧式文件、以名字兜底的 URL、空值或无值的键和 `transfer.credentialsInUrl` 仍交给 git，十余种配置形状与 git 逐字节比对。
- 本地身份以前每次打开仓库起 `git config --local` 读 `user.name` 与 `user.email`（各两次），现在直接读公共目录下的
  `config`：照 `--local` 只读这一个文件、不跟随 include、取最后一个值并按 git 规范化引号与转义，快 33× 到 65×；
  空值、无值的键和非常规键名仍交给 git，链接工作树、大小写、续行、include 等情形与 git 逐字节比对。
  `branch::list` 里的 `git remote` 也改用同一份进程内远端配置（任一作用域里有键的远端，排序去重）。
- 分支详情以前每次起 `for-each-ref` 和 `git remote` 两个进程，现在照 `branch_get_upstream` 与 `fill_remote_ref_details`
  在进程内求上游：`branch.<名>.remote` 取最后一个值、`merge` 取第一个，经该远端的 fetch refspec 映射（先匹配者胜，
  通配只替换一个 `*`），引用按名排序、按路径前缀匹配模式，快 10× 到 29×。`.` 远端（要走 `dwim_ref`）、旧式远端文件、
  否定或非常规 refspec、空值或无值的键、通配模式仍交给 git；追踪分支、带 `/` 的远端名、短名 merge、URL 远端、
  多个 merge、packed refs、自定义 refspec 与三个真实仓库都和 git 逐字节一致。
- 贮藏列表以前每次刷新起一个 `git log -g`，现在直接读 `refs/stash` 的 reflog，按 `log -g` 从新到旧的顺序拼出同样的记录，
  快 20× 到 55×。没有 `refs/stash`（也没有它能展开成的其他引用）时与 git 的 128 退出一样返回空列表；
  符号引用、没有 reflog、空 SHA 或对象缺失仍交给 git，多条、删除中间一条、清空几种情形与 git 逐字节比对。
- open-repository（热缓存）快 2.0× 到 4.6×，差距来自 status、history 和远端列表。
- 前四张表全部来自 2026-10-29 的同一次运行（open-repository 每次先丢掉未跟踪缓存，等于打开仓库后的第一次调用）。倍数是同一次运行里两侧的比值，绝对值随系统状态波动。
- 提交图改为从全部本地分支、远端跟踪分支、标签、HEAD 与贮藏遍历（2026-10-27，用户决定）之后单独复测，
  `bun run bench` 同一次运行（合成仓库、Desktop 检出、Homebrew），中位数 ms，git 一侧仍是 Desktop 只走 HEAD 的
  同一页历史命令（Desktop 没有提交图），所以 git 一侧遍历的范围更小：

  | 仓库 | graph 第一页 | git CLI | graph 翻到第 2000 行（新增 `history-graph-deep-page`） | git CLI |
  |---|---:|---:|---:|---:|
  | 合成仓库（1 个分支，3 条贮藏） | 1.2 | 12.5 | 1.1 | 11.0 |
  | Desktop 检出（691 个引用，690 个起点） | 2.1 | 13.7 | 2.5 | 14.1 |
  | Homebrew（543 个标签） | 2.3 | 14.1 | 3.0 | 15.2 |

  第一版直接把全部起点交给 gix `rev_walk`，Desktop 检出第一页从 2.3 ms 涨到 5.0 ms：`Sorting::ByCommitTime`
  入队时从对象库把每个起点解码一遍取提交时间（690 个起点约 2.8 ms），commit-graph 只在之后的遍历里用到。
  `graph.rs` 的 `DateWalk` 改成和 `query_details` 快速路径一样先查 commit-graph（34 位时间戳与父提交），
  不在图里的才读对象，浅克隆边界按 shallow 文件截断；起点顺序照 `git log --all`（引用按全名、HEAD 最后，
  同一时间按入队先后），Rust 测试与 `git rev-list --all` 在读对象和读 commit-graph 两条路径上逐个比对。
  同机同一次交替运行旧、新两个 release 构建（各 20 次）：Desktop 检出第一页旧 1.97 / 2.09 ms、新 2.09 / 2.01 ms，
  持平。遍历起点（去掉非提交对象）随引用索引缓存，贮藏每次读 `refs/stash` reflog。
- 文件历史（2026-10-28，GitLens 参考功能第四项）以前是一次 `git log --follow -n500`，不分页，取满 500 条就提示截断。
  现在照 GitLens 一页 100 条、多取一条判断 hasMore，并在进程内实现 `--follow`：gix 按 git 的日期顺序遍历，
  每个非合并提交只比这个路径沿途的树（tree-diff.c 的 pathspec 比较），路径新建时按 diffcore-rename 的
  精确→估计相似度（`find_copies_harder`、`single_follow`、50% 阈值、每个目标 4 个候选）找来源并改跟旧路径，
  二进制判定照 diff 属性与 NUL 规则，`log.showRoot` 照读。`bun run bench` 同一次运行（机器上另有一个
  agent 在跑 release 测试，load 5 到 9），中位数 ms：

  | 仓库 | 第一页 | GitLens 第一页 | 第二页 | GitLens 加载更多 | 全量 145 条 | git 同参数 |
  |---|---:|---:|---:|---:|---:|---:|
  | 合成仓库（8 个提交） | 3.2 | 27.8 | — | — | 3.3 | 28.8 |
  | 合并冲突仓库（2 个提交） | 1.1 | 14.0 | — | — | 1.2 | 13.3 |
  | Desktop 检出（40 382 个提交） | 44.6 | 62.9 | 137.5 | 261.8 | 127.4 | 270.7 |
  | Homebrew（53 361 个提交） | 50.7 | 177.5 | 141.2 | 326.4 | 138.9 | 483.1 |

  - 第一版逐个提交顺序比树，Desktop 检出全量 406 ms、Homebrew 643 ms，比 git（279 / 372 ms）慢。分段计时：
    遍历 4 万个提交与读父提交树只要 8 到 18 ms，85% 以上的时间在读路径沿途的树对象（增量解压）；
    换成不解码整棵树的 `TreeRefIter`、关掉对象缓存、调大增量基缓存只省到 531 ms。现在按遍历顺序分批
    （256 起、倍增到 8192），每批分给最多 8 个线程各用自己的仓库句柄查「路径变了没有」，本线程再按顺序消费；
    遇到改名就用新路径重查本批剩余部分，所以结果与顺序处理相同（1 200 个提交、三次改名的回归测试覆盖重查）。
    这样全量降到 127 / 139 ms，快 2.1× / 3.5×。git 没有用 commit-graph 的 changed-path Bloom 过滤
    （两个仓库的 commit-graph 都没有 BDAT 块），所以两边都是逐个提交比树。
  - GitLens 第一页还要算 `--numstat --raw -M`，git 一侧做的事更多。第 101 条在 Desktop 检出的遍历顺序里排第 1 239 个提交、
    Homebrew 排第 14 829 个。上面这张小表测于 blobless 克隆积了 571 个按需取 blob 留下的 promisor pack 时；
    换成完整克隆后 Desktop 检出（当时的文件 `copilot-store.ts`）第一页 3.6×、第二页 3.4×、全量 3.2×，Homebrew 4.0× / 2.4× / 3.6×。
    那时第二页 GitCub 照前 201 条重走，第一页的工作重做一遍（Homebrew 第二页 130 ms 对第一页 46 ms）。
  - 续走游标（2026-10-28）：每页把遍历停下时的状态——日期优先队列、已见集合、入队序号、当前跟着的（可能已改名的）
    路径、这一批已经并行查好但还没消费的提交与结果、批大小，以及多取的那一条——存在进程内，前端拿到不透明编号，
    翻页时传回。游标只用一次，最多 4 个、10 分钟，同一仓库同一文件只留最新的；仓库、文件、skip、剥开后的 HEAD、
    `log.showRoot` 任何一项对不上，或队列里的提交在现在的仓库里排序日期不同（commit-graph 重写只是重新定位），
    就按前 skip+limit+1 条从头走，所以两种走法结果相同。改名检测读过 gitattributes 的遍历不留游标（属性来自工作区）。
    提交在输出它的那一页才渲染，装饰与缩写按当时的引用和对象库。2026-10-28 那次运行：Desktop 检出
    `app/package.json` 第二页带游标 3.5 ms、不带游标重走 9.0 ms（2.6×），第三页带游标 8.5 ms；Homebrew 第二页
    155.5 ms 对重走 259.8 ms（1.7×）。2026-10-29 结果表：Desktop 检出第二页带游标 4.2 ms、重走 9.7 ms（2.3×），
    第三页 8.2 ms；Homebrew 第二页 88.0 ms 对重走 131.8 ms（1.5×），全量 131.6 ms。Homebrew 这个文件只有 145 条，第二页剩下 45 条，接着走仍要一直走到根提交才能确定
    没有第 146 条（git 也一样），所以它和全量 161.8 ms 几乎相同：省掉的是第一页那段，剩下的是遍历本身。第三页
    行只在历史超过两页时出现（Homebrew 没有）。GitLens 的加载更多同样走到根，且这次 load 高，git 一侧 614.7 ms 波动大
    （442 到 876 ms），倍数只按同一行看。
  - GitLens 的「加载更多」不只是快慢问题：Desktop 检出上它的第二页只有 34 条，git 全量第 101 到 145 条里有 11 个
    提交不在其中——都是侧分支上的提交（如 `120cd3f39`），日期早于第一页最后一个提交、但不是它的祖先，
    `<sha>^` 起步就走不到。GitCub 接着同一条 git 日期顺序遍历走（游标失效时按前缀重走），第二页 45 条与 git 全量的
    切片一致，这是相对 GitLens 的有意差异。
  - 让位给 git 的情形：pathspec 魔法或通配符、某个版本里这个路径是目录或子模块、replace 引用、grafts、浅克隆、
    读不到的对象（blobless 克隆缺少改名检测要读的 blob 时，git 会按需联网取）。Desktop 检出与 Homebrew 各抽 61 个
    文件逐字节比对全量历史全部一致；加上游标后在完整克隆上重抽各 41 个文件，全量一致，并按每页 100 条与 37 条
    带游标逐页翻到底：Desktop 21 页、Homebrew 39 页与 git 全量切片逐页一致（其中 13 / 19 页接着游标走）；更早用顺序版本跑的 327 个 Desktop 文件里 326 个一致，1 个因 blob 缺失让位。
- 未覆盖：冷缓存下首次打开仓库（无法在进程内可重复测量）、`A...B`、`HEAD~n`、短 SHA 等其余修订号写法（仍起 git 进程）、
  推送/拉取等网络操作、FSEvents 触发的状态刷新节流，以及 WebView 渲染。没有测过的路径不做更快的声明。
  应用整体的启动时间与常驻内存另见下面「应用启动与内存」。

- Desktop 检出改用完整克隆（2026-10-28）：`Vendor/desktop` 按 Vendor 规则是 blobless 单分支克隆，git 一侧读旧提交缺 blob 时
  会联网按需补取，每取一次留下一个 promisor pack——一次 `bun run bench` 就让它从 2 个 pack 涨到 274 个，git 一侧计入的是网络
  往返，GitCub 打开对象库也随 pack 数变慢（`gix::open` 在 274 个 pack 时 4.4 ms，Homebrew 0.14 ms）。现在 `bun run bench`
  拒绝部分克隆（`remote.*.promisor`），子进程一律带 `GIT_NO_LAZY_FETCH=1`；Desktop 检出用
  `git clone --single-branch https://github.com/desktop/desktop.git test-results/bench-repos/desktop`（与 Vendor 同为 c3a5c51ea），
  在 `commit-graph write --reachable` 之后测量。这份克隆的 691 个引用全是松散文件（git 2.54 克隆未打包），
  其中 689 个是标签。
- 松散引用（2026-10-28）：上面那次运行里 branch-details 在 Desktop 检出只快 1.34×（8.3 对 11.2 ms）。分段计时
  （`refs_breakdown`，Desktop 检出，中位数）：`gix::open` 0.16 ms，`references().all()` 8.0 ms，同样遍历但只走
  `refs/heads/` 与 `refs/remotes/` 0.22 ms；直接用 std::fs 逐个读 691 个松散文件 7.3 ms（每个 open+read 约 10 µs，
  只 stat 约 1 µs），读配置 0.15 ms。也就是 8 ms 几乎全花在读标签文件上，而 `records_in_process` 遍历全部引用
  再按前缀过滤；git 的 `for-each-ref refs/heads/ refs/remotes/` 只读这两个目录。现在按请求的前缀遍历
  （`references().prefixed`，与 files 后端一样先列目录、再与 packed-refs 归并、松散优先），branch-details 降到
  0.4 ms，两次运行分别 29× 与 28.5×（Homebrew 21× 与 25×）。`refs/tags` 里的坏引用也不再让分支列表让位给 git。
  新增差分测试覆盖松散与 packed 混合、同名引用松散优先、绕过 git 删掉松散文件后回落到 packed 值、`git branch -D`、
  残留 `.lock` 文件、符号引用、带 `/` 的远端名、空的或损坏的引用文件（交给 git），与 `for-each-ref` 逐字节对照。
- 引用索引（history 翻页、标签、提交图起点共用）命中缓存时只剩指纹，Desktop 检出 1.4 到 2.0 ms（691 次 stat 加目录遍历；
  4 线程 stat 省不到 0.4 ms，没有做）。但任何引用变化都会整表重建：Desktop 检出 12 到 16 ms（读松散文件约 8 ms，
  剥 annotated 标签约 3.5 ms），Homebrew 3.5 到 5 ms，提交或 fetch 之后的第一页因此变慢。并行读松散文件收益不稳定
  （4 线程有时快一倍，8 线程回到串行水平），所以没有绕开 gix 自己并行读。现在缓存同时保存解析好的引用表：
  指纹里只有 `refs/` 下的松散文件变了时，按全名用 gix 的「松散优先、否则 packed-refs」查找只重读这些名字，
  符号引用每次都重新解析（目标变了它自己的文件不变）；`packed-refs` 变了、链接工作树、命名空间、非 ASCII 名字、
  坏引用或查到的是补前缀后的别的引用都整表重读。同一次运行里关掉增量路径对照：Desktop 检出「刚移动过一个分支」的
  第一页 18.9 对 git 24.9 ms（1.32×），打开后 5.2 对 25.1（4.85×）；2026-10-28 的两次运行 Desktop 检出 8.5× 与 4.4×
  （后一次 git 一侧中位数 56 ms、GitCub 12.6 ms，负载波动大，最小值 6.0 对 47.8），Homebrew 4.2× 与 4.7×；
  2026-10-29 结果表里 Desktop 检出 7.3 对 35.0 ms（4.8×）、Homebrew 4.1 对 18.2 ms（4.4×）。修改时间在 3 秒内的文件记为 racy，
  指纹相同也照样重读（原地改写、大小、inode 与修改时间都不变时 stat 看不出差别，原先的缓存会返回旧结果）；
  测试先构造这种改写，确认关掉 racy 判定时会失败。增量结果与整表重建的每个字段逐项对照（提交、移动符号引用目标、
  悬空符号引用变得可解析、删建标签、删分支连同目录、分离与回到 HEAD、pack-refs、松散覆盖 packed、replace 引用、坏引用），
  并在其中几步与 `git log` 逐字节对照。

## 应用启动与内存（2026-10-29）

`bun run bench:app`（`scripts/bench-app.ts`）把打包好的 GitCub 和已安装的 GitHub Desktop 用同一种方式各启动 5 次、
交替进行，取中位数；数据在 `test-results/benchmark/app.json`（不入库）。这次运行：2026-10-29 18:51，main 提交 3812f18，
启动时 load 1.8（1 分钟），macOS 27.2，GitHub Desktop 3.6.7（`/Applications` 里的正式版），GitCub 为
`bun scripts/prepare-e2e.ts` 构建的 `src-tauri/target/debug/bundle/macos/GitCub.app`（Tauri 3.0.0-alpha.5，
Rust **debug** 配置加 `hasgard-testing`）。

| 应用 | 启动到就绪 | 启动到窗口 | 就绪后 RSS | 打开仓库后 RSS |
|---|---:|---:|---:|---:|
| GitCub（debug 包） | 429 ms（337–506） | 297 ms（278–420） | 272 MiB（251–272） | 434 MiB（411–438） |
| GitHub Desktop 3.6.7 | 792 ms（730–893） | 858 ms（844–1027） | 500 MiB（492–522） | 535 MiB（532–569） |

括号里是 5 次的最小–最大。打开仓库那一步两边做的事不同（见下），只记不比：GitCub 从重载到改动列表出现 513 ms（510–515），
Desktop 从 `cli-action` 发出到改动列表出现 308 ms（306–384）。

方法：

- 为什么是 debug 包：tauri-plugin-hasgard 在非 debug 构建里是空插件（`init` 在 `debug_assertions` 之外直接返回空 plugin），
  release 包起不来 socket，窗口也不会被挪到测试显示器（本机 release 包实测 20 秒内没有 socket）。所以 GitCub 一侧的
  Rust 进程是未优化、带调试信息的 123 MB 二进制，启动与内存都偏保守；WebKit 的几个 XPC 进程不受影响。Desktop 是正式版。
- 就绪：照 Desktop 自己的 E2E（`tests/conformance/upstream/desktop/e2e/app-launch-test.ts`）的定义——`#desktop-app-container` 的 innerHTML 超过 100 个
  字符，即 React 应用已渲染（两边第一屏都是欢迎页）。GitCub 经 tauri-hasgard 的 `eval` 轮询（每次约 25 ms），Desktop 经
  `--remote-debugging-port` 的 Chrome DevTools 协议 `Runtime.evaluate` 轮询。从 `spawn` 起算，含进程启动、WebView 创建和页面加载。
- 窗口：另一条并行轮询（每 50 ms 一次 `CGWindowListCopyWindowInfo`，只认 layer 0 的在屏窗口），记第一次看到窗口的时间。
  System Events 的 `count windows` 对启动中先被查过的进程会一直报 0，不用。GitCub 在测试构建里先隐藏窗口、由 hasgard
  挪到副显示器后再显示，所以它的窗口时间含这一步；Desktop 的窗口先出现在主显示器上，就绪后再用 System Events 挪到副显示器
  （启动计时不受影响）。每 50 ms 起一个 osascript 进程会与启动中的应用争 CPU，两边一样。
- 内存：`ps -axo pid,ppid,rss,comm` 的 RSS 求和。GitCub 是主进程加它的 WebKit XPC 辅助进程（WebContent、GPU、Networking；
  它们由 launchd 启动、父进程不是应用，按「启动前不存在的 WebKit XPC 进程」归属）；Desktop 是主进程加全部子进程
  （两个 Helper 和 Renderer）。RSS 把共享的框架页按进程各算一次，两边都偏大，只能两边互比。「就绪后」在就绪再静置 3 秒后取，
  「打开仓库后」在改动列表渲染出来再静置 3 秒后取；每次启动的进程清单与各自的 RSS 都记在 app.json 里。
- 仓库：脚本生成的合成仓库（50 000 个跟踪文件、201 次提交、603 处改动，与 `bun run bench` 共用
  `scripts/synthetic-repository.ts`，放在 `*.noindex` 目录里避开 Spotlight）。两边都用干净的新配置目录：GitCub 以
  `GITCUB_TEST_DATA_DIR` 隔离，预先写好 state.json 让它选中这个仓库并跳过 Desktop 导入询问；Desktop 以 `--user-data-dir`
  隔离（单实例锁随之独立，开发者已开着的 Desktop 不受影响，它的数据不被读写）。打开仓库的做法不同：GitCub 在欢迎页上写
  `has-shown-welcome-flow` 后 `location.reload()`，计的是整个应用重载到改动列表出现；Desktop 不响应 `location.reload()`，
  按它的 E2E 点「Skip this step」和「Finish」走完欢迎流程，再在渲染进程里发 `cli-action`（`github <path>` 命令行走的路径），
  在 DOM 里点「Add Repository」，计的是从发出到改动列表出现。两边的改动列表都数到 601 个改动，与结果表 status 行
  GitCub 一侧返回的条目数相同。
- 没有注入键盘事件；但每次启动应用都会激活、短暂抢走焦点，脚本开头会打印这条警告。

未覆盖：

- 真正的冷启动：两边的二进制都已在页缓存里（Desktop 正在被用户使用，GitCub 刚构建），没有测重启后的第一次启动。
- GitCub 的 release 包（原因见上）；Rust 侧的 debug 开销没有单独量化。
- 只有 RSS，没有 `phys_footprint`、压缩内存与 GPU 内存；Electron 的 GPU 进程和 WebKit 的 GPU XPC 都计入各自一侧。
- Desktop 在新配置目录下启动会联网检查更新，GitCub 这条路径不联网；网络条件不同不在控制之内。
- 只测了一个仓库形状、到改动列表出现为止；没有测 diff 渲染、滚动、切换仓库、历史页和长时间运行后的内存。
- 窗口时间的分辨率是 50 ms 轮询；只在 macOS 上测。

## 复现

```sh
bun run bench                      # 合成仓库 + 可选的真实仓库路径参数
bun run bench -- --no-synthetic /path/to/repo
bun run bench -- --iterations 20 --files 100000 --commits 500
bun scripts/prepare-e2e.ts         # 带 hasgard-testing 的 debug 包，bench:app 要用
bun run bench:app                  # 启动与内存，5 次；--launches、--repo、--no-desktop、--settle 可调
```
