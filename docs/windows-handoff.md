# Windows 测试与修复交接

写于 2026-11-22，基线 `main` = `7bb42c3`。最新发布 0.1.15（`nyssance/releases` 的 `gitcub-v0.1.15`，含未签名的 `gitcub_0.1.15_windows_x64.exe`）。

## 当前状态

- macOS 上全部验证通过：类型检查、lint、ts7-lint、clippy 无警告；组件测试 112/112；原生回归 `macos-workflows` 48/48。
- 最近改动：notify 8 → 9（Windows 后端是 ReadDirectoryChangesW，**这次升级在 Windows 上还没验证**），前后端依赖补丁升级；组件测试 3 个老失败已修。
- Windows 上从没做过完整的手工验收。下面的清单就是要测的范围。

## 环境准备

1. Rust stable（MSVC 工具链）、Visual Studio Build Tools（C++ 桌面开发）、WebView2 运行时（Win11 自带）。
2. Bun Canary（`bun fmt` / `bun lint` 只有 Canary 有）：`bun upgrade --canary`。
3. 仓库根目录：
   ```
   bun install --frozen-lockfile
   bun scripts/fetch-git.ts win32-x64
   ```
   第二步下载随包 git（dugite-native，和 Desktop 同源）到 `src-tauri/resources/git/win32-x64`。不下载时会回退到 PATH 上的 git，行为和成品不一样。

## 运行与打包

- 开发实例（带 Hasgard，可脚本驱动）：`bun run dev:tauri`
- 本地安装包：`bun tauri build --bundles nsis --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"`
  （没有更新签名私钥，必须关掉更新器产物，否则打包最后一步失败。）
- Hasgard 0.7 在 Windows 上走命名管道，默认 `\\.\pipe\tauri-hasgard-<应用标识>`，只允许当前用户连接；`tauri-hasgard` CLI 可 eval 和截图。

## 检查与测试

```
bun check --no-script -p tsconfig.json
bun check --no-script -p tsconfig.tools.json
bun lint
bun ts7-lint
cd src-tauri && cargo clippy --locked --workspace --all-targets -- -D warnings
cd src-tauri && cargo test --locked --workspace
bun tests/conformance/run.ts --no-native
```

- `cargo test` 在 Windows 上会多跑 `#[cfg(windows)]` 的用例。其中 `credentials` 的用例会往 Windows 凭据管理器写一个唯一的测试凭据，不读已安装 Desktop 的账号。
- `macos-workflows.test.ts` 是 macOS 原生套件，Windows 上用 `--no-native` 跳过。
- 跑单个套件：`bun tests/conformance/run.ts ui-components.test.tsx`。

## Windows 专属代码

| 模块 | Windows 行为 |
|---|---|
| `src-tauri/src/git.rs` | 随包 git 在 `cmd\git.exe`，exec path 在 MSYS2 子目录（照 dugite） |
| `src-tauri/src/process.rs` | 子进程加 `CREATE_NO_WINDOW`，不能闪黑框 |
| `src-tauri/src/credentials.rs` | 导入 Desktop 时从 Windows 凭据管理器读 Desktop 的令牌 |
| `src-tauri/src/desktop_import.rs` | Desktop 数据在 `%APPDATA%\GitHub Desktop`，安装检测 `%LOCALAPPDATA%\GitHubDesktop` |
| `src-tauri/src/windows_integrations.rs` | 外部编辑器与 shell：Desktop `editors/win32.ts`、`shells/win32.ts`（2970f9ae1）的移植，注册表查找 30 个编辑器、JetBrains Toolbox 产品和 10 个 shell；不含 WSL（Desktop 仅 beta 开启）与自定义集成 |
| `src-tauri/src/system.rs` | 在资源管理器中显示；终端优先 Windows Terminal，没有则 cmd |
| `src-tauri/src/shell_env.rs` | 从注册表 `HKLM\SOFTWARE\GitForWindows` 找 Git for Windows |
| `src-tauri/src/notifications.rs` | Windows 原生通知与权限 |
| `src-tauri/src/gitignore.rs` | 用 `FILE_FLAG_OPEN_REPARSE_POINT` 拒绝符号链接或联接点形式的 .gitignore |
| `src-tauri/src/commands.rs` | 提示音写 `\x07` 到 stderr |
| `src-tauri/src/stats_context.rs` | ARM64 上 x64 仿真检测 |

## 手工验收清单（按优先级）

1. **启动与首次引导**：安装 0.1.15 的 exe，或跑开发实例；检测并导入本机 GitHub Desktop（仓库列表、账号、令牌），只授权一次，重启后不再读 Desktop 凭据。
2. **随包 git**：克隆、拉取、提交、推送一个 GitHub 测试仓库；全程不能弹出控制台窗口。
3. **文件监听（notify 9）**：在资源管理器或编辑器里改文件、新建、删除、重命名，改动列表要自动刷新；切分支、`git commit` 后状态要更新；`node_modules` 之类被忽略的目录不触发刷新。
4. **路径**：含空格、中文、超过 260 字符的路径；CRLF 文件的 diff 和按行暂存。
5. **外部集成**：在编辑器中打开、在终端中打开、在资源管理器中显示，逐个试表里的编辑器和 shell。
6. **通知**：推送完成或检查失败时的系统通知。
7. **自动更新**：装 0.1.14 等它在 30 秒后检查，下载后提示重启以更新到 0.1.15。安装包未签名，SmartScreen 会提示。
8. **界面**：标题栏与窗口按钮、DPI 缩放、深色模式、仓库栏页签上的 ↑↓、fetch 进度条。

## 修复时的规则（摘自 AGENTS.md 与以往约定）

- 行为以 `Vendor/desktop` 为准，"要和原版一样"；改前先找 Desktop 对应源码。
- 只格式化改过的文件：`bun fmt <文件>`；Rust 只用 stable，不加 `+nightly`。
- 提交按明确路径暂存，提交信息结尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 推送后不等 CI。版本号只升补丁位，打 `v*` 标签（会触发发布）要等用户说"发"。
- i18n key 用英文文案的 camelCase，中英两份同步改。
- 不提交自建 GitLab 的主机名，不打印任何令牌。

## 2026-11-23 Windows 实测结果

机器：Windows 11 x64，Git 2.56.1.windows.1（scoop，`ucrt64\bin\git.exe`）。

- `cargo clippy --locked --workspace --all-targets -- -D warnings`：通过。
- `cargo test --locked --workspace`：338 通过、1 忽略。
- `bun tests/conformance/run.ts --no-native`（独占机器的一轮）：2615 通过、76 失败。其中 22 个是上游套件；54 个是 `macos-workflows`、`status-responsiveness` 的原生用例，这轮没有准备带 Hasgard 的应用包，全部连不上。这一轮之后又修了通知的 2 个（单独重跑通过），上游套件剩 20 个。日志在 `test-results/win-check/`（不入库）。
- 整轮必须独占机器、磁盘留足空间：同时跑 cargo 会多出几十个假失败，D 盘写满时链接器报 LNK1318／LNK1201。

### 当天修掉的

| 提交 | 内容 |
|---|---|
| `a0159ba` | 外部编辑器与 shell 改为 Desktop 的注册表查找（见上表） |
| `eb7cd29` | 交互式变基的临时文件名只含时间戳，Windows 时钟粒度粗，连续创建撞名（os error 80） |
| `94383b6` | 提交钩子的 shell 环境：Desktop 以空环境起 shell，libuv 在 Windows 上仍传 PATH、SYSTEMROOT 等 11 个变量；之前真清空，cmd 没有 PATH、Windows PowerShell 起不来 |
| `fb61ac4` | 工作树路径照 Desktop `Path.normalize` 归一成反斜杠，否则与仓库路径按字符串比不相等 |
| `53170d9` | 去掉 Bun 默认的 5 秒单测上限（原版 node:test 没有）；rebase 进度、子模块 pull 之前的失败都是超时，不是 Git 行为差异 |
| `47809ae`、`7063674` 及之后 | clippy 死代码；`printenvz` 夹具兼容新版 Cargo 目录布局；系统垫片认 `__WIN32__ = false` 的平台模拟（通知的两个「on macOS」用例） |

### 仍失败的 20 个上游用例

Windows 相关：

| 套件 | 失败 | 现象 |
|---|---:|---|
| `desktop/get-shell-env-test.ts` | 1 | git-bash：Desktop 的 `findGitBash` 只认 `\cmd\git.exe` 与 `\mingw64\bin\git.exe`，本机 Git 2.56 在 `\ucrt64\bin\`，Desktop 在这台机器上同样找不到。照原版未改；要不要加 `ucrt64` 待定 |
| App Launch（e2e） | 2 | 连不上 Hasgard 命名管道（含一个同因的未命名失败）：需要先 `bun scripts/prepare-e2e.ts` 打包并启动应用，这轮没准备 |

与平台无关，回 macOS 处理（多数属于清单里 `stale` 的 3.7.0 多账号套件）：

| 套件 | 失败 | 现象 |
|---|---:|---|
| `desktop/repositories-list-grouping-test.ts` | 7 | 原版按账号拆分分组，`groupRepositories` 没拆。项目规则是按平台分页签、不折叠分组，实现还是登记排除需要决定 |
| `desktop/ui/clone-repository-test.ts` | 5 | 路径校验、无可用账号的 URL 页、登出后清除选择 |
| `desktop/ui/invalidated-token-test.ts` | 2 | 登出后没有出现登录入口 |
| `desktop/ui/test-token-expiration-dialog-test.ts` | 1 | `fireEvent.change` 切换账号没生效，原因没查实 |
| `desktop/usage-data-test.ts` | 1 | 示例数据过期，需重新生成 |
| `desktop/main-process/menu-test.ts` | 1 | Copilot handoff 菜单项；Copilot 已移除，应登记排除 |

### 仍未做

- 上面「手工验收清单」8 项一项都没做；notify 9 的文件监听在 Windows 上仍未验证。
- 新的编辑器／shell 启动只有命令行拼装与 `cmd.exe` 逐字传参的单元测试，没有在界面里逐个点开验证。
- 原生套件没有在 Windows 上跑过。
- 基准只有 open-head、index-entries、refs、status 四项；进程内 blame、raw-diff 与 status 的预检／未跟踪缓存在 Windows 上未覆盖。

## 待办（2026-11-24 记）

### 需要用户决定

1. ~~文件监听锁住仓库目录~~ **已实现，待 Windows 验证**（2026-11-24，macOS 侧）：资源管理器到前台时放掉目录句柄，离开时重新监听并补一次刷新（`src-tauri/src/watch.rs` 的 `yield_to_explorer`，每 250 ms 查一次前台进程是不是 `explorer.exe`）。其余时间照常实时监听。Windows 专属代码只在独立小工程里对 `x86_64-pc-windows-msvc` 做过编译检查，整包没有在 Windows 上编译或运行过。要验证：
   - `cargo clippy`、`cargo test` 通过（`watch::tests` 新增 2 个用例，平台无关）。
   - 选中仓库后切到资源管理器，给仓库文件夹改名、挪走：应成功；回到 GitCub 显示「找不到仓库」；改回原名后自动恢复。
   - 编辑器在前台改文件、GitCub 在旁边：列表仍实时刷新。
   - 从终端或其他程序改名仍会被拒（只认资源管理器），原生用例「a repository moved away…」由测试进程改名，预计仍失败，需要按这个限制调整或登记。
2. ~~git-bash 查找是否认 `\ucrt64\bin\git.exe`~~ **已决定并实现**（2026-11-24）：认。`src/lib/hooks/get-shell.ts` 的 `findGitBash` 多一条 `\ucrt64\bin\git.exe`，目录结构同 mingw64；这是相对 Desktop 的有意差异，已写进 AGENTS.md。待 Windows 验证：scoop 的 Git 2.56 下钩子环境默认可用，`desktop/get-shell-env-test.ts` 的 git-bash 用例通过。
3. ~~仓库分组的 7 个上游用例~~ **已决定**（2026-11-24）：不按账号拆分分组。7 个用例由 `tests/conformance/design-adaptations.ts` 排除，其余 3 个照跑（macOS 上 3/3 通过）。

### 回 macOS 先做

- ~~`66194d5` 没有在 macOS 上编译过~~ 已处理（2026-11-24）：确实编译不过（`std::os::unix::net::Stream` 不存在），改为 `UnixStream as Stream`；hooks 的 Rust 测试与原生套件通过。
- `9ad378b`（仓库名取平台 basename）与之后的前端改动只跑了格式化和类型检查；这台 Windows 的 Bun 没有 `bun lint`，`bun lint`、`bun ts7-lint` 要补跑。
- ~~`macos-workflows` 在 macOS 上重跑~~ 已处理（2026-11-24）：48/48 通过；`bun lint`、`bun ts7-lint` 也已补跑，无问题。
- 上游套件里与平台无关的 17 个失败（见上一节表格）和清单里 247 个 `stale`。

### Windows 原生套件还没查完的

`bun scripts/prepare-e2e.ts` 后跑 `bun tests/conformance/run.ts macos-workflows.test.ts`。App Launch 通过；`macos-workflows` 最近一轮 40 通过、8 失败。钩子用例要求 PATH 上的 git 是标准布局（`…\cmd\git.exe`），见上面第 2 条。

| 用例 | 状态 |
|---|---|
| multi-file discard…，以及连带的 merge、pull 两个 pre-merge-commit 钩子用例 | 测试用 ⌘ 点击多选，Windows 上是 Ctrl；已改，未重跑确认 |
| diff layout, whitespace projection and search… | 搜索框能打开，回车后没有出现结果播报；怀疑测试驱动的 Enter 没送到窗口，未确认 |
| keyboard reorder moves the commit… | 依赖方向键与 Enter，同上，未确认 |
| history list and commit details render :alias: emoji… | 原因未查 |
| undoing a local commit from history restores its message… | 原因未查 |
| a repository moved away… | 见上面第 1 条 |

`status-responsiveness.test.ts` 里的 Trending 原生视图和三指手势是 macOS 专属，其余两个用例在 Windows 上还没单独跑过。

### 其它没做的

- 「手工验收清单」8 项；notify 9 的文件监听除了上面的锁目录问题外没有专门验证。
- 新的编辑器／shell 启动没有在界面里逐个点开验证。
- 钩子的「中止」在 Windows 上用 `taskkill /T /F` 结束整棵进程树，没有专门的用例覆盖。
- Windows 基准仍只有 open-head、index-entries、refs、status 四项。
