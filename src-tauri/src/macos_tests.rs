//! GitCub production workflows, independent of the immutable Desktop test files.
use crate::{branch, git::Git, net, ops, raw_diff, status};
use std::{path::Path, process::Command, time::Instant};

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    git(dir.path(), &["config", "user.name", "GitCub Test"]);
    git(dir.path(), &["config", "user.email", "test@example.invalid"]);
    git(dir.path(), &["config", "commit.gpgsign", "false"]);
    git(dir.path(), &["config", "core.hooksPath", "/dev/null"]);
    std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-qm", "base"]);
    dir
}

#[test]
fn remote_checkout_tracks_without_detaching_and_refuses_local_collision() {
    let source = fixture();
    git(source.path(), &["branch", "feature"]);
    let root = tempfile::tempdir().unwrap();
    let clone = root.path().join("clone");
    branch::clone(source.path().to_str().unwrap(), &clone, None).unwrap();
    net::checkout(&clone, "refs/remotes/origin/feature").unwrap();
    assert_eq!(git(&clone, &["branch", "--show-current"]), "feature");
    assert_eq!(git(&clone, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature");
    net::checkout(&clone, "main").unwrap();
    assert!(net::checkout(&clone, "refs/remotes/origin/feature").is_err());
    assert_eq!(git(&clone, &["branch", "--show-current"]), "main");
}

#[test]
fn rebase_conflict_survives_status_reload_and_can_abort_or_continue() {
    let dir = fixture();
    let repo = dir.path();
    git(repo, &["checkout", "-qb", "feature"]);
    std::fs::write(repo.join("file.txt"), "feature\n").unwrap();
    git(repo, &["commit", "-qam", "feature"]);
    let original = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["checkout", "-q", "main"]);
    std::fs::write(repo.join("file.txt"), "main\n").unwrap();
    git(repo, &["commit", "-qam", "main"]);
    net::checkout(repo, "feature").unwrap();
    assert!(ops::rebase(repo, "main").is_err());
    assert_eq!(status::status(repo).unwrap().operation, Some(ops::Operation::Rebase));
    assert!(ops::rebase_snapshot(repo).unwrap().is_some());
    ops::abort_operation(repo, ops::Operation::Rebase).unwrap();
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), original);
    assert_eq!(std::fs::read_to_string(repo.join("file.txt")).unwrap(), "feature\n");
    assert!(ops::rebase(repo, "main").is_err());
    ops::resolve_conflict(repo, "file.txt", ops::Resolution::Theirs).unwrap();
    ops::continue_operation(repo, ops::Operation::Rebase).unwrap();
    assert!(status::status(repo).unwrap().operation.is_none());
    assert_eq!(git(repo, &["rev-parse", "HEAD^"]), git(repo, &["rev-parse", "main"]));
    assert_eq!(std::fs::read_to_string(repo.join("file.txt")).unwrap(), "feature\n");
}

#[test]
fn progress_arrives_before_the_process_can_finish() {
    let dir = tempfile::tempdir().unwrap();
    let release = dir.path().join("release");
    let mut received = false;
    let output = Git::new(None).args(["-c", "alias.progress-test=!printf 'Receiving objects: 50%% (1/2)\\r' >&2; for i in $(seq 1 500); do test -f \"$RELEASE_FILE\" && exit 0; sleep 0.01; done; exit 1", "progress-test"])
        .env("RELEASE_FILE", &release)
        .output_raw_stream(|chunk| {
            if matches!(chunk.stream, crate::git::TerminalStream::Stderr) {
                received = true;
                std::fs::write(&release, "continue").unwrap();
            }
        }).unwrap();
    assert!(received && output.status.success());
}

#[test]
fn native_status_and_large_diff_match_git() {
    let dir = fixture();
    let repo = dir.path();
    for n in 0..5000 {
        std::fs::write(repo.join(format!("file-{n}.txt")), "base\n").unwrap();
    }
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "5000 files"]);
    for n in 0..100 {
        std::fs::write(repo.join(format!("file-{n}.txt")), "changed\n").unwrap();
    }
    let started = Instant::now();
    let actual = status::status(repo).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(actual.changes.len(), 100);
    assert_eq!(git(repo, &["status", "--porcelain"]).lines().count(), actual.changes.len());
    assert!(elapsed.as_secs() < 10, "native status took {elapsed:?}");
    std::fs::write(repo.join("file.txt"), (0..100_000).map(|n| format!("changed {n}\n")).collect::<String>()).unwrap();
    let started = Instant::now();
    let diff = raw_diff::working_directory_diff(repo, "file.txt", raw_diff::FileKind::Normal, false).unwrap();
    assert!(diff.text.contains("+changed 99999"));
    assert!(started.elapsed().as_secs() < 10);
    println!(
        "GitCub native status: {elapsed:?}; 5001 tracked files, 100 modified; 100000-line diff: {:?}",
        started.elapsed()
    );
}

#[test]
fn native_git_reads_rotating_credentials_without_returning_refresh_tokens() {
    assert_eq!(crate::settings::access_token("plain"), Some("plain".into()));
    assert_eq!(
        crate::settings::access_token(
            r#"github-desktop-oauth:{"version":1,"credential":{"accessToken":"access","refreshToken":"refresh"}}"#
        ),
        Some("access".into())
    );
    assert_eq!(crate::settings::access_token(r#"github-desktop-oauth:{"version":1,"credential":null}"#), None);
    assert_eq!(crate::settings::access_token("github-desktop-oauth:invalid"), None);
}

#[test]
fn active_remote_follows_tracking_configuration_instead_of_alphabetical_order() {
    let dir = fixture();
    let repo = dir.path();
    git(repo, &["remote", "add", "aaa", "/unused-a"]);
    git(repo, &["remote", "add", "origin", "/unused-origin"]);
    git(repo, &["remote", "add", "team", "/unused-team"]);
    assert_eq!(status::status(repo).unwrap().remote.as_deref(), Some("origin"));
    git(repo, &["config", "branch.main.remote", "team"]);
    git(repo, &["config", "branch.main.merge", "refs/heads/different-name"]);
    git(repo, &["update-ref", "refs/remotes/team/different-name", "HEAD"]);
    assert_eq!(status::status(repo).unwrap().remote.as_deref(), Some("team"));
    let details = branch::list(repo, Some("refs/heads/main")).unwrap();
    assert_eq!(details[0].upstream_without_remote.as_deref(), Some("different-name"));
}

#[test]
fn merge_cherry_pick_and_revert_recover_after_failed_continue_and_abort() {
    for operation in [ops::Operation::Merge, ops::Operation::CherryPick, ops::Operation::Revert] {
        let dir = fixture();
        let repo = dir.path();
        git(repo, &["checkout", "-qb", "feature"]);
        std::fs::write(repo.join("file.txt"), "feature\n").unwrap();
        git(repo, &["commit", "-qam", "feature"]);
        let feature = git(repo, &["rev-parse", "HEAD"]);
        git(repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("file.txt"), "main\n").unwrap();
        git(repo, &["commit", "-qam", "main"]);
        let main_commit = git(repo, &["rev-parse", "HEAD"]);
        if operation == ops::Operation::Revert {
            std::fs::write(repo.join("file.txt"), "later\n").unwrap();
            git(repo, &["commit", "-qam", "later"]);
        }
        let original_head = git(repo, &["rev-parse", "HEAD"]);
        let original_contents = std::fs::read(repo.join("file.txt")).unwrap();
        let start = || match operation {
            ops::Operation::Merge => ops::merge(repo, "feature", false),
            ops::Operation::CherryPick => ops::cherry_pick(repo, std::slice::from_ref(&feature)),
            ops::Operation::Revert => ops::revert(repo, &main_commit, false),
            ops::Operation::Rebase => unreachable!(),
        };
        assert!(start().is_err());
        assert_eq!(status::status(repo).unwrap().operation, Some(operation));
        assert!(ops::continue_operation(repo, operation).is_err());
        assert_eq!(status::status(repo).unwrap().operation, Some(operation));
        ops::abort_operation(repo, operation).unwrap();
        assert_eq!(git(repo, &["rev-parse", "HEAD"]), original_head);
        assert_eq!(std::fs::read(repo.join("file.txt")).unwrap(), original_contents);
        assert!(status::status(repo).unwrap().operation.is_none());
        assert!(start().is_err());
        ops::resolve_conflict(repo, "file.txt", ops::Resolution::Theirs).unwrap();
        assert!(git(repo, &["diff", "--name-only", "--diff-filter=U"]).is_empty());
        ops::continue_operation(repo, operation).unwrap();
        assert!(status::status(repo).unwrap().operation.is_none());
        assert_eq!(git(repo, &["status", "--porcelain"]), "");
        assert_eq!(
            std::fs::read_to_string(repo.join("file.txt")).unwrap(),
            if operation == ops::Operation::Revert { "base\n" } else { "feature\n" }
        );
    }
}
