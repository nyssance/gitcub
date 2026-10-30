# GitCub

面向 GitHub 与 GitLab 的 Git 桌面客户端。Tauri 3（alpha）+ Rust + React。

Tauri 版本对齐 alwith-desktop / alwith-u：Rust 核心与 Wry runtime 使用
`3.0.0-alpha.5`，显式注册 Wry；JS API 和插件使用对应的 3.0 alpha 版本。

名字取自印加的结绳记事——一串绳结记录一段历史，正是 commit history 在做的事。
《易经》里也有「上古结绳而治」。

## 为什么做

GitHub Desktop 有两个没法绕开的问题：

- **零国际化**。867 个文件、10 万行 UI 全是硬编码英文，没有任何 i18n 基础设施。
- **不支持 GitLab**。国内大量公司私有部署 GitLab，它只认 GitHub。

GitCub 从第一天就上 i18n，并把两个平台放在同等位置。

## 架构

```
本地热路径   status / 索引读写 / 分支列表        gix 进程内
git CLI      fetch / push / commit / diff / apply  低频、由用户触发
```

`gix`（gitoxide）不做这几件事，是查证过的：

| 能力 | gix 0.87 | 上游状态 |
|---|---|---|
| push | ✗ | issue #306 以 `not_planned` 关闭 |
| 从 index 写 tree | ✗ | 无对应 API，因此无法 commit |
| ahead/behind | ✗ | 需自行实现图遍历 |

走 CLI 反而白捡了 hooks、GPG 签名、credential helper、`core.quotepath`
等一整套用户已有配置的正确行为。

## 目录结构：怎么既跟上游又用新框架

原版源码、Desktop 兼容组件、标准基础控件和业务组件分别维护。目录边界如下：

```
src/
  upstream/     逐行照搬原版，一行都不改 —— 可机械同步
  lib/          Tauri 适配、应用服务与领域工具
    ui/         非组件的 UI 工具：主题、调度、ref、活动监测等
  ui/
    base/       标准 shadcn / Base UI 基础控件
    desktop/    保留 Desktop 调用契约的兼容组件，内部使用标准基础控件
      dialog/   Desktop 对话框契约适配
      list/     Desktop 列表选择与虚拟滚动契约
    shared/     GitCub 自有的跨业务展示组件
    changes/    更改、提交、作者输入与提交署名
    diff/       diff 业务组件；辅助逻辑统一引用 upstream/ui/diff
    branches/   分支业务及分支名校验界面
    sign-in/    登录流程、认证表单和企业实例入口
    preferences/ 偏好设置与 Git 用户配置
stories/       自定义组件和业务组合的 Storybook 场景
.storybook/    预览配置、测试模拟与浏览器验收
src-tauri/src/  Rust 后端；git 参数组合照抄原版，注释标出处
```

| 层 | 跟上游的方式 | 为什么能/不能照搬 |
|---|---|---|
| `upstream/` | 按上游清单同步原始源码 | 不在业务目录复制第二份同名实现 |
| `src-tauri/` | 人工对照它的 `lib/git/*.ts` 更新参数 | 语言不同，但 git 命令行是稳定契约 |
| `ui/desktop/` | 对照原版实现和调用契约 | 基础控件适配至 shadcn；平台差异接入 Tauri |
| `ui/<业务>/` | 保留业务行为，移植组件核对完整样式依赖 | 用 Storybook 和上游测试验证实际覆盖的场景 |

`ui/lib/` 和 `ui/dialog/` 已移除，不保留旧路径转发文件。原版测试快照中的历史路径
仅由 `tests/conformance/desktop-ui-paths.json` 映射到新目录，生产代码直接引用实际位置。

`upstream/` 的唯一规矩是**不改**。缺全局变量或类型就在 `upstream/globals.d.ts`
里 `declare`，编译规则冲突就在根 tsconfig 放宽，要改行为就在 `lib/` 写适配层。
细则见 [upstream/README.md](src/upstream/README.md)。

```sh
fab vendor          # 交互管理 Desktop / GitLens 参考仓库：查看、同步、压缩
fab vendor-status   # 看上游哪些文件变了、落后多少 commit
fab vendor-sync     # 覆盖并更新 .source-commit
fab check           # 行为由测试兜底
```

参考源码位于上层 `Vendor/desktop` 和 `Vendor/vscode-gitlens`，来源记录在
`vendors.json`。Desktop 用于 Git 操作和界面行为对照；GitLens 用于历史、分支图、
blame 等功能参考，不机械复制进项目。

`fab vendor` 直接移植 ALwith Desktop 的管理实现：查看清单与大小、并发同步、
实时进度、自动补录和 blobless 压缩。同步处理全部仓库；压缩处理全部符合条件的仓库，
不增加仓库选择。新克隆和压缩都使用 `git clone --single-branch --filter=blob:none`。
仓库管理与 `fab vendor-sync` 的项目内文件同步保持分开。

## 自定义组件预览

```sh
bun run storybook        # http://localhost:6006
bun run storybook:build  # 静态预览输出到 storybook-static/（已忽略）
bunx playwright install chromium  # 首次运行浏览器验收
bun run storybook:test   # 构建后验收全部 stories，包含 play 交互断言
```

`stories/` 只收录自定义组件与业务组合，不为原版 shadcn/ReUI 基础组件重复建示例。
目前有 29 类、173 个自定义业务场景；具体范围见下表。
工具栏可切换深浅主题和中英文；使用生产组件、样式与国际化资源。

浏览器验收独立组合两种主题、两种语言与两种视口，合计每个 story 8 项验收。
独立组件的窄视口为 360px，完整桌面页面使用 Tauri 配置的最小窗口宽度；宽视口为 1000px。
验收检查 Storybook 完成状态、交互断言、无障碍报告及浏览器错误。
无障碍检查通过 Storybook 的 a11y 插件执行，失败会阻止验收通过。
自动验收使用独立的 6007 端口，可与 6006 上的开发预览同时运行。
`__mocks__/@tauri-apps/plugin-os.js`（通过 `sb.mock` 注册） 仅固定 macOS 展示环境；业务操作使用可断言的回调，
不访问真实仓库或凭据。原生读接口夹具见 `.storybook/mocks/native.ts`，未知调用会使验收失败。
迁移对照见 [自有 UI 回归迁移表](tests/conformance/README.md#自有-ui-回归迁移到-storybook)。
Storybook 不代替 Hasgard 原生端到端验证和 Rust Git 行为测试。

发布到 alwith.dev 使用官方 CLI，不另建本地基线系统。设置 `ALWITH_DEV_CLI` 为官方
`alwith.dev/cli/src/main.ts` 的绝对路径，`ALWITH_DEV_PROJECT` 为已注册的项目 slug，
`ALWITH_DEV_SERVER` 为服务地址；上传令牌通过 `ALWITH_DEV_TOKEN` 环境变量提供。
提交源码后运行 `bun run storybook:publish --dry-run` 自检，去掉 `--dry-run` 才上传。
入口会重新构建 Storybook；官方 CLI 校验工作区干净且对应登记的 HEAD、产物不含 sourcemap、
内嵌源码或本机路径。CI 的提交／分支／PR 基准信息交给官方 CLI 解析。
线上项目和上传凭据尚未配置，不能把本地通过称为已建立线上基线。

| 自定义业务范围 | 场景和关键断言 |
|---|---|
| 关于 GitCub | 作者 GitHub 链接、外部打开调用 |
| 设置、欢迎流程、虚拟列表 | 设置读取完成前禁止写入、刷新远端保留忽略规则编辑、页签、键盘、焦点、布局、语言、受控／非受控滚动、卸载 ref |
| 提交图、分支行、作者、路径、提示条、CI 步骤 | 状态、长文本、重命名同行、关闭／撤销、跳转回调 |
| Blame | 十万行虚拟滚动与末行提交跳转、切换文件后忽略旧结果与旧错误、加载、空、错误、提交选择与关闭 |
| 子模块 | 切换后打开正确子模块、加载、错误、干净／脏状态、打开正确路径 |
| 图片 Diff／加载 | 切换图片后忽略旧结果与旧错误、新增、删除、过大、并排／滑动／洋葱皮／差值、滑块键盘操作 |
| 统一文本 Diff | Desktop 原版行号与 SVG 勾选、全选／部分选择、整块切换、悬停、展开上下文、跨行拖动、十万行搜索与虚拟渲染 |
| Diff 工作流 | 展开／折叠、原始行号选择与丢弃、连续修改块、空白过滤选择提示、逐个搜索匹配、全选复制未渲染行、展开失败重试与过期结果 |
| 改动文件列表 | Desktop Cmd／Shift 多选、批量勾选／丢弃、键盘导航、部分选择、一万文件虚拟渲染 |
| 分栏文本 Diff | 两侧文本、只读、逐行选择保持邻行不变、搜索与换行 |
| 提交摘要和文件列表 | GitHub／GitLab 子组 issue 链接、离线文本、全部文件状态、选择回调、长路径 |
| 历史侧栏 | 提交选择、搜索与清空、错误恢复、等待搜索时禁止重排、切换比较清除旧结果、合并回调、空历史 |
| PR/MR 创建 | GitHub fork／GitLab 子组 URL 和项目 ID、上游分支、无远端、游离 HEAD、加载、远端发现／目标查询失败重试、推送失败不跳网页 |
| PR/MR 列表及 CI | 搜索与检出参数、网页评审、重跑前必须确认、加载／空／失败重试 |
| 趋势页 | 旧榜单不能覆盖新筛选结果、打开平台、加载／失败、目录选择取消／异常／防重复 |
| 贮藏与冲突处理 | 恢复／丢弃回调、空与长消息、双方版本选择、冲突未解决禁止继续、继续与中止操作 |
| Inbox | 空、加载、本地冲突／未推送、远端评审、失败后重试 |
| 标签 | 搜索与计数、精确推送／远端删除 refspec、取消删除不得写入、确认期间锁定、确认异常、加载／空／失败重试 |

以上是明确覆盖的业务场景，不代表所有自定义组件、所有分支或真实服务行为已覆盖。
原生登录、凭据、Git 写入、系统集成继续由 Hasgard/Rust 验收；截图目前用于复核，不冒充像素基线回归。

## 部分暂存

行级选择的数据模型、diff 解析与补丁生成移植自 GitHub Desktop（见 NOTICE.md）：

```
git diff --patch-with-raw -z  →  DiffParser  →  界面勾选
                              →  formatPatch  →  git apply --cached
```

## 开发

任务入口是 `fabfile.py`（Python 3.15，依赖 fabric、rich、InquirerPy；约定同 alwith-desktop），`fab -l` 看全部：

```sh
fab install         # 装依赖 + hasgard CLI + 下载随包 git
fab dev             # tauri dev
fab f               # Rust 格式化 + import 排序 + Bun fmt
fab fix             # Clippy / Bun lint 修复 + 格式化 + 换行归一
fab check           # 类型、lint、工具测试、Rust 编译 / 测试，最后汇总
fab clean           # 交互选择 cargo sweep、cargo clean 或仅清空目录
fab info            # Tauri 环境信息
fab build           # 打正式包并报体积
fab vendor-status   # 照搬的上游代码落后多少 commit
fab upgrade         # 升级依赖（跨大版本只报告，由人决定）
```

### 随包分发的 git

二进制取自 [desktop/dugite-native](https://github.com/desktop/dugite-native)——
GitHub Desktop 用的同一个源，各平台预编译且附校验和。

打包它是为了不依赖用户装没装 git，也不受其 git 版本影响：
我们用了 `-z`、`--patch-with-raw`、`--unidiff-zero` 等参数，老版本上行为可能不一致。
开发时如果没跑下载脚本，会自动回退到 PATH 上的 git。

`fab git-download` 会剥掉三部分，148MB → 28MB：

| 剥掉的 | 省 | 理由 |
|---|---|---|
| Git Credential Manager | 107MB | 整个 .NET 运行时 + Avalonia UI；我们用自己的 `GIT_ASKPASS` |
| `git-http-backend`、`git-shell`、`scalar` 等 | 13MB | 前两个是**服务端**组件，客户端用不到 |
| 142 个 `git-*` 兼容符号链接 | — | 现代 git 单体二进制内部分发；**且 Tauri 打包会跟随符号链接**，不删的话进包会膨胀到 500MB+ |

成品：`GitCub.app` 51MB，DMG 21MB。

> macOS 分发还需要对包内 git 逐个签名并公证，否则 Gatekeeper 会拦。待处理。

调试用 [tauri-hasgard](https://github.com/nyssance/tauri-hasgard) 驱动 WebView：

`fab dev` / `bun run dev:tauri` 自动启用 `hasgard-testing` feature；默认正式构建不包含
Hasgard 插件和自动化权限。

```sh
tauri-hasgard snapshot
tauri-hasgard eval 'document.querySelector(".list-scroller").scrollHeight'
```

## 许可

AGPL-3.0。包含移植自 GitHub Desktop 的 MIT 代码，见 [NOTICE.md](NOTICE.md)。


## Desktop 行为基准

`tests/desktop/manifest.json` 固定 Desktop commit，并登记 `app/test`、`script`、
`eslint-rules` 中的测试文件摘要。它是完整的文件清单，不是用例数量或覆盖率。
Rust 移植在 `src-tauri/src/desktop_tests/`，直接调用生产模块，使用 Git 和文件系统
独立检查结果。每项移植记录原始用例标题、Rust 测试名及适配差异。

```sh
python3 scripts/desktop_tests.py                    # 校验映射；有 Vendor 时检查上游变化
python3 scripts/desktop_tests.py --sync             # 更新全量清单；变化的已移植文件标记 stale
python3 scripts/desktop_tests.py --require-complete # 完整性门禁：仍有 pending/partial/stale 就失败
cargo test --manifest-path src-tauri/Cargo.toml desktop_tests
```

`bun run test:upstream` 直接运行保留原始断言的 Desktop / GitLens 测试快照，通过
测试专用 JSON 桥调用 Rust 生产模块；UI/store 调用生产 TypeScript；E2E 操作真实 Tauri 应用。
macOS 全套测试还需要 `cargo install tauri-hasgard-cli --version "^0.6" --locked`。
执行与适配边界见 [原版测试说明](tests/conformance/README.md)。

`fab check` 会运行清单回归检查、原版行为测试和全部 Rust 测试。普通测试通过只证明已实现的场景通过，
不代表完整性门禁通过。固定版本登记 252 个 Desktop 文件，其中 6 个 ESLint 开发规范测试按用户要求移出执行范围；其余 246 个文件接入，包括 UI、原生模块、
工具脚本和真实 Tauri E2E。文件数不是覆盖率；Windows 运行时和真实服务行为不在此结论内；不支持 Linux。
更新安装与重启另有 macOS 隔离回归，不等同正式分发验收。跳过的用例不能算已验证。
没有 Vendor 的 CI 只检查固定清单和本地实现，不声称检查过上游最新变化。

上游测试变化后必须复核操作、夹具、断言和平台条件，不能仅更新摘要以消除失败。
不以改弱上游断言、吞掉错误或跳过失败用例来宣称等价。GitCub 独有回归单独登记。


GitLens 作为第二个独立基准登记在 `tests/gitlens/manifest.json`，覆盖版本控制中的
扩展、包和 E2E 测试文件，夹具里的示例测试归入辅助材料而不重复计数。清单还记录
blame、搜索与比较、分支图和 Inbox/Launchpad 对应的 GitCub 文件、上游测试及已知差异。
GitLens blame/worktree 解析已接入原版断言，其余场景仍按清单标记 pending；不能把现有
GitCub 自有测试直接算作 GitLens 原版测试。

```sh
python3 scripts/desktop_tests.py --source gitlens
python3 scripts/desktop_tests.py --source gitlens --sync
python3 scripts/desktop_tests.py --source gitlens --require-complete
```

`fab check` 同时校验两个来源的清单。Desktop 的 Git 操作基准和 GitLens 的功能基准
分别跟踪，不因一个来源测试通过就推断另一个来源也兼容；重叠功能出现不同预期时，
明确记录采用哪种行为及理由，不把两个实现的片段混成新的隐含规则。

## PR / MR 与 CI 的实现边界

待办页独立请求各实例的待评审和本人创建列表，一类请求失败不会丢弃另一类的成功结果。
加载失败会显示错误并允许刷新，不能显示成“没有待办”；显式刷新失败不会静默返回磁盘旧缓存。
GitHub 的 CI 汇总同时检查 Checks 和旧式 commit status；GitLab 从 MR 详情读取 head pipeline，
不假定列表响应一定包含流水线。详情查询按每批最多 8 条并发执行。

重跑不解析网页 URL：GitHub 通过 check suite 对应 workflow run ID；GitLab 将 commit status ID
与该提交流水线返回的 job ID 对照，只向核实的 job 提供重跑操作。多个失败检查对应同一工作流时
只提交一次重跑请求。权限错误会显示；未匹配到原生任务的外部检查不提供重跑按钮。
接口依据 [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)、
[GitLab jobs](https://docs.gitlab.com/api/jobs/) 和
[GitLab merge requests](https://docs.gitlab.com/api/merge_requests/)。

这些是 GitCub 自有功能与回归，不计入 Desktop / GitLens 原版测试覆盖。
本地验证涵盖编号映射、平台路由、CI 状态汇总及模拟 HTTP 的分页和失败处理；
不代表已经在真实账号上验证重跑权限或全部自建实例版本。当前仍需相应 Checks / Actions / CI
读取权限；MR 合并结果流水线、子流水线和跨项目流水线的完整追踪尚未验证。


## macOS 账号与恢复

欢迎页和设置页共用 GitHub/GitLab 设备授权；自建实例显式选择服务类型，并保存各自的应用 ID。
GitLab 授权请求 `api write_repository`，以支持 MR／CI 写操作和 Git 推送。
短期令牌及刷新令牌由原生层保存并续期，前端持有的账号身份在续期后仍可解析到当前令牌。
关闭或取消登录会作废后端尝试；退出、更换账号后，旧请求不能覆盖新凭据。
协议依据 [GitLab OAuth](https://docs.gitlab.com/api/oauth2/)、
[GitLab scopes](https://docs.gitlab.com/integration/oauth_provider/) 和
[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

远端分支检出建立跟踪分支，推拉使用当前分支配置的远端和上游分支名。
clone／rebase／cherry-pick 通过 Tauri Channel 发送运行中的进度；冲突状态从磁盘恢复。
工作树监听覆盖外部 Git 元数据目录，修改忽略规则时清空过滤缓存；切换仓库后丢弃旧状态请求。
macOS 路径别名先统一再注册监听；连续编辑同一个文件时，即使 Git 状态未改变也刷新选中 diff。
应用状态和开发凭据采用原子文件替换，避免中断留下半份文件。

本地回归不能替代真实账号、企业部署环境或长期稳定性验收。签名与公证属于独立发布工作。


真实 GitHub 验收需明确授权仓库后手动运行：

```sh
bun run test:live:github --repository owner/name
```

该命令使用现有 `gh` 登录，在临时目录启动隔离应用，并通过生产 Tauri 命令执行克隆、
暂存、提交、推送、PR 创建与 CI 失败重跑。它创建独立的临时分支和 PR，测试完成后关闭 PR、
删除远端测试分支及隔离凭据副本；不合并，不推送默认分支。它不会进入普通 CI。
结果保存在 `test-results/live-github/report.json`；清理失败会返回失败并记录待处理对象。

2026-10-19 已在项目自身的私有仓库 `nyssance/gitcub` 实测原生账号读取、HTTPS 克隆、暂存、
提交、认证推送、fetch/pull、跟踪分支及 PR 创建；[测试 PR #1](https://github.com/nyssance/gitcub/pull/1)
已关闭，远端临时分支和隔离凭据已清理，未合并或修改默认分支。测试使用现有 CLI 凭据，
不代表浏览器设备授权已实测。Actions 在等待期限内一直排队，因此真实 CI 重跑仍未验收；
取消接口返回 409，而读取接口仍显示排队，相关证据保存在报告中。

真实 GitLab 验收针对你自己控制的自建 GitLab 实例，实例地址只通过环境变量传入，不写进仓库：

```sh
GITCUB_LIVE_GITLAB_HOST=<hostname> bun run test:live:gitlab --project group/subgroup/name
```

该命令用 `git credential fill` 从系统凭据助手读取该主机的令牌（仅驻留内存，写入隔离应用的凭据副本后在结束时删除），
在临时目录启动隔离应用，通过生产 Tauri 命令执行账号识别、含子组项目的仓库列表（与独立分页的 API 结果逐项核对）、
HTTPS 克隆、暂存、提交、推送、fetch/pull、MR 创建、流水线失败任务的原生重跑，并通过 GitLab API 独立确认重跑任务成功。
它只操作独立的临时分支和 MR，结束后关闭 MR、删除远端分支；不合并，不推送默认分支。项目没有可用在线 runner、
或任务在限定时间内无人领取时，CI 步骤记为跳过并写明原因，其余步骤照常验收；`--ci-tags a,b` 可显式指定任务标签。
结果保存在 `test-results/live-gitlab/report.json`，报告与控制台输出中的实例地址一律替换为 `<host>`。

`bun run bench` 在合成的 5 万文件仓库和传入的真实仓库上，把 Rust/gix 的 status、历史翻页与 Desktop 的等价 git 命令放在同一进程里对照计时；
方法、数据和未覆盖项见 `docs/benchmarks.md`，原始报告写入 `test-results/benchmark/report.json`。

2026-10-27 已在一台自建 GitLab 18.9 CE 实例的专用测试项目上实测全部步骤：群组机器人账号识别、26 个项目
（含子组项目）的列表核对、私有项目 HTTPS 克隆、暂存、提交、认证推送、fetch/pull、跟踪分支、MR 创建、
原生重跑失败任务并由 API 独立确认重跑任务成功；测试 MR 已关闭，远端临时分支与隔离凭据已清理，默认分支未改动。

2026-10-29 在同一实例上用户授权的专用验收项目（124 个分支、含二进制文件、重命名与合并历史、两个待合并 MR）复测：
原生全部 8 步再次通过，27 个项目（含子组）的列表与两页 API 结果逐项一致；`tests/macos/live-gitlab-transport.ts`
只读复测 HTTPS 拉取、无权限账号的 SSH 拉取在 3 秒内报出 GitLab 原因、断网拉取不挂起、网络恢复后同一仓库拉取成功。
有权限的 SSH 克隆仍未验收：只读 Deploy Key 已通过 API 登记，但实例的 sshd 未接受该密钥（需实例侧重建 authorized_keys 或改用已授权账号的密钥）。

### 发布

发布流程照搬 ALwith U：推送 `v<版本>` 标签（必须等于 `src-tauri/tauri.conf.json` 的 `version`）后，
`release.yml` 在 macOS runner 上用 Developer ID 签名、公证（.app 与 DMG 都盖章）、生成更新器包（`.app.tar.gz` + `.sig`）
和 `latest.json`，在公开仓 [nyssance/releases](https://github.com/nyssance/releases) 建草稿 Release `gitcub-v<版本>`，源码仓保持私有。
人工检查发布后，再手动运行工作流并填 `publish_latest=v<版本>`，把 `latest.json` 覆盖到固定的 `gitcub-latest` Release，
更新器端点只读那里。不带参数的手动运行只出未签名的安装包作为工件。目前只发 macOS（Apple Silicon）。

仓库 secrets：`APPLE_CERTIFICATE`（Developer ID Application 证书导出的 .p12 做 base64）、`APPLE_CERTIFICATE_PASSWORD`、
`APPLE_SIGNING_IDENTITY`（形如 `Developer ID Application: 名字 (TEAMID)`）、`APPLE_ID`、`APPLE_PASSWORD`（App 专用密码）、
`APPLE_TEAM_ID`、`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`RELEASE_TOKEN`（只对 nyssance/releases 有 Contents 读写的 fine-grained token）。更新器私钥只在本机 `~/.tauri/gitcub.key`
和仓库 secrets 里，公钥写在 `tauri.conf.json`；丢了私钥或密码就再也签不出已装用户认的更新。

### 原生菜单与双栏 Diff 的适配

菜单模板沿用固定的 Desktop 源码，运行时按 `app/src/lib/menu-update.ts` 的条件映射
本项目的仓库状态，再更新 Tauri 的原有菜单句柄；不通过反复重建菜单替代状态更新。
分叉分支的菜单提供带确认的 `--force-with-lease`，PR/MR 关联同时核对源仓库和实际 push URL。
筛选／贮藏显隐、文本全选、焦点侧栏每次 5 像素的宽度调整共用应用动作。
中文文案在呈现层适配，上游菜单模板及其原始断言保持不变。

双栏 Diff 的行配对、连续改动组、两侧 token 和临时拖选范围来自
`app/src/ui/diff/side-by-side-diff.tsx`；虚拟列表接口适配为 TanStack Virtual，
词法 token 使用本项目的 CodeMirror 6 worker。松开鼠标后才提交勾选范围，勾选不直接修改
Git index；连续改动段之间的上下文不会把不相邻改动合并成一个全选组。
两种视图共享折行设置，原生窗口回归验证实际勾选状态、双侧高亮和 Git index。

`tests/conformance/workflow-navigation.test.ts` 和 `macos-workflows.test.ts` 中的新增用例属于
GitCub 集成回归，不计作新增的上游原版测试。此处的 GitLab fork 测试使用隔离 Git 仓库；
截至本轮验收未发现可用的 GitLab CLI、环境令牌或 gitlab.com Git 凭据，真实 GitLab 服务验收仍未完成。

设置页导航统一使用项目的 shadcn `base-vega` / Base UI 垂直 Tabs；不再使用手写的 TabBar
包装器及其全局竖排样式。选中状态由 Base UI 管理，图标与文字为同一 flex 行的直接子项。
原生窗口回归逐页检查五个导航项的对齐、透明未选中背景、唯一选中态及对应面板。

开发工具链使用 Bun Canary（需提供 `bun fmt` 与 `bun lint`）；CI 同样安装 Canary。格式与 lint 配置统一放在 `bunfig.toml`。执行 `bun fmt`、`bun lint` 或 `bun lint --fix`；Rust 仍使用 rustfmt / Clippy。

Lint 分两步：Bun 默认推荐规则，及与 ALwith Desktop 共用的 `@nyssance/ts7-lint` 现代语法规则（含循环依赖检查）。后者的规则只在那个包里，`bunfig.toml` 不放共享规则。`bun lint` 和 `bun lint --fix` 依次执行 `bun lint` 与 `ts7-lint`；本地 `fab lint` / `fab check` 与 CI 共用此入口。上游快照、夹具、原版 shadcn/ReUI 组件不参与改写。默认警告不阻断，错误返回非零；格式化仅由本地主动执行，不纳入检查入口。

本地迁移：设置 → 高级 → 从 GitHub Desktop 导入。读取本机 Desktop 的仓库清单、主题、侧栏宽度及已支持的编辑器/终端，合并已有仓库，跳过无效目录。Git 身份共享系统 Git 配置；账号需在 GitCub 登录，不复制 Desktop OAuth 凭据。

首次引导会检测本机 GitHub Desktop，并询问是否导入；导入或跳过后持久化选择，不重复询问。Windows 从 `%APPDATA%/GitHub Desktop` 读取数据，从 `%LOCALAPPDATA%/GitHubDesktop` 检测默认安装；支持将已安装的 VS Code、Cursor、Command Prompt、PowerShell、Windows Terminal、Git Bash 等映射为本机集成。
