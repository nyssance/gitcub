# 项目规则

## 产品目标与自主推进

- 用户已于 2026-10-21 明确移除 Copilot：不再提供 AI 提交信息生成、AI 冲突解决、Copilot 设置或应用交接，不打包 SDK、Koffi、独立 worker 或其 Webpack 构建链。相关上游快照仅保留溯源，测试登记明确排除该功能；普通 Git 工作流继续验收。

- 目标是打造世界最佳 GitHub 客户端，在可靠性、性能、Git 工作流和协作体验上超越官方，并将 GitLab（含子组、自建实例）作为一等支持平台。
- 项目规则只维护本文件，不再建立重复的 `AGENT.md`。目标是建设方向，不代表已经达成。
- 用户于 2026-10-27 明确：世界最佳是交付标准，不是口号。每次交付后必须回答「现在是最佳了吗」：对照 Vendor/desktop、Vendor/vscode-gitlens 和实测数据列出仍不是最佳的地方、依据和建议顺序，用户确认后继续做，不以「与上游对齐」或「测试通过」为终点。
- 性能结论只认 `bun run bench` 的实测：同一进程里把 Rust/gix 热路径与 Desktop 原样的 git 命令对照（git 侧只计进程，是 Desktop 的下界），结果连同未覆盖项写进 `docs/benchmarks.md`。两边跑同一条 git 命令的路径只能报持平，不得宣称更快；热路径里每次调用都起 git 进程视为缺陷，优先用 gix 替代并以基准验证。
- 优化按数据排序：先把怀疑的开销加进基准测出来再改，改后复测同一组仓库；绝对值随系统状态波动时只比同一次运行里的两侧。
- 按目标自主连续推进，一口气完成当前条件下尽可能多的完整工作，不停留于计划或清单，不等用户逐项指出问题。
- 优先保证数据与凭据安全、Git 正确性，再打通两平台真实工作流、性能与高级功能。兼容性和性能结论必须有实际验证。
- 共享功能不能只实现 GitHub 分支后声称兼容 GitLab；必须考虑分页、权限、错误恢复和自建实例。
- 功能范围以用户明确要求和 Vendor/desktop 实际实现为准。“世界最佳”“一口气做完”“测试”均不代表可以自行新增功能或扩大验收范围。原版没有、用户未明确要求的功能，不自行添加；GitLab 支持只做已授权功能的对应适配，不借此扩展产品范围。
- PR/MR 创建、评论、评审、批准／请求修改和合并使用托管平台网页，不自行增加应用内管理流程。CI 仅保留经 Vendor/desktop 源码核实的既有状态、步骤和重跑能力，日志详情打开网页；不新增应用内评审、日志或产物管理。核对原版功能必须给出具体源码与调用链，不凭印象声称原版有或没有。
- 按用户明确要求，GitHub CI 只支持 Checks API，不接入旧式 Commit Status API，也不将其列为待补齐功能。这是相对 Desktop 的有意差异；GitLab 原生状态与任务接口不受此规则影响。
- 默认验收聚焦 Desktop 本地导入、账号识别、仓库列表、克隆、拉取、提交、推送及 UI 一致性。不把真实 PR/MR 创建、CI 触发或重跑列为默认验收任务、完成条件或产品缺口；用户要求一般测试时不得自动执行这些远端写操作，只有用户当前明确要求专项验收时才纳入。
- 用户纠正功能范围后立即更新本文件中的对应规则，清除冲突表述；不得只在聊天中承诺后继续按旧范围推进。
- 当前开发与验收以用户实际使用的 macOS 为优先；先完成 macOS 已授权的功能和原生回归，不反复以 Windows 验收作为交付缺口，也不擅自转向 Windows 专项工作。
- 参考 Vendor/desktop 的成熟行为与原版测试、Vendor/vscode-gitlens 的高级能力，持续跟踪上游更新；超越官方不等于无依据重写基础能力。
- 每次交付完成相关格式化、类型检查、lint、Rust 检查及行为测试，报告实际完成范围和仍未完成的部分。
- 已授权的开发、修复和可逆验证持续执行，不为常规实现选择重复请求确认；发布、真实账号写操作仍遵守用户授权范围。

- 用户于 2026-10-22 明确要求凭据只导入一次：仅显式导入时读取外部凭据并存入 GitCub 自己的凭据存储；启动、切仓库、刷新不得重读 Desktop 钥匙串或反复触发授权。拒绝授权后不得后台重试。
- 所有可能阻塞的 Git、文件、进程及凭据操作必须离开 UI 主线程，使用阻塞任务池；不得只给函数加 async 后仍阻塞异步运行时。
- 用户于 2026-10-26 决定去掉 Dexie/IndexedDB：Desktop 数据库（仓库、用户、Issue、PR、统计）改用 Rust 侧命名 JSON 存储，与 ALwith Desktop 共用 crates.io 的 `alwith-module-store`，前端经 `@alwith/module-store` 访问；`src/lib/databases/base-database.ts` 只保留 Desktop store 实际使用的 Dexie 表 API 子集。原版 Dexie 迁移测试登记为排除，不再引入浏览器数据库或新的持久化方案。

## 文案与 i18n

- 用户于 2026-10-30 明确：i18n 的 key 必须能看出 value 是什么——按英文文案的 camelCase 命名（`addRepository`、`searchRepositories`、`thirdParty`），不用 `add`、`search`、`third` 这种和文案对不上的缩写；中英两份文件 key 一一对应，新增或改文案时同步改 key。

## 项目结构

- 使用标准 Tauri 单应用布局：根目录 `src/`、`index.html`、`package.json`，Rust 放在 `src-tauri/`；不再增加 `app/` 包装层或重复的前端包配置。
- UI 目录按职责划分：`ui/base` 为标准基础控件，`ui/desktop` 为 Desktop 契约兼容组件，`ui/shared` 为自有通用展示组件，其余业务组件归属对应业务目录；非组件 UI 工具放在 `lib/ui`。不恢复混杂的 `ui/lib`，不保留搬迁前路径的转发壳。上游已有辅助实现直接复用 `src/upstream`，不在业务目录另存副本。

## 移植

- 用户要求移植时，一比一复制指定项目的实现及所需辅助函数、导入和配置；不得自行重写、简化或重新设计。
- 只调整本项目确实不同的路径及用户明确要求的差异；验证完整调用链，不只做语法检查。
- Desktop 原版业务组件的一比一核对必须包含 JSX、交互、辅助函数、样式及其全局依赖（盒模型、字体、间距、圆角、状态色）；不能仅凭复制了宽度公式或部分测试通过宣称一致。原版业务区域的尺寸与状态样式不得替换为 shadcn 通用 token；基础控件仍遵守下方 shadcn 优先规则。
- 用户于 2026-10-30 明确：状态管理照 alwith-desktop 用 zustand，按功能一个 store（`features/<x>/store.ts` 的组织方式），不在 App 组件里堆 useState（2026-10-30 时 App 有 54 个 useState，原生菜单 effect 的依赖循环就是这种结构的直接后果）。大量异步编排（IPC 串联、操作互斥、刷新合并、PR/MR 检出这类多步流程）用 effect-ts，不再手写 Promise 链与 ref 标志位。
- 用户于 2026-10-30 给出分工：选中项、弹窗、筛选条件用 zustand（只属于单个组件的局部状态可用 useState）；派生显示数据用 selector 或渲染时计算，不另存一份状态；请求、重试、并发、资源释放用 Effect；业务错误与服务依赖用 Effect。过期请求靠中断 fiber 丢弃，不用会话计数器或 stale 标志。
- 用户于 2026-10-30 明确：一比一指的是行为、结构和样式，React 写法以 alwith-desktop（`/Users/ny/Projects/ALwith/alwith-desktop`）为范本——函数组件、hooks、动画用 motion 的 AnimatePresence；不照搬 Desktop（React 16）的 class 组件，也不引入依赖 findDOMNode 的旧库（react-css-transition-replace 在 React 19 下把 ref 挂到 class 子组件拿到的是实例，渲染抛错卸掉整棵树，2026-10-30 原生套件 8 个用例因此失败）。移植后的组件必须在本项目的 React 版本下跑过原生回归。

## Vendor

- vendor 实现完全照搬 ALwith Desktop，不自行重写、简化或另造管理方式；只做本项目路径、清单及用户明确要求的差异适配。
- 同步和压缩直接处理清单中的全部仓库，不增加仓库选择步骤。
- 只维护远端默认主分支，使用 `git clone --single-branch --filter=blob:none`；压缩采用 blobless 单分支重克隆，不用保留所有分支的 `git gc` 替代。

## 依赖版本

- 升级依赖时沿用项目既有的版本约束粒度，不得擅自补全小版本号或补丁号。
- Cargo 稳定依赖中，`0.x` 保持 `"0.x"`（例如 `"0.23"`，不要写成 `"0.23.1"`）；已有整数主版本约束保持整数主版本写法。
- 精确解析版本由锁文件记录；升级依赖时同步更新锁文件并完成必要的 API 适配和验证。
- 预发布版本保留必要的 alpha / beta 标识；用户明确要求精确版本时遵从用户要求。

## 共享 Atlas 布局

- Atlas 沿用 Desktop 的 `region` 区域语义，公开类型、参数、状态和 DOM 标记统一使用 `region`，不另设同义的 `panel` 命名。
- 横滑面板、吸附、输入仲裁和触控板原生采集由独立的 `@nyssance/atlas` 库维护；本项目只组合业务面板，不另存 Embla 控制器或原生手势副本。
- Atlas 原生桥通过 crates.io 的 `atlas-tauri` 版本依赖获取，不再从 `node_modules` 或同级源码仓读取 Rust crate；前端包与 Cargo 包独立分发。
- Atlas 核心不绑定框架，提供 React、Vue、Angular、Svelte 及 Tauri 接入边界；兼容性只按实际验证范围报告。
- 用户于 2026-10-22 明确收敛原生触控板手势范围：目前仅支持 Wry，CEF 暂不支持，不继续为 CEF 自造采集方案，不引入私有 API 或要求关闭 App Sandbox 的库。CEF 宿主保留 Atlas 布局、鼠标与键盘操作；不得将布局兼容宣称为原生三指手势兼容。
- Atlas 自有代码同样采用 TS7、ESNext 与共享 `@nyssance/ts7-lint` 现代语法规则；CI 和本地使用同一检查入口。
- Atlas 用单一 `gutter` 参数控制固定的视口左右留白和随面板移动的两侧半间隙，默认 4px；下边距默认 `gutter * 2`，显式 `insetBottom` 可覆盖，内容 padding 独立。鼠标平移按 Desktop 默认中键，通过 `panButton: "middle" | "side"` 传参和运行时更新；库不提供设置界面或保存宿主偏好。

## 界面布局

- 左侧仓库导航用标准 shadcn Sidebar 与 Collapsible 组合，统一采用其行高、间距、圆角、悬停和选中样式，不再用全局 CSS 覆盖成 Fleet 尺寸；保留原生透明背景，不添加侧栏底色；仓库标题、分组和每个项目行均不添加装饰图标，不为项目图标额外请求仓库元信息。

- −1 趋势屏内的 GitHub 站内导航保留在当前内嵌网页，包括仓库、用户、搜索及登录页面；`target=_blank` / `window.open` 的 GitHub 链接也在同一网页中导航，不自动打开系统浏览器。站外链接与明确的“在浏览器中打开”操作仍使用系统浏览器。
- 内嵌浏览器工具栏遵循 Chrome：左侧依次为后退、前进、刷新／停止，加载中在刷新位置显示停止按钮，不另放加载图标；前进、后退使用 WebView 原生历史并按可用性禁用按钮。

- 用户于 2026-10-22 要求趋势改为内嵌 GitHub Trending 网页，删除 HTML 抓取和搜索 API 回退；参考 ALwith Desktop，趋势在左侧浮板，Git 工作区在右侧浮板，只用横向画布滑动切换，不加顶部切换 Tab。同一个仓库导航栏在 −1 屏右侧完整保留，回到工作屏后位于左侧。画布触控板手势默认关闭，设置中显式开启后才响应三指切换；普通双指滚动不受影响，中键拖动保留。网页不接入应用凭据或本地 Git 权限。

- 用户于 2026-10-22 明确要求 Tab 使用胶囊式标准 shadcn Tabs；“我的 / 第三方”是页签，不使用独立按钮或下划线式页签。
- 仓库导航默认进入“我的”，不因列表为空、未登录或账号验证失败自动切到“第三方”。
- 账号、远端读取失败不能冒充未登录、无远端或空仓库列表，也不能覆盖最后一次成功缓存。macOS 仓库递归监听使用 FSEvents，禁止强制 kqueue 为构建目录的每个文件持有描述符。

- CI 界面以 Desktop 原版组件及交互为基准，GitHub/GitLab 共用组件，平台差异只在数据与接口适配层处理，不另造 GitLab 面板。用户已明确允许步骤区使用 ReUI；须保留失败定位、状态、时长及跳转行为。

- 全局除自定义业务控件外，所有基础控件必须使用标准 shadcn/ui（本项目采用 Base UI），包括折叠、导航、表单、菜单、弹层和页签，不用原生元素或手写状态逻辑另造同类控件。shadcn 没有对应控件时才使用 ReUI，两者均无合适控件时才允许自造。不得以旧 Desktop 或 Fleet 外观覆盖标准控件；兼容层只保留 Desktop 的业务行为与测试契约。自定义 diff、虚拟列表、图形和 Atlas 布局不属于基础控件替代。
- 顶部工具栏保持紧凑单行，搜索、筛选、数量统计、视图切换和操作按钮放在同一行。
- 不为数量统计、操作提示或装饰性说明增加第二行；不默认使用 flex-wrap。空间不足时优先精简、收进更多菜单，必要时横向滚动。
- 避免框套框，移除列表、筛选区、工具栏和内容区外冗余的装饰性 Card、边框与背景容器。
- 优先用间距、对齐、标题及必要的分隔线建立层级；仅为确实需要独立边界的内容保留一层边框。
- Storybook 只维护项目自定义组件与业务组合的 stories；不为原版 shadcn/ReUI 基础组件重复编写示例。复用生产组件、主题和国际化，不另造展示版 UI。


## Desktop / GitLens 行为一致性

- Git 行为以 Vendor/desktop 的测试场景为基准；移植时记录上游 commit、测试文件和原始用例标题，保留操作顺序及可观察结果断言。
- 原版未运行、跳过、尚未移植或只移植部分断言的场景不得标为完全兼容；Rust/API 差异必须明确登记。
- 上游测试改变时复核对应 Rust 实现；不得仅改摘要、削弱断言或跳过失败测试来消除差异。
- 独有回归与上游移植分开登记。测试通过仅证明覆盖场景通过，不宣称未测试行为也一致。
- Git 写操作共用互斥入口，确认后的恢复动作不得再次获取同一操作锁；确认期间分支变化时中止后续写操作。旧仓库异步结果不得覆盖当前仓库状态，后台 diff 刷新不得清除尚未处理的操作错误。

- 功能参考还包括 Vendor/vscode-gitlens：blame、历史搜索与比较、分支图、Inbox/Launchpad 等必须保留 GitLens 来源与测试追踪，不只登记 Desktop。
- 两个来源独立固定 commit、监测测试与夹具变化。功能参考不等于测试移植；前端或 VS Code 环境测试不能冒充 Rust 已覆盖。
- 同一功能的上游预期不同时，明确记录采用的行为及理由，不默默混合两个上游语义。
- 用户于 2026-10-27 决定按功能深度推进 GitLens 参考能力，顺序：历史搜索（GitLens 查询语法，Rust 一比一移植 `search.utils.ts`，原版测试经 bridge 运行）→ autolink → 分支图 → 文件历史；每项完成后更新 `tests/gitlens/manifest.json` 的 features 与对应条目。GitLab 边角场景（SSH、权限不足、断网恢复、大分页、令牌过期、非标准端口）和其它平台验收留待用户另行决定。
- 用户于 2026-10-27 决定（「全做」）：提交图从全部本地分支、远端跟踪分支、标签、HEAD 与贮藏遍历，贮藏作为独立行显示（GitLens graph.stashRows / graph.slashRemote 语义，引擎自研，不对照 `plus` 源码）；GitLab 支持部署在子路径下的自建实例（`https://host[:port]/sub/path`），凭据、OAuth、接口地址与远端 URL 匹配都按完整基址处理；工作区选中文件的 diff 改为进程内生成，只有与 `git diff` 逐字节一致的情形走快路径，其余回退 git；GitLab SSH、断网恢复与大分页按只读操作做真实实例验收，不做远端写操作。
- 2026-10-27 核实：Vendor/vscode-gitlens 中任何名为 `plus` 的目录（`packages/plus/*`、`src/plus/*`、`src/webviews/apps/plus/*` 等）受 GitLens Pro License（`LICENSE.plus`）约束，不是 MIT，禁止复制、移植、改写或作为实现蓝本；只有 `plus` 之外的文件是 MIT。提交图引擎（`packages/plus/commit-graph`）、Launchpad（`src/plus/launchpad`）和自然语言搜索（`src/plus/search`）因此只能自研或参考 MIT 实现，不得对照其源码；清单里这些文件登记为 `excluded`，理由写明许可证。
- 用户于 2026-10-27 明确不考虑 VS Code：GitLens 中仅属于 VS Code 扩展宿主、webview、E2E、扩展运行时工具及 GitKraken Plus/AI/agent 的测试在 `tests/gitlens/manifest.json` 登记为 `excluded` 并写明原因，不计为缺口；保持 pending 的只有 Git 行为和上面列出的参考功能。

## 开发工具链

- 项目自有 TypeScript 代码和构建脚本统一使用 TypeScript 7 检查；不引入旧版编译器。Vendor 与原版测试快照保持原样，必要的测试 API 适配仍调用 TS7 编译器。
- 前端格式化、import / Tailwind 排序与 lint 统一使用 Bun 原生命令，配置放在 `bunfig.toml`；不再引入 Prettier、Oxlint 或 Biome。当前需使用支持 `bun fmt` / `bun lint` 的 Bun Canary，CI 与本地一致。
- 现代语法规则与 ALwith Desktop 共用 `@nyssance/ts7-lint`，规则只在那个包里，`bunfig.toml` 不放共享规则。直接依次运行 `bun lint` 与 `bun ts7-lint`，供本地 Fabric 和 CI 共用；上游快照、夹具及原版 shadcn/ReUI 组件不参与改写。
- Rust 继续使用项目 `rustfmt.toml` 与 Clippy；原版上游快照、夹具和生成组件不得被格式化。
- Fabric / `fab` 仅作为本地开发入口；CI 直接执行 Bun、Cargo 与测试命令，不调用或安装 Fabric。本地 Fabric 自身的回归测试由本地运行。
- 格式化仅通过本地主动执行 `fab f` / `bun fmt`；不设置格式检查脚本，也不在 CI 或 `fab check` 中执行 Bun / Rust 格式检查。
