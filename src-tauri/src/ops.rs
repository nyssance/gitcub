//! 分支操作、贮藏、撤销与历史操作。
//!
//! git 参数照原版 `app/src/lib/git/{merge,rebase,stash,reset,revert,cherry-pick,tag}.ts`
//! 抄。这些命令的细节（`--squash` 之后还要补一次 commit、revert 合并提交要带
//! `-m 1`、贮藏消息的标记格式）都是原版踩出来的，不自己发挥。

use crate::git::Git;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Preserve the Desktop marker so both clients can recognize branch stashes.
const STASH_MARKER: &str = "!!GitHub_Desktop";

pub fn stash_message(branch: &str) -> String {
    format!("{STASH_MARKER}<{branch}>")
}

/// 仓库正卡在哪个多步操作里。
///
/// 这四个都是「开始了但还没收尾」的状态：工作区里可能有冲突要解，解完还得
/// 显式地继续或中止。原先界面是靠 `try continue_rebase() catch commit()` 猜的，
/// 猜错就报一句莫名其妙的 git 错误；而 git 自己在 `.git` 里写得清清楚楚。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

/// 从 `.git` 里认出正在进行的操作，顺带给出「对面」是谁（界面上要写清楚
/// 「用 X 的版本」里的 X 到底是哪条分支）。
pub fn in_progress(git_dir: &Path) -> Option<(Operation, Option<String>)> {
    let head_name = |f: &str| {
        std::fs::read_to_string(git_dir.join(f))
            .ok()
            .map(|s| s.trim().trim_start_matches("refs/heads/").to_string())
            .filter(|s| !s.is_empty())
    };

    if git_dir.join("MERGE_HEAD").exists() {
        // MERGE_MSG 的第一行是 git 自己写的 "Merge branch 'main'"
        let theirs = std::fs::read_to_string(git_dir.join("MERGE_MSG")).ok().and_then(|m| {
            let line = m.lines().next()?.to_string();
            let start = line.find('\'')? + 1;
            let end = line[start..].find('\'')? + start;
            Some(line[start..end].to_string())
        });
        return Some((Operation::Merge, theirs));
    }
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Some((Operation::Rebase, head_name("rebase-merge/onto-name")));
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some((Operation::CherryPick, None));
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some((Operation::Revert, None));
    }
    None
}

/// 收尾。合并是靠一次普通提交收尾的（`--no-edit` 用 git 备好的 MERGE_MSG），
/// 其余三个都有自己的 `--continue`。
pub fn continue_operation(repo: &Path, op: Operation) -> Result<(), String> {
    if op == Operation::Merge {
        return finish_merge(repo, &[], &[]).map(|_| ());
    }
    if op == Operation::Rebase {
        return continue_rebase(repo, &[], None);
    }
    if op == Operation::CherryPick {
        let outcome = continue_cherry_pick(repo, &[], &[])?;
        return if matches!(outcome.result, CherryPickResult::CompletedWithoutError) {
            Ok(())
        } else {
            Err(outcome.diagnostic)
        };
    }
    let args: &[&str] = match op {
        Operation::Merge => &["commit", "--no-edit"],
        Operation::Rebase => &["rebase", "--continue"],
        Operation::CherryPick => &["cherry-pick", "--continue"],
        Operation::Revert => &["revert", "--continue"],
    };
    Git::new(Some(repo)).args(args).run()
}

/// Desktop createMergeCommit: keep already staged files and apply explicit resolutions.
pub fn finish_merge(repo: &Path, paths: &[String], resolutions: &[(String, Resolution)]) -> Result<String, String> {
    for (path, resolution) in resolutions {
        resolve_conflict(repo, path, *resolution)?;
    }
    let other: Vec<_> = paths.iter().filter(|path| !resolutions.iter().any(|(p, _)| p == *path)).collect();
    if !other.is_empty() {
        Git::new(Some(repo)).args(["--literal-pathspecs", "add", "-A", "--"]).args(other).run()?;
    }
    let output = Git::new(Some(repo)).args(["commit", "--no-edit", "--cleanup=strip"]).output()?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let error = crate::git::stderr_of(&output);
    if error.contains("nothing to commit") {
        return Err("There are no changes to commit.".into());
    }
    Err(error)
}

/// Desktop continueRebase：按传入文件暂存解决结果，非交互式完成提交信息编辑。
pub fn continue_rebase(repo: &Path, paths: &[String], editor: Option<&str>) -> Result<(), String> {
    let outcome = continue_rebase_with_resolutions(repo, paths, &[], editor)?;
    match outcome.result {
        RebaseResult::CompletedWithoutError | RebaseResult::AlreadyUpToDate => Ok(()),
        _ => Err(outcome.diagnostic),
    }
}

pub fn abort_operation(repo: &Path, op: Operation) -> Result<(), String> {
    let args: &[&str] = match op {
        Operation::Merge => &["merge", "--abort"],
        Operation::Rebase => &["rebase", "--abort"],
        Operation::CherryPick => &["cherry-pick", "--abort"],
        Operation::Revert => &["revert", "--abort"],
    };
    let out = Git::new(Some(repo)).args(args).output()?;
    if out.status.success() {
        return Ok(());
    }
    let error = crate::git::stderr_of(&out);
    if op == Operation::Merge && error.contains("There is no merge to abort") {
        return Err("There is no merge in progress, so there is nothing to abort".into());
    }
    Err(error)
}

// ── 分支 ────────────────────────────────────────────────────────────

/// 合并会不会冲突 —— **合之前**就告诉用户。
///
/// 照原版 determineMergeability：`git merge-tree --write-tree` 在内存里试合一次，
/// 冲突的文件名列在树 ID 后面，数一数 NUL 就知道有几个。它不碰工作区，
/// 也不碰 index，所以随便调。
///
/// 有这一步的意义：原来是「点合并 → 一堆冲突 → 现在怎么办」，
/// 现在是「点合并 → 告诉你会有 3 个文件冲突 → 你决定合不合」。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// 会冲突的文件数。0 = 干净
    pub conflicts: u32,
    /// 两条线毫无共同祖先，根本没法合
    pub unrelated: bool,
}

pub fn merge_preview(repo: &Path, ours: &str, theirs: &str) -> Result<MergePreview, String> {
    let out = Git::new(Some(repo))
        .args(["--no-optional-locks", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs])
        .output()?;

    // 退出码 1 = 有冲突，不是错误；但冲突的结果至少会写出树 ID。
    // 一个字节都没写出的 1（比如分支不存在时的「not something we can merge」）
    // 是真出问题，不能当成「0 个冲突」放过去——GitLens c54e108f4 修的就是这个。
    match out.status.code() {
        Some(0) => {}
        Some(1) if !out.stdout.is_empty() => {}
        _ => {
            let err = crate::git::stderr_of(&out);
            if err.contains("unrelated histories") || err.contains("refusing to merge") {
                return Ok(MergePreview { conflicts: 0, unrelated: true });
            }
            return Err(err);
        }
    }

    // 输出是 `<树 ID>\0[<文件名>\0]*`，减掉树 ID 那一个就是冲突文件数
    let n = out.stdout.iter().filter(|b| **b == 0).count();
    Ok(MergePreview { conflicts: n.saturating_sub(1) as u32, unrelated: false })
}

/// 合并分支。`squash` 时原版会在 merge --squash 之后再补一次 commit ——
/// --squash 只把改动放进暂存区，不产生提交。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MergeResult {
    Success,
    AlreadyUpToDate,
}

pub fn merge(repo: &Path, branch: &str, squash: bool) -> Result<(), String> {
    merge_result(repo, branch, squash).map(|_| ())
}

pub fn merge_result(repo: &Path, branch: &str, squash: bool) -> Result<MergeResult, String> {
    merge_with_options(repo, branch, squash, false)
}

pub fn merge_with_options(repo: &Path, branch: &str, squash: bool, no_verify: bool) -> Result<MergeResult, String> {
    // 原版 merge.ts 两条命令各自的 interceptHooks。命令在 scoped 里才建，钩子代理的环境才带得上
    let output = crate::hooks::scoped(repo, &["pre-merge-commit", "post-merge", "commit-msg"], || {
        let mut command = Git::new(Some(repo)).arg("merge");
        if no_verify {
            command = command.arg("--no-verify");
        }
        if squash {
            command = command.arg("--squash");
        }
        command.args(["--", branch]).env("GIT_MERGE_AUTOEDIT", "no").output()
    })?;
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    if squash {
        let intercept = ["pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-auto-gc"];
        crate::hooks::scoped(repo, &intercept, || Git::new(Some(repo)).args(["commit", "--no-edit"]).run())?;
    }
    Ok(if output.stdout == b"Already up to date.\n" { MergeResult::AlreadyUpToDate } else { MergeResult::Success })
}

pub fn merge_base(repo: &Path, first: &str, second: &str) -> Result<Option<String>, String> {
    let out = Git::new(Some(repo)).args(["merge-base", "--", first, second]).output()?;
    match out.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().into())),
        Some(1 | 128) => Ok(None),
        _ => Err(crate::git::stderr_of(&out)),
    }
}

/// 把当前分支变基到 base 上。
#[allow(dead_code)] // Non-streaming entry point used by the upstream conformance bridge.
pub fn rebase(repo: &Path, base: &str) -> Result<(), String> {
    let outcome = rebase_branch(repo, base, None)?;
    match outcome.result {
        RebaseResult::CompletedWithoutError | RebaseResult::AlreadyUpToDate => Ok(()),
        _ => Err(outcome.diagnostic),
    }
}

pub fn rename_branch(repo: &Path, from: &str, to: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["branch", "-m", from, to]).run()
}

/// 相对某个分支领先/落后多少个提交。
pub fn ahead_behind(repo: &Path, ours: &str, theirs: &str) -> Result<(u32, u32), String> {
    ahead_behind_range(repo, &symmetric_difference(ours, theirs))?.ok_or_else(|| "无法解析比较的引用".into())
}

pub fn symmetric_difference(ours: &str, theirs: &str) -> String {
    format!("{ours}...{theirs}")
}

pub fn ahead_behind_range(repo: &Path, range: &str) -> Result<Option<(u32, u32)>, String> {
    match crate::history::left_right_counts(repo, range) {
        Ok(counts) => return Ok(Some(counts)),
        Err(reason) => log::debug!("ahead/behind fast path unavailable for {}: {reason}", repo.display()),
    }
    ahead_behind_via_git(repo, range)
}

/// Desktop `getAheadBehind` 的原始命令。
pub fn ahead_behind_via_git(repo: &Path, range: &str) -> Result<Option<(u32, u32)>, String> {
    let out =
        Git::new(Some(repo)).args(["rev-list", "--left-right", "--count", "--end-of-options", range, "--"]).output()?;
    if out.status.code() == Some(128) {
        return Ok(None);
    }
    if !out.status.success() {
        return Err(crate::git::stderr_of(&out));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(Some((ahead, behind)))
}

// ── 贮藏 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// 形如 stash@{0}
    pub name: String,
    pub sha: String,
    pub message: String,
    /// 是不是本客户端建的（消息带标记）
    pub ours: bool,
    pub branch_name: Option<String>,
    pub tree: String,
    pub parents: Vec<String>,
}

/// 贮藏列表。原版用 `log -g refs/stash`，而不是 `stash list`——后者的格式
/// 不好稳定解析。仓库还没有 stash 时 git 退出码是 128，不算错误。
pub fn stashes(repo: &Path) -> Result<Vec<StashEntry>, String> {
    let records = match stash_records_in_process(repo) {
        Some(records) => records,
        None => match stash_records_via_git(repo)? {
            Some(records) => records,
            None => return Ok(vec![]),
        },
    };
    Ok(parse_stash_records(&records))
}

/// Desktop `getStashes`: `git log -g --format=%gD%x00%H%x00%gs%x00%T%x00%P refs/stash --`; exit 128
/// (no stash ref) is `None`.
pub fn stash_records_via_git(repo: &Path) -> Result<Option<String>, String> {
    let output = Git::new(Some(repo))
        .args(["log", "-g", "--format=%gD%x00%H%x00%gs%x00%T%x00%P", "refs/stash", "--"])
        .output()?;
    if output.status.code() == Some(128) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

/// The same records from the `refs/stash` reflog, newest first as `log -g` walks it. A missing ref
/// (and no other ref `refs/stash` could expand to) is an empty list, as git's exit 128 is. Anything
/// unusual — a symbolic or reflog-less ref, a null or missing commit, an unparsable line — is left
/// to git (`None`).
pub fn stash_records_in_process(repo: &Path) -> Option<String> {
    let repo = gix::open(repo).ok()?;
    let Some(reference) = repo.try_find_reference("refs/stash").ok()? else {
        let candidates =
            ["refs/refs/stash", "refs/tags/refs/stash", "refs/heads/refs/stash", "refs/remotes/refs/stash"];
        let other = candidates
            .iter()
            .chain(&["refs/remotes/refs/stash/HEAD"])
            .any(|name| !matches!(repo.try_find_reference(*name), Ok(None)));
        return if other { None } else { Some(String::new()) };
    };
    if reference.name().as_bstr() != "refs/stash" || !matches!(reference.target(), gix::refs::TargetRef::Object(_)) {
        return None;
    }
    let mut out = String::new();
    let mut log = reference.log_iter();
    let entries = log.rev().ok()??;
    for (index, entry) in entries.enumerate() {
        let entry = entry.ok()?;
        let id = entry.new_oid;
        if id.is_null() {
            return None;
        }
        let commit = repo.find_object(id).ok()?.try_into_commit().ok()?;
        let parents = commit.parent_ids().map(|id| id.to_string()).collect::<Vec<_>>().join(" ");
        let tree = commit.tree_id().ok()?;
        let message = String::from_utf8_lossy(entry.message.as_ref());
        out.push_str(&format!("refs/stash@{{{index}}}\0{id}\0{message}\0{tree}\0{parents}\n"));
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn parse_stash_records(records: &str) -> Vec<StashEntry> {
    records
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.trim_start_matches("refs/").to_string();
            let sha = parts.next()?.to_string();
            let message = parts.next()?.to_string();
            let branch_name = [STASH_MARKER, "!!GitCub", "!!Quipu"].iter().find_map(|marker| {
                let (_, rest) = message.split_once(&format!("{marker}<"))?;
                rest.strip_suffix('>').filter(|name| !name.is_empty()).map(str::to_string)
            });
            let tree = parts.next()?.to_string();
            let parents = parts.next()?.split_whitespace().map(str::to_string).collect();
            Some(StashEntry { name, sha, message, ours: branch_name.is_some(), branch_name, tree, parents })
        })
        .collect()
}

/// 贮藏当前分支的改动。
///
/// 贮藏前先把未跟踪文件 `git add` 进去——照原版 createDesktopStashEntry
/// （desktop#8085）。不这么做的话 `git stash push` 不收未跟踪文件，它们会
/// 留在工作区跟着你跑到别的分支上，而用户以为「改动都存起来了」。
/// 原版用 add 而不是 `--include-untracked`，这里照抄不发挥。
pub fn stash_push(repo: &Path, branch: &str) -> Result<(), String> {
    let untracked: Vec<String> = crate::status::status(repo)?
        .changes
        .iter()
        .filter(|c| c.kind == crate::status::ChangeKind::Untracked)
        .map(|c| c.path.clone())
        .collect();
    create_stash(repo, branch, &untracked).map(|_| ())
}

pub fn create_stash(repo: &Path, branch: &str, untracked: &[String]) -> Result<bool, String> {
    if !untracked.is_empty() {
        Git::new(Some(repo)).args(["--literal-pathspecs", "add", "--"]).args(untracked).run()?;
    }
    let output = Git::new(Some(repo)).args(["stash", "push", "-m", &stash_message(branch)]).output()?;
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(output.stdout != b"No local changes to save\n")
}

pub fn last_branch_stash(repo: &Path, branch: &str) -> Result<Option<StashEntry>, String> {
    Ok(stashes(repo)?.into_iter().find(|entry| entry.branch_name.as_deref() == Some(branch)))
}

pub fn drop_stash_sha(repo: &Path, sha: &str) -> Result<(), String> {
    if let Some(entry) = stashes(repo)?.into_iter().find(|entry| entry.ours && entry.sha == sha) {
        stash_drop(repo, &entry.name)?;
    }
    Ok(())
}

pub fn pop_stash_sha(repo: &Path, sha: &str) -> Result<(), String> {
    if let Some(entry) = stashes(repo)?.into_iter().find(|entry| entry.ours && entry.sha == sha) {
        stash_pop(repo, &entry.name)?;
    }
    Ok(())
}

pub fn stash_pop(repo: &Path, name: &str) -> Result<(), String> {
    let output = Git::new(Some(repo)).args(["stash", "pop", "--quiet", name]).output()?;
    if output.status.success() {
        return Ok(());
    }
    // Desktop leaves resolvable conflicts in the working tree and removes the
    // applied stash; errors preventing application must retain the stash.
    if output.status.code() == Some(1) && output.stderr.is_empty() {
        return stash_drop(repo, name);
    }
    Err(crate::git::stderr_of(&output))
}

pub fn stash_drop(repo: &Path, name: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["stash", "drop", name]).run()
}

// ── 撤销与重置 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    /// 丢弃提交，改动也丢
    Hard,
    /// 丢弃提交，改动退回工作区（未暂存）
    Mixed,
    /// 丢弃提交，改动留在暂存区
    Soft,
}

pub fn reset(repo: &Path, mode: ResetMode, target: &str) -> Result<(), String> {
    let args: &[&str] = match mode {
        ResetMode::Hard => &["reset", "--hard"],
        ResetMode::Mixed => &["reset"],
        ResetMode::Soft => &["reset", "--soft"],
    };
    Git::new(Some(repo)).args(args).arg(target).run()
}

/// Reset explicit paths without interpreting pathspec metacharacters.
pub fn reset_paths(repo: &Path, mode: ResetMode, target: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut command = Git::new(Some(repo)).args(["--literal-pathspecs", "reset"]);
    command = match mode {
        ResetMode::Hard => command.arg("--hard"),
        ResetMode::Soft => command.arg("--soft"),
        ResetMode::Mixed => command,
    };
    command.args([target, "--"]).args(paths).run()
}

/// 撤销上一次提交：改动退回暂存区，提交没了。
/// 用 `--soft` 而不是 `--mixed`：撤销后多半是要改一下重新提交，
/// 让暂存状态保持原样，用户不用重新勾一遍。
pub fn undo_commit(repo: &Path) -> Result<(), String> {
    reset(repo, ResetMode::Soft, "HEAD^")
}

/// 修订上一次提交。
#[allow(dead_code)] // Non-streaming entry point used by the upstream conformance bridge.
pub fn amend(repo: &Path, summary: &str, description: &str) -> Result<(), String> {
    amend_stream(repo, summary, description, |_| {})
}

/// Desktop createCommit 的 amend：钩子多拦一个 post-rewrite，输出给「提交进度」
pub fn amend_stream(
    repo: &Path, summary: &str, description: &str, on_output: impl FnMut(crate::git::TerminalChunk),
) -> Result<(), String> {
    let intercept = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "pre-auto-gc"];
    crate::hooks::scoped(repo, &intercept, || {
        let mut g = Git::new(Some(repo)).args(["commit", "--amend", "-m"]).arg(summary);
        if !description.trim().is_empty() {
            g = g.args(["-m"]).arg(description);
        }
        let out = g.output_stream(on_output)?;
        crate::git::checked_result(Path::new("."), out, &[0], &[]).map(|_| ())
    })
}

// ── 历史操作 ────────────────────────────────────────────────────────

/// 回滚一个提交。合并提交要带 `-m 1` 指定沿哪条父线回滚。
pub fn revert(repo: &Path, sha: &str, is_merge: bool) -> Result<(), String> {
    let mut g = Git::new(Some(repo)).arg("revert");
    if is_merge {
        g = g.args(["-m", "1"]);
    }
    g.arg(sha).run()
}

/// 摘取提交。`--empty=keep` 保留变成空的提交，与原版一致。
#[allow(dead_code)] // Non-streaming entry point used by the upstream conformance bridge.
pub fn cherry_pick(repo: &Path, shas: &[String]) -> Result<(), String> {
    cherry_pick_stream(repo, shas, |_| {}, |_| {})
}
pub fn cherry_pick_stream(
    repo: &Path, shas: &[String], output: impl FnMut(crate::git::TerminalChunk),
    on_progress: impl FnMut(MultiCommitProgress),
) -> Result<(), String> {
    let commits = shas
        .iter()
        .map(|sha| {
            let commit = crate::history::query(repo, sha, Some(1), None, &[])?
                .into_iter()
                .next()
                .ok_or("Missing cherry-pick commit")?;
            Ok(crate::history::CommitOneLine { sha: commit.sha, summary: commit.summary })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let outcome = cherry_pick_commits_stream(repo, &commits, output, on_progress)?;
    if matches!(outcome.result, CherryPickResult::CompletedWithoutError) { Ok(()) } else { Err(outcome.diagnostic) }
}

// ── 标签 ────────────────────────────────────────────────────────────

/// 建带注释的标签（原版就是 `-a -m ''`）。
pub fn create_tag(repo: &Path, name: &str, sha: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["tag", "-a", "-m", "", name, sha]).run()
}

pub fn delete_tag(repo: &Path, name: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["tag", "-d", name]).run()
}

pub fn tags(repo: &Path) -> Result<Vec<String>, String> {
    Ok(Git::new(Some(repo))
        .args(["tag", "--list", "--sort=-creatordate"])
        .stdout_or_empty()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect())
}

/// Desktop getAllTags: annotated tags resolve to their commit, not the tag object.
pub fn all_tags(repo: &Path) -> Result<std::collections::BTreeMap<String, String>, String> {
    let output = Git::new(Some(repo)).args(["show-ref", "--tags", "-d"]).output()?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(crate::git::stderr_of(&output));
    }
    let mut tags = std::collections::BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((sha, name)) = line.split_once(' ') {
            let name = name.strip_prefix("refs/tags/").unwrap_or(name);
            tags.insert(name.strip_suffix("^{}").unwrap_or(name).into(), sha.into());
        }
    }
    Ok(tags)
}

/// Dry-run preserves tag results even when pushing the branch would be rejected.
pub fn tags_to_push(repo: &Path, remote: &str, branch: &str, token: Option<&str>) -> Result<Vec<String>, String> {
    let output = Git::new(Some(repo))
        .args(["push", "--follow-tags", "--dry-run", "--no-verify", "--porcelain", "--", remote, branch])
        .with_optional_token(token, None)
        .output()?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split('\t').collect();
            if parts.len() == 3 && parts[0] == "*" && parts[2] == "[new tag]" {
                Some(parts[1].split(':').next()?.trim_start_matches("refs/tags/").into())
            } else {
                None
            }
        })
        .collect())
}

/// 同步上游：从 fork 的源仓库拉取并快进。
///
/// 做法与原版的 update-branch-with-contribution-target-branch 一致：
/// 配一个 `upstream` 远端 → 拉它的默认分支 → 合并。用 `--ff-only`，
/// 因为 fork 的主分支上本来就不该有自己的提交；真有的话让用户自己决定怎么办，
/// 而不是默默造一个合并提交。
pub fn sync_upstream(repo: &Path, upstream_url: &str, branch: &str) -> Result<(), String> {
    // 已经配过就更新地址，没配过就加
    let has = Git::new(Some(repo)).args(["remote", "get-url", "upstream"]).stdout().is_ok();
    if has {
        Git::new(Some(repo)).args(["remote", "set-url", "upstream", upstream_url]).run()?;
    } else {
        Git::new(Some(repo)).args(["remote", "add", "upstream", upstream_url]).run()?;
    }

    Git::new(Some(repo)).args(["fetch", "upstream"]).run()?;
    Git::new(Some(repo)).args(["merge", "--ff-only", &format!("upstream/{branch}")]).run()
}

// ── 工作树 ──────────────────────────────────────────────────────────

/// 一个工作树。主仓库自己也是一个（`main` 为真）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub main: bool,
    pub sha: Option<String>,
    pub kind: String,
    pub locked: WorktreeReason,
    pub prunable: WorktreeReason,
}

/// GitLens 保留整个 lock/prune 原因；无原因时为 true，未设置时为 false。
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum WorktreeReason {
    Flag(bool),
    Reason(String),
}

impl WorktreeReason {
    fn parse(reason: &str) -> Self {
        let reason = unquote_c_string(reason.trim());
        if reason.is_empty() { Self::Flag(true) } else { Self::Reason(reason) }
    }
}

/// 还原 Git 的 C 风格引号（`"a\nb"`、`\303\251` 八进制 UTF-8 字节）；没加引号的原样返回。
/// 锁定/可清理原因带换行或非 ASCII 时 Git 会这样输出（core.quotePath 默认开）。
/// 对齐 GitLens c1f6e5f3c3097bbc03a250050b1f7009411d9d56 `worktreeParser.ts` 的 `unquoteCString`。
fn unquote_c_string(value: &str) -> String {
    if !value.starts_with('"') {
        return value.into();
    }
    let inner = value[1..].strip_suffix('"').unwrap_or(&value[1..]).as_bytes();
    let mut bytes = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] != b'\\' || i + 1 >= inner.len() {
            bytes.push(inner[i]);
            i += 1;
            continue;
        }
        let next = inner[i + 1];
        if next.is_ascii_digit() && next < b'8' {
            let mut j = i + 1;
            while j < i + 4 && j < inner.len() && inner[j].is_ascii_digit() && inner[j] < b'8' {
                j += 1;
            }
            let octal = std::str::from_utf8(&inner[i + 1..j]).expect("octal digits are ASCII");
            bytes.push((u32::from_str_radix(octal, 8).expect("octal digits") & 0xff) as u8);
            i = j;
            continue;
        }
        bytes.push(match next {
            b'a' => 7,
            b'b' => 8,
            b'f' => 12,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'v' => 11,
            other => other,
        });
        i += 2;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// 工作树列表。用 `--porcelain`：默认输出是给人看的，列宽会变。
pub fn worktrees(repo: &Path) -> Result<Vec<Worktree>, String> {
    let out = Git::new(Some(repo)).args(["worktree", "list", "--porcelain", "-z"]).stdout()?;
    Ok(parse_worktrees(&out))
}

pub fn worktrees_from_git_dir(git_dir: &Path) -> Result<Vec<Worktree>, String> {
    let out = Git::new(Some(git_dir))
        .arg("--git-dir")
        .arg(git_dir)
        .args(["worktree", "list", "--porcelain", "-z"])
        .stdout()?;
    Ok(parse_worktrees(&out))
}

/// A persisted main-worktree path survives pruning; stale hints fall back to Git metadata.
pub fn main_worktree_path(
    repo: &Path, main_path: Option<&Path>, git_dir: Option<&Path>,
) -> Result<Option<String>, String> {
    if main_path == Some(repo) {
        return Ok(None);
    }
    if let Some(path) = main_path.filter(|path| path.exists()) {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    let Some(git_dir) = git_dir else {
        return Ok(None);
    };
    Ok(worktrees_from_git_dir(git_dir)?.into_iter().find(|wt| wt.main && Path::new(&wt.path) != repo).map(|wt| wt.path))
}

pub fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut entry: Option<Worktree> = None;

    // -z preserves embedded newlines in paths. Keep newline input for GitLens callers.
    let fields: Vec<_> = if out.contains('\0') { out.split('\0').collect() } else { out.lines().collect() };
    for line in fields.into_iter().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(worktree) = entry.take() {
                list.push(worktree);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            entry = Some(Worktree {
                path: rest.into(),
                branch: None,
                main: list.is_empty(),
                sha: None,
                kind: "branch".into(),
                locked: WorktreeReason::Flag(false),
                prunable: WorktreeReason::Flag(false),
            });
        } else if let Some(worktree) = entry.as_mut() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                // GitLens c1f6e5f3c：HEAD 指向 `refs/heads/` 之外（如 refs/remotes/…）时不算分支。
                "branch" => worktree.branch = value.strip_prefix("refs/heads/").map(Into::into),
                "HEAD" => worktree.sha = Some(value.into()),
                "bare" | "detached" => worktree.kind = key.into(),
                "locked" => worktree.locked = WorktreeReason::parse(value),
                "prunable" => worktree.prunable = WorktreeReason::parse(value),
                _ => {}
            }
        }
    }
    list
}

/// 新建工作树。已有分支就挂上去，没有就顺手建一条——这正是工作树最常见的
/// 用法：为一条新分支单开一个目录，不动当前工作区。
pub fn add_worktree(repo: &Path, path: &Path, branch: &str, create: bool) -> Result<(), String> {
    add_worktree_at(repo, path, create.then_some(branch), (!create).then_some(branch))
}
pub fn add_worktree_at(
    repo: &Path, path: &Path, create_branch: Option<&str>, commitish: Option<&str>,
) -> Result<(), String> {
    let mut git = Git::new(Some(repo)).args(["worktree", "add"]);
    if let Some(branch) = create_branch {
        git = git.args(["-b", branch]);
    }
    git = git.arg("--").arg(path);
    if let Some(commitish) = commitish {
        git = git.arg(commitish);
    }
    git.run()
}

pub fn remove_worktree(repo: &Path, path: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["worktree", "remove", path]).run()
}

/// Desktop `moveWorktree` 的工作目录与参数：从主工作树运行，因为 `repo` 往往就是
/// 被移动的那个工作树，而 Windows 拒绝重命名某个进程的当前目录。
pub fn move_worktree_command(
    repo: &Path, old_path: &str, new_path: &str,
) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let main = worktrees(repo)?
        .into_iter()
        .find(|wt| wt.main)
        .ok_or_else(|| "Could not determine the main worktree of the repository".to_string())?;
    Ok((main.path.into(), ["worktree", "move", "--", old_path, new_path].map(String::from).to_vec()))
}

/// 移动（重命名）一个链接工作树。
pub fn move_worktree(repo: &Path, old_path: &str, new_path: &str) -> Result<(), String> {
    let (cwd, args) = move_worktree_command(repo, old_path, new_path)?;
    Git::new(Some(&cwd)).args(args).run()
}

// ── 冲突 ────────────────────────────────────────────────────────────

/// 冲突文件的取舍。`--ours` 是当前分支那一版，`--theirs` 是被合进来那一版。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    Ours,
    Theirs,
}

pub fn add_conflicted_file(repo: &Path, file: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["--literal-pathspecs", "add", "--", file]).run()
}

/// 按用户的取舍解决一个冲突文件。
///
/// 不能一律 `git checkout --ours/--theirs`：modify/delete 冲突里被选中的那边
/// 根本没有这个文件的版本，git 会直接报
/// `path 'x' does not have their version`。原版（stageManualConflictResolution）
/// 是看 index 里那一侧在不在——不在就 `git rm`（接受删除），在就 checkout 再 add。
pub fn resolve_conflict(repo: &Path, file: &str, keep: Resolution) -> Result<(), String> {
    let data = Git::new(Some(repo)).arg("--literal-pathspecs").args(["ls-files", "-u", "-z", "--", file]).stdout()?;
    let conflicts = crate::index_parser::conflicts(Some(&data), &repo.to_string_lossy());
    let conflict = conflicts.iter().find(|entry| entry.path == file).ok_or("该文件已不在冲突索引中，请刷新")?;
    let chosen_exists = match keep {
        Resolution::Ours => conflict.current.is_some(),
        Resolution::Theirs => conflict.incoming.is_some(),
    };

    if !chosen_exists {
        // 选中的那边把文件删了——「用那边的」就是接受这个删除
        return Git::new(Some(repo)).arg("--literal-pathspecs").args(["rm", "-q", "--", file]).run();
    }

    let flag = match keep {
        Resolution::Ours => "--ours",
        Resolution::Theirs => "--theirs",
    };
    Git::new(Some(repo)).arg("--literal-pathspecs").args(["checkout", flag, "--", file]).run()?;
    // 取完还得标记成已解决，否则 git 仍认为它在冲突中
    add_conflicted_file(repo, file)
}

/// 冲突中的文件列表。`diff --name-only --diff-filter=U` 只给未解决的。
/// 只在测试里用：判定标准要由 git 自己给，而不是拿我们的 status 验我们自己。
#[derive(Debug, Serialize)]
pub enum CherryPickResult {
    CompletedWithoutError,
    ConflictsEncountered,
    OutstandingFilesNotStaged,
    UnableToStart,
}
#[derive(Serialize)]
pub struct CherryPickOutcome {
    pub result: CherryPickResult,
    pub progress: Vec<MultiCommitProgress>,
    pub diagnostic: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickSnapshot {
    pub progress: MultiCommitProgress,
    pub remaining_commits: Vec<crate::history::CommitOneLine>,
    pub commits: Vec<crate::history::CommitOneLine>,
    pub target_branch_undo_sha: String,
    pub cherry_picked_count: usize,
}

pub fn cherry_pick_snapshot(repo: &Path) -> Result<Option<CherryPickSnapshot>, String> {
    let git = gix::open(repo).map_err(|e| e.to_string())?;
    let head_path = git.path().join("CHERRY_PICK_HEAD");
    if !head_path.exists() {
        return Ok(None);
    }
    let read =
        |name: &str| std::fs::read_to_string(git.path().join("sequencer").join(name)).map(|s| s.trim().to_string());
    let mut head = String::new();
    let sequence = (|| -> std::io::Result<_> {
        let safety = read("abort-safety")?;
        head = read("head")?;
        let todo = read("todo")?;
        Ok((safety, todo))
    })();
    let (safety, todo) = match sequence {
        Ok(sequence) => sequence,
        Err(_) => {
            let Ok(sha) = std::fs::read_to_string(head_path) else {
                return Ok(None);
            };
            let Some(commit) = crate::history::query(repo, sha.trim(), Some(1), None, &[])?.into_iter().next() else {
                return Ok(None);
            };
            let commits = vec![crate::history::CommitOneLine { sha: commit.sha, summary: commit.summary }];
            return Ok(Some(CherryPickSnapshot {
                progress: progress_at(1, 1, &commits),
                remaining_commits: vec![],
                commits,
                target_branch_undo_sha: head,
                cherry_picked_count: 0,
            }));
        }
    };
    if head.is_empty() || safety.is_empty() || todo.is_empty() {
        return Ok(None);
    }
    let remaining_commits: Vec<_> = todo
        .lines()
        .filter_map(|line| {
            let (sha, summary) = line.strip_prefix("pick ").unwrap_or(line).split_once(' ')?;
            Some(crate::history::CommitOneLine { sha: sha.into(), summary: summary.into() })
        })
        .collect();
    if remaining_commits.is_empty() {
        return Ok(None);
    }
    let mut commits = if safety != head {
        let Some(commits) = crate::history::commits_in_range(repo, &format!("{head}..{safety}"))? else {
            return Ok(None);
        };
        commits
    } else {
        vec![]
    };
    let cherry_picked_count = commits.len();
    commits.extend(remaining_commits.iter().cloned());
    Ok(Some(CherryPickSnapshot {
        progress: progress_at(cherry_picked_count + 1, commits.len(), &commits),
        remaining_commits,
        commits,
        target_branch_undo_sha: head,
        cherry_picked_count,
    }))
}

fn parse_cherry_pick_output(
    repo: &Path, output: std::process::Output, commits: &[crate::history::CommitOneLine], count: usize,
) -> Result<CherryPickOutcome, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut position = count;
    let progress = stdout
        .lines()
        .filter(|line| is_cherry_picked_line(line))
        .map(|_| {
            position += 1;
            progress_at(position, commits.len(), commits)
        })
        .collect();
    let diagnostic = crate::git::stderr_of(&output);
    let result = if output.status.success() {
        CherryPickResult::CompletedWithoutError
    } else if stdout.contains("CONFLICT") {
        CherryPickResult::ConflictsEncountered
    } else if crate::status::status(repo)?
        .changes
        .iter()
        .any(|file| file.change == crate::status::ChangeType::Conflicted)
    {
        CherryPickResult::OutstandingFilesNotStaged
    } else {
        return Err(diagnostic);
    };
    Ok(CherryPickOutcome { result, progress, diagnostic })
}

pub fn cherry_pick_commits(
    repo: &Path, commits: &[crate::history::CommitOneLine],
) -> Result<CherryPickOutcome, String> {
    cherry_pick_commits_stream(repo, commits, |_| {}, |_| {})
}
pub fn cherry_pick_commits_stream(
    repo: &Path, commits: &[crate::history::CommitOneLine], mut on_output: impl FnMut(crate::git::TerminalChunk),
    mut on_progress: impl FnMut(MultiCommitProgress),
) -> Result<CherryPickOutcome, String> {
    if commits.is_empty() {
        return Ok(CherryPickOutcome {
            result: CherryPickResult::UnableToStart,
            progress: vec![],
            diagnostic: "No commits to cherry-pick".into(),
        });
    }
    let shas = commits
        .iter()
        .map(|commit| crate::history::resolve_revision(repo, &commit.sha))
        .collect::<Result<Vec<_>, _>>()?;
    // Desktop _initializeCherryPickProgress：初始摘要取最后一个提交
    on_progress(initial_progress(commits.last().map(|c| c.summary.as_str()), commits.len()));
    let mut position = 0;
    let mut lines = line_stream(crate::git::TerminalStream::Stdout, |line| {
        if is_cherry_picked_line(line) {
            position += 1;
            on_progress(progress_at(position, commits.len(), commits));
        }
    });
    let output =
        Git::new(Some(repo)).arg("cherry-pick").args(shas).args(["--empty=keep", "-m", "1"]).output_raw_stream(
            |chunk| {
                lines(&chunk);
                on_output(chunk);
            },
        )?;
    drop(lines);
    parse_cherry_pick_output(repo, output, commits, 0)
}

pub fn continue_cherry_pick(
    repo: &Path, paths: &[String], resolutions: &[(String, Resolution)],
) -> Result<CherryPickOutcome, String> {
    for (path, resolution) in resolutions {
        if paths.contains(path) {
            resolve_conflict(repo, path, *resolution)?;
        }
    }
    let tracked: Vec<_> = crate::status::status(repo)?
        .changes
        .into_iter()
        .filter(|file| {
            file.kind != crate::status::ChangeKind::Untracked
                && paths.contains(&file.path)
                && !resolutions.iter().any(|(path, _)| path == &file.path)
        })
        .map(|file| file.path)
        .collect();
    if !tracked.is_empty() {
        Git::new(Some(repo)).args(["--literal-pathspecs", "add", "-A", "--"]).args(tracked).run()?;
    }
    let Some(snapshot) = cherry_pick_snapshot(repo)? else {
        return Ok(CherryPickOutcome {
            result: CherryPickResult::UnableToStart,
            progress: vec![],
            diagnostic: "No cherry-pick state".into(),
        });
    };
    let has_changes =
        crate::status::status(repo)?.changes.iter().any(|file| file.kind != crate::status::ChangeKind::Untracked);
    let args = if has_changes { ["cherry-pick", "--continue"] } else { ["commit", "--allow-empty"] };
    let output = Git::new(Some(repo)).args(args).env("GIT_EDITOR", ":").output()?;
    parse_cherry_pick_output(repo, output, &snapshot.commits, snapshot.cherry_picked_count)
}

#[cfg(test)]
pub fn conflicted_files(repo: &Path) -> Vec<String> {
    Git::new(Some(repo))
        .args(["diff", "--name-only", "--diff-filter=U"])
        .stdout_or_empty()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// Reflog order is newest first. Renamed intermediate names must stay excluded.
pub fn recent_branches(repo: &Path, limit: usize) -> Result<Vec<String>, String> {
    let output = Git::new(Some(repo))
        .args(["log", "-g", "--no-abbrev-commit", "--pretty=oneline", "HEAD", "-n", "2500", "--"])
        .output()?;
    if output.status.code() == Some(128) {
        return Ok(vec![]);
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    let mut names = Vec::new();
    let mut excluded = std::collections::HashSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if names.len() == limit {
            break;
        }
        let operation = line
            .split_once("checkout: moving from ")
            .map(|(_, rest)| (false, rest))
            .or_else(|| line.split_once("renamed ").map(|(_, rest)| (true, rest)));
        let Some((renamed, rest)) = operation else {
            continue;
        };
        let Some((from, to)) = rest.split_once(" to ") else {
            continue;
        };
        let from = from.trim_start_matches("refs/heads/");
        let to = to.trim_start_matches("refs/heads/");
        if renamed {
            excluded.insert(from.to_string());
        }
        if !excluded.contains(to) && !names.iter().any(|name| name == to) {
            names.push(to.to_string());
        }
    }
    Ok(names)
}

pub fn branch_checkouts(repo: &Path, after: &str) -> Result<std::collections::BTreeMap<String, String>, String> {
    let output = Git::new(Some(repo))
        .args([
            "reflog",
            "--date=iso",
            &format!("--after={after}"),
            "--pretty=%H %gd %gs",
            "--grep-reflog=checkout: moving from .* to .*$",
            "--",
        ])
        .output()?;
    if output.status.code() == Some(128)
        && String::from_utf8_lossy(&output.stderr).contains("does not have any commits yet")
    {
        return Ok(Default::default());
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    let mut checkouts = std::collections::BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((_, rest)) = line.split_once(" HEAD@{")
            && let Some((date, rest)) = rest.split_once("} checkout: moving from ")
            && let Some((_, name)) = rest.rsplit_once(" to ")
        {
            checkouts.entry(name.into()).or_insert_with(|| date.to_string());
        }
    }
    Ok(checkouts)
}

#[derive(Debug, serde::Serialize)]
pub struct SubmoduleEntry {
    pub sha: String,
    pub path: String,
    pub describe: String,
}

pub fn list_submodules(repo: &Path) -> Result<Vec<SubmoduleEntry>, String> {
    let output = Git::new(Some(repo)).args(["submodule", "status", "--"]).output()?;
    if output.status.code() == Some(128) {
        return Ok(vec![]);
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (sha, rest) = line.get(1..)?.split_once(' ')?;
            let (path, describe) = rest.strip_suffix(')')?.rsplit_once(" (")?;
            Some(SubmoduleEntry { sha: sha.into(), path: path.into(), describe: describe.into() })
        })
        .collect())
}

pub fn reset_submodules(repo: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    Git::new(Some(repo))
        .args(["--literal-pathspecs", "submodule", "update", "--recursive", "--force", "--"])
        .args(paths)
        .run()
}

pub fn format_patch(repo: &Path, base: &str, head: &str) -> Result<String, String> {
    let base = crate::history::resolve_revision(repo, base)?;
    let head = crate::history::resolve_revision(repo, head)?;
    Git::new(Some(repo))
        .args(["format-patch", "--unified=1", "--minimal", "--stdout", &format!("{base}..{head}"), "--"])
        .stdout()
}

pub fn using_lfs(repo: &Path) -> Result<bool, String> {
    let output =
        Git::new(Some(repo)).args(["lfs", "track", "--json"]).env("GIT_LFS_TRACK_NO_INSTALL_HOOKS", "1").stdout()?;
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&output) else {
        return Ok(false);
    };
    Ok(data["patterns"]
        .as_array()
        .is_some_and(|patterns| patterns.iter().any(|pattern| pattern["tracked"].as_bool() == Some(true))))
}

pub fn tracked_by_lfs(repo: &Path, file: &str) -> Result<bool, String> {
    let output = Git::new(Some(repo)).args(["check-attr", "-z", "filter", "--", file]).stdout()?;
    Ok(output.split('\0').nth(2) == Some("lfs"))
}

pub fn files_not_tracked_by_lfs(repo: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let stdin = format!("{}\0", paths.join("\0"));
    let output = Git::new(Some(repo)).args(["check-attr", "--stdin", "-z", "filter"]).stdin(stdin).stdout()?;
    let fields: Vec<_> = output.split('\0').collect();
    let tracked: std::collections::HashSet<_> = fields
        .chunks(3)
        .filter_map(|group| match group {
            [path, "filter", "lfs"] => Some(*path),
            _ => None,
        })
        .collect();
    Ok(paths.iter().filter(|path| !tracked.contains(path.as_str())).cloned().collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseState {
    pub original_branch_tip: String,
    pub target_branch: String,
    pub base_branch_tip: String,
}

pub fn rebase_state(repo: &Path) -> Option<RebaseState> {
    let repo = gix::open(repo).ok()?;
    let dir = repo.path();
    if !dir.join("REBASE_HEAD").exists() {
        return None;
    }
    let read =
        |name: &str| std::fs::read_to_string(dir.join("rebase-merge").join(name)).ok().map(|s| s.trim().to_string());
    Some(RebaseState {
        original_branch_tip: read("orig-head")?,
        target_branch: read("head-name")?.trim_start_matches("refs/heads/").into(),
        base_branch_tip: read("onto")?,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiCommitProgress {
    pub kind: &'static str,
    pub current_commit_summary: String,
    pub position: usize,
    pub total_commit_count: usize,
    pub value: f64,
}

#[derive(Serialize)]
pub struct RebaseSnapshot {
    pub commits: Vec<crate::history::CommitOneLine>,
    pub progress: MultiCommitProgress,
}

pub fn format_rebase_value(value: f64) -> f64 {
    (value.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

/// Desktop rebase.ts GitRebaseParser：`Rebasing (n/m)` 这一行
pub fn rebase_progress(line: &str, commits: &[crate::history::CommitOneLine]) -> Option<MultiCommitProgress> {
    let numbers = line.strip_prefix("Rebasing (")?.split_once(')')?.0;
    let (position, total) = numbers.split_once('/')?;
    Some(progress_at(position.trim().parse().ok()?, total.trim().parse().ok()?, commits))
}

/// Desktop cherry-pick.ts GitCherryPickParser：stdout 里每拣完一个提交有一行 `[分支 sha] 摘要`
fn is_cherry_picked_line(line: &str) -> bool {
    line.strip_prefix('[')
        .and_then(|rest| rest.split_once(']'))
        .is_some_and(|(label, _)| label.contains(char::is_whitespace))
}

/// Desktop configureOptionsForRebase 里的 byline：把一路输出按 \r / \n 切成行，边跑边交给 `on_line`
pub fn line_stream(
    stream: crate::git::TerminalStream, mut on_line: impl FnMut(&str),
) -> impl FnMut(&crate::git::TerminalChunk) {
    let mut pending = Vec::new();
    move |chunk| {
        if std::mem::discriminant(&chunk.stream) != std::mem::discriminant(&stream) {
            return;
        }
        for &byte in &chunk.bytes {
            if matches!(byte, b'\r' | b'\n') {
                if !pending.is_empty() {
                    on_line(&String::from_utf8_lossy(&pending));
                    pending.clear();
                }
            } else {
                pending.push(byte);
            }
        }
    }
}

/// Desktop _initializeMultiCommitOperation 的初始进度：第 1 个、0%
pub fn initial_progress(summary: Option<&str>, total: usize) -> MultiCommitProgress {
    MultiCommitProgress {
        kind: "multiCommitOperation",
        current_commit_summary: summary.unwrap_or_default().into(),
        position: 1,
        total_commit_count: total,
        value: 0.0,
    }
}

fn progress_at(position: usize, total: usize, commits: &[crate::history::CommitOneLine]) -> MultiCommitProgress {
    MultiCommitProgress {
        kind: "multiCommitOperation",
        current_commit_summary: commits
            .get(position.saturating_sub(1))
            .map_or_else(String::new, |commit| commit.summary.clone()),
        position,
        total_commit_count: total,
        value: if total == 0 { 0.0 } else { format_rebase_value(position as f64 / total as f64) },
    }
}

pub fn rebase_snapshot(repo: &Path) -> Result<Option<RebaseSnapshot>, String> {
    let Some(state) = rebase_state(repo) else {
        return Ok(None);
    };
    let git = gix::open(repo).map_err(|e| e.to_string())?;
    let read = |name: &str| {
        std::fs::read_to_string(git.path().join("rebase-merge").join(name)).ok()?.trim().parse::<usize>().ok()
    };
    let (Some(position), Some(total)) = (read("msgnum"), read("end")) else {
        return Ok(None);
    };
    let Some(commits) =
        crate::history::commits_in_range(repo, &format!("{}..{}", state.base_branch_tip, state.original_branch_tip))?
    else {
        return Ok(None);
    };
    Ok(Some(RebaseSnapshot { progress: progress_at(position, total, &commits), commits }))
}

#[derive(Debug, Serialize)]
pub enum RebaseResult {
    CompletedWithoutError,
    AlreadyUpToDate,
    ConflictsEncountered,
    OutstandingFilesNotStaged,
    Aborted,
}
#[derive(Serialize)]
pub struct RebaseOutcome {
    pub result: RebaseResult,
    pub progress: Vec<MultiCommitProgress>,
    pub diagnostic: String,
}

fn parse_rebase_output(
    repo: &Path, output: std::process::Output, commits: &[crate::history::CommitOneLine], continuing: bool,
) -> Result<RebaseOutcome, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let progress = stderr.split(['\r', '\n']).filter_map(|line| rebase_progress(line, commits)).collect();
    let diagnostic = crate::git::stderr_of(&output);
    let result = if output.status.success() {
        if stdout.trim().starts_with("Current branch ") && stdout.trim().ends_with(" is up to date.") {
            RebaseResult::AlreadyUpToDate
        } else {
            RebaseResult::CompletedWithoutError
        }
    } else if continuing
        && !stdout.contains("CONFLICT")
        && !stderr.contains("could not apply")
        && rebase_state(repo).is_some()
    {
        RebaseResult::OutstandingFilesNotStaged
    } else if rebase_state(repo).is_some()
        && crate::status::status(repo)?.changes.iter().any(|file| file.change == crate::status::ChangeType::Conflicted)
    {
        RebaseResult::ConflictsEncountered
    } else {
        return Err(diagnostic);
    };
    Ok(RebaseOutcome { result, progress, diagnostic })
}

pub fn rebase_branch(repo: &Path, base: &str, target: Option<&str>) -> Result<RebaseOutcome, String> {
    rebase_branch_stream(repo, base, target, |_| {}, |_| {})
}
pub fn rebase_branch_stream(
    repo: &Path, base: &str, target: Option<&str>, mut output: impl FnMut(crate::git::TerminalChunk),
    mut on_progress: impl FnMut(MultiCommitProgress),
) -> Result<RebaseOutcome, String> {
    let base_sha = crate::history::resolve_revision(repo, base)?;
    let target_sha = crate::history::resolve_revision(repo, target.unwrap_or("HEAD"))?;
    let commits = crate::history::commits_in_range(repo, &format!("{base_sha}..{target_sha}"))?
        .ok_or("Missing rebase commits")?;
    let mut git = Git::new(Some(repo)).args(["-c", "rebase.backend=merge", "rebase", "--", base]);
    if let Some(target) = target {
        git = git.arg(target);
    }
    on_progress(initial_progress(commits.first().map(|c| c.summary.as_str()), commits.len()));
    let mut lines = line_stream(crate::git::TerminalStream::Stderr, |line| {
        if let Some(progress) = rebase_progress(line, &commits) {
            on_progress(progress);
        }
    });
    let raw = git.output_raw_stream(|chunk| {
        lines(&chunk);
        output(chunk);
    })?;
    drop(lines);
    parse_rebase_output(repo, raw, &commits, false)
}

pub fn continue_rebase_with_resolutions(
    repo: &Path, paths: &[String], resolutions: &[(String, Resolution)], editor: Option<&str>,
) -> Result<RebaseOutcome, String> {
    for (path, resolution) in resolutions {
        resolve_conflict(repo, path, *resolution)?;
    }
    let tracked: Vec<_> = crate::status::status(repo)?
        .changes
        .into_iter()
        .filter(|file| {
            file.kind != crate::status::ChangeKind::Untracked
                && paths.contains(&file.path)
                && !resolutions.iter().any(|(path, _)| path == &file.path)
        })
        .map(|file| file.path)
        .collect();
    if !tracked.is_empty() {
        Git::new(Some(repo)).args(["--literal-pathspecs", "add", "-A", "--"]).args(tracked).run()?;
    }
    let Some(snapshot) = rebase_snapshot(repo)? else {
        return Ok(RebaseOutcome {
            result: RebaseResult::Aborted,
            progress: vec![],
            diagnostic: "No rebase state".into(),
        });
    };
    let has_changes =
        crate::status::status(repo)?.changes.iter().any(|file| file.kind != crate::status::ChangeKind::Untracked);
    let output = Git::new(Some(repo))
        .args(["rebase", if has_changes { "--continue" } else { "--skip" }])
        .env("GIT_EDITOR", editor.unwrap_or(":"))
        .output()?;
    parse_rebase_output(repo, output, &snapshot.commits, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Cmd;

    fn git(r: &Path, args: &[&str]) -> std::process::Output {
        Cmd::new("git").arg("-C").arg(r).args(args).output().unwrap()
    }

    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "1\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "first"]);
        d
    }

    /// Desktop `getStashes` from the reflog in process must equal `git log -g` byte for byte.
    /// Desktop rebase / cherry-pick 的进度在 git 运行时边跑边报：变基读 stderr 的 `Rebasing (n/m)`，
    /// 拣选读 stdout 每个提交一行的 `[分支 sha] 摘要`；初始进度变基取第一个提交、拣选取最后一个
    #[test]
    fn 变基与拣选的进度边跑边报() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let g = |args: &[&str]| {
            crate::test_repo::git(r, &[&["-c", "user.name=t", "-c", "user.email=t@example.com"], args].concat())
        };
        g(&["init", "-q", "-b", "main"]);
        g(&["commit", "-q", "--allow-empty", "-m", "base"]);
        g(&["checkout", "-qb", "feature"]);
        for name in ["one", "two", "three"] {
            std::fs::write(r.join(name), name).unwrap();
            g(&["add", "."]);
            g(&["commit", "-qm", name]);
        }
        g(&["checkout", "-q", "main"]);
        std::fs::write(r.join("main"), "main").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "on main"]);
        g(&["checkout", "-q", "feature"]);

        let mut rebased = Vec::new();
        let outcome = rebase_branch_stream(r, "main", None, |_| {}, |p| rebased.push(p)).unwrap();
        assert!(matches!(outcome.result, RebaseResult::CompletedWithoutError));
        let seen: Vec<_> = rebased.iter().map(|p| (p.position, p.value, p.current_commit_summary.as_str())).collect();
        assert_eq!(seen, vec![(1, 0.0, "one"), (1, 0.33, "one"), (2, 0.67, "two"), (3, 1.0, "three")]);

        g(&["checkout", "-qb", "target", "main"]);
        let shas: Vec<String> = ["feature~1", "feature"]
            .iter()
            .map(|rev| crate::test_repo::git(r, &["rev-parse", rev]).trim().into())
            .collect();
        let mut picked = Vec::new();
        cherry_pick_stream(r, &shas, |_| {}, |p| picked.push(p)).unwrap();
        let seen: Vec<_> = picked.iter().map(|p| (p.position, p.total_commit_count, p.value)).collect();
        assert_eq!(seen, vec![(1, 2, 0.0), (1, 2, 0.5), (2, 2, 1.0)]);
        assert_eq!(picked[0].current_commit_summary, "three");
    }

    #[test]
    fn 进程内贮藏列表与_git_逐字节一致() {
        let d = repo();
        let p = d.path();
        let same = |label: &str, answered: bool| {
            let fast = stash_records_in_process(p);
            assert_eq!(fast.is_some(), answered, "{label}: {fast:?}");
            let git = stash_records_via_git(p).unwrap().unwrap_or_default();
            if let Some(fast) = fast {
                assert_eq!(fast, git, "{label}");
            }
            assert_eq!(
                serde_json::to_value(stashes(p).unwrap()).unwrap(),
                serde_json::to_value(parse_stash_records(&git)).unwrap(),
                "{label}: parsed"
            );
        };
        same("no stash", true);
        for (index, message) in
            [stash_message("main"), "WIP plain".into(), stash_message("feature/x")].iter().enumerate()
        {
            std::fs::write(p.join("a.txt"), format!("{index}\n")).unwrap();
            std::fs::write(p.join(format!("new-{index}.txt")), "u\n").unwrap();
            git(p, &["add", "."]);
            assert!(git(p, &["stash", "push", "-m", message]).status.success());
        }
        std::fs::write(p.join("a.txt"), "keep\n").unwrap();
        assert!(git(p, &["stash", "push", "--include-untracked", "-m", "untracked tree"]).status.success());
        same("four stashes", true);
        assert!(git(p, &["stash", "drop", "stash@{1}"]).status.success());
        same("after dropping the middle", true);
        std::fs::write(p.join(".git/logs/refs/stash"), "").unwrap();
        same("empty reflog", false);
        assert!(git(p, &["stash", "clear"]).status.success());
        same("cleared", true);
    }

    #[test]
    fn 非冲突文件不能被当成对方删除而移除() {
        let d = repo();
        let before = std::fs::read(d.path().join("a.txt")).unwrap();
        let head = git(d.path(), &["rev-parse", "HEAD"]);
        assert!(resolve_conflict(d.path(), "a.txt", Resolution::Theirs).is_err());
        assert_eq!(std::fs::read(d.path().join("a.txt")).unwrap(), before);
        assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
        assert!(git(d.path(), &["status", "--porcelain"]).stdout.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn 冲突路径包含通配符或换行时只解决指定文件() {
        for name in ["*.txt", "with\nnewline.txt", ":(glob)*"] {
            let d = repo();
            let p = d.path();
            std::fs::write(p.join(name), "base\n").unwrap();
            Git::new(Some(p)).args(["add", "."]).run().unwrap();
            Git::new(Some(p)).args(["commit", "-qm", "base"]).run().unwrap();
            Git::new(Some(p)).args(["switch", "-qc", "other"]).run().unwrap();
            for file in [name, "a.txt"] {
                std::fs::write(p.join(file), "theirs\n").unwrap();
            }
            Git::new(Some(p)).args(["commit", "-qam", "theirs"]).run().unwrap();
            Git::new(Some(p)).args(["switch", "-q", "main"]).run().unwrap();
            for file in [name, "a.txt"] {
                std::fs::write(p.join(file), "ours\n").unwrap();
            }
            Git::new(Some(p)).args(["commit", "-qam", "ours"]).run().unwrap();
            assert!(merge(p, "other", false).is_err());
            let untouched = std::fs::read(p.join("a.txt")).unwrap();
            resolve_conflict(p, name, Resolution::Theirs).unwrap();
            assert_eq!(std::fs::read_to_string(p.join(name)).unwrap(), "theirs\n");
            assert_eq!(std::fs::read(p.join("a.txt")).unwrap(), untouched);
            assert!(!Git::new(Some(p)).args(["ls-files", "-u", "--", "a.txt"]).stdout().unwrap().is_empty());
        }
    }

    /// 合之前就该知道会不会撞车。
    #[test]
    fn 合并预览能数出冲突文件数() {
        let d = repo();
        let p = d.path();
        git(p, &["switch", "-qc", "他们"]);
        std::fs::write(p.join("a.txt"), "他们改的\n").unwrap();
        std::fs::write(p.join("b.txt"), "他们加的\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "他们"]);
        git(p, &["switch", "-q", "main"]);
        std::fs::write(p.join("a.txt"), "我们改的\n").unwrap();
        git(p, &["commit", "-qam", "我们"]);

        let r = merge_preview(p, "main", "他们").unwrap();
        assert_eq!(r.conflicts, 1, "只有 a.txt 会撞");
        assert!(!r.unrelated);
        // 预览不该动工作区，更不该留下半个合并
        assert!(!p.join(".git").join("MERGE_HEAD").exists());
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "我们改的\n");

        // 反过来：能干净合上的要报 0
        git(p, &["switch", "-qc", "干净的", "main"]);
        std::fs::write(p.join("c.txt"), "互不相干\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "干净"]);
        assert_eq!(merge_preview(p, "main", "干净的").unwrap().conflicts, 0);
    }

    /// `git merge-tree` 碰到不存在的分支会退出 1 且什么都不输出，和「有冲突」同一个退出码；
    /// 以前数 NUL 数出 0 就当干净放过去了。GitLens c54e108f4 修的同一个坑：无输出的失败是错误。
    #[test]
    fn 合并预览找不到分支要报错不能当干净() {
        let d = repo();
        let p = d.path();
        let err = merge_preview(p, "main", "没有这个分支").unwrap_err();
        assert!(err.contains("not something we can merge"), "{err}");
        // 不存在的分支也不能冒充「无共同祖先」
        git(p, &["switch", "-qc", "干净的"]);
        std::fs::write(p.join("c.txt"), "互不相干\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "干净"]);
        let ok = merge_preview(p, "main", "干净的").unwrap();
        assert_eq!((ok.conflicts, ok.unrelated), (0, false));
    }

    /// 一边改、一边删的冲突。「用删的那边」不能走 checkout —— 那边没有版本。
    #[test]
    fn 一边改一边删的冲突两个选择都能解() {
        for keep in [Resolution::Theirs, Resolution::Ours] {
            let d = repo();
            let p = d.path();
            git(p, &["switch", "-qc", "他们"]);
            git(p, &["rm", "-q", "a.txt"]);
            git(p, &["commit", "-qm", "他们删了"]);
            git(p, &["switch", "-q", "main"]);
            std::fs::write(p.join("a.txt"), "我们改的\n").unwrap();
            git(p, &["commit", "-qam", "我们改了"]);
            git(p, &["merge", "他们"]);

            resolve_conflict(p, "a.txt", keep).unwrap_or_else(|e| panic!("{keep:?} 解不了: {e}"));
            assert!(conflicted_files(p).is_empty(), "{keep:?} 之后不该还有冲突: {:?}", conflicted_files(p));
            match keep {
                // 用我们的 = 保留这个文件
                Resolution::Ours => assert!(p.join("a.txt").exists(), "用我们的应保留文件"),
                // 用他们的 = 接受删除
                Resolution::Theirs => assert!(!p.join("a.txt").exists(), "用他们的应删掉文件"),
            }
        }
    }

    #[test]
    fn 合并另一条分支() {
        let d = repo();
        let p = d.path();
        git(p, &["switch", "-c", "feature"]);
        std::fs::write(p.join("b.txt"), "2\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "second"]);
        git(p, &["switch", "main"]);

        merge(p, "feature", false).unwrap();
        assert!(p.join("b.txt").exists());
    }

    #[test]
    fn 压缩合并只留一个提交且要自己补那次提交() {
        let d = repo();
        let p = d.path();
        git(p, &["switch", "-c", "feature"]);
        for (f, m) in [("b.txt", "b"), ("c.txt", "c")] {
            std::fs::write(p.join(f), "x\n").unwrap();
            git(p, &["add", "."]);
            git(p, &["commit", "-m", m]);
        }
        git(p, &["switch", "main"]);

        merge(p, "feature", true).unwrap();
        let count = String::from_utf8(git(p, &["rev-list", "--count", "HEAD"]).stdout).unwrap();
        // first + 一次压缩提交
        assert_eq!(count.trim(), "2");
    }

    #[test]
    fn 贮藏能存能列能弹回() {
        let d = repo();
        let p = d.path();
        std::fs::write(p.join("a.txt"), "changed\n").unwrap();

        stash_push(p, "main").unwrap();
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1\n");

        let list = stashes(p).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].ours, "本客户端建的贮藏要带标记");

        stash_pop(p, &list[0].name).unwrap();
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "changed\n");
    }

    #[test]
    fn 撤销提交后改动还在暂存区() {
        let d = repo();
        let p = d.path();
        std::fs::write(p.join("b.txt"), "2\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "second"]);

        undo_commit(p).unwrap();

        let count = String::from_utf8(git(p, &["rev-list", "--count", "HEAD"]).stdout).unwrap();
        assert_eq!(count.trim(), "1");
        let staged = String::from_utf8(git(p, &["diff", "--cached", "--name-only"]).stdout).unwrap();
        assert_eq!(staged.trim(), "b.txt");
    }

    #[test]
    fn 修订提交改的是同一次提交() {
        let d = repo();
        let p = d.path();
        amend(p, "改过的标题", "").unwrap();
        let count = String::from_utf8(git(p, &["rev-list", "--count", "HEAD"]).stdout).unwrap();
        assert_eq!(count.trim(), "1");
        let msg = String::from_utf8(git(p, &["log", "-1", "--format=%s"]).stdout).unwrap();
        assert_eq!(msg.trim(), "改过的标题");
    }

    #[test]
    fn 回滚提交会新增一个反向提交() {
        let d = repo();
        let p = d.path();
        std::fs::write(p.join("b.txt"), "2\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "second"]);
        let sha = String::from_utf8(git(p, &["rev-parse", "HEAD"]).stdout).unwrap();

        revert(p, sha.trim(), false).unwrap();
        assert!(!p.join("b.txt").exists());
        let count = String::from_utf8(git(p, &["rev-list", "--count", "HEAD"]).stdout).unwrap();
        assert_eq!(count.trim(), "3");
    }

    #[test]
    fn 标签能建能列能删() {
        let d = repo();
        let p = d.path();
        create_tag(p, "v1.0", "HEAD").unwrap();
        assert_eq!(tags(p).unwrap(), vec!["v1.0"]);
        delete_tag(p, "v1.0").unwrap();
        assert!(tags(p).unwrap().is_empty());
    }

    #[test]
    fn 冲突时能挑一边并标记已解决() {
        let d = repo();
        let p = d.path();
        git(p, &["switch", "-c", "feature"]);
        std::fs::write(p.join("a.txt"), "theirs\n").unwrap();
        git(p, &["commit", "-am", "theirs"]);
        git(p, &["switch", "main"]);
        std::fs::write(p.join("a.txt"), "ours\n").unwrap();
        git(p, &["commit", "-am", "ours"]);

        // 合并必然冲突
        assert!(merge(p, "feature", false).is_err());
        assert_eq!(conflicted_files(p), vec!["a.txt"]);

        resolve_conflict(p, "a.txt", Resolution::Theirs).unwrap();
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "theirs\n");
        assert!(conflicted_files(p).is_empty());
    }

    #[test]
    fn 同步上游能把落后的分支快进上去() {
        // 造一个「上游」和一个落后于它的「fork」
        let upstream = repo();
        let up = upstream.path();
        std::fs::write(up.join("new.txt"), "上游的新提交\n").unwrap();
        git(up, &["add", "."]);
        git(up, &["commit", "-m", "上游新提交"]);

        let fork = tempfile::tempdir().unwrap();
        let f = fork.path().join("fork");
        Cmd::new("git").args(["clone", "-q", up.to_str().unwrap(), f.to_str().unwrap()]).output().unwrap();
        // 克隆之后上游又往前走一步
        std::fs::write(up.join("newer.txt"), "更新的\n").unwrap();
        git(up, &["add", "."]);
        git(up, &["commit", "-m", "又一个提交"]);

        assert!(!f.join("newer.txt").exists());
        sync_upstream(&f, up.to_str().unwrap(), "main").unwrap();
        assert!(f.join("newer.txt").exists(), "同步之后该有上游的新文件");
    }

    #[test]
    fn 工作树解析只认_refs_heads_分支() {
        // 与 GitLens c1f6e5f3c worktreeParser.test.ts 的 branchName 用例同源：
        // bare / detached 无分支，refs/remotes 不算分支但类型仍是 branch。
        let out = "worktree /repo.git\nbare\n\n\
                   worktree /repo/wt\nHEAD 2222222222222222222222222222222222222222\ndetached\n\n\
                   worktree /repo/remote\nHEAD 3333333333333333333333333333333333333333\nbranch refs/remotes/origin/main\n\n\
                   worktree /repo/feature\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/feature/new\n\n";
        let list = parse_worktrees(out);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].branch, None);
        assert_eq!(list[0].kind, "bare");
        assert_eq!(list[1].branch, None);
        assert_eq!(list[1].kind, "detached");
        assert_eq!(list[2].branch, None, "refs/remotes 之下的 HEAD 不是分支");
        assert_eq!(list[2].kind, "branch");
        assert_eq!(list[3].branch.as_deref(), Some("feature/new"));
    }

    #[test]
    fn 工作树能建能列能删() {
        let d = repo();
        let p = d.path();
        let extra = d.path().parent().unwrap().join("wt-extra");

        add_worktree(p, &extra, "wt-branch", true).unwrap();
        let list = worktrees(p).unwrap();
        assert_eq!(list.len(), 2, "主工作树 + 新建的那个");
        assert!(list[0].main, "第一条是主工作树");
        assert_eq!(list[1].branch.as_deref(), Some("wt-branch"));

        remove_worktree(p, extra.to_str().unwrap()).unwrap();
        assert_eq!(worktrees(p).unwrap().len(), 1);
    }

    /// Desktop 9a47fa5cf `app/test/unit/git/worktree-move-test.ts` 的三个用例：
    /// 移动仓库自己指向的工作树、从主工作树移动另一个、从兄弟链接工作树移动。
    #[test]
    fn 移动工作树不在被移动的目录里运行() {
        for case in ["own", "main", "sibling"] {
            let parent = tempfile::tempdir().unwrap();
            let main = parent.path().canonicalize().unwrap().join("repo");
            std::fs::create_dir(&main).unwrap();
            git(&main, &["init", "-b", "main"]);
            git(&main, &["config", "user.email", "t@example.com"]);
            git(&main, &["config", "user.name", "T"]);
            std::fs::write(main.join("README"), "hello").unwrap();
            git(&main, &["add", "."]);
            git(&main, &["commit", "-m", "first"]);
            let worktree = parent.path().canonicalize().unwrap().join("repo-wt-a");
            git(&main, &["worktree", "add", "-b", "feature-a", "--", worktree.to_str().unwrap()]);
            let sibling = parent.path().canonicalize().unwrap().join("repo-wt-b");
            let repo = match case {
                "own" => worktree.clone(),
                "main" => main.clone(),
                _ => {
                    git(&main, &["worktree", "add", "-b", "feature-b", "--", sibling.to_str().unwrap()]);
                    sibling.clone()
                }
            };
            let renamed = parent.path().canonicalize().unwrap().join("repo-wt-renamed");

            let (cwd, args) =
                move_worktree_command(&repo, worktree.to_str().unwrap(), renamed.to_str().unwrap()).unwrap();
            assert!(
                !cwd.starts_with(&worktree),
                "{case}: git worktree move ran from inside the moved worktree ({cwd:?})"
            );
            assert_eq!(cwd, main, "{case}: runs from the main worktree");
            assert_eq!(args[..3], ["worktree", "move", "--"]);
            move_worktree(&repo, worktree.to_str().unwrap(), renamed.to_str().unwrap()).unwrap();

            assert!(!worktree.exists(), "{case}");
            assert!(renamed.exists(), "{case}");
            let listed: Vec<_> = worktrees(&main).unwrap().into_iter().map(|wt| wt.path).collect();
            let mut expected = vec![main.to_string_lossy().into_owned(), renamed.to_string_lossy().into_owned()];
            if case == "sibling" {
                expected.push(sibling.to_string_lossy().into_owned());
            }
            assert_eq!(listed[0], expected[0], "{case}: main worktree stays first");
            let (mut rest, mut expected_rest) = (listed[1..].to_vec(), expected[1..].to_vec());
            rest.sort();
            expected_rest.sort();
            assert_eq!(rest, expected_rest, "{case}");
        }
    }

    #[test]
    fn 领先落后计数() {
        let d = repo();
        let p = d.path();
        git(p, &["switch", "-c", "feature"]);
        std::fs::write(p.join("b.txt"), "2\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "second"]);

        let (ahead, behind) = ahead_behind(p, "feature", "main").unwrap();
        assert_eq!((ahead, behind), (1, 0));
    }
}
