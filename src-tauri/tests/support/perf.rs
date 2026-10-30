//! Production status/history regression baseline; no Electron comparison is claimed.
use crate::{history, status};
use std::path::Path;
use std::process::Command;
use std::time::Instant;

/// 造一个有点体量的仓库：2000 个文件、50 次提交
fn fixture() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let git = |args: &[&str]| {
        let output = Command::new("git").arg("-C").arg(p).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "T"]);
    git(&["config", "commit.gpgsign", "false"]);
    git(&["config", "core.hooksPath", ".git/no-hooks"]);

    for round in 0..50 {
        for i in 0..40 {
            let name = format!("file-{}.txt", round * 40 + i);
            std::fs::write(p.join(&name), format!("内容 {round}\n").repeat(20)).unwrap();
        }
        git(&["add", "."]);
        git(&["commit", "-m", &format!("第 {round} 次提交")]);
    }
    d
}

fn ms(f: impl FnOnce()) -> u128 {
    let t = Instant::now();
    f();
    t.elapsed().as_millis()
}

#[test]
fn 热路径的耗时量级不退化() {
    let d = fixture();
    let p: &Path = d.path();

    // 各跑两次：第一次带上文件系统冷启动的影响，取第二次
    let mut status = 0;
    let mut log = 0;
    for _ in 0..2 {
        status = ms(|| {
            let result = status::status(p).unwrap();
            assert!(result.changes.is_empty());
        });
        log = ms(|| {
            let result = history::log(p, 200, 0).unwrap();
            assert_eq!(result.len(), 50);
            assert_eq!(result[0].summary, "第 49 次提交");
        });
    }

    // Broad regression budget, not a claim about latency on every machine.
    assert!(status < 1000, "status 用了 {status}ms，慢了一个量级");
    assert!(log < 1000, "log 用了 {log}ms，慢了一个量级");
    for i in 0..100 {
        std::fs::write(p.join(format!("file-{i}.txt")), "modified\n").unwrap();
        std::fs::write(p.join(format!("untracked-{i}.txt")), "new\n").unwrap();
    }
    let dirty = ms(|| {
        let result = status::status(p).unwrap();
        assert_eq!(result.changes.len(), 200);
        assert_eq!(result.changes.iter().filter(|f| f.change == status::ChangeType::Modified).count(), 100);
        assert_eq!(result.changes.iter().filter(|f| f.kind == status::ChangeKind::Untracked).count(), 100);
    });
    assert!(dirty < 1000, "dirty status took {dirty}ms");
    println!("dirty status {dirty}ms (100 modified, 100 untracked)");
    println!("基线：status {status}ms、log {log}ms（2000 个文件 / 50 次提交）");
}
