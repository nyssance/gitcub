# 原版行为测试

自有卡死回归：`coalescing-runner.test.ts` 覆盖状态刷新串行执行、事件合并、扫描期间
修改后的补扫、错误恢复及不同仓库之间的隔离；不计入 Desktop 上游兼容数量。
`commands::repo_status` 在阻塞任务池执行，避免 gix 文件哈希阻塞 macOS 事件循环。
`status-responsiveness.test.ts` 在隔离仓库阻塞 Git clean filter，验证扫描尚未结束时
真实 macOS WebView 和原生 IPC 仍响应，释放 filter 后状态正常返回。
另一个场景以本地 partial clone 和被阻塞的 promisor remote 复现 `commit_files`
补取 blob，验证阻塞期间仍能切到发现页、返回仓库及读取状态；不请求真实远端。

凭据导入回归由 Rust `credentials::tests` 覆盖：重新创建导入调用后使用已持久化凭据、
不重复读取外部源、拒绝授权不继续尝试助手、忽略已登出的 host。
`desktop_import::tests` 核对 GitHub API endpoint 与自建 GitLab 端口的元数据映射；
这些夹具不读取个人钥匙串，不代表真实账号授权已人工验收。

`stories/discover.stories.tsx` 复用生产侧栏和发现页，覆盖胶囊 Tabs 的鼠标／键盘切换、
搜索和筛选；`.storybook/discovery-layout.spec.ts` 在 800/1000px 下用滚轮检查两处长列表、
顶部控件位置、原生滚动条抑制和 overlay 自动隐藏。
侧栏 Sidebar、Sheet、useMobile 及滚动条规则参考 ALwith Desktop
`494518376bf1f21ad9bde2cde6952ccff46ac5e6` 的
`src/components/ui/{sidebar,sheet}.tsx`、`src/hooks/use-mobile.ts` 与
`src/styles/global-utilities.css`；基础组件只适配本项目导入路径。

浮板画布参考同一 ALwith commit 的 `src/features/layout/components/{atlas,slab}.tsx`：
保留 leading → navigation → workspace 连续排列、默认工作屏、三指原生事件、中键合成拖动与松手吸附；
不使用顶部切换 Tab。−1 屏给导航保留 244px，导航在右侧完整可见，回工作屏后位于左侧；
同一导航节点持续挂载，采用 ALwith 的 248px 导航板宽和 Embla 分组规则。
按用户要求，触控板手势默认关闭，「设置 → 触控板」中可显式开启；未检测到设备时开关禁用，手势不生效。设备检测沿用同一 ALwith commit 的 `src-tauri/src/commands/trackpad.rs` macOS HID 实现；普通双指滚动和中键拖动不受影响。
原生回归先断言默认手势不翻屏，再通过真实设置开关启用并验证持久化与三指切换。
未引入 ALwith 的多工作区、终端、overview 或额外设置。
`src/lib/ui/atlas-swipe.ts` 与 `tests/conformance/atlas-swipe.test.ts` 保留原 helper 和 7 个原始用例
（仅将 Vitest 导入改为 `bun:test`，运行 `bun test tests/conformance/atlas-swipe.test.ts`）。
macOS 触点采集和纯状态机来自其 `src-tauri/src/platform/trackpad/{mod,macos}.rs`，
事件传输适配为 Tauri emit；原状态机测试随 `cargo test` 运行，不代表物理触控板已人工验收。
浏览器回归检查左右浮板边界、双指滚动不翻屏、中键切换及工作区搜索状态保留。
`status-responsiveness.test.ts` 的第三个自有场景检查真实原生 Trending 视图延迟创建、
尺寸/位置、三指事件切换、导航节点复用、返回工作区时隐藏，以及子视图存在时原生 IPC 保持响应；网页联网成功不是该用例的断言。
趋势不再抓取 HTML 或回退到搜索 API，网页使用无应用权限的独立临时浏览会话。

`bun run test:upstream` builds the Rust JSON test executable and runs the original
`upstream/` suites with Bun. Each suite runs in its own process to isolate module mocks.
`source-loader.mjs` uses Bun plugins for import mapping and TypeScript/JSX loading;
Node's `registerHooks` is used only when explicitly selecting Node with
`JS_TEST_RUNTIME=/absolute/path/to/node`. The test runner never requires a binary
named `node` on PATH. Node execution requires version 24 or newer.
Cargo, Bun, Git, Git LFS and Hasgard CLI are required for the complete suite
(`cargo install tauri-hasgard --version "^0.5" --locked`); a Vendor checkout is not required.
全套执行在 macOS 验证；Windows/Linux CI 作业是编译门禁。

`bun check --no-script -p tsconfig.json && bun check --no-script -p tsconfig.tools.json` 使用 TS7 检查应用、构建脚本与项目自有测试。原版快照和仓库
夹具不作为独立检查入口；`tsconfig.tools.json` 的 `rootDirs` 仅把已引用的上游
helper 类型导入映射到实际生产源码，运行时仍使用 runner 的显式平台适配。

## 执行路径

- Desktop gitignore、remote management/discovery、init → `bridge.ts` → Rust 生产模块。
- Desktop repository discovery/config → Rust `repository.rs` / `git_config.rs`；打开目录和身份设置也使用这些模块。
- Desktop branch/checkout/for-each-ref/refs/merge/diff-check → Rust `branch.rs` / `ops.rs` / `status.rs`，包含远端同名分支、子模块、已删除远端分支和冲突标记。
- Desktop log revision exclusions → Rust `history::query`，应用分支比较也使用此查询。
- Desktop revert/squash/reorder → Rust `ops.rs` / `interactive.rs`，包含原版冲突继续、非法目标及历史断言。
- GitLens index/conflict parser → Rust `index_parser.rs`；真实冲突解决使用同一解析器。
- Desktop changes filter → `src/lib/desktop-filter-changes.ts`；仅替换类型导入，ChangesSidebar 调用同一实现。这是前端覆盖，不是 Rust 覆盖。
- Desktop diff parser、text diff expansion → 应用实际使用的 `src/upstream/` TypeScript。
- Desktop patch formatter → 应用实际使用的 diff 解析和补丁生成；读取工作区 diff 时调用 Rust。
- GitLens blame parser → `blame_model.rs`；应用 `blame.rs` 也使用这个解析器。
- GitLens worktree parser → `ops::parse_worktrees`；应用工作树列表使用同一函数。
- GitLens status parser → `porcelain::parse_gitlens` / `porcelain::fold_matching_ignored`；diff 面板的子模块脏条目数用同一解析器统计。应用状态（含子模块脏法）由 gix 计算，Desktop 形状的 `porcelain::parse` 只作一致性基准。
- GitLens commit search query → `search_query.rs`（search.utils.ts 一比一移植）；History 侧栏搜索框经 `history::search` 使用同一解析与参数构造。
- GitLens revision.utils / fileStatus.utils / remote / branch.utils → `bridge.ts` → Rust `search_query`、
  `raw_diff::file_diff_pathspecs`、`remote::parse`、`branch::split_remote_branch_name`；不能合法运行的块由
  `gitlens-unported-blocks.ts` 按标题删除。
- GitLens integration（commits.searchTypeMerge、revision、revParseGitDir、env.gitDir、gitIgnoreFilter）→ 原样
  `integration/helpers.ts` 快照准备仓库，CliGitProvider/Git/locator 换成 `gitlens-integration-local.ts`，经桥调用
  `history::search` / `history::resolve_shas` / `ops::stashes` / `repository::repository_type` / `branch::tip` /
  `watch::ignored_by_git`。helpers.ts 自己的导入只按套件声明的 `gitlensHelperImports` 解析。
- GitLens autolinks → `src/lib/autolinks.ts`（autolink.utils.ts 一比一移植）；提交详情与 Desktop RichText 经 `lib/autolink-rules.ts` 用同一实现把设置里的规则和 GitLab 内置引用渲染成链接。这是前端覆盖，不是 Rust 覆盖。
- GitLens provider 集成套件（`packages/git-cli/src/providers/__tests__/integration/*.test.ts`，快照在 `upstream/gitlens/integration/`）→
  原版 `integration/helpers.ts` 快照（`upstream/gitlens/packages/git-cli/src/providers/__tests__/integration/`，仓库夹具仍用 git CLI 构造）→
  `gitlens-integration.ts` 的 `CliGitProvider` 适配 → `bridge.ts` 的 `call` → Rust 生产函数。`gitlens-modules.ts` 只对 helpers.ts 把
  `../../../cliGitProvider.js`、`../../../exec/locator.js`、`../../../service.js`、`./shadowCheck.js` 及 `@gitlens/utils/logger.js`
  指到适配；套件里直接导入 cliGitProvider/locator 的由 run.ts 的 `imports` 重定向。适配按子 provider（config、cache、refs、remotes、
  tags、worktrees，加顶层 clone/init/dispose）只列出已移植套件用到的方法，每个方法只翻译参数与返回形状：tags → `ops::all_tags`，
  remotes → `remote_ops::list`，worktrees → `ops::worktrees` / `ops::remove_worktree`，config → `git_config::get/set`、
  `repository::repository_type`，refs → `history::resolve_revision`、`ops::merge_base`、`branch::list`，clone →
  `branch::clone_output`，init → `system::init_repo`（桥 `init` 接受分支名，缺省 main）。访问未映射的成员、传入没有生产对应的选项
  （bare、取消信号、unset、全局读写等）一律抛 `NotMappedError`，不返回替身结果；`createCliGitService`、`verifyBaseRemeasure`、
  `findGitPath` 同样抛错。GitLens 的 cache/repository 钩子不被调用；`cache.registerRepoPath` 是空操作（GitCub 不按 checkout 缓存），
  `cache.getCommonPath` 取生产工作树列表的主工作树。`Logger.configure` 是空实现（只配置日志通道）。
  `gitlens-integration-adaptations.ts` 把 Mocha TDD 的 suite/test/suiteSetup/suiteTeardown/setup/teardown 映射到 node:test，
  按标题跳过登记的排除块并删除只被排除块使用的导入（sinon、`@gitlens/git/errors.js`）；登记的标题或导入在快照中找不到即加载失败。
  后续套件：快照放进 `upstream/gitlens/integration/`、登记 sources.json，把名字加入 run.ts 的集成套件列表，在适配里补方法与桥操作，
  在 adaptations 里登记排除标题与理由。
- status、stash、pausedOperations、branches、commits 集成套件在适配末尾另起一块（`Object.assign(subProviders, …)`）：
  status → `status::status`（FileChange 映射为状态字母与三类工作区改动，只接受 force 与 untracked: 'all'），stash →
  `ops::stashes`，不带路径与选项的 saveStash → `ops::stash_push`（消息固定为 Desktop 分支标记），applyStash({deleteAfter}) →
  `ops::pop_stash_sha`（无保留条目的 apply），pausedOps → `status::status` 的 operation 与 `ops::continue_operation`（桥 `operation/continue`，只接受
  messageEditor: 'true'），branches → `branch::list` / `branch::tip`，commits → `history::log`（多读一条判断 hasMore）/
  `history::query`。包装 Mocha 全局量时同时提供 `test.skip`。
- GitLens operations / graph 集成套件（operations、operations.upstreamRemote、operations.indexLockHook、graph.slashRemote、
  graph.stashRows）用同一
  适配的 ops / branches / graph 子 provider，但写操作与提交图经应用的 TypeScript 层：`src/lib/ipc.ts`、`push.ts`、`fetch.ts`、
  `branch-workflows.ts` 按 app.tsx 的方式组合，`tauri.ts` 把 Tauri 命令（commit、amend_commit、merge_branch、graph、push_with_tags、
  fetch_output、fetch_refspec、branch_details、repository_tip、repo_status、worktrees）转到运行同一 Rust 函数的桥操作。推送只接受检出分支
  （工具栏 `pushWithRecovery`），拉取、fetch 的分支引用同样只接受检出分支。GitLens 的 `errors.ts`、`utils/reference.utils.ts` 是逐字节
  快照，其 `@vscode/l10n` 与 `@gitlens/utils/date.js` 由 `gitlens-l10n.ts` 渲染英文原文；错误原因只取生产给出的
  `BranchWorkflowError` 代码，不解析 git 输出。`bun tests/conformance/run.ts <suite 文件>…` 可只跑指定套件。

这个 Git JSON 桥只供测试，正式应用通过 Tauri IPC 调用同一 Rust 模块。
适配层不重新实现 Git 操作或计算预期值。测试中的 Git CLI 调用用于准备夹具和独立验证。

## 适配边界

统计示例测试通过 `usage-data.ts` 使用 TS7 原生类型查询 API；不再调用 TS6
`readConfigFile` / `createProgram`。它仍从生产 `DailyStats` 类型生成全部字段，并保留原版
JSON 全量比较。TS7 的联合类型成员顺序可能不同，字符串示例按源码声明顺序选取，
以保留原版 `Architecture` 示例 `x64`。`typescript/unstable/sync` 依赖 Node 的管道内部字段，
Bun 下不可用；`usage-data-generate.ts` 改用 `typescript/unstable/async` 在子进程里计算，
原版同步测试通过子进程结果调用生产 `buildStatsPayload`。升级 TS7 时必须重跑此测试。

Bun 运行时差异的其余处理：Tailer 改为在 watcher 上订阅 `change` 事件（Node 对传入的监听器做同样注册，
Bun 的 watcher 只通过事件触达）；凭据中继对子进程流的 `unref` 按可选调用；Desktop remote 套件里
对 `https://github.com/desktop/not-found.git` 的 blob 过滤 fetch 由隔离 gitconfig 的 `url.insteadOf`
指向临时本地仓库，套件不再依赖网络。

`design-adaptations.ts` 与 Copilot 删减同一机制：按用户规则基础控件一律使用标准 shadcn/ui，
Desktop 里要求原生 `<details>` 及其 `toggle` 事件的 tutorial step 用例无法通过，整文件登记为 `partial`，
排除的用例标题写在清单 `adaptation` 里。

原测试文件字节不变。runner 只改导入路径，把 GitLens 的 suite/test 全局变量映射为
Node describe/it，并提供原版平台常量和测试目录。Desktop Repository 适配保留用例需要的 path、gitDir、mainWorktreePath；身份和 Git 配置
使用隔离的测试环境；fixtures 中 `_git` 在临时副本中恢复为 `.git`。

GitLens Map/Date 通过 JSON 后在 bridge 恢复类型。Rust 返回的是测试涉及的数据字段，
不是 GitLens 的 GitCommit/GitWorktree 类、URI 或 VS Code workspace resolver。
worktree 原版测试只检查 locked/prunable，不证明类的其他方法等价。
diff 包含文本、图片、二进制、子模块；另有 GitCub 独立十万行 diff 原生与 WebView 回归。init 默认使用 GitCub 默认分支 main；GitLens provider 套件传入的分支名原样交给 `system::init_repo`。

`ported` 表示该原始测试文件已整体接入可执行门禁，不表示对应功能所有路径已覆盖。
Rust 原生移植、原版 TypeScript 断言与 GitCub 自有回归分别登记，不能把数量相加当覆盖率。

PR/MR 检出接入 Desktop `AppStore._findPullRequestBranch` 的远端匹配、跟踪分支复用和
fork 分支创建流程；GitLab 扩展使用 `mr/编号`，URL 由 Rust 解析以支持子组和 SSH。
`workflow-navigation.test.ts` 用隔离 fork 与生产 Rust IPC 验证提交、跟踪关系和同名分支保护。
macOS 对应界面回归只模拟托管平台元数据，检出、仓库状态和配置读取仍走真实应用与 Git；
该测试不代表真实 GitHub/GitLab 服务验收。

## 上游更新

`sources.json` 固定每份测试的来源路径、commit、SHA-256，以及夹具与许可证摘要。
runner 在执行前核验快照，拒绝缺失、被格式化或被修改的文件，以及未登记的测试集合。
Python 门禁还对照本机 Vendor 原文，并监测全量上游测试和辅助文件的变化。

更新 Vendor 后先运行两个来源的清单检查。`scripts/desktop_tests.py --sync` 会把变化的
已接入文件标记为 stale，不会自动认可新断言。逐项对照测试、helper 和 fixture，更新原版
快照、生产实现及适配说明，然后运行完整门禁；通过后才能将 stale 恢复为 ported。
不要直接修改 expected、跳过失败测试，或仅更新摘要来消除差异。

许可证分别保存在 `upstream/desktop/LICENSE` 和 `upstream/gitlens/LICENSE`。

仓库发现保留正常路径的词法表示，仅在所有权诊断中按真实父目录匹配。
config 原版 HOME 覆盖在测试子进程中映射为临时 GIT_CONFIG_GLOBAL，不接触用户全局配置。
变基结果将 Rust Result 和真实冲突状态映射成 Desktop 枚举；历史适配支持 revision/range、分页和额外过滤选项，保留正文末尾换行。
GitLens index 的 singleEntry 仅影响上游分配策略，JSON 桥不保留该性能区别。
冲突字段通过省略不存在的 revision 保留 JavaScript undefined 语义，状态常量使用原版 fileStatus.ts。
GitLens git 模型许可证另存于 `upstream/gitlens/LICENSE-git`。

分支与标签测试调用生产 GitStore，其 Git 读取经 Rust 恢复原版 Tip/Branch 字段。
这些场景验证原版测试涉及的缓存与事件，不能代表所有 store 工作流。
分支详情、HEAD 类型及上游差异通过 Tauri 命令提供；分支下拉同时列本地和远端分支，远端检出建立本地跟踪分支。
检出、删除远端分支、合并和冲突标记使用应用实际调用的生产操作。
fixtures 中的冲突/本地 fork/子模块构造函数保留 Desktop 操作顺序，完整 helper 原文也记录摘要。

## 已接入的后续 Git 契约

commit、add、apply、reset、diff-stage、diff-resolution 使用真实 Rust 索引/提交操作和应用
`src/lib/stage.ts`、`src/lib/diff.ts`。commit SHA 返回值保留 Desktop 对 Git stdout 的原始解析
（包括 root commit 的历史兼容行为）。reset 原版的 `it.skip` 场景由明确登记的适配器启用，原始操作和断言不变。

remote-parsing 通过 Rust；clone-path-safety/status-utils 是应用使用的原版 TypeScript。
worktree 使用 NUL 分隔解析，覆盖换行路径、锁定、可清理工作树和主工作树路径恢复；
保留 GitLens 的锁定/清理原因文本。description/reflog/submodule/format-patch 均通过 Rust。
worktree move（Desktop 9a47fa5cf）：Rust `ops::move_worktree_command` 用 `git worktree list` 找到主工作树并组装
`git worktree move -- old new`，`ops::move_worktree` 以主工作树为 cwd 执行；原版 worktree-move 套件包装自己的
dugite 记录每次 git 调用的 cwd，适配器因此把 Rust 算出的命令交给套件记录的 exec 执行，cwd 断言观察的是 Rust 选择的
主工作树。实际由 Rust 执行的路径由镜像的 Rust 测试 `移动工作树不在被移动的目录里运行` 覆盖。Bun 的 `mock.module`
会重绑所有已导入该模块的命名空间（Node 不会），套件自己的 dugite 与生产侧传输经 run.ts 的 `mocks` 映射分成两个模块，
避免原版包装函数递归。

tag/log/status 覆盖带注释标签、标签推送、复制/重命名和子模块状态。显式配置复制检测时，
状态查询对 gix 当前遗漏的复制源使用 Git CLI 补充；默认路径仍使用 gix。
fetch 的 fastForwardBranches 只更新非当前且能快进的跟踪分支，不写 FETCH_HEAD。
LFS 的批量过滤也用于实际提交大小检查；检查跟踪模式时不安装钩子。

push 测试调用应用的 `src/lib/push.ts` 和原生推送；目前测试验证初始进度事件，不代表持续
进度、终端或 hook 回调已覆盖。pull 尊重 pull.ff/pull.rebase，默认 --ff，递归更新子模块；
不再强制覆盖用户配置为 --ff-only。拒绝 Git 子进程无法安全处理的前导短横线 remote 名称。
stash 使用 Desktop 兼容标记并识别旧 GitCub 标记；保留阻止应用的错误，对已应用的冲突按
Desktop 行为移除 stash。原版 skip 与独有回归始终分别记账。

revision-consumers 覆盖前导短横线引用、二进制 blob、限长读取和 merge-base 比较。限长读取在
Rust 中限制 stdout 缓冲并回收子进程。rebase/cherry-pick 读取实际 Git 状态和 sequencer，
返回 Git stdout/stderr 解析出的进度序列；当前 JSON 桥按完成后顺序投递，不证明实时推送。
clone 覆盖协议 allowlist、URL 重写、递归子模块、分支选项和敏感路径。生产克隆与测试共用
Rust clone_output；新建仓库写入默认 .gitattributes，但保留已有文件（GitCub 数据保护扩展）。

基础工具测试运行生产 TypeScript：数值/字节格式化、分支名清理、身份校验、列表选择、
Promise 等待等。其中分支创建、补全键盘导航、身份设置、OAuth 轮询和图片大小显示已
接入对应函数；其他独立工具只代表该模块契约已验证，不代表整个功能界面已完成。
数字格式偏好使用浏览器 localStorage；测试 DOM 使用与 Desktop 相同的 jsdom 包，
未提供 Electron 或业务 IPC 的假结果。Desktop 数据库改用 Rust 命名 JSON 存储后，
`tauri.ts` 以内存 Map 替身实现 `store_*` 命令，只保留 JSON 可表示的值。
Git/clone/LFS 进度解析运行 Rust；生产 clone 通过 Tauri Channel 实时投递 stderr 解析的进度，JSON 桥保留完成后的序列。
format-commit-message 使用共享原版格式化函数，再经生产 Rust 调用 Git interpret-trailers；共同作者处理失败会中止提交，
避免丢失归属信息。默认 README 写入作为显式命令提供，不自动覆盖用户文件。

补充执行边界：

- Git 核心执行、凭据协议、路径/文件工具、SSH 提示解析、终端变换与尾缓冲运行 Rust。生产
  `executeGit` 通过 Tauri Channel 接收实时终端字节；独立终端测试使用原生进程管道。
  生产 clone/rebase/cherry-pick 已通过 Channel 实时投递；JSON 桥的批量返回契约保持不变。
- 完整提交模型由 `history::query_details` 提供独立的作者/提交者身份、未折叠尾注和标签；
  TypeScript 恢复 Date、Commit 和 co-author 模型。日志/引用测试也经过这条生产调用链。
- 2026-10-21 按用户要求移除 Copilot 功能与 SDK/Koffi/Webpack 打包链。相关快照保留溯源，
  在 sources.json 与 Desktop manifest 中明确排除，不再执行或计为功能兼容。API、仓库规则、菜单和令牌消费者混合套件
  仅运行非 Copilot 用例，并标记 partial；账号、指标套件移除已不存在的 CopilotStore 构造参数及能力查询 mock；OAuth 请求数由 5 改为 4（移除了 Copilot GraphQL 查询），凭据与会话断言完整保留。
- API、OAuth、账号与凭据状态机、仓库/fork/worktree 模型、分组和文本工具运行生产 TypeScript。
  原版 API 测试自己控制 fetch，原版存储测试使用原版 InMemoryStore；没有替换这些被测状态机。
  Desktop 9a47fa5cf 的短期令牌灰度（`src/lib/short-lived-token-rollout.ts`）原样移植：GHES 不请求 Central，
  beta/开发构建直接启用，其余构建 GET Central 的 feature 接口（5 秒超时、不跟随重定向、不带凭据），任何失败回落到
  长期令牌；登录存储在灰度检查期间被取消或重开时不再打开浏览器。原版 rollout 套件会改写 `__DEV__` /
  `__RELEASE_CHANNEL__` 全局量，`tests/conformance/build-environment.ts` 把这些赋值镜像到 build-environment 的
  live binding，生产 `desktop-features.ts` 不改；GUID 经 Rust stats 存储桥读取，版本号来自 package.json。
  `getHTMLURL` 改用 WHATWG `URL` 的 origin（保留 GHES 非默认端口），项目已移除 legacy url polyfill，
  原版「window 未定义」用例原样通过。
  账号模块的类型声明适配和 GitCub 钥匙串命名空间与 Desktop 不同，序列化格式保持兼容。
  欢迎页和设置页共用原生设备授权入口及凭据存储。原生授权支持实例类型、取消、令牌续期和账号替换保护；Desktop API 请求也通过原生续期解析当前令牌。原版状态机测试与原生授权回归分别记账，不据此宣称真实服务已验收。
- 原版登录测试的浏览器启动边界被记录在 `opener.ts`，不打开真实认证页面；这验证登录状态，
  不验证系统浏览器是否启动。Tauri 环境/构建变量在测试中映射为真实 Node 环境，允许上游
  测试临时调整预览标志与 cwd；生产应用在启动时读取原生 cwd。
- `mock-api-test` 验证上游测试辅助器自身（未 mock 的方法必须失败），不是产品网络覆盖。
  测试辅助器和产品实现来源均纳入 SHA256 校验。
- `status-parser` 在 Rust 中解析原版 porcelain-v2 场景；应用状态（含子模块脏法与领先/落后计数）自 2026-10-27 起全部由 gix 计算，不再起 git 进程，Desktop 形状的解析器只作一致性基准（同模块的 GitLens 形状由 diff 面板的子模块脏条目数复用）；
  普通状态热路径继续使用 gix。

UI suites now execute the original Desktop components in React 19. Original
snapshots and shared render/timer helpers remain byte-identical. React props
explicitly include children, and destructive submit/reset events bubble because
React 17+ delegates at the root. Tests retain their original assertions. The
runner uses a real zero-delay timer only for RTL 16's microtask drain; application
timers still use Node's original fake-clock control. Electron clipboard mocks
intercept the same production platform boundary that calls WebView clipboard;
dialog attention uses Tauri's window plus the macOS system alert. Text controls
use the WebView's native editing/spelling context menu instead of Electron IPC.

Repository databases and stores keep the original uniqueness constraints, table
operations and model hydration on top of the named JSON store (`src/lib/databases/base-database.ts`,
a Dexie-API subset backed by the `alwith-module-store` crate shared with ALwith Desktop). Dexie's schema-version migration
suites (`database-migration-test`, `repositories-database-test`) are excluded by the
2026-10-26 decision to remove Dexie; the in-memory store stub replaces no store logic.
UI CI and Issue providers retain upstream store/callback contracts; their UI
suites do not certify remote network requests or imply GitLab API coverage.
DDS parsing uses the original converter, with conversion wired into the image
diff load path. Original mocked-WebGL tests do not certify a device's GPU.

Build SHA discovery is used by Vite and includes the original linked-worktree and
packed-ref tests. Release version and changelog utilities are build tooling;
passing those tests is not Rust Git behavior coverage. Original React lifecycle
warnings are retained rather than removing assertions or migrating component
behavior merely to silence them.

## 252 个 Desktop 文件的执行范围

固定 commit：`bebc062caafcf818993b9f53397b976d33484231`。保留原版快照，排除项以 `sources.json` 为准（含 ESLint 与用户移除的 Copilot）；
执行前核验原始 SHA-256。完整性检查和行为执行是两个独立门禁。

- CommitMessage、自动补全、新建分支、欢迎、关于和下载退出对话框进入应用实际界面。
- AppStore 移植原版仓库指示器及账号/令牌统计所需的方法闭包，连接生产 AccountsStore、
  StatsStore、GitStore 和命名存储数据库。窗口与导航仍由 GitCub React 根组件管理，
  不表示整个 Desktop AppStore 的所有工作流都已替换。
- 认证推送经过真实 Rust Git 子进程、TCP trampoline 和 credential helper；测试使用隔离凭据。
- 原版 `app-launch.e2e.ts` 的 10 个用例原文不改，通过 Hasgard 操作实际 WKWebView。
  Electron 菜单/退出 IPC 映射为 Tauri 事件/命令；原版 helper 独立检查实际 Git 结果。
  覆盖欢迎配置、默认标题提交、创建/切换分支、启动更新检查、关于版本、下载状态、
  下载中退出保护和强制退出。应用数据、Git 全局配置、应用标识和更新服务均隔离。
- 更新服务器保留上游的悬挂下载行为，清单格式适配为 Tauri。此测试不覆盖下载完成、
  签名验证成功、安装成功或重启。正式发布需配置 `GITCUB_UPDATE_ENDPOINT` 和
  `GITCUB_UPDATE_PUBLIC_KEY`；测试地址只在 `hasgard-testing` 编译功能中可用。
- `test-results/desktop-e2e/` 保存真实 WebView 命令、日志、截图和 trace；`test:upstream`
  自动重建 `.app`，避免用旧二进制验证新代码。
- GitLens 独立登记（5c1708eca，v19.5.0；与 020cfc1b7 相比夹具只变了 package.json 的 check:colors 脚本与 scripts/build.mjs，已移植套件及 helpers.ts 逐字节未变）：579 个文件中 14 个完整移植、20 个部分移植、0 个未接入、545 个明确排除（含 `plus` 目录因 GitLens Pro License 排除的文件），不计入 Desktop 的 256 个文件。
  上游 c54e108f4 新增的 `branches.applyConflicts.test.ts` 与 `providers/__tests__/branches.test.ts` 两项打桩用例测的是 GitLens 变基/cherry-pick 冲突预测（给 `merge-tree` 传树，需 git 2.45）；
  Desktop 变基预览只数提交（`app/src/ui/lib/update-branch.ts`），GitCub 只有照 `determineMergeability` 的合并预览 `ops::merge_preview`，两文件登记 excluded；
  该提交「merge-tree 退出 1 且无输出是错误、不是干净」的规则在 `merge_preview` 同步落地，由 Rust 回归 `合并预览找不到分支要报错不能当干净` 覆盖。


## macOS 产品回归

`macos-workflows.test.ts` 与原版快照分开，使用隔离的真实 Tauri 应用，检查统一登录入口、
远端分支检出、重载后的冲突中止、十万行 diff 虚拟化、原生／Desktop 凭据共享及退出保护、
连续文件变更后的 diff 收敛。Rust `macos_tests`、`oauth::tests`、`watch::tests` 补充验证
跟踪远端、多端口实例、流式进度、令牌续期请求、取消与替换登录、linked worktree 监听。
原生 UI 测试也覆盖 macOS `/var` 路径别名、Git 状态未变时的二次内容刷新、凭据轮换存储兼容、
首次欢迎页的语言恢复与两栏布局。

`tests/macos/update-install.ts` 独立验证损坏签名拒绝、下载、包替换和应用重启。
该隔离测试使用临时测试密钥，不代表 Developer ID、公证或正式发布验收。

`tests/macos/live-github.ts` 是需授权仓库的独立真实服务验收入口，不加入普通 CI。
2026-10-19 在 `nyssance/gitcub` 验证了原生私有克隆、提交推送、拉取和 PR 创建，测试对象已清理；
Actions 排队超时，真实 CI 重跑未通过验收。详见 `test-results/live-github/report.json`。
GitLab 真实服务、浏览器设备授权、企业 SSO/代理/证书环境、长期压力和完整辅助功能仍需独立验收。


## shadcn DOM 适配

Portal 弹窗查询使用 `baseElement`，控件状态仍由真实 Base UI 组件提供。
复制按钮用例等待异步剪贴板调用完成再推进假时钟，并同步模拟 `Date`，
使 lodash 的播报 debounce 与定时器处于同一时间轴；原快照与结果断言不变。
DOM 身份／空值断言改用同等布尔判断，避免失败时 Node 序列化整个 React DOM 树。
测试 runner 将 React、React DOM、Base UI 和 Testing Library 交给 Node 原生加载，
避免打包 React 的 CommonJS wrapper 后异步 `act` 回退到不会关闭的浏览器 MessageChannel。

原版测试快照保持不变。`ui-dom-adaptations.ts` 明确登记控件 DOM 差异：复选框／单选框的原生属性断言读取 Base UI 实际隐藏 input，并额外核对可访问根元素的 `aria-checked`；选中页签由原生隐式可聚焦改为显式 `tabIndex=0`。点击、焦点、回调次数、状态预期与操作顺序保持原样。这些属于经过 DOM 适配的行为测试，不代表原版 DOM 完全一致。

## 自有 UI 回归迁移到 Storybook

迁移只调整自有回归的执行位置，原版上游快照和兼容性登记保持不变。
`bun run storybook:test` 是 CI 独立门禁；测试矩阵包含两种主题、两种语言和宽／窄视口。

| 原位置 | Storybook 目标 | 保留的断言与原生边界 |
|---|---|---|
| `virtualized-grid.test.ts`（已删除，runner 注册同步移除） | `stories/virtualized-grid.stories.tsx` / `ControlledOffsetsAndImperativeRef` | 初始 200、更新 600、解除受控后 imperative 滚动到 400、重算后仍为 400、卸载 ref 为 null；实际浏览器滚动替代 jsdom |
| `macos-workflows.test.ts` / welcome opens the same GitHub/GitLab account settings and cancels cleanly | `stories/preferences.stories.tsx` / `NavigationContract` | 5 个页签、唯一选中态、图标对齐、非活动背景和边框透明、各面板关联、垂直键盘导航、关闭回调；Hasgard 保留真实入口、两平台账号页、Escape 关闭及 Git 身份写入完整链路 |
| `macos-workflows.test.ts` / saved Chinese language applies to welcome and Git identity before onboarding | `stories/welcome.stories.tsx` / `LayoutAndIdentity` | 欢迎内容居中、边界内、背景不透明、跳过后的本地化配置界面；Hasgard 保留 save_state、WebView 重载及中文文案验证 |

设置的每个页签另有独立 story，确保无障碍检查覆盖非默认面板。
Storybook 原生读接口使用 `.storybook/mocks/native.ts` 的明确夹具，未知命令导致验收失败；
模拟调用不能代替凭据、Git 配置写入、真实账户或原生菜单验收。
Git 索引、diff/拖选与实际仓库联动、登录、菜单、文件监听和性能场景仍由原生测试验证。


ESLint 工具链已移除，日常格式与 lint 检查使用 Bun 原生命令。源码测试加载器使用 Oxc 转换 TypeScript/JSX；原生模块构建测试通过 `typescript-native-build.mjs` 调用实际 TypeScript 7 CLI，保留诊断与输出文件断言。排除的 6 个开发规范测试不计为已通过或兼容，原版快照继续校验完整性。

GitLens 清单回归通过 Git 对象读取 manifest 固定 commit，Vendor 更新不会自动更改基线；`python scripts/desktop_tests.py --source gitlens` 仍对照当前 Vendor 检测新增测试、断言与夹具变化。采用新基线需单独审阅并显式同步。

GitLens 仓库里任何名为 `plus` 的目录受 GitLens Pro License（`Vendor/vscode-gitlens/LICENSE.plus`）约束，不是 MIT；
这些文件（含 `packages/plus/commit-graph` 的提交图引擎、`src/plus/launchpad`、`src/plus/search`）于 2026-10-27 全部登记为 `excluded`，
理由是许可证，不得复制或移植，快照目录里也不得出现 `plus` 路径。提交图继续使用自研 `graph.rs`。

自研提交图（`src-tauri/src/graph.rs`、`src/ui/history/graph.tsx`）只对照两份 MIT 实现的规则，不复制代码：
VS Code `src/vs/workbench/contrib/scm/browser/scmHistory.ts`（`toISCMHistoryItemViewModelArray`、`renderSCMHistoryItemGraph`，
<https://github.com/microsoft/vscode/blob/25c94ab342a6b167d4b97ade0829955d4f7e094e/src/vs/workbench/contrib/scm/browser/scmHistory.ts>，
测试 <https://github.com/microsoft/vscode/blob/c71cce40e40af3bfbd53e44fd728263c1aa03d69/src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts>，
许可证 <https://github.com/microsoft/vscode/blob/eee5d36cbf70c906d66bcdc03861b3feaa445d75/LICENSE.txt> 为 MIT）
与 lazygit `pkg/gui/presentation/graph/graph.go`（`getNextPipes`，
<https://github.com/jesseduffield/lazygit/blob/73fac4a55462d41a218ce7a558b844926f8c2c87/pkg/gui/presentation/graph/graph.go>，
测试 <https://github.com/jesseduffield/lazygit/blob/da5b9b54eb4598079d3d56f128c1fe9fb57acd26/pkg/gui/presentation/graph/graph_test.go>，
许可证 <https://github.com/jesseduffield/lazygit/blob/12f475544e608552d5b4ea1b5226cc7b2fbe09bc/LICENSE> 为 MIT）。
采用的规则：提交落在第一条等它的泳道上，其余等它的泳道汇入后收掉、右侧左移补位（两者一致）；
第一个父提交沿用本泳道和色流（VS Code 首个 parent 继承 swimlane 颜色）；出边按父提交所在的输出泳道画
（VS Code `findLastIndex(outputSwimlanes, parentId)`），所以第二个父提交已经有泳道在等时不再开泳道、也不会漏画合并线——
这里与两份参考不同：VS Code 和 lazygit 都为每个额外父提交新开一条泳道（`getNextAvailablePosForNewPipe`），GitCub 保留原有的复用规则以控制宽度。
色流在开泳道时分配、随泳道左移和翻页携带（VS Code 用旋转的 `colorRegistry`，lazygit 按提交取色，GitCub 按色流取 Primer 调色板）。
提交顺序与 GitLens 提交图的 `git log --all --date-order` 逐条相同（`graph::date_order`，git commit.c `sort_in_topological_order(REV_SORT_BY_COMMIT_DATE)` 的一比一移植：
走完可达集合、算入度，按提交时间取最新、同一秒按进队先后的优先队列，父提交等所有子提交出完才进队）。
gix 的广度优先和 `git log` 的默认顺序（按时间、同一秒按进队先后）都不是拓扑序——广度优先会把分叉点排在分支上更早的子提交前面，
默认顺序在同一秒的一串提交或时钟倒退时也会把父提交排到子提交前面——泳道等一个已经画过的提交就一直悬着。
序列整条按仓库缓存，键是起点集合（引用 + 贮藏基提交）与浅克隆边界，任一起点变了才重排；`graph::tests` 用固定种子的 300 个提交、
5 条分支、只在 8 秒内取时间的 fast-import 夹具和同一秒、时钟倒退的夹具与 `git rev-list --date-order --exclude=refs/pull/* --all` 逐条、逐页（1、7、50）对照，读对象与读 commit-graph 两条路径都测。
翻页由 `GraphCursor`（泳道、色流、下一个色流编号）接续，`graph::tests` 证明分批与一次算完逐字节相同；
前端每页 100 条、离底 10 行翻页，同 Desktop 的 `CommitBatchSize`（app/src/lib/stores/git-store.ts）与 `CloseToBottomThreshold`（app/src/ui/history/compare.tsx）。
`stories/commit-graph.stories.tsx` 的 `MergeHeavy`/`Paged` 夹具由 Rust 测试夹具 `busy_history(12)` 算出。

GitLens 清单中的 `excluded` 是用户于 2026-10-27 明确划出的范围，不是产品缺口，每条都带 `exclusion` 原因：
VS Code 扩展宿主（`src/commands`、`src/system`、`src/env`、`src/views`、`src/quickpicks`、`src/terminal`、`src/virtual`、
`src/__tests__` 等）、webview UI/RPC（`src/webviews`、`packages/components`、`packages/ipc`、`packages/plus/commit-graph-ui`）、
VS Code E2E（`tests/e2e`）、扩展运行时工具（`packages/utils`）、GitKraken Plus 托管集成与 AI/agent（`packages/plus/integrations`、
`packages/plus/git-github`、`packages/plus/ai`、`packages/plus/agents`、`src/plus/{ai,gk,kepler,coretools,startWork,agents}`、`src/agents`）
以及仓库脚本（`scripts/__tests__`）。保持 `pending` 的只有 Git 行为与 AGENTS.md 列出的参考功能：`packages/git-cli`、`packages/git`、
`src/git`、`src/autolinks`。`--sync` 复用既有条目，排除状态会保留。
worktree 解析器在 c1f6e5f3c 新增 branchName 规则：`branch refs/heads/<name>` 才算分支，bare/detached 或指向 `refs/heads/` 之外的 HEAD 没有分支名；
Rust `ops::parse_worktrees` 同步该规则，bridge 仅把 `kind`/`branch` 改名为 GitLens 的 `type`/`branchName` 并按已知分支列表匹配 `branch`。

status 解析器（`statusParser.test.ts`，46 项）：Rust `porcelain::parse_gitlens` 解析 porcelain v1 的 `##` 表头与 `XY path` /
`R old -> new` 行，以及 v2 的 `# branch.*` 表头和 `1`/`2`/`u`/`?`/`!` 记录（子模块 `S` 字段映射为 `{oid, previousOid}`，重命名在制表符后取原路径），
只返回原始 x/y 代码、路径、表头字段和子模块 oid；`foldMatchingIgnored` 对应 `porcelain::fold_matching_ignored`。
索引/工作区/冲突状态、detached 标签、repoPath 规范化和文件 uri 由原版 `status.ts`、`statusFile.ts`、`branch.utils.ts`、`uri.ts`、`path.ts` 快照计算，
快照按上游 `packages/<pkg>/src` 布局存放（`gitlens-modules.ts` 映射 `@gitlens/*` 与 `#env/*`），bridge 只把 Rust 字段交给这两个构造函数。
`@gitlens/utils/decorators` 以空实现替代，status.utils 的 l10n 格式化以抛错桩替代；GitLens 的记录拆分是位置式且不校验模式/哈希字段，
Desktop 形状的 `porcelain::parse` 仍按原正则校验，两者不共用拆分代码。应用热路径状态仍由 gix 提供。

提交搜索语法（`search.utils.test.ts`，107 项中 91 项）：Rust `search_query` 一比一移植 `packages/git/src/utils/search.utils.ts`
（`parseSearchQuery`、`parseSearchQueryGitCommand`、`rebuildSearchQueryFromParsed`、`getSearchQueryComparisonKey`、`areSearchQueriesEqual`、
`createSearchQueryForCommit(s)`，含 `models/search.ts` 的操作符表与 `revision.utils.ts` 的 `isSha`/`shortenRevision`）；位置按 UTF-16 码元计，
`Map`/`Set` 序列化为插入顺序的去重条目，bridge 只还原类型。`parseSearchQueryGitHubCommand` 套件（16 项）面向 GitHub 搜索 API，
托管平台搜索走网页，`hosted-search-adaptations.ts` 在加载时删去该 suite 块与导入，清单登记为 `partial` 并写明套件标题。
应用侧 `history::search` 按 git-cli `searchCommits`/`parseCommits` 组装并执行命令（`--all` 或 `ref:`、`commit:` 解析后 `--no-walk --stdin`、
贮藏经 `--stdin`、`type:stash/merge/tip` 后置过滤、`-n limit+1`/`--skip`），输出沿用 Desktop 提交格式；不加 `--use-mailmap`/`-M`/ordering。
沿用的上游行为：不区分大小写的 `file:` glob 生成 `:(icase):(glob)…` 而 git 只认第一段魔法前缀；全字匹配依赖 ERE `\b`，Apple Git 不支持。
端到端场景在 Rust `history::tests`（消息/作者/提交者、引号短语、文件通配与 glob、`-S`/`-G`、日期、`ref:`、`type:merge`、长短 sha、`@me`、四个匹配开关、limit+skip、空查询与语法错误、贮藏）。

自动链接（`autolink.utils.test.ts` 29 项、`src/autolinks` 的 `autolinks.test.ts` 2 项）：`src/lib/autolinks.ts` 一比一移植 `packages/git/src/utils/autolink.utils.ts`
（serializeAutolink、isDynamic/isCacheable、ensureCachedRegex 三种输出格式的缓存、ensureCachedBranchNameRegexes 的分支名规则、`<num>` 替换、getAutolinks、
getBranchAutolinks 的 priorityProviderIds 排序与首个匹配即返回），`models/autolink.ts` 的类型和 `packages/utils/src/string.ts` 的 encodeHtmlWeak/escapeRegex 逐字复制；
三份上游文件与 `iterable.ts` 按 `packages/<pkg>/src` 布局快照并登记在 `support`。runner 只重定向 `../autolink.utils.js`、`../utils/-webview/autolinks.utils.js`（上游 webview 包装只是
重导出 getAutolinks 并把分支排序固定为 Jira/Linear 优先，本项目无托管 issue 集成，夹具 provider id 为 '1' 时结果相同）和两个类型导入。
`autolinksProvider.test.ts` 依赖 VS Code container 与 AutolinksProvider 的 marked/l10n 渲染，登记为 `excluded`。
应用侧 `lib/autolink-rules.ts` 在 Desktop 分词之后用同一 messageRegex 找位置：设置 › 高级的规则（前缀、含 `<num>` 的 URL、字母数字、忽略大小写、标题，
持久化在 `AppState.autolinks`，校验前缀/URL 必填且 URL 含 `<num>`）与 GitLab 远端的 `#<num>` issue、`!<num>` 合并请求内置引用（`packages/git/src/remotes/gitlab.ts`）；
提交详情 `ui/history/commit-summary.tsx` 与 `ui/desktop/rich-text.tsx` 把它们渲染成走系统浏览器的链接，标题取 GitLens 的 title；GitHub 的 `#<num>` 仍由 Desktop 分词器处理。
getBranchAutolinks 已移植并有测试，界面尚未使用；html/markdown 格式只在测试里执行。未对应：GitLab `owner/repo#1`/`owner/repo!1` 动态引用、GitHub `GH-<num>`、issue 富化与脚注。
独立回归 `autolinks.test.ts`（本地）覆盖规则在提交信息里成链、GitLab 远端才把 `!12` 链到合并请求、GitHub 远端沿用 Desktop 分词、规则校验、字母数字与忽略大小写。

### 统一 Diff 行组件

参考 `Vendor/desktop` commit `bebc062caafcf818993b9f53397b976d33484231` 的
`app/src/ui/diff/side-by-side-diff-row.tsx` 与 `side-by-side-diff.tsx` 行构造。
统一和并排模式现在均调用移植的行构造／行组件，不再维护 CodeMirror gutter。
保留原版 SVG diffCheck／diffDash、隐藏原生 checkbox、双行号列和整块选择结构。
适配点：Tauri 数据接口、TanStack 虚拟滚动、主题变量、搜索高亮，以及隐藏 checkbox
的明确名称、checked／indeterminate 同步（避免与 aria-checked 不一致）。这不是整个
Desktop Diff 父组件的逐字复制，也不代表全界面像素一致。

GitCub 的明确无障碍差异：深色模式新增词级高亮保留原版 `#22863a` 背景，
文字由 `#f6f8fa` 改为白色，修正原组合仅 4.34:1 的对比度。
`History/Window/LongPaths` 使用生产 DiffView，连同头像、长路径和分栏最小宽度
一起接受明暗主题的无障碍及布局检查；上游样式快照保持原样。

`stories/unified-diff.stories.tsx` 是新增的自有回归，复现 269–273 行（272 行修改）的
截图场景，并检查全选、部分选择、整块切换、悬停、键盘、拖选与十万行末尾搜索。
`macos-workflows.test.ts` 的大文件／布局用例已改查实际统一行组件；保留原来的
可见末行、DOM 行数上限及工作流断言。原版快照与夹具不改写。


### Diff 父层与恢复链路补充

仍以 Desktop `bebc062caafcf818993b9f53397b976d33484231` 为参考：
`side-by-side-diff.tsx` 的 `onDiscardChanges` 使用原始 diff；
`onContextMenuHunk` 使用 `findInteractiveOriginalDiffRange` 的连续修改范围；
`onExpandWholeFile`／`onCollapseExpandedLines` 仅改变显示内容。
GitCub 复用这些算法和模型，菜单以标准 shadcn ContextMenu 组合；移除应用层对原始
Diff 的展开改写。文件切换、后台刷新和空白过滤会使旧菜单／展开请求失效。

自有回归（不计入原版一致性数量）：
- `stories/diff-workflow.stories.tsx`：菜单目标、展开后原始行号、折叠、过期读取、失败重试。
- `stories/unified-diff.stories.tsx`：新增越界拖选和 Escape 取消；越界持续滚动为本项目补充。
- `selection.test.ts`：过期部分选择拒绝且 index 不变；只丢弃一个连续修改块。
- `highlighter.test.ts`：diff 高亮 worker 的逐行 token 快照（`fixtures/highlighter/`），快照由原 @codemirror/lang-* 实现生成，
  证明改为直接拼 @lezer 解析器后 8 种语言、嵌套 HTML/CSS/JS、Markdown 内联 HTML 与 CRLF 输出不变；运行 `bun test tests/conformance/highlighter.test.ts`。
- `macos-workflows.test.ts`：真实 WebView 展开、丢弃确认及工作区／index 断言。
- `macos_tests.rs`：merge／cherry-pick／revert 在继续失败后可中止恢复，再重新解决并继续；rebase 由既有恢复用例覆盖。
- 文件列表复用 Desktop `List`；改动列表保留 checkbox，使用其 list/listitem 模式。
  对应本地 ARIA 适配去掉 listitem 的 aria-selected，使用 aria-current，不改原版快照。

GitCub 保留变基的 Git index stage 2／3 含义：ours 为变基后的基底，theirs 为正在重放
的提交。UI 明确命名，避免借用合并分支的名称误导用户。忙碌时禁用冲突操作，
同一操作入口加同步锁，失败后刷新并保留继续／中止入口。

展开后的焦点恢复也沿用 `focusAfterLastExpandedHunkChange` 的顺序：同一位置／方向、
后续按钮、前一个按钮、Diff 容器。列表键盘故事使用原版 macOS 的 Command+Down
到达末行（不是 Windows/Linux 的 End），并断言最终选中路径和实际虚拟渲染行数。

### 索引事务、文件多选与文本操作补充

仍参考 Desktop `bebc062caafcf818993b9f53397b976d33484231` 的
`ui/changes/filter-changes-list.tsx` 多选及 `ui/diff/side-by-side-diff.tsx`
的 `onCutOrCopy`、`onSelectAll`、空白选择提示。History 的 `ui/history/file-list.tsx`
本来就是单选，继续保持。shadcn 负责菜单／提示的展示；Changes 批量丢弃复用一次原生确认。

自有回归，不增加上游完全兼容数量：
- `stage.rs`：以 Git 标准 index.lock 排斥其他写入，独立临时索引完成整批操作后原子替换；
  失败不改原 index，不恢复覆盖别人的更新。测试失败后字节不变、锁冲突、linked worktree、
  split-index、无 HEAD 的新仓库与空选择；不宣称工作区文件或 HEAD 同时具备事务隔离。
- `stories/changed-files.stories.tsx`：Shift 范围、Cmd 非连续选择、批量勾选与批量丢弃目标。
- `stories/diff-workflow.stories.tsx`：同一行多个搜索结果前后导航、无结果计数、空白过滤下
  先提示再恢复选择，以及全选复制包含未挂载的虚拟行。

Storybook 发布包通过 alwith.dev 官方 CLI 的 `checkPublishCleanliness` 检查；
生产 OS 模块使用 Storybook 手工 mock，不再用带绝对路径的 Vite alias。
未配置线上项目及上传凭据前，不登记任何线上基线审核通过。

本轮验证：全量上游门禁 2,363 项通过、无跳过；新增的多文件丢弃及 About 作者链接另随
16 项 Hasgard macOS 工作流通过。Rust 170 项单元测试、2 项 askpass、1 项性能回归通过。
160 个 Storybook 场景 × 8 种组合均覆盖，失败修复后按受影响场景分批复测；不是单次全绿报告。
alwith.dev 线上上传及 GitHub／GitLab 本轮真实服务写入验收尚未完成。

### 原版菜单和勾选语义核对

参考同一 Desktop commit 的 `ui/app.tsx::selectAll`、`ui/lib/list/list.tsx::toggleSelection`、
`ui/changes/sidebar.tsx::onChangedItemClick`／`onToggleInclude` 和
`ui/changes/changed-file.tsx::handleCheckboxChange`：菜单先发可取消的 `select-all` DOM 事件；
Enter／空格逐个反转选中文件的纳入状态，点击复选框只改当前文件。
多文件统一纳入／排除使用 `filter-changes-list.tsx` 中的独立右键菜单操作。
修正先前复选框批量切换的偏差，不把它登记为原版行为。

新增自有 Storybook 回归覆盖菜单事件、混合纳入状态、Enter／空格和单文件复选框隔离；
Hasgard 的批量丢弃用例补充验证真实菜单全选能到达 Changes 列表。

shadcn ContextMenu 的 Portal 鼠标事件在 React 树中会冒泡到文件行；隔离菜单的
mousedown／mouseup／click，防止批量操作后选择被收成单选。Storybook 保留操作前后
选中文件集合以及批量回调路径断言。原生全选测试点击可聚焦的 List 行，并先断言焦点：
Hasgard 对标题 span 调用 focus 不会模拟浏览器默认的祖先焦点行为。

### Local GitHub Desktop migration (GitCub regression)

`desktop_import.rs` reads the local Desktop profile; `desktop_import_log.rs` validates LevelDB framing and the live file manifest. Schema reference: Desktop `bebc062caafcf818993b9f53397b976d33484231`, `app/src/lib/databases/repositories-database.ts`, `app/src/ui/index.tsx` (`Database`), `app/src/lib/stores/app-store.ts` and `app/src/ui/lib/application-theme.ts`. These are new GitCub migration tests, not transplanted upstream cases.

The importer resolves the newest sequence per key, honors deletion tombstones and the current manifest, validates WAL checksums/batch completeness, rejects concurrently changing files and unreadable records, and validates local working directories. `blob-decoder` 0.2 needs an adapter for V8 `kPadding`: remove only NUL tags identified at decoder value boundaries, following [V8 ReadTag/PeekTag](https://github.com/v8/v8/blob/main/src/objects/value-serializer.cc); never strip NULs from string contents. Unsupported records fail instead of importing guessed paths.

Rust fixtures cover Unicode paths, selected repository, duplicate/deleted/missing repositories, obsolete logs, corruption and settings allowlisting. Storybook `Settings/Navigation` covers import merging, busy state and failure/retry. `conformance` operation `desktop/import` accepts a profile path for read-only native integration checks. Only standard profiles are auto-discovered; custom Electron user-data-dir locations are not yet supported. Accounts/OAuth secrets, custom editor shell commands and preferences without a GitCub equivalent are not migrated. macOS editor/terminal display names map to the existing bundle-ID catalog; Windows names map only to discovered native executable integrations (never macOS bundle IDs).

First-run import is gated by the existing welcome flow. An explicit import/skip persists `desktopImportHandled` only after a successful native save. Missing installations bypass the offer; installations without data allow continuing without import. Storybook `Onboarding/DesktopImport` covers offer, skip, absent install, prior choice, empty profile, failure/retry and busy state. Native macOS tests verify skip persistence across a real WebView reload using an isolated test profile (`hasgard-testing` only). Windows CI runs migration fixtures, Windows discovery and state roundtrip tests on Windows; local macOS checks do not certify Windows UI launch behavior.
