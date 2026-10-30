//! 测试用的仓库夹具。只有造起来麻烦、又被多处用到的才放这里。

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn git(r: &Path, args: &[&str]) -> String {
    let o = Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// 一个带子模块的仓库，子模块三种脏法齐活：
/// 指向的提交变了、内部有改动、内部有未跟踪文件。
///
/// 返回 (临时目录, 父仓库路径)。子模块的相对路径是 `mod`。
pub fn with_submodule() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let inner = d.path().join("inner");
    let outer = d.path().join("outer");

    std::fs::create_dir_all(&inner).unwrap();
    git(&inner, &["init", "-q", "-b", "main", "."]);
    git(&inner, &["config", "user.email", "t@t.t"]);
    git(&inner, &["config", "user.name", "t"]);
    std::fs::write(inner.join("f.txt"), "v1\n").unwrap();
    git(&inner, &["add", "."]);
    git(&inner, &["commit", "-qm", "inner 1"]);
    std::fs::write(inner.join("f.txt"), "v2\n").unwrap();
    git(&inner, &["commit", "-qam", "inner 2"]);

    std::fs::create_dir_all(&outer).unwrap();
    git(&outer, &["init", "-q", "-b", "main", "."]);
    git(&outer, &["config", "user.email", "t@t.t"]);
    git(&outer, &["config", "user.name", "t"]);
    std::fs::write(outer.join("top.txt"), "top\n").unwrap();
    git(&outer, &["add", "."]);
    git(&outer, &["commit", "-qm", "outer 1"]);
    // 本地路径的子模块默认被 git 拒绝（CVE-2022-39253），测试里显式放行
    git(&outer, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", "../inner", "mod"]);
    git(&outer, &["commit", "-qm", "加子模块"]);

    // 三种脏法
    let m = outer.join("mod");
    git(&m, &["checkout", "-q", "HEAD~1"]);
    std::fs::write(m.join("f.txt"), "v1\n改脏了\n").unwrap();
    std::fs::write(m.join("未跟踪.txt"), "新\n").unwrap();

    (d, outer)
}
