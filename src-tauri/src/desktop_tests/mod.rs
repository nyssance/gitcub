//! GitHub Desktop 行为回归。来源与覆盖范围见 tests/desktop/manifest.json。
//! 测试操作调用生产模块；git CLI 仅用于夹具准备和独立结果检查。

use std::path::Path;
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn empty_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    crate::system::init_repo(dir.path(), "master").unwrap();
    git(dir.path(), &["config", "user.name", "Desktop test"]);
    git(dir.path(), &["config", "user.email", "desktop-test@example.invalid"]);
    git(dir.path(), &["config", "commit.gpgsign", "false"]);
    git(dir.path(), &["config", "core.autocrlf", "false"]);
    git(dir.path(), &["config", "core.hooksPath", "/dev/null"]);
    dir
}

// app/test/unit/git/init-test.ts — 原版两个用例。
#[test]
fn init_creates_repository() {
    let dir = tempfile::tempdir().unwrap();
    crate::system::init_repo(dir.path(), "main").unwrap();
    assert!(dir.path().join(".git").exists());
}

#[test]
fn init_sets_default_branch() {
    let dir = tempfile::tempdir().unwrap();
    crate::system::init_repo(dir.path(), "main").unwrap();
    assert!(crate::status::status(dir.path()).is_ok());
    assert_eq!(git(dir.path(), &["symbolic-ref", "--short", "HEAD"]).trim(), "main");
}

// app/test/unit/git/remote-management-test.ts — 同样的参数矩阵和磁盘断言。
#[test]
fn remote_add_treats_names_and_urls_literally() {
    for name in ["origin", "--remote"] {
        for url in ["/path/with spaces/repository", "--mirror"] {
            let dir = empty_repo();
            crate::system::add_remote(dir.path(), name, url).unwrap();
            assert_eq!(git(dir.path(), &["config", "--get", &format!("remote.{name}.url")]).trim(), url);
        }
    }
}

#[test]
fn remote_add_rejects_duplicate_without_changing_url() {
    let dir = empty_repo();
    crate::system::add_remote(dir.path(), "origin", "/original").unwrap();
    assert!(crate::system::add_remote(dir.path(), "origin", "/replacement").is_err());
    assert_eq!(git(dir.path(), &["config", "--get", "remote.origin.url"]).trim(), "/original");
}

#[test]
fn remote_set_url_treats_arguments_literally() {
    for name in ["origin", "--remote"] {
        for url in ["/path/with spaces/repository", "--push"] {
            let dir = empty_repo();
            git(dir.path(), &["remote", "add", "--", name, "/original"]);
            crate::system::set_remote_url(dir.path(), name, url).unwrap();
            assert_eq!(git(dir.path(), &["config", "--get", &format!("remote.{name}.url")]).trim(), url);
        }
    }
}

#[test]
fn remote_set_url_rejects_missing_remote() {
    for name in ["origin", "--remote"] {
        let dir = empty_repo();
        assert!(crate::system::set_remote_url(dir.path(), name, "/replacement").is_err());
    }
}

#[test]
fn remote_remove_keeps_other_remotes() {
    for name in ["origin", "--remote"] {
        let dir = empty_repo();
        git(dir.path(), &["remote", "add", "--", name, "/repository"]);
        git(dir.path(), &["remote", "add", "--", "retained", "/retained"]);
        crate::system::remove_remote(dir.path(), name).unwrap();
        assert_eq!(git(dir.path(), &["remote"]), "retained\n");
    }
}

#[test]
fn remote_remove_ignores_missing_remote() {
    for name in ["origin", "--remote"] {
        let dir = empty_repo();
        crate::system::remove_remote(dir.path(), name).unwrap();
    }
}

fn plan(path: &str, include: crate::stage::Include) -> crate::stage::StageFile {
    crate::stage::StageFile { path: path.into(), old_path: None, include, patch: None }
}

fn commit(root: &Path, summary: &str, description: &str, allow_empty: bool) -> Result<(), String> {
    crate::net::commit(
        root,
        summary,
        description,
        crate::net::CommitOptions { skip_hooks: false, sign_off: false, allow_empty, co_authors: vec![] },
    )
}

// app/test/unit/git/commit-test.ts — 空仓库、正文和 allowEmpty 的磁盘结果。
// Rust API 返回 ()，不伪造 Desktop 的 shortSha 返回值；此文件保持 partial 状态。
#[test]
fn commit_empty_repository() {
    use crate::stage::Include::All;
    let dir = empty_repo();
    let root = dir.path();
    std::fs::write(root.join("foo"), "foo\n").unwrap();
    std::fs::write(root.join("bar"), "bar\n").unwrap();
    assert_eq!(crate::status::status(root).unwrap().changes.len(), 2);
    crate::stage::apply_selection(root, &[plan("foo", All), plan("bar", All)]).unwrap();
    commit(root, "added two files", "this is a description", false).unwrap();
    assert!(crate::status::status(root).unwrap().changes.is_empty());
    assert_eq!(git(root, &["rev-list", "--count", "HEAD"]).trim(), "1");
    assert_eq!(git(root, &["show", "-s", "--format=%s"]), "added two files\n");
    assert_eq!(git(root, &["show", "-s", "--format=%b"]), "this is a description\n\n");
}

#[test]
fn commit_preserves_commentary() {
    let dir = empty_repo();
    std::fs::write(dir.path().join("foo"), "foo\n").unwrap();
    crate::stage::apply_selection(dir.path(), &[plan("foo", crate::stage::Include::All)]).unwrap();
    commit(dir.path(), "Special commit", "# this is a comment", false).unwrap();
    assert_eq!(git(dir.path(), &["show", "-s", "--format=%b"]), "# this is a comment\n\n");
}

#[test]
fn commit_allows_empty_when_requested() {
    let dir = empty_repo();
    commit(dir.path(), "Initial commit", "", true).unwrap();
    commit(dir.path(), "empty commit", "", true).unwrap();
    assert_eq!(git(dir.path(), &["show", "-s", "--format=%s"]), "empty commit\n");
    assert_eq!(git(dir.path(), &["rev-list", "--count", "HEAD"]).trim(), "2");
}

#[test]
fn commit_rejects_empty_by_default() {
    let dir = empty_repo();
    commit(dir.path(), "Initial commit", "", true).unwrap();
    assert!(commit(dir.path(), "should fail", "", false).is_err());
    assert_eq!(git(dir.path(), &["rev-list", "--count", "HEAD"]).trim(), "1");
}

// GitCub 扩展：Desktop 空仓库用例并未直接断言“取消勾选”，单独登记，不能冒充上游测试。
#[test]
fn empty_repository_can_exclude_a_file() {
    use crate::stage::Include::{All, None};
    let dir = empty_repo();
    std::fs::write(dir.path().join("foo"), "foo\n").unwrap();
    std::fs::write(dir.path().join("bar"), "bar\n").unwrap();
    crate::stage::apply_selection(dir.path(), &[plan("foo", All), plan("bar", None)]).unwrap();
    commit(dir.path(), "only foo", "", false).unwrap();
    assert_eq!(git(dir.path(), &["ls-tree", "--name-only", "HEAD"]), "foo\n");
    assert_eq!(std::fs::read_to_string(dir.path().join("bar")).unwrap(), "bar\n");
}

#[test]
fn commit_staged_new_file_then_deleted() {
    let dir = empty_repo();
    let root = dir.path();
    std::fs::write(root.join("first"), "line1\n").unwrap();
    std::fs::write(root.join("second"), "line2\n").unwrap();
    git(root, &["add", "."]);
    std::fs::remove_file(root.join("first")).unwrap();
    let status = crate::status::status(root).unwrap();
    assert_eq!(status.changes.len(), 1);
    assert_eq!(status.changes[0].path, "second");
    assert_eq!(status.changes[0].change, crate::status::ChangeType::Added);
    crate::stage::apply_selection(root, &[plan("second", crate::stage::Include::All)]).unwrap();
    commit(root, "commit everything", "", false).unwrap();
    assert!(crate::status::status(root).unwrap().changes.is_empty());
    assert_eq!(git(root, &["show", "-s", "--format=%s"]), "commit everything\n");
    assert_eq!(git(root, &["ls-tree", "--name-only", "HEAD"]), "second\n");
}

#[test]
fn commit_staged_delete_with_untracked_file() {
    let dir = empty_repo();
    let root = dir.path();
    std::fs::write(root.join("first"), "line1\n").unwrap();
    git(root, &["add", "first"]);
    git(root, &["commit", "-m", "commit first file"]);
    git(root, &["rm", "--cached", "first"]);
    std::fs::write(root.join("first"), "line2\n").unwrap();
    let status = crate::status::status(root).unwrap();
    assert_eq!(status.changes.len(), 1);
    assert_eq!(status.changes[0].path, "first");
    assert_eq!(status.changes[0].kind, crate::status::ChangeKind::Untracked);
    crate::stage::apply_selection(root, &[plan("first", crate::stage::Include::All)]).unwrap();
    commit(root, "commit again!", "", false).unwrap();
    assert!(crate::status::status(root).unwrap().changes.is_empty());
    assert_eq!(git(root, &["show", "-s", "--format=%s"]), "commit again!\n");
    assert_eq!(git(root, &["show", "HEAD:first"]), "line2\n");
}

#[test]
fn commit_file_deleted_in_index_stays_deleted() {
    let dir = empty_repo();
    let root = dir.path();
    std::fs::write(root.join("secret"), "contents\n").unwrap();
    std::fs::write(root.join(".gitignore"), "").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "Initial commit"]);
    std::fs::write(root.join("secret"), "Somethign secret\n").unwrap();
    std::fs::write(root.join(".gitignore"), "secret").unwrap();
    git(root, &["rm", "--cached", "secret"]);
    let status = crate::status::status(root).unwrap();
    assert_eq!(status.changes.len(), 2);
    assert_eq!(status.changes[1].change, crate::status::ChangeType::Deleted);
    crate::stage::apply_selection(
        root,
        &[plan(".gitignore", crate::stage::Include::All), plan("secret", crate::stage::Include::All)],
    )
    .unwrap();
    commit(root, "Remove secret", "", false).unwrap();
    assert!(crate::status::status(root).unwrap().changes.is_empty());
    assert_eq!(git(root, &["ls-tree", "--name-only", "HEAD"]), ".gitignore\n");
    assert_eq!(std::fs::read_to_string(root.join("secret")).unwrap(), "Somethign secret\n");
}
