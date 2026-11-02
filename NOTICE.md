# NOTICE

GitCub 以 AGPL-3.0 发布，其中包含从 **GitHub Desktop** 移植的代码。

## GitHub Desktop (MIT License)

来源：https://github.com/desktop/desktop
版权：Copyright (c) GitHub, Inc.

以下文件整体或大部分移植自 GitHub Desktop，保留其 MIT 许可：

```
src/upstream/models/diff/            数据模型与 DiffSelection
src/upstream/lib/diff-parser.ts      git diff 输出解析
src/upstream/lib/patch-formatter.ts  行选择 → 补丁
src/upstream/lib/fatal-error.ts
src/upstream/lib/remote-parsing.ts
src/upstream/lib/status.ts
src/upstream/lib/offset-from.ts
src/upstream/models/manual-conflict-resolution.ts
src/upstream/ui/diff/diff-explorer.ts
src/upstream/lib/equality.ts
src/upstream/lib/highlighter/types.ts
src/upstream/models/status.ts        工作区文件模型
src/upstream/ui/diff/text-diff-expansion.ts
src/upstream/ui/diff/diff-helpers.tsx
src/upstream/ui/diff/changed-range.ts
src/upstream/ui/diff/get-tokens.ts
src/styles/desktop.css      布局规则（移植自其 SCSS）
```

此外，`src-tauri/src/raw_diff.rs` 与 `src-tauri/src/history.rs` 中调用 git 的
参数组合直接照搬自 GitHub Desktop 的 `app/src/lib/git/`，注释中标注了对应来源。

MIT 与 AGPL-3.0 单向兼容：MIT 代码可并入 AGPL 项目，但必须保留上述版权声明。

MIT License 全文见 https://github.com/desktop/desktop/blob/development/LICENSE

`tests/conformance/upstream/desktop/`、`tests/conformance/fixtures/` 和 Rust 中的
repository、git_config、interactive、gitignore、remote、branch、merge、diff-check 行为移植也来自该项目。测试快照的完整许可证保存在
`tests/conformance/upstream/desktop/LICENSE`，来源 commit 与摘要见 `sources.json`。

## GitLens git-cli (MIT License)

来源：https://github.com/gitkraken/vscode-gitlens/tree/main/packages/git-cli
版权：Copyright (c) 2021-2026 Axosoft, LLC dba GitKraken ("GitKraken")；
Copyright (c) 2016-2021 Eric Amodio。

`src-tauri/src/blame_model.rs`、`index_parser.rs` 和 `ops.rs` 的 worktree 解析参考此包；原版测试保存在
`tests/conformance/upstream/gitlens/`，该包的完整 MIT 许可证保存在同目录 `LICENSE`。

## Primer Octicons (MIT License)

来源：https://github.com/primer/octicons
版权：Copyright (c) GitHub, Inc.
以 npm 依赖 `@primer/octicons-react` 引入，未修改。

GitLens `packages/git/src/models/fileStatus.ts` 的原版状态常量用于索引测试，
对应 MIT 许可证保存在 `tests/conformance/upstream/gitlens/LICENSE-git`。

`src/lib/desktop-filter-changes.ts` 来自 Desktop 的 `app/src/ui/changes/filter-changes-logic.ts`，
只适配类型导入与格式化，原始源文件及其摘要也保存在测试来源登记中。

Desktop 后续移植：src/upstream 中的独立工具与选择模型保持原始字节；
src/lib/format-number.ts、format-bytes.ts、src/models/formatting-preferences.ts
保留原始函数体，仅调整导入路径。原文快照与来源摘要记录于 tests/conformance/sources.json。
Rust progress.rs、file_system.rs 以及 net.rs/ops.rs 的新增契约参考同一 Desktop 版本，
通过未改写的上游测试验证。TypeScript 工具覆盖与 Rust 覆盖分别登记。

Desktop 后续移植还包括终端流、HTTP/OAuth 与凭据状态机、仓库/账号/提交/分支/工作树模型、
仓库分组、仓库规则、CI checks、文本与发布说明解析、Copilot 提示词/冲突上下文/响应重组/
模型选择/内存文件系统。适配后的 TypeScript 位于 `src/lib/`、`src/models/`，原始文件完整
快照保存在 `tests/conformance/upstream/desktop/production/`；按原始字节保留的模块位于
`src/upstream/`。所有来源路径及 SHA256 见 `tests/conformance/sources.json`。
Rust `credential_protocol.rs`、`terminal.rs`、`porcelain.rs` 和完整提交查询参考同一 Desktop
版本。原版测试辅助器也保留该项目 MIT 许可证；测试适配不代表使用 Electron 运行时。

Additional GitHub Desktop MIT ports include UI primitives, native-boundary dialog
and clipboard contracts, accessible tooltips, branch/repository/worktree items,
CI status, Issue completion, appearance, DDS conversion, repository databases and
stores, Git error representation, build SHA discovery and release utilities.
Original source files and hashes are recorded in tests/conformance/sources.json.
Platform changes use Tauri/WebView APIs, React 19 types/events, and local asset URLs.

Additional MIT ports include CommitMessage/autocompletion, welcome and update
dialogs, their SCSS dependencies, AppStore account/indicator method closures,
native notification/trampoline managers, SDK authentication, and the unchanged
app-launch E2E suite. Hash-registered SCSS lives under `src/upstream/styles`;
platform adapters remain outside those immutable files.
