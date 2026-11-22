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
| `src-tauri/src/windows_integrations.rs` | 外部编辑器与 shell：VS Code、Cursor、cmd、PowerShell、pwsh、Windows Terminal、Git Bash |
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
