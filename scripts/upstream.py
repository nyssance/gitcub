"""项目内 upstream 文件同步的检查辅助；参考仓库管理直接使用 fabfile.py 中的 Desktop 实现。"""

import os
import subprocess
from pathlib import Path


def git(path: Path, *args: str, check: bool = True, network: bool = False):
    result = subprocess.run(
        ["git", "-C", str(path), "-c", "http.lowSpeedLimit=1024",
         "-c", "http.lowSpeedTime=30", *args],
        capture_output=True, text=True, timeout=3600 if network else 60,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result


def text(path: Path, *args: str) -> str:
    return git(path, *args).stdout.strip()


def normalized_url(url: str) -> str:
    return url.removeprefix("https://").removeprefix("git@").replace(":", "/").rstrip("/").removesuffix(".git")


def inspect(path: Path) -> dict[str, str]:
    if not path.exists():
        return {"branch": "—", "head": "—", "date": "—", "state": "未克隆"}
    branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).stdout.strip()
    dirty = bool(text(path, "status", "--porcelain"))
    shallow = text(path, "rev-parse", "--is-shallow-repository") == "true"
    return {
        "branch": branch or "游离 HEAD",
        "head": text(path, "rev-parse", "--short", "HEAD"),
        "date": text(path, "log", "-1", "--format=%cs"),
        "state": " / ".join(["有本地修改" if dirty else "干净", "浅克隆" if shallow else "完整历史"]),
    }


def validate_checkout(path: Path, url: str) -> str:
    if normalized_url(text(path, "remote", "get-url", "origin")) != normalized_url(url):
        raise RuntimeError("origin 与 vendors.json 不一致，未操作")
    branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).stdout.strip()
    if not branch:
        raise RuntimeError("当前为游离 HEAD，请先切回要维护的分支")
    if text(path, "status", "--porcelain"):
        raise RuntimeError("有本地修改，未操作；请先自行提交或保存")
    return branch


def baseline_status(path: Path, pinned: str, head: str) -> str:
    if not pinned:
        return "未记录同步基线"
    if pinned == head:
        return "同步基线与 HEAD 一致"
    if git(path, "cat-file", "-e", f"{pinned}^{{commit}}", check=False).returncode:
        return "基线提交不在本地，无法统计"
    if text(path, "rev-parse", "--is-shallow-repository") == "true":
        return "浅克隆历史不完整，不统计提交数；不报告落后数量"
    ancestor = git(path, "merge-base", "--is-ancestor", pinned, head, check=False)
    if ancestor.returncode == 1:
        return "基线不是当前 HEAD 的祖先，不报告落后数量"
    if ancestor.returncode:
        raise RuntimeError(ancestor.stderr.strip())
    return f"基线后新增 {text(path, 'rev-list', '--count', f'{pinned}..{head}')} commits"


def file_status(source: Path, destination: Path, files: list[str]) -> dict[str, list[str]]:
    result = {"changed": [], "missing_source": [], "missing_local": []}
    for rel in files:
        src, dst = source / rel, destination / rel
        if not src.is_file():
            result["missing_source"].append(rel)
        elif not dst.is_file():
            result["missing_local"].append(rel)
        elif src.read_bytes() != dst.read_bytes():
            result["changed"].append(rel)
    return result
