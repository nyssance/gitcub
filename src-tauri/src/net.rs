//! 网络操作与提交：走 git CLI。
//!
//! gix 0.87 没有 push（上游 #306 以 not_planned 关闭），也不能从 index 写 tree
//! （因此无法 commit）。fetch 本可以用 gix，但一并走 CLI 是为了让**认证只有一套
//! 实现**，而不是 gix-credentials 和 git credential 系统各写一遍。
//!
//! 代价可以接受：这些都是用户主动触发的低频操作，进程启动开销无关紧要。
//! 真正的热路径（status / diff / index）仍然全在进程内由 gix 承担。
//!
//! ## token 怎么传
//!
//! 通过 `GIT_ASKPASS` 指回本程序自己，token 用**环境变量**交给子进程。
//!
//! | 方式 | 泄漏面 |
//! |---|---|
//! | URL 内嵌 `https://x:TOKEN@host/` | ❌ 进 argv，`ps aux` 全系统可见 |
//! | `-c http.extraHeader=Authorization: ...` | ❌ 同样进 argv |
//! | `GIT_ASKPASS` + 环境变量 | ✅ 不进 argv；环境只有同用户进程可读 |
//!
//! 环境变量不是绝对安全（同用户可读 /proc/<pid>/environ），但和 token 本身的
//! 存储位置是同一信任边界，而 argv 会泄漏给机器上的所有用户。

use crate::git::Git;
use std::path::Path;

/// 根据 git 给的提示串决定回答用户名还是密码。
///
/// 拆成纯函数而不是直接读环境：环境是进程全局的，测试并行跑会互相踩。
fn choose<'a>(prompt: &str, user: &'a str, token: &'a str) -> &'a str {
    let p = prompt.to_ascii_lowercase();
    if p.contains("username") || p.contains("user name") { user } else { token }
}

/// git 调用 askpass 时只给一个提示字符串，据此区分它要用户名还是密码。
pub fn askpass(prompt: &str) -> String {
    // GitHub 用 PAT/OAuth token 时用户名可为任意非空值；GitLab 惯例是 oauth2
    let user = std::env::var("GITCUB_ASKPASS_USER").unwrap_or_else(|_| "oauth2".into());
    let token = std::env::var("GITCUB_ASKPASS_TOKEN").unwrap_or_default();
    choose(prompt, &user, &token).to_owned()
}

/// 若本次启动是 git 的 askpass 回调，返回应答；否则返回 `None`。
///
/// 判定依据是我们自己注入的 `GITCUB_ASKPASS_TOKEN`——只有 `Git::with_token`
/// 拉起的 git 子进程才有它，普通启动不会误判。
pub fn askpass_if_invoked() -> Option<String> {
    std::env::var_os("GITCUB_ASKPASS_TOKEN")?;
    let prompt = std::env::args().nth(1)?;
    Some(askpass(&prompt))
}

/// 推送。两个细节照原版 push.ts：
///   - 远端还没有这条分支时要带 `--set-upstream`，否则下次还得手动指定
///   - 强推一律 `--force-with-lease`，不给 `--force`：后者会覆盖别人刚推上去的提交
pub fn push(
    repo: &Path, remote: &str, refspec: &str, set_upstream: bool, force_with_lease: bool, token: Option<&str>,
    user: Option<&str>,
) -> Result<(), String> {
    push_with_tags(
        repo,
        remote,
        refspec,
        &[],
        PushOptions { set_upstream, force_with_lease, ..Default::default() },
        token,
        user,
        None,
    )
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PushOptions {
    pub set_upstream: bool,
    pub force_with_lease: bool,
    pub no_verify: bool,
    /// 前端要进度（Desktop push.ts 有 progressCallback 时带 --progress）
    pub progress: bool,
}

/// 推送、拉取、获取的进度回调（Desktop executionOptionsWithProgress 的 progressCallback）
pub type OnProgress<'a> = Option<&'a mut dyn FnMut(crate::progress::Progress)>;

/// 有回调时边跑边把 stderr 交给解析器（Desktop createProgressProcessCallback），没有就照常等输出
fn output_with_progress(
    git: Git, parser: fn() -> crate::progress::Parser, on_progress: OnProgress,
) -> Result<std::process::Output, String> {
    let Some(emit) = on_progress else { return git.output() };
    let mut stream = crate::progress::ProgressStream::new(parser(), emit);
    let output = git.output_raw_stream(|chunk| stream.push(chunk))?;
    stream.finish();
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
pub fn push_with_tags(
    repo: &Path, remote: &str, refspec: &str, tags: &[String], options: PushOptions, token: Option<&str>,
    user: Option<&str>, on_progress: OnProgress,
) -> Result<(), String> {
    // 原版 push.ts interceptHooks
    crate::hooks::scoped(repo, &["pre-push"], || {
        push_with_tags_unhooked(repo, remote, refspec, tags, options, token, user, on_progress)
    })
}

#[allow(clippy::too_many_arguments)]
fn push_with_tags_unhooked(
    repo: &Path, remote: &str, refspec: &str, tags: &[String], options: PushOptions, token: Option<&str>,
    user: Option<&str>, on_progress: OnProgress,
) -> Result<(), String> {
    let PushOptions { set_upstream, force_with_lease, no_verify, .. } = options;
    let mut g = Git::new(Some(repo)).arg("push");
    // Desktop push.ts：有进度回调才带 --progress
    if on_progress.is_some() {
        g = g.arg("--progress");
    }

    if set_upstream {
        g = g.arg("--set-upstream");
    } else if force_with_lease {
        g = g.arg("--force-with-lease");
    }
    if no_verify {
        g = g.arg("--no-verify");
    }
    g = g.args(["--", remote, refspec]);
    for tag in tags {
        g = g.arg(if tag.starts_with("refs/tags/") { tag.clone() } else { format!("refs/tags/{tag}") });
    }
    let output =
        output_with_progress(g.with_optional_token(token, user), crate::progress::Parser::push_parser, on_progress)?;
    crate::git::checked_result(Path::new("."), output, &[0], &[]).map(|_| ())
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteOptions {
    pub progress: bool,
    pub no_verify: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}
impl From<std::process::Output> for RemoteOutput {
    fn from(output: std::process::Output) -> Self {
        Self {
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }
}
impl RemoteOutput {
    fn success(self) -> Result<(), String> {
        if self.exit_code == Some(0) {
            Ok(())
        } else {
            Err(if self.stderr.is_empty() { self.stdout } else { self.stderr })
        }
    }
}
pub fn fetch_output(
    repo: &Path, remote: &str, options: RemoteOptions, token: Option<&str>, user: Option<&str>, on_progress: OnProgress,
) -> Result<RemoteOutput, String> {
    let mut git = Git::new(Some(repo)).arg("fetch");
    if options.progress {
        git = git.arg("--progress");
    }
    let git = git.args(["--prune", "--recurse-submodules=on-demand", "--", remote]).with_optional_token(token, user);
    let output = output_with_progress(git, crate::progress::Parser::fetch_parser, on_progress)?;
    if output.status.success() {
        crate::remote_ops::update_head(repo, remote, token, user)?;
    }
    Ok(output.into())
}
pub fn fetch(repo: &Path, remote: &str, token: Option<&str>, user: Option<&str>) -> Result<(), String> {
    fetch_output(repo, remote, RemoteOptions::default(), token, user, None)?.success()
}
pub fn fetch_refspec(repo: &Path, remote: &str, refspec: &str, token: Option<&str>) -> Result<(), String> {
    let output =
        Git::new(Some(repo)).args(["fetch", "--", remote, refspec]).with_optional_token(token, None).output()?;
    if matches!(output.status.code(), Some(0 | 128)) { Ok(()) } else { Err(crate::git::stderr_of(&output)) }
}
/// Desktop pull semantics: honor configured merge/rebase/ff policy and recurse submodules.
pub fn pull_output(
    repo: &Path, remote: &str, options: RemoteOptions, token: Option<&str>, user: Option<&str>, on_progress: OnProgress,
) -> Result<RemoteOutput, String> {
    if remote.starts_with('-') {
        return Err("Cannot pull from a remote whose name starts with '-'.".into());
    }
    // 原版 pull.ts interceptHooks
    let intercept = [
        "pre-merge-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-merge",
        "pre-rebase",
        "pre-commit",
        "post-rewrite",
    ];
    let output = crate::hooks::scoped(repo, &intercept, || {
        pull_output_unhooked(repo, remote, options, token, user, on_progress)
    })?;
    // Desktop _pull：成功后更新远端 HEAD；这一步不要紧，失败只记日志，不让用户重试整个拉取
    if output.exit_code == Some(0)
        && let Err(error) = crate::remote_ops::update_head(repo, remote, token, user)
    {
        log::error!("Failed updating remote HEAD: {error}");
    }
    Ok(output)
}

fn pull_output_unhooked(
    repo: &Path, remote: &str, options: RemoteOptions, token: Option<&str>, user: Option<&str>, on_progress: OnProgress,
) -> Result<RemoteOutput, String> {
    let mut command = Git::new(Some(repo)).args(["-c", "rebase.backend=merge", "pull"]);
    if crate::git_config::get(Some(repo), "pull.ff", false, false)?.is_none() {
        command = command.arg("--ff");
    }
    if options.progress {
        command = command.arg("--progress");
    }
    if options.no_verify {
        command = command.arg("--no-verify");
    }
    let command = command.args(["--recurse-submodules", "--", remote]).with_optional_token(token, user);
    Ok(output_with_progress(command, crate::progress::Parser::pull_parser, on_progress)?.into())
}
pub fn pull(repo: &Path, remote: &str, token: Option<&str>, user: Option<&str>) -> Result<(), String> {
    pull_output(repo, remote, RemoteOptions::default(), token, user, None)?.success()
}

/// 切换分支。
///
/// gix 有 worktree-mutation 但没有完整的 checkout 语义（保留未提交改动、
/// 冲突检测、稀疏检出等）。`git switch` 全都处理好了。
pub fn checkout(repo: &Path, branch: &str) -> Result<(), String> {
    let target = crate::branch::list(repo, None)?.into_iter().find(|b| b.reference == branch || b.name == branch);
    match target {
        Some(b) if b.remote => crate::branch::checkout(repo, &b.name_without_remote, Some(&b.reference), false),
        _ => crate::branch::checkout(repo, branch, None, false),
    }
}

/// 提交 index 里的内容。
///
/// 走 git CLI 不是妥协：gix 无法从 index 写出 tree（和 push 一样是空缺），
/// 而 `git commit` 顺带把 hooks、GPG 签名、author/committer 配置、
/// commit.template 全都处理了——自己实现要写一大堆还容易和用户配置不一致。
/// 提交选项。三项与原版 commit-message.tsx 的齿轮菜单一一对应：
/// Bypass Commit Hooks / Add Signed-off-by Trailer / Allow Empty Commit。
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOptions {
    pub skip_hooks: bool,
    pub sign_off: bool,
    pub allow_empty: bool,
    /// 共同作者，每项形如 `名字 <邮箱>`。写成 Co-authored-by trailer
    #[serde(default)]
    pub co_authors: Vec<String>,
}

/// 把 Co-authored-by 挂到提交信息末尾。
///
/// 交给 `git interpret-trailers` 而不是自己拼字符串（原版 mergeTrailers 也是）：
/// trailer 该空一行、已经有同名 trailer 时该怎么并、用户自己配的
/// `trailer.separators` 是什么——这些规则 git 自己最清楚。
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Trailer {
    pub token: String,
    pub value: String,
}

pub fn format_commit_message(
    repo: &Path, summary: &str, description: Option<&str>, trailers: &[Trailer],
) -> Result<String, String> {
    let message = format!("{summary}\n\n{}\n", description.unwrap_or(""));
    let message = format!("{}\n", message.trim_end_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}'));
    if trailers.is_empty() {
        return Ok(message);
    }
    let mut git = Git::new(Some(repo)).args(["interpret-trailers", "--no-divider"]);
    for trailer in trailers {
        git = git.args(["--trailer", &format!("{}={}", trailer.token, trailer.value)]);
    }
    git.stdin(message).stdout()
}

#[allow(dead_code)] // Non-streaming entry point used by the upstream conformance bridge and tests.
pub fn commit(repo: &Path, summary: &str, description: &str, options: CommitOptions) -> Result<(), String> {
    commit_output(repo, summary, description, options).map(|_| ())
}

#[allow(dead_code)] // Non-streaming entry point used by the upstream conformance bridge.
pub fn commit_output(repo: &Path, summary: &str, description: &str, options: CommitOptions) -> Result<String, String> {
    commit_with_hooks(repo, summary, description, options, None, None, |_| {})
}

/// Desktop createCommit：开了钩子环境时按原版 interceptHooks 交给钩子代理，git 输出逐块给「提交进度」
pub fn commit_with_hooks(
    repo: &Path, summary: &str, description: &str, options: CommitOptions, hooks_env: Option<crate::hooks::HooksEnv>,
    callbacks: Option<std::sync::Arc<dyn crate::hooks::HookCallbacks>>,
    on_output: impl FnMut(crate::git::TerminalChunk),
) -> Result<String, String> {
    if summary.trim().is_empty() {
        return Err("提交摘要不能为空".into());
    }
    let mut g = Git::new(Some(repo)).arg("commit");
    if options.skip_hooks {
        g = g.arg("--no-verify");
    }
    if options.sign_off {
        g = g.arg("--signoff");
    }
    if options.allow_empty {
        g = g.arg("--allow-empty");
    }

    // 整条信息从 stdin 进去（原版 createCommit 也是 `-F -`）：要挂 trailer
    // 就必须把摘要和正文当成一整块处理，`-m` 分段拼不出来。
    let trailers = options
        .co_authors
        .iter()
        .map(|author| Trailer { token: "Co-authored-by".into(), value: author.clone() })
        .collect::<Vec<_>>();
    let message = format_commit_message(repo, summary, Some(description), &trailers)?;

    // https://git-scm.com/docs/githooks/2.46.1；改提交走 amend_commit，这里没有 post-rewrite
    let intercept = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-auto-gc"];
    crate::hooks::with_hooks_env(repo, &intercept, hooks_env, callbacks, |env| {
        let g = env.into_iter().fold(g, |g, (key, value)| g.env(key, value));
        let out = g.args(["-F", "-"]).stdin(message).output_stream(on_output)?;
        crate::git::checked_result(Path::new("."), out, &[0], &[]).map(|result| result.stdout)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Cmd;

    fn git(r: &Path, args: &[&str]) -> std::process::Output {
        Cmd::new("git").arg("-C").arg(r).args(args).output().unwrap()
    }

    /// Desktop executionOptionsWithProgress：推送、获取、拉取带进度回调时，stderr 边跑边解析成进度，
    /// 百分比按各自的步骤权重单调增长到 1；不带回调时不加 --progress、不解析
    #[test]
    fn 推送_获取_拉取的进度() {
        use crate::progress::Progress;
        let d = tempfile::tempdir().unwrap();
        let commit = |r: &Path, name: &str| {
            // 不可压缩的内容，让 git 一定打包出对象并报告进度
            let bytes: Vec<u8> = (0..200_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
            std::fs::write(r.join(name), bytes).unwrap();
            git(r, &["add", "."]);
            git(r, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", name]);
        };
        let upstream = d.path().join("up.git");
        let a = d.path().join("a");
        let b = d.path().join("b");
        Cmd::new("git").args(["init", "-q", "--bare", "-b", "main"]).arg(&upstream).output().unwrap();
        let url = format!("file://{}", upstream.display());
        for r in [&a, &b] {
            Cmd::new("git").args(["clone", "-q", &url]).arg(r).output().unwrap();
        }
        commit(&a, "one");
        git(&a, &["push", "-q", "origin", "HEAD:main"]);
        git(&b, &["pull", "-q", "origin", "main"]);

        let percents = |events: &[Progress], title: &str| -> Vec<f64> {
            let seen: Vec<f64> = events
                .iter()
                .map(|e| match e {
                    Progress::Progress { percent, .. } | Progress::Context { percent, .. } => *percent,
                })
                .collect();
            assert!(seen.windows(2).all(|w| w[0] <= w[1] + 1e-9), "{seen:?}");
            assert!(
                events.iter().any(|e| matches!(e, Progress::Progress { details, .. } if details.title == title)),
                "缺少 {title}: {:?}",
                events
                    .iter()
                    .map(|e| match e {
                        Progress::Progress { details, .. } => details.text.clone(),
                        Progress::Context { text, .. } => text.clone(),
                    })
                    .collect::<Vec<_>>()
            );
            seen
        };

        commit(&a, "two");
        let mut pushed = Vec::new();
        let options = PushOptions { set_upstream: false, progress: true, ..Default::default() };
        push_with_tags(&a, "origin", "HEAD:main", &[], options, None, None, Some(&mut |e| pushed.push(e))).unwrap();
        let seen = percents(&pushed, "Writing objects");
        assert!((seen.last().copied().unwrap() - 0.9).abs() < 1e-6, "写完对象占 0.2 + 0.7：{seen:?}");

        let mut fetched = Vec::new();
        let options = RemoteOptions { progress: true, ..Default::default() };
        let out = fetch_output(&b, "origin", options, None, None, Some(&mut |e| fetched.push(e))).unwrap();
        assert_eq!(out.exit_code, Some(0));
        // 对象少时 git 用 unpack-objects 静默解包，没有 Receiving objects 这一步
        percents(&fetched, "remote: Compressing objects");

        commit(&a, "three");
        git(&a, &["push", "-q", "origin", "HEAD:main"]);
        let mut pulled = Vec::new();
        let options = RemoteOptions { progress: true, ..Default::default() };
        let out = pull_output(&b, "origin", options, None, None, Some(&mut |e| pulled.push(e))).unwrap();
        assert_eq!(out.exit_code, Some(0), "{}", out.stderr);
        percents(&pulled, "remote: Compressing objects");
        assert!(b.join("three").exists());
    }

    #[test]
    fn 共同作者写成_trailer() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        let g = |args: &[&str]| {
            Cmd::new("git").arg("-C").arg(&r).args(args).output().unwrap();
        };
        g(&["init", "-q", "-b", "main", "."]);
        g(&["config", "user.email", "t@t.t"]);
        g(&["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "x\n").unwrap();
        g(&["add", "."]);

        commit(
            &r,
            "做了点事",
            "顺便说两句",
            CommitOptions { co_authors: vec!["某人 <someone@example.com>".into()], ..Default::default() },
        )
        .unwrap();

        let msg = String::from_utf8_lossy(&git(&r, &["log", "-1", "--format=%B"]).stdout).into_owned();
        assert!(msg.starts_with("做了点事"), "摘要该在第一行: {msg:?}");
        assert!(msg.contains("顺便说两句"), "正文要在: {msg:?}");
        assert!(msg.contains("Co-authored-by: 某人 <someone@example.com>"), "共同作者该成为 trailer: {msg:?}");
        // trailer 前必须空一行，否则 git 不认它是 trailer
        let tail = msg.trim_end();
        let lines: Vec<&str> = tail.lines().collect();
        let i = lines.iter().position(|l| l.starts_with("Co-authored-by:")).unwrap();
        assert!(lines[i - 1].trim().is_empty(), "trailer 前该空一行: {msg:?}");
    }

    /// 环境变量是进程全局的，读它的测试必须串行，否则和别的测试互相踩。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn 非_askpass_启动时不拦截() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::remove_var("GITCUB_ASKPASS_TOKEN");
        }
        assert!(askpass_if_invoked().is_none(), "普通启动不该被当成 askpass 回调");
    }

    /// git 只给一个自由格式的提示串，靠它区分要用户名还是密码。
    /// 判错的后果是把 token 当用户名发出去：认证失败，且 token 已泄漏给服务端。
    #[test]
    fn 能区分用户名与密码提示() {
        let (u, t) = ("oauth2", "ghp_secret");
        assert_eq!(choose("Username for 'https://github.com': ", u, t), u);
        assert_eq!(choose("Password for 'https://github.com': ", u, t), t);
        // GitLab 的提示串措辞不同，同样要走对分支
        assert_eq!(choose("User name for 'https://gitlab.com': ", u, t), u);
        // 认不出来的提示按密码处理：给错用户名只是失败，给错密码才会泄漏 token
        assert_eq!(choose("Enter passphrase: ", u, t), t);
    }

    /// 造一个「工作仓库 + 本地裸远端」的组合。
    /// 本地远端不需要认证，用来验证 push/fetch/pull 的管道本身。
    fn repo_with_remote() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let bare = d.path().join("remote.git");
        let work = d.path().join("work");
        Cmd::new("git").args(["init", "-q", "-b", "main", "--bare"]).arg(&bare).output().unwrap();
        Cmd::new("git").args(["init", "-q", "-b", "main"]).arg(&work).output().unwrap();
        git(&work, &["config", "user.email", "t@t.t"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("a.txt"), "1\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "init"]);
        git(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        (d, work)
    }

    #[test]
    fn push_能把提交送到远端() {
        let (_d, work) = repo_with_remote();
        push(&work, "origin", "HEAD:refs/heads/main", false, false, Some("unused-token"), None).unwrap();
        let out = git(&work, &["ls-remote", "origin", "refs/heads/main"]);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("refs/heads/main"), "远端没有 main: {text}");
    }

    /// 没有 token 也要能推：SSH 远端、本地远端、用户自己的 credential helper
    /// 都属于这一类，硬要 token 的话这些人一个都推不出去。
    #[test]
    fn 没有_token_照样能推到不需要认证的远端() {
        let (_d, work) = repo_with_remote();
        push(&work, "origin", "HEAD:refs/heads/main", true, false, None, None).unwrap();
        let out = git(&work, &["ls-remote", "origin", "refs/heads/main"]);
        assert!(String::from_utf8_lossy(&out.stdout).contains("refs/heads/main"));
    }

    #[test]
    fn fetch_能拿到远端新提交() {
        let (_d, work) = repo_with_remote();
        push(&work, "origin", "HEAD:refs/heads/main", false, false, Some("t"), None).unwrap();
        git(&work, &["branch", "--set-upstream-to=origin/main"]);

        let other = work.parent().unwrap().join("other");
        Cmd::new("git")
            .args(["clone", "-q"])
            .arg(work.parent().unwrap().join("remote.git"))
            .arg(&other)
            .output()
            .unwrap();
        git(&other, &["config", "user.email", "o@o.o"]);
        git(&other, &["config", "user.name", "o"]);
        std::fs::write(other.join("b.txt"), "2\n").unwrap();
        git(&other, &["add", "."]);
        git(&other, &["commit", "-qm", "来自他人"]);
        git(&other, &["push", "-q", "origin", "HEAD:main"]);

        fetch(&work, "origin", Some("t"), None).unwrap();
        let out = git(&work, &["log", "--oneline", "origin/main"]);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("来自他人"), "fetch 没拿到新提交: {text}");
    }

    #[test]
    fn pull_尊重_ff_only_配置() {
        let (_d, work) = repo_with_remote();
        push(&work, "origin", "HEAD:refs/heads/main", false, false, Some("t"), None).unwrap();
        git(&work, &["branch", "--set-upstream-to=origin/main"]);

        let other = work.parent().unwrap().join("other");
        Cmd::new("git")
            .args(["clone", "-q"])
            .arg(work.parent().unwrap().join("remote.git"))
            .arg(&other)
            .output()
            .unwrap();
        git(&other, &["config", "user.email", "o@o.o"]);
        git(&other, &["config", "user.name", "o"]);
        std::fs::write(other.join("b.txt"), "2\n").unwrap();
        git(&other, &["add", "."]);
        git(&other, &["commit", "-qm", "远端"]);
        git(&other, &["push", "-q", "origin", "HEAD:main"]);

        std::fs::write(work.join("c.txt"), "3\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "本地"]);

        git(&work, &["config", "pull.ff", "only"]);
        assert!(pull(&work, "origin", Some("t"), None).is_err(), "分叉时 pull 应当失败");
        git(&work, &["config", "--unset", "pull.ff"]);
        pull(&work, "origin", Some("t"), None).unwrap();
        assert_eq!(git(&work, &["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.split(|b| *b == b' ').count(), 3);
    }
}
