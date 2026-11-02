"""GitCub 的任务入口。约定同 alwith-desktop 的 fabfile。

    fab -l              列出全部任务
    fab install         装依赖 + 下载随包 git
    fab dev             起开发实例
    fab format          格式化（别名 fab f）
    fab fix             能自动修的都修掉
    fab check           类型检查 + lint + 测试
    fab update          升级依赖（别名 fab u）
    fab vendor-status   看照搬的上游代码落后多少 commit
"""

import json
import os
import time
from threading import Lock
lazy from concurrent.futures import ThreadPoolExecutor, wait
import hashlib
import platform
import shutil
import subprocess
import sys
lazy import tarfile
import tempfile
lazy import urllib.request
from pathlib import Path

lazy import rich
lazy from rich import box
lazy from rich.cells import cell_len
lazy from rich.console import Group
lazy from rich.live import Live
lazy from rich.table import Table
lazy from InquirerPy.base.control import Choice
from fabric import task
lazy from invoke import Context
lazy from InquirerPy import inquirer
from scripts import upstream as vendor_tools

ROOT = Path(__file__).resolve().parent
TAURI_CONFIG = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())

# ── 照搬自 GitHub Desktop 的代码 ──────────────────────────────────────────────
# src/upstream/ 下是逐行照搬的原版文件，规矩是**一行都不改**，所以同步就是
# 机械覆盖。需要适配的地方都在 upstream/ 之外，见 src/upstream/README.md。
#
# 加文件就在 files 里加一条相对 src_root / dst_root 的路径。
_VENDOR_RECIPES = {
    "desktop": {
        "src_root": "app/src",
        "dst_root": "src/upstream",
        "files": [
            "lib/enum.ts",
            "lib/format-duration.ts",
            "lib/to_sentence.ts",
            "lib/is-record.ts",
            "lib/promise.ts",
            "lib/remove-remote-prefix.ts",
            "lib/sanitize-ref-name.ts",
            "lib/truncate-with-ellipsis.ts",
            "lib/worktree-dropdown.ts",
            "models/commit-identity.ts",
            "ui/add-repository/sanitized-repository-name.ts",
            "ui/lib/identifier-rules.ts",
            "ui/lib/list/list-row-index-path.ts",
            "ui/lib/list/section-list-selection.ts",
            "ui/lib/list/selection.ts",
            "ui/lib/round.ts",
            "ui/lib/parse-files-to-be-overwritten.ts",
            "lib/local-storage.ts",
            "lib/parse-pac-string.ts",
            "models/git-author.ts",
            "models/equality-hash.ts",
            "models/author.ts",
            "lib/fuzzy-find.ts",
            "lib/compare.ts",
            "models/remote.ts",
            "lib/http-status-code.ts",
            "models/workflow-preferences.ts",
            "models/uncommitted-changes-strategy.ts",
            "models/repo-rules.ts",
            "lib/emoji.ts",
            "lib/squirrel-error-parser.ts",
            "lib/suppress-certificate-error.ts",
            "models/release-notes.ts",
            "lib/stores/base-store.ts",
            "lib/stores/stores.ts",
            "models/clone-options.ts",
            "models/progress.ts",
            "models/stash-entry.ts",
            "ui/diff/image-diffs/dds-converter.ts",
            "ui/diff/image-diffs/sizing.ts",
            "ui/octicons/octicons.generated.ts",
            "lib/format-relative.ts",
            "ui/autocompletion/common.ts",
            "lib/welcome.ts",
            "models/commit-message.ts",
            "lib/merge.ts",
            "lib/stores/helpers/find-default-remote.ts",
            "ui/lib/expiring-operation-cache.ts",
            "lib/range.ts",
            "lib/endpoint-token.ts",
            "models/preferences.ts",
            "models/tutorial-step.ts",
            "lib/errno-exception.ts",
            "models/clone-repository-tab.ts",
            "models/menu-ids.ts",
            "crash/shared.ts",
            "lib/cli-action.ts",
            "lib/logging/log-level.ts",
            # 纯数据模型 + 选择状态
            "models/diff/diff-data.ts",
            "models/diff/diff-line.ts",
            "models/diff/diff-selection.ts",
            "models/diff/image-diff.ts",
            "models/diff/image.ts",
            "models/diff/index.ts",
            "models/diff/raw-diff.ts",
            "models/status.ts",
            "models/manual-conflict-resolution.ts",
            # 纯函数：解析 git diff 输出、由行选择生成补丁
            "lib/diff-parser.ts",
            "lib/patch-formatter.ts",
            "lib/fatal-error.ts",
            "lib/equality.ts",
            "lib/remote-parsing.ts",
            "lib/status.ts",
            "lib/offset-from.ts",
            "lib/highlighter/types.ts",
            # diff 的算法部分（展开上下文、行内变化区间、token 映射）
            "ui/diff/text-diff-expansion.ts",
            "ui/diff/changed-range.ts",
            "ui/diff/get-tokens.ts",
            "ui/diff/diff-helpers.tsx",
            "ui/diff/diff-explorer.ts",
        ],
    },
}

# 随包分发的 git 来自 desktop/dugite-native —— GitHub Desktop 用的同一个源。
# 跟随 dugite 的清单，不自己维护 URL。
_DUGITE_MANIFEST = "https://raw.githubusercontent.com/desktop/dugite/main/script/embedded-git.json"
_GIT_DEST = ROOT / "src-tauri/resources/git"

# Git Credential Manager 及其 .NET 运行时：我们用自己的 GIT_ASKPASS，用不上。
# 独占 107MB。
_GCM_PATTERNS = [
    "*.dll", "*.json", "git-credential-manager*",
    "libSkiaSharp.*", "libHarfBuzzSharp.*", "libcoreclr.*", "libclrjit.*",
    "libhostfxr.*", "libhostpolicy.*", "libSystem.*",
    "libmscordaccore.*", "libmscordbi.*", "createdump",
]

# 客户端用不到的组件。git-http-backend 和 git-shell 是**服务端**的。
_UNUSED_BINARIES = [
    "bin/scalar", "libexec/git-core/scalar",
    "libexec/git-core/git-http-backend", "libexec/git-core/git-shell",
    "libexec/git-core/git-imap-send", "libexec/git-core/git-http-push",
    "libexec/git-core/git-cvsserver", "libexec/git-core/git-daemon",
]


def _vendor_src(name: str) -> Path:
    return VENDOR_DIR / name


def _vendor_manifest() -> dict:
    return json.loads(VENDORS_JSON.read_text())["vendors"]


# ── 依赖 ─────────────────────────────────────────────────────────────────────


def _sibling_packages() -> list[Path]:
    """根目录下自带 package.json 的平级子包(当前只有 browser-extension,它是 wxt 的
    workspace 根,有自己的一套依赖树)。

    根 package.json **没有 workspaces 字段**,所以 `bun install` / `bun update` 在根跑
    完全不下探这些目录 —— 它们的依赖不会被任何自动化碰到,只能靠人记得 cd 进去装。
    后果实撞(2026-07-31):guide 当时也是独立包,vitepress 写着 "latest",而 vitepress
    2.x 挂在 npm 的 `next` 标签下,`latest` 永远解析到 1.6.4;锁文件停在 7-21 没人动过,
    于是根目录早就 2.0.0-alpha 了,guide 还在 1.6.4,谁也没发现。guide 已就此并入根
    (同 docs/:只留内容,依赖与脚本都在根),剩下的这些用本函数兜住。

    自动发现而不是写死名单:再加平级子包时不需要有人记得回来改这里。
    """
    return sorted(p.parent for p in ROOT.glob("*/package.json") if p.parent.name != "node_modules")


@task
def install(c: Context) -> None:
    """安装, 卡住的话试试看--no-cache参数"""
    c.run("bun install")
    for pkg in _sibling_packages():
        rich.print(f"[cyan]{pkg.name}[/cyan]")
        with c.cd(pkg.name):
            c.run("bun install")
    # Hasgard CLI(dev 检查 / MCP / E2E 共用同一协议):安装 crates.io 正式版本。
    if c.run("command -v tauri-hasgard", warn=True, hide=True).ok:
        rich.print("tauri-hasgard 已安装,跳过")
    else:
        c.run("cargo install tauri-hasgard-cli")
    git_download(c)


@task(aliases=["u", "update"])
def upgrade(c: Context) -> None:
    """升级"""
    c.run("git pull --ff-only")
    c.run("bun outdated")
    # 沿用 Desktop 的更新顺序。Atlas 原生桥已独立发布到 crates.io，
    # 下方 cargo update 不依赖 Bun 安装出的 Rust 源码。
    c.run("bun update")
    with c.cd("src-tauri"):
        c.run("cargo update")
        # cargo update stays within declared requirements. Report newer incompatible
        # releases (including pinned prereleases) without changing manifests or locks.
        # Unlike cargo-outdated, this does not resolve a rewritten temporary workspace.
        if not c.run("command -v cargo-upgrade", warn=True, hide=True).ok:
            c.run("cargo install cargo-edit --locked")
        c.run("cargo upgrade --dry-run --incompatible allow --pinned allow", warn=True)
    # 平级独立包(browser-extension):根没有 workspaces,上面那条完全够不着它们。
    # 用 c.cd 而不是 `bun --cwd` —— bun 1.3.14 的 `bun update --cwd <相对路径>` 直接
    # ENOENT(只认绝对路径),而同一个 flag 在 `bun install` 上却正常,踩过一次。
    for pkg in _sibling_packages():
        rich.print(f"[cyan]{pkg.name}[/cyan]")
        with c.cd(pkg.name):
            c.run("bun outdated", warn=True)
            c.run("bun update")


@task
def clean(c: Context) -> None:
    """清理"""
    mode = inquirer.select(
        "请选择清理方式:",
        [
            Choice("sweep", "cargo sweep(温和:只删 30 天没碰的编译产物,日常瘦身首选)"),
            Choice("full", "cargo clean(全量:target 清空,下次全量重编译)"),
            Choice("dirs", "仅删空目录(不动编译产物)"),
        ],
    ).execute()
    if mode == "sweep":
        # cargo-sweep 缺失时先装(装一次全局可用)
        if c.run("which cargo-sweep", warn=True, hide=True).failed:
            c.run("cargo install cargo-sweep")
        with c.cd("src-tauri"):
            # --installed:清掉已卸载 toolchain 的产物(活跃仓比 --time 更有效);再叠 30 天阈值
            c.run("cargo sweep --installed")
            c.run("cargo sweep --time 30")
    elif mode == "full":
        with c.cd("src-tauri"):
            c.run("cargo clean")
    c.run("find . -type d -empty -print -delete")


# ── 开发 ─────────────────────────────────────────────────────────────────────


@task(aliases=["d"])
def dev(c: Context) -> None:
    """启动 GitCub 桌面开发实例（fab tauri 的兼容入口）。"""
    tauri(c)


@task
def tauri(c: Context) -> None:
    """Tauri 开发实例；使用 exec 传递终端信号，启用 Hasgard。"""
    if not _bundled_git_ready():
        rich.print("[yellow]随包 git 未下载，将回退到 PATH 上的 git。跑 fab git-download 可下载。[/yellow]")
    # exec 替换自身,不拉子进程:python 层在 stage/问答做完后毫无运行期作用,留着只会
    # 挡信号——invoke 管道模式下 Ctrl-C 层层失灵(2026-07-30 实撞:cargo 已死,
    # fab/node 存活傻等,进程杀不掉)。exec 后链条是 终端→node(tauri)→cargo,信号直达。
    os.chdir(ROOT)
    arguments = [
        "bunx",
        "--bun", "tauri",
        "dev",
        "--config",
        "src-tauri/tauri.dev-instance.conf.json",
        "--features",
        "hasgard-testing",
    ]
    os.execvp("bunx", arguments)


def _bundled_git_ready() -> bool:
    """随包 git 下载过没有。
    目录里有个 .gitkeep 占位（理由见 .gitignore），所以不能只看目录在不在，
    得看里面有没有真的 git 可执行文件。"""
    return any(_GIT_DEST.glob("*/bin/git*"))


@task
def build(c: Context) -> None:
    """打正式包。"""
    if not _bundled_git_ready():
        rich.print("[red]随包 git 未下载，成品会依赖用户环境。先跑 fab git-download。[/red]")
        raise SystemExit(1)
    c.run("bunx --bun tauri build")
    bundle = ROOT / "src-tauri/target/release/bundle"
    for p in sorted(bundle.rglob("*.dmg")) + sorted(bundle.rglob("*.app")):
        size = subprocess.run(["du", "-sh", str(p)], capture_output=True, text=True).stdout.split()[0]
        rich.print(f"  {size}\t{p.relative_to(ROOT)}")


@task(name="release-macos")
def release_macos(c: Context, check: bool = False) -> None:
    """本地构建、签名、公证并生成 macOS 更新包（不发布）。"""
    if not check and not _bundled_git_ready():
        raise SystemExit("先运行 fab git-download，正式包必须包含 Git")
    c.run("python3 scripts/release-macos.py" + (" --check" if check else ""))


@task
def check(c: Context) -> None:
    """只读静态门禁:不修改工作区;任一类型、lint、Rust 或审计项失败即返回非零。"""
    _verify(c)


@task
def fix(c: Context) -> None:
    """自动修复:clippy、格式、Bun safe fixes 与换行归一;完成后请运行 `fab check`。"""
    _fix(c)


def _format(c: Context) -> None:
    """格式化：rustfmt + Bun 原生格式化、import 与 Tailwind 排序。"""
    with c.cd("src-tauri"):
        c.run(" ".join(["cargo", "fmt", *_workspace_packages()]), echo=False)
    c.run("bun fmt", echo=False)
    rich.print("[green]✓ 格式化完成[/green]")


def _verify(c: Context) -> None:
    """运行 GitCub 全套门禁并汇总；控制流程照搬 Desktop，检查项对应本项目。"""
    steps = [
        ("app types", ["bun", "check", "--no-script", "-p", "tsconfig.json"], ROOT),
        ("tool types", ["bun", "check", "--no-script", "-p", "tsconfig.tools.json"], ROOT),
        ("lint", ["bun", "lint"], ROOT),
        ("modern syntax", ["bun", "ts7-lint"], ROOT),
        ("tooling tests", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], ROOT),
        ("clippy", ["cargo", "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"], ROOT / "src-tauri"),
        ("rust compile surface", ["cargo", "check", "--locked", "--workspace", "--all-targets"], ROOT / "src-tauri"),
        ("hasgard compile surface", ["cargo", "check", "--locked", "--workspace", "--all-targets", "--all-features"], ROOT / "src-tauri"),
        ("upstream behavior", ["bun", "run", "test:upstream"], ROOT),
        ("rust tests", ["cargo", "test", "--locked", "--workspace"], ROOT / "src-tauri"),
    ]
    results = []
    for name, command, directory in steps:
        result = subprocess.run(command, cwd=directory, check=False)
        rich.print(f"{'[green]✓[/green]' if result.returncode == 0 else '[red]✗[/red]'} {name}", flush=True)
        results.append((name, result.returncode == 0))
    rich.print("\n[bold]体检汇总[/bold]")
    for name, ok in results:
        rich.print(f"  {'[green]✓[/green]' if ok else '[red]✗[/red]'} {name}")
    if not all(ok for _, ok in results):
        raise SystemExit(1)


def _fix(c: Context) -> None:
    """应用 Rust、Bun 的安全修复，最后统一格式化并归一换行。"""
    with c.cd("src-tauri"):
        c.run("cargo clippy --fix --allow-dirty")
    c.run("bun lint --fix && bun ts7-lint --fix")
    _format(c)
    _normalize_crlf(c)


def _workspace_packages() -> list[str]:
    """cargo fmt 的 `-p` 参数:workspace 全部成员。不用 `--all`——它会顺着 path 依赖把
    patches/ 下特意排除在 workspace 外的第三方快照也格式化掉。"""
    metadata = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        cwd=ROOT / "src-tauri",
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [arg for package in json.loads(metadata)["packages"] for arg in ("-p", package["name"])]


_CRLF_SKIP = set()


def _normalize_crlf(c: Context) -> None:
    """已跟踪文本文件 CRLF/mixed → LF。git ls-files --eol 标 w/crlf|w/mixed 的即含 CR,
    二进制文件标 w/none / w/-text 不会命中,无需自己判类型。生成物走 _CRLF_SKIP 跳过。"""
    fixed: list[str] = []
    for line in c.run("git ls-files --eol", hide=True).stdout.splitlines():
        if "w/crlf" not in line and "w/mixed" not in line:
            continue
        path = line.split("\t", 1)[-1].strip()
        if path in _CRLF_SKIP:
            continue
        p = ROOT / path
        p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
        fixed.append(path)
    if fixed:
        rich.print(f"[green]CRLF→LF 归一 {len(fixed)} 个文件[/green]")
        for f in fixed:
            rich.print(f"  {f}")


@task(name="format", aliases=["f"])
def format_code(c: Context) -> None:
    """格式化代码"""
    _format(c)


@task
def lint(c: Context) -> None:
    c.run("clear")
    c.run("bun lint && bun ts7-lint")


@task
def preview(c: Context) -> None:
    """运行预览"""
    c.run("bun preview")


@task
def info(c: Context) -> None:
    """信息"""
    c.run("bunx --bun tauri info")


# ── 照搬的上游代码 ────────────────────────────────────────────────────────────


@task(name="vendor-status")
def vendor_status(c: Context) -> None:
    """离线查看两个参考仓库及项目内源码的同步差异。"""
    _vendor_list()
    for name, recipe in _VENDOR_RECIPES.items():
        src = _vendor_src(name)
        dst = ROOT / recipe["dst_root"]
        rich.print(f"\n[bold]{name} → {recipe['dst_root']}[/bold]")
        if not src.exists():
            rich.print("[yellow]源仓库未克隆，运行 fab vendor → 同步[/yellow]")
            continue
        head = vendor_tools.text(src, "rev-parse", "HEAD")
        commit_file = dst / ".source-commit"
        pinned = commit_file.read_text().strip() if commit_file.exists() else ""
        rich.print(f"  {pinned[:12] or '未记录'} → {head[:12]}")
        rich.print(f"  {vendor_tools.baseline_status(src, pinned, head)}")
        changes = vendor_tools.file_status(src / recipe["src_root"], dst, recipe["files"])
        for key, label in [("changed", "内容变化"), ("missing_source", "上游缺失"), ("missing_local", "本地缺失")]:
            for rel in changes[key]:
                rich.print(f"  {label}: {rel}")
        if not any(changes.values()):
            rich.print(f"  [green]{len(recipe['files'])} 个文件内容一致[/green]")


@task(name="vendor-sync")
def vendor_sync(c: Context) -> None:
    """同步项目内的 Desktop 文件；全部来源通过检查后才覆盖、推进基线。"""
    prepared = []
    for name, recipe in _VENDOR_RECIPES.items():
        src, dst = _vendor_src(name), ROOT / recipe["dst_root"]
        vendor_tools.validate_checkout(src, _vendor_manifest()[name]["url"])
        head = vendor_tools.text(src, "rev-parse", "HEAD")
        changes = vendor_tools.file_status(src / recipe["src_root"], dst, recipe["files"])
        if changes["missing_source"]:
            raise RuntimeError(f"{name} 上游缺失文件，未同步: {', '.join(changes['missing_source'])}")
        # 先读取全部内容，避免缺文件或读取失败后仍推进 .source-commit。
        content = {rel: (src / recipe["src_root"] / rel).read_bytes() for rel in recipe["files"]}
        prepared.append((name, dst, head, content))

    for name, dst, head, content in prepared:
        count = 0
        for rel, data in content.items():
            target = dst / rel
            if target.is_file() and target.read_bytes() == data:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            rich.print(f"  ~ {rel}")
            count += 1
        (dst / ".source-commit").write_text(head + "\n")
        rich.print(f"[bold]{name}[/bold] → {head[:12]}，覆盖 {count} 个文件")
    rich.print("\n[dim]接着跑 fab check，验证适配层与行为。GitLens 仅供参考，不复制进项目。[/dim]")


def has_tool(name: str) -> bool:
    """命令是否在 PATH 上(装没装某个 CLI 工具)。"""
    return shutil.which(name) is not None


# vendors.json(只存 URL,提交进仓)是清单。fab vendor → 同步 把每个仓留在其当前分支上
# pull 到最新、缺的按清单克隆 —— 永不 checkout 到某个 commit、永不 detach HEAD(不干扰
# GitHub Desktop)。跟上面 vendor_sync/vendor_status(镜像进项目内小写 vendor/)是两回事。
VENDOR_DIR = ROOT.parent / "Vendor"
VENDORS_JSON = ROOT / "vendors.json"
# 永不瘦身:CCB(fab sync 的上游源)和 OC(参考源)要全历史全分支,
# 克隆时也必须是完整 clone(不加 --single-branch / --filter)
VENDOR_NO_SHRINK = set()
VENDOR_FETCH_CONCURRENCY = 8
# 「卡住」的真实信号是传输停滞,不是跑了多久 —— 交给 git 自己判(低于 1KiB/s 持续 30s 即中止),
# 比在外面赌一个总时长准。外层 timeout 只兜 git 压根没在传输的情况(等锁、等 stdin)。
VENDOR_STALL_BYTES_PER_SECOND = 1024
VENDOR_STALL_SECONDS = 30
VENDOR_NETWORK_TIMEOUT = 900
VENDOR_CLONE_TIMEOUT = 3600  # 全量 clone(CCB/OC 带全历史全分支)比 fetch 慢一个量级
VENDOR_SLOW_HINT_SECONDS = 30  # 实时表里超过就标黄,慢仓自己冒出来


def _git_env() -> dict[str, str]:
    """GIT_TERMINAL_PROMPT=0:仓变私有/被删时直接失败并报出来,不静默挂在凭据提示上等输入。"""
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


def _git_stall_args() -> list[str]:
    """传输停滞即中止(见 VENDOR_STALL_* 注释),放在子命令前。"""
    return [
        "-c",
        f"http.lowSpeedLimit={VENDOR_STALL_BYTES_PER_SECOND}",
        "-c",
        f"http.lowSpeedTime={VENDOR_STALL_SECONDS}",
    ]


def _vendor_git(
    path: Path, *args: str, check: bool = True, timeout: float = 60
) -> subprocess.CompletedProcess:
    """timeout 缺省按本地操作给(rev-parse / symbolic-ref 这类瞬时),网络操作由调用方显式放大。"""
    return subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        check=check,
        timeout=timeout,
        env=_git_env(),
    )


def _vendor_git_network(path: Path, *args: str, timeout: float) -> subprocess.CompletedProcess:
    return _vendor_git(path, *_git_stall_args(), *args, check=False, timeout=timeout)


def _repo_owner(url: str) -> str:
    """从 git remote url 取 owner:https://host/OWNER/REPO(.git) 或 git@host:OWNER/REPO.git。"""
    s = url.removesuffix(".git")
    if s.startswith("git@"):
        s = s.split(":", 1)[-1]
    return s.rstrip("/").split("/")[-2]


def _size_mib(path: Path) -> int:
    """目录占用(MiB,整数),纯 Python 跨平台——不 shell out du(Windows 原生无 du)。"""
    if not path.exists():
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                continue  # 断链/权限:批处理跳过单个文件不中断
    return total // (1024 * 1024)


def _fmt_mib(mib: int) -> str:
    """带单位显示:>=1024 MiB 转 GiB(一位小数),否则 MiB。"""
    return f"{mib / 1024:.1f} GiB" if mib >= 1024 else f"{mib} MiB"


def _autodiscover_vendors(manifest: dict) -> bool:
    """把已 clone 但没登记的 git 仓补进 manifest(不写文件,由调用方统一落盘),返回是否真补录了。
    manifest 与磁盘的收敛点:消除"磁盘拷进来一批却没进清单、check/shrink 全无视"的漂移。
    非 git / 无 origin 的目录补不了,显式提示不静默吞(手动物走 _unmanaged)。"""
    if not VENDOR_DIR.exists():
        return False  # 新机器/新 checkout 上 Vendor/ 还没建,没什么可发现(iterdir 会抛 FileNotFoundError)
    known = set(manifest["vendors"]) | set(manifest.get("_unmanaged", []))
    added: list[str] = []
    skipped: list[str] = []
    for d in sorted(VENDOR_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir() or d.name in known:
            continue
        if not (d / ".git").exists():
            skipped.append(f"{d.name}(非 git,如是手动物登记进 _unmanaged)")
            continue
        url = _vendor_git(d, "remote", "get-url", "origin", check=False).stdout.strip()
        if not url:
            skipped.append(f"{d.name}(git 仓但无 origin remote)")
            continue
        manifest["vendors"][d.name] = {
            "author": _repo_owner(url),
            "url": url if url.endswith(".git") else f"{url}.git",
        }
        added.append(d.name)
    if skipped:
        rich.print(f"[yellow]跳过 {len(skipped)} 个未登记目录(补不了,需手动处理):{'; '.join(skipped)}[/yellow]")
    if added:
        rich.print(f"[cyan]自动补录 {len(added)} 个未登记仓进 vendors.json:{', '.join(added)}[/cyan]")
    return bool(added)


def _write_vendors_json(c: Context, manifest: dict) -> None:
    """落盘 vendors.json:清旧 MB 字段 + 按名排序 + 交给 Bun fmt 定型。
    json.dumps 短数组每元素一行、Bun fmt 会压成一行,不走这步每次写都跟全仓 Bun fmt 风格漂移。"""
    for m in manifest["vendors"].values():
        m.pop("sizeMB", None)
        m.pop("gitMB", None)
    manifest["vendors"] = dict(sorted(manifest["vendors"].items(), key=lambda kv: kv[0].lower()))
    VENDORS_JSON.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    c.run("bun fmt vendors.json", hide=True)


def _vendor_list() -> None:
    """列出 Vendor/ 清单与各仓大小(读 vendors.json,不 fetch,最后一行合计)。"""
    vendors = json.loads(VENDORS_JSON.read_text())["vendors"]
    table = Table(box=box.SIMPLE, pad_edge=False, header_style="bold bright_white")
    table.add_column("#", style="grey50", justify="right")
    table.add_column("Vendor", style="cyan")
    table.add_column("Author", style="grey62")
    table.add_column("Total / Git", style="grey50", justify="right")
    total_size = total_git = 0
    for idx, (name, meta) in enumerate(sorted(vendors.items(), key=lambda kv: kv[0].lower()), 1):
        size, git = meta.get("sizeMiB", 0), meta.get("gitMiB", 0)
        total_size += size
        total_git += git
        table.add_row(str(idx), name, meta["author"], f"{_fmt_mib(size)} / {_fmt_mib(git)}")
    table.add_section()
    table.add_row("", f"[bold]{len(vendors)} 个[/bold]", "", f"[bold]{_fmt_mib(total_size)} / {_fmt_mib(total_git)}[/bold]")
    rich.print(table)


@task
def vendor(c: Context) -> None:
    """Vendor/ 参考 clone 集单一入口:查看 / 同步 / 压缩。"""
    # 补录是 disk↔manifest 的收敛步骤,三个操作共享:先扫盘把未登记仓补进清单再分发,
    # 这样查看能看到刚拷进来的仓、压缩也能直接压新登记的仓(只在真补录时才落盘,否则不脏 git)。
    manifest = json.loads(VENDORS_JSON.read_text())
    if _autodiscover_vendors(manifest):
        _write_vendors_json(c, manifest)
    action = inquirer.select(
        message="Vendor 操作?",
        choices=[
            Choice("view", "查看   列清单 + 大小(不联网)"),
            Choice("sync", "同步   fetch + 补录 + 同步到最新"),
            Choice("compress", "压缩   blobless 瘦身省空间"),
        ],
    ).execute()
    if action == "view":
        _vendor_list()
    elif action == "sync":
        _vendor_check(c)
    else:
        _vendor_shrink(c)


def _vendor_check(c: Context) -> None:
    """Vendor/ 同步到最新(缺的按 vendors.json 克隆);扫盘补录未登记仓。留在分支上,永不 detach HEAD。"""
    manifest = json.loads(VENDORS_JSON.read_text())  # 补录已在 vendor() 入口做,这里读到的已是收敛后的清单
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    def build_table(rows: list[tuple[str, ...]]) -> Table:
        table = Table(box=box.SIMPLE, pad_edge=False, header_style="bold bright_white")
        table.add_column(justify="right")
        table.add_column("Vendor", style="cyan")
        table.add_column("Author", style="grey62")
        table.add_column("Branch", style="green")
        table.add_column("Updated", style="grey50")
        table.add_column("Total / Git", style="grey50", justify="right")
        for row in rows:
            table.add_row(*row)
        return table

    vendors = sorted(manifest["vendors"].items(), key=lambda kv: kv[0].lower())
    vendor_name_width = max(cell_len("正在同步"), *(cell_len(name) for name, _meta in vendors))
    done: dict[str, tuple[str, ...]] = {}  # name → 成品行,最后按清单顺序出表
    running: dict[str, tuple[str, float]] = {}  # name → (阶段, 起始 monotonic),实时表的数据源
    fail: list[str] = []
    pulled: list[str] = []
    cloned: list[str] = []
    state_lock = Lock()

    def build_running_table() -> Table:
        """正在同步的仓,按已耗时降序 —— 卡住的那个恒在第一行,不必猜是谁。"""
        table = Table(box=box.SIMPLE, pad_edge=False, header_style="bold bright_white")
        table.add_column("正在同步", style="cyan", width=vendor_name_width, no_wrap=True)
        table.add_column("阶段", style="grey62", width=cell_len("查默认分支"), no_wrap=True)
        table.add_column("已耗时", style="grey50", justify="right")
        now = time.monotonic()
        with state_lock:
            snapshot = [(n, label, now - started) for n, (label, started) in running.items()]
        for name, label, elapsed in sorted(snapshot, key=lambda item: item[2], reverse=True):
            slow = elapsed >= VENDOR_SLOW_HINT_SECONDS
            table.add_row(
                f"[yellow]{name}[/yellow]" if slow else name,
                label,
                f"[yellow]{elapsed:.0f}s[/yellow]" if slow else f"{elapsed:.0f}s",
            )
        return table

    def sync_one(idx: int, name: str, meta: dict) -> None:
        """一个仓的完整同步,跑在 worker 线程里;共享状态一律经 state_lock。"""
        author = meta["author"]
        link = f"[link={meta['url'].removesuffix('.git')}]{name}[/link]"
        d = VENDOR_DIR / name

        def stage(label: str) -> None:
            with state_lock:
                running[name] = (label, time.monotonic())

        def settle(row: tuple[str, ...], failed: str = "") -> None:
            with state_lock:
                running.pop(name, None)
                done[name] = row
                if failed:
                    fail.append(f"{name}({failed})")

        fresh_clone = not (d / ".git").exists()
        if fresh_clone:
            # 只拉主分支 + blob 懒取(--filter=blob:none):大仓省一大截,仍留完整提交历史
            # 供 diff/GitHub Desktop;不浅克隆(--depth 会丢历史、废掉基线 diff)。
            # 永不瘦身的仓(CCB/OC)例外:必须完整 clone,否则新机器上一开局就是瘦的
            slim = [] if name in VENDOR_NO_SHRINK else ["--single-branch", "--filter=blob:none"]
            stage("clone")
            try:
                clone = subprocess.run(
                    ["git", *_git_stall_args(), "clone", *slim, meta["url"], str(d)],
                    capture_output=True,
                    text=True,
                    timeout=VENDOR_CLONE_TIMEOUT,
                    env=_git_env(),
                )
            except subprocess.TimeoutExpired:
                settle((f"{idx} [red]✘[/red]", link, author, "[red]clone 超时[/red]", "", ""), "clone 超时")
                return
            if clone.returncode:
                settle((f"{idx} [red]✘[/red]", link, author, "[red]clone 失败[/red]", "", ""), "clone 失败")
                return
            with state_lock:
                cloned.append(name)
        try:
            # 留在分支上 ff 到最新;若历史遗留 detached,先回默认分支——绝不停在游离 HEAD
            branch = _vendor_git(d, "symbolic-ref", "-q", "--short", "HEAD", check=False).stdout.strip()
            if not branch:
                stage("查默认分支")
                r = _vendor_git_network(d, "remote", "show", "origin", timeout=VENDOR_NETWORK_TIMEOUT).stdout
                branch = next(
                    (ln.split(":")[1].strip() for ln in r.splitlines() if "HEAD branch:" in ln), ""
                )
                if branch:
                    # blobless 仓 checkout 要按需回源取 blob,一样算网络操作
                    _vendor_git_network(d, "checkout", "--quiet", branch, timeout=VENDOR_NETWORK_TIMEOUT)
            before = _vendor_git(d, "rev-parse", "HEAD", check=False).stdout.strip()
            stage("fetch")
            _vendor_git_network(d, "fetch", "origin", timeout=VENDOR_NETWORK_TIMEOUT)
            # blobless 克隆的仓,ff 更新工作区时要按需回源取 blob —— 这一步同样走网络、同样会卡
            stage("merge")
            pull = _vendor_git_network(d, "merge", "--ff-only", f"origin/{branch}", timeout=VENDOR_NETWORK_TIMEOUT)
        except subprocess.TimeoutExpired:
            # 一个仓超时不拖垮另外 83 个(批处理不中断),但绝不吞:红行 + 计入 fail + 末尾 SystemExit(1)
            with state_lock:
                phase = running.get(name, ("?", 0.0))[0]
            settle((f"{idx} [red]✘[/red]", link, author, f"[red]{phase} 超时[/red]", "", ""), f"{phase} 超时")
            return
        after = _vendor_git(d, "rev-parse", "HEAD", check=False).stdout.strip()
        updated = _vendor_git(d, "log", "-1", "--format=%cr", check=False).stdout.strip()
        # 本次真的拉到了新提交才标圆点 —— 光看 "最后提交在多久前" 分不出「刚更新」和「本来就最新」
        changed = fresh_clone or (before and after and before != after)
        if changed and not fresh_clone:
            with state_lock:
                pulled.append(name)
        # size 增量:只有本次真变了(clone/pull)或还没记过的仓才重 du,没变的沿用 json 旧值
        if changed or "sizeMiB" not in meta:
            stage("测大小")
            meta["sizeMiB"] = _size_mib(d)
            meta["gitMiB"] = _size_mib(d / ".git")
        mark = "[yellow]●[/yellow]" if changed else "[green]✓[/green]"
        size_cell = f"{_fmt_mib(meta['sizeMiB'])} / {_fmt_mib(meta['gitMiB'])}"
        local_commits = pull.returncode and "up to date" not in pull.stdout.lower()
        branch_cell = f"{branch} [dim](本地提交)[/dim]" if local_commits else branch
        settle((f"{idx} {mark}", link, author, branch_cell, updated, size_cell))

    # Live 区只画「此刻在跑的仓」(最多并发数那么多行,不会被终端高度裁掉),完整全表结束后再打印。
    # 之前是串行 + 一个仓做完才追加一行:等着的那个仓在屏上没有任何痕迹,看起来就是死住了。
    total = len(vendors)
    with Live(transient=True, auto_refresh=False) as live:
        with ThreadPoolExecutor(max_workers=VENDOR_FETCH_CONCURRENCY) as pool:
            futures = [pool.submit(sync_one, idx, name, meta) for idx, (name, meta) in enumerate(vendors, 1)]
            pending = set(futures)
            while pending:
                # 等的是 future 本身(真实信号),timeout 只是这一帧的重绘节拍,不是赌一个时长
                pending = wait(pending, timeout=0.25).not_done
                with state_lock:
                    finished, failed_now = len(done), len(fail)
                live.update(
                    Group(
                        f"[bold]同步 {finished}/{total}[/bold] [dim]· 并发 {VENDOR_FETCH_CONCURRENCY} · 失败 {failed_now}[/dim]",
                        build_running_table(),
                    ),
                    refresh=True,
                )
    for future in futures:
        future.result()  # worker 里的意外异常照常炸出来,不静默烂在 future 里

    rich.print(build_table([done[name] for name, _meta in vendors]))

    _write_vendors_json(c, manifest)  # 增量测得的 size 落盘(补录在入口已落过一次)

    manual = manifest.get("_unmanaged") or []
    if manual:
        rich.print(f"[dim]手动物(非 git,本任务不管,需自行放置):{', '.join(manual)}[/dim]")
    if fail:
        rich.print(f"[red]{len(fail)} 个失败:{', '.join(fail)}[/red]")
        raise SystemExit(1)
    total = len(manifest["vendors"])
    if cloned:
        rich.print(f"[green]新克隆 {len(cloned)} 个:{', '.join(cloned)}[/green]")
    if pulled:
        rich.print(f"[yellow]本次更新 {len(pulled)} 个:{', '.join(pulled)}[/yellow]")
    else:
        rich.print("[dim]本次没有仓拉到新提交[/dim]")
    total_mib = sum(m.get("sizeMiB", 0) for m in manifest["vendors"].values())
    rich.print(f"[green]{total} 个已同步到最新[/green] [dim]· 磁盘占用合计 {_fmt_mib(total_mib)}[/dim]")


def _vendor_real_dirty(path: Path) -> bool:
    """有没有真的本地改动 —— 忽略 .DS_Store 之类 Finder 垃圾(没设全局 gitignore,故在此过滤)。"""
    lines = _vendor_git(path, "status", "--porcelain", check=False).stdout.splitlines()
    return any(ln.strip() and not ln.rstrip().endswith(".DS_Store") for ln in lines)


def _vendor_is_shrunk(path: Path) -> bool:
    """已是 blobless 部分克隆 = 瘦过了。再重 clone 只是全量重下 + 跟到上游最新,不会更小。"""
    r = _vendor_git(path, "config", "--get", "remote.origin.partialclonefilter", check=False)
    return r.stdout.strip() == "blob:none"


def _vendor_shrink_one(c: Context, name: str, url: str, lfs_args: str) -> None:
    """删旧 + blobless 单分支重 clone。"""
    d = VENDOR_DIR / name
    before = _size_mib(d)
    shutil.rmtree(d)
    c.run(f"git{lfs_args} clone --single-branch --filter=blob:none {url} '{d}'", warn=True)
    # clone 若中途断(LFS/网络),补一次 reset --hard 把工作树补全
    if (d / ".git").exists():
        c.run(f"git{lfs_args} -C '{d}' reset --hard HEAD", warn=True, hide=True)
    rich.print(f"  [green]✓[/green] {name:24s} {_fmt_mib(before)} → {_fmt_mib(_size_mib(d))}")


def _vendor_shrink(c: Context) -> None:
    """重 clone Vendor/ 干净仓为 blobless 单分支省空间(直接删旧+重拉)。缺 git-lfs 先 brew 装。claude-code/openclaude 永不瘦身。"""
    manifest = json.loads(VENDORS_JSON.read_text())
    vendors = manifest["vendors"]

    # 确保 git-lfs:LFS 仓(vscode 等)没它 clone 会崩;缺则 brew 装(问一句),装上就拿真内容不留指针
    if not has_tool("git-lfs"):
        if inquirer.confirm("git-lfs 没装,LFS 仓需要它才能拿真内容。brew 装一下?", default=True).execute():
            c.run("brew install git-lfs", warn=True)
            c.run("git lfs install", warn=True)
    has_lfs = has_tool("git-lfs")
    # 带前导空格,可直接拼进 `git{lfs_args} ...`:装了 git-lfs 时为空、命令保持 `git clone`
    lfs_args = (
        ""
        if has_lfs
        else " -c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.clean=cat -c filter.lfs.required=false"
    )
    if not has_lfs:
        rich.print("[yellow]无 git-lfs:LFS 文件会留成指针(源码正常,不影响读)[/yellow]")

    # 分类:永不瘦身 / 未克隆 / 脏仓排除(重 clone 会丢改动)/ 干净可选
    targets: list[str] = []
    dirty: list[str] = []
    missing: list[str] = []
    protected: list[str] = []
    done: list[str] = []
    for name in sorted(vendors, key=str.lower):
        if name in VENDOR_NO_SHRINK:
            protected.append(name)
            continue
        d = VENDOR_DIR / name
        if not (d / ".git").exists():
            missing.append(name)
            continue
        if _vendor_is_shrunk(d):
            done.append(name)
            continue
        if _vendor_real_dirty(d):
            dirty.append(name)
            continue
        targets.append(name)
    if done:
        rich.print(f"[dim]已瘦身跳过:{', '.join(done)}[/dim]")
    if protected:
        rich.print(f"[dim]永不瘦身(sync 源/参考源,需全历史):{', '.join(protected)}[/dim]")
    if dirty:
        rich.print(f"[yellow]跳过脏仓(重 clone 会丢本地改动):{', '.join(dirty)}[/yellow]")
    if missing:
        rich.print(f"[dim]未克隆(先 fab vendor → 同步):{', '.join(missing)}[/dim]")
    if not targets:
        rich.print("[green]没有需要瘦身的仓(都已瘦身或被排除)[/green]")
        return
    for name in targets:
        _vendor_shrink_one(c, name, vendors[name]["url"], lfs_args)
    rich.print(f"\n[green]{len(targets)} 个瘦身完成[/green]")


# ── 随包分发的 git ────────────────────────────────────────────────────────────


def _platform_key() -> str:
    sysname = {"Darwin": "darwin", "Windows": "win32", "Linux": "linux"}[platform.system()]
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    return f"{sysname}-{arch}"


def _slim(target: Path) -> None:
    """剥掉用不到的部分：148MB → 28MB。"""
    core = target / "libexec/git-core"
    freed = 0
    if core.is_dir():
        for pattern in _GCM_PATTERNS:
            for p in core.glob(pattern):
                freed += p.stat().st_size if p.is_file() else 0
                p.unlink(missing_ok=True) if p.is_file() else shutil.rmtree(p, ignore_errors=True)
    for rel in _UNUSED_BINARIES:
        p = target / rel
        if p.is_file():
            freed += p.stat().st_size
            p.unlink()
    for rel in ["share/bash-completion", "share/man", "doc"]:
        shutil.rmtree(target / rel, ignore_errors=True)
    rich.print(f"  剥掉 GCM 与服务端组件：省 {freed / 1024 / 1024:.0f}MB")

    # 删掉指向 git 自身的兼容符号链接。现代 git 是单体二进制内部分发，
    # 这些链接没人用；**关键是 Tauri 打包资源时会跟随符号链接**，
    # 每个链接被复制成 3.4MB 的完整副本 —— 不删的话进包会从 28MB 膨胀到 500MB+。
    n = 0
    if core.is_dir():
        for p in core.iterdir():
            if p.is_symlink() and p.readlink().name == "git":
                p.unlink()
                n += 1
    if n:
        rich.print(f"  删掉 {n} 个 git-* 兼容符号链接（Tauri 会跟随链接复制）")


@task(name="git-download")
def git_download(c: Context, all_platforms: bool = False) -> None:
    """下载随包分发的 git（来自 desktop/dugite-native）。"""
    with urllib.request.urlopen(_DUGITE_MANIFEST) as r:
        manifest = json.load(r)

    keys = sorted(manifest) if all_platforms else [_platform_key()]
    for key in keys:
        entry = manifest.get(key)
        if entry is None:
            rich.print(f"[yellow]{key} 不在 dugite 清单里，跳过[/yellow]")
            continue
        rich.print(f"[cyan]{key}[/cyan]")
        target = _GIT_DEST / key
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / entry["name"]
            with urllib.request.urlopen(entry["url"]) as r, archive.open("wb") as f:
                shutil.copyfileobj(r, f)
            got = hashlib.sha256(archive.read_bytes()).hexdigest()
            if got != entry["checksum"]:
                raise SystemExit(f"校验和不匹配\n  期望 {entry['checksum']}\n  实际 {got}")
            rich.print("  校验和 ✅")
            shutil.rmtree(target, ignore_errors=True)
            target.mkdir(parents=True)
            with tarfile.open(archive) as tar:
                tar.extractall(target)
        _slim(target)
        # 必须用 lstat：libexec 里的 git-* 是符号链接，stat() 会跟随链接
        # 把每个都按目标大小算，28MB 能报成 500MB。
        size = sum(f.lstat().st_size for f in target.rglob("*") if not f.is_dir())
        rich.print(f"  → {target.relative_to(ROOT)}  {size / 1024 / 1024:.0f}MB")
