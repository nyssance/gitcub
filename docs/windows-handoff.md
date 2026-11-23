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

机器：Windows 11 x64，Git 2.56.1.windows.1，基线 `905b515` 加当天三个修复。

- `cargo clippy --locked --workspace --all-targets -- -D warnings`：通过（此前 `examples/live_gitlab.rs` 因 `host_api::post` 未使用而失败，已修）。
- `cargo test --locked --workspace`：338 通过、1 忽略。此前 `interactive::tests::挪到最后` 失败：临时文件名只含时间戳，Windows 时钟粒度粗，连续创建撞名（os error 80），已加进程内序号。
- `bun tests/conformance/run.ts --no-native`（无其它负载的一轮）：2593 通过、45 失败、其中 15 个是 5 秒超时。日志在 `test-results/win-check/`（不入库）。同时跑 cargo 时失败会涨到 81 个，整轮必须独占机器。

### 仍失败的用例（未修）

Git 行为，优先看：

| 套件 | 失败 | 现象 |
|---|---:|---|
| `desktop/pull/pull-test.ts` | 2 | with submodules 两项：单独重跑仍失败，一项 5 秒超时，一项 `Rust bridge exited null` |
| `desktop/rebase/progress-test.ts` | 3 | 两轮都失败（解决冲突后的进度、REBASE_HEAD、detached HEAD）；未单独重跑 |
| `desktop/commit-test.ts` | 13 | 只在整轮里失败，单独重跑 25/25 通过；是套件间干扰或负载，不是确定的行为差异 |
| `gitlens/integration/worktrees.test.ts` | 1 | 默认工作树路径返回 `C:/…`，仓库路径是 `C:\…`，分隔符不一致 |

Windows 专属功能：

| 套件 | 失败 | 现象 |
|---|---:|---|
| `desktop/get-shell-env-test.ts` | 3 | 夹具找不到 `printenvz` 的问题已修（新版 Cargo 的 `build/gitcub/<hash>/out` 布局），pwsh 通过；git-bash 返回 failure，powershell 进程以 0xffff0000 退出，cmd 的结果里没有 PATH。影响提交钩子的 shell 环境 |

看起来与平台无关、需要在 macOS 上确认的（多数属于清单里 `stale` 的 3.7.0 多账号套件）：

| 套件 | 失败 | 现象 |
|---|---:|---|
| `desktop/repositories-list-grouping-test.ts` | 7 | 按账号分组的结果与预期数组不等 |
| `desktop/ui/clone-repository-test.ts` | 5 | 路径校验与无可用账号的 URL 页 |
| `desktop/ui/invalidated-token-test.ts` | 2 | 登出后没有出现登录入口 |
| `desktop/ui/test-token-expiration-dialog-test.ts` | 1 | 时间差正好 8 小时（本机 UTC+8），本地时间与 UTC 的换算 |
| `desktop/show-notification-test.ts`、`desktop/notification-permission-test.ts` | 2 | 模拟 macOS 的用例在 Windows 宿主上取到了真实平台 |
| `desktop/usage-data-test.ts` | 1 | 示例数据过期，需重新生成 |
| `desktop/main-process/menu-test.ts` | 1 | Copilot handoff 菜单项；Copilot 已移除，应登记排除 |
| 未定位 | 3 | 日志里未命名的套件级失败，属于哪个套件没查 |

### 仍未做

- 上面「手工验收清单」8 项一项都没做；notify 9 的文件监听在 Windows 上仍未验证。
- 新的编辑器／shell 启动只有命令行拼装与 `cmd.exe` 逐字传参的单元测试，没有在界面里逐个点开验证。
- 基准只有 open-head、index-entries、refs、status 四项；进程内 blame、raw-diff 与 status 的预检／未跟踪缓存在 Windows 上未覆盖。
