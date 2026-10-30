//! 交互式变基 —— 压缩提交、重排提交。
//!
//! 做法照搬原版（app/src/lib/git/{squash,reorder,rebase}.ts）：自己把 todo
//! 列表写成文件，再让 git 直接吃它，而不是弹一个编辑器出来。关键是那句
//! `-c sequence.editor=cat "<todo>" >`——git 会把它当命令跑，后面接上真正的
//! todo 文件路径，等价于「用我们写好的内容覆盖 git 生成的那份」。
//!
//! todo 的拼法有讲究，不能照用户点选的顺序来：必须**按 log 的顺序从老到新
//! 重放**，否则冲突会莫名其妙地多。这一段的算法是逐行对着原版抄的。

use crate::git::Git;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 一次性用的临时文件。走完就删，panic 也删得掉。
struct Temp(PathBuf);

impl Temp {
    fn new(tag: &str, content: &str) -> Result<Self, String> {
        let p = std::env::temp_dir().join(format!(
            "gitcub-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        if let Err(error) = file.write_all(content.as_bytes()) {
            let _ = std::fs::remove_file(&p);
            return Err(format!("写临时文件失败: {error}"));
        }
        Ok(Self(p))
    }

    /// git 配置里要用的那串：`cat "<路径>" >`
    fn as_editor(&self) -> String {
        format!("cat '{}' >", self.0.to_string_lossy().replace('\'', "'\\''"))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `last_retained..HEAD` 的提交，**新的在前**（和 `git log` 一致）。
fn commits_since(repo: &Path, last_retained: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let range;
    let mut g = Git::new(Some(repo)).args(["log", "--format=%H%x00%s", "--no-show-signature"]);
    if let Some(base) = last_retained {
        range = format!("{base}..HEAD");
        g = g.arg(&range);
    }
    Ok(g.stdout()?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let (sha, summary) = l.split_once('\0')?;
            Some((sha.to_string(), summary.to_string()))
        })
        .collect())
}

/// 跑一次交互式变基。`message` 有值时连提交信息编辑器一起替换掉。
fn run(repo: &Path, todo: &str, last_retained: Option<&str>, message: Option<&str>) -> Result<(), String> {
    let todo_file = Temp::new("todo", todo)?;
    let msg_file = match message {
        Some(m) if !m.trim().is_empty() => Some(Temp::new("msg", m)?),
        _ => None,
    };

    // 提交信息编辑器：给了信息就拿它覆盖，没给就用 `:`（什么都不做，
    // 即接受 git 拼好的默认信息）
    let editor = msg_file.as_ref().map_or_else(|| ":".to_string(), Temp::as_editor);
    // 第一个提交没有父，只能用 --root
    let base = last_retained.unwrap_or("--root");

    Git::new(Some(repo))
        .args(["-c", &format!("sequence.editor={}", todo_file.as_editor())])
        .env("GIT_EDITOR", editor)
        .args(["rebase", "-i", base])
        .run()
}

/// 把 `to_squash` 压到 `onto` 上。
///
/// 目标是「保持 log 里的先后顺序」：原版的注释举的例子是 A B C D E 里把 A 和 E
/// 压到 C 上，结果应该是 B、A-C-E、D —— A 仍在 C 前、E 仍在 C 后。
pub fn squash(
    repo: &Path, to_squash: &[String], onto: &str, last_retained: Option<&str>, message: &str,
) -> Result<(), String> {
    if to_squash.is_empty() {
        return Err("没有要压缩的提交".into());
    }
    if to_squash.iter().any(|s| s == onto) {
        return Err("要压缩的提交里不能包含被压到的那个".into());
    }

    let commits = commits_since(repo, last_retained)?;
    if commits.is_empty() {
        return Err("这个范围里没有提交".into());
    }

    let mut todo = String::new();
    let mut found_onto = false;
    let mut at_squash: Vec<&(String, String)> = Vec::new();
    let mut after: Vec<&(String, String)> = Vec::new();

    // 倒着走 = 从老到新重放
    for c in commits.iter().rev() {
        if to_squash.contains(&c.0) {
            if found_onto {
                todo.push_str(&format!("squash {} {}\n", c.0, c.1));
            } else {
                // 还没遇到被压的那个，先攒着——要按 log 的顺序排，
                // 不能信调用方给的顺序
                at_squash.push(c);
            }
            continue;
        }
        if c.0 == onto {
            found_onto = true;
            at_squash.push(c);
            for (i, x) in at_squash.iter().enumerate() {
                let action = if i == 0 { "pick" } else { "squash" };
                todo.push_str(&format!("{action} {} {}\n", x.0, x.1));
            }
            continue;
        }
        if found_onto {
            // 后面可能还有要压过来的，先攒着，最后统一 pick
            after.push(c);
            continue;
        }
        todo.push_str(&format!("pick {} {}\n", c.0, c.1));
    }

    if !found_onto {
        return Err("被压到的那个提交不在范围里，再走下去会把提交弄丢".into());
    }
    for c in after {
        todo.push_str(&format!("pick {} {}\n", c.0, c.1));
    }

    run(repo, &todo, last_retained, Some(message))
}

/// 把 `to_move` 移到 `before` 之前；`before` 为 None 表示移到最后。
pub fn reorder(
    repo: &Path, to_move: &[String], before: Option<&str>, last_retained: Option<&str>,
) -> Result<(), String> {
    if to_move.is_empty() {
        return Err("没有要移动的提交".into());
    }

    let commits = commits_since(repo, last_retained)?;
    if commits.is_empty() {
        return Err("这个范围里没有提交".into());
    }

    let mut todo = String::new();
    let mut found_base = false;
    let mut before_base: Vec<&(String, String)> = Vec::new();
    let mut after: Vec<&(String, String)> = Vec::new();

    for c in commits.iter().rev() {
        if to_move.contains(&c.0) {
            if found_base {
                todo.push_str(&format!("pick {} {}\n", c.0, c.1));
            } else {
                before_base.push(c);
            }
            continue;
        }
        if before.is_some_and(|b| b == c.0) {
            found_base = true;
            after.push(c);
            for x in &before_base {
                todo.push_str(&format!("pick {} {}\n", x.0, x.1));
            }
            continue;
        }
        if found_base {
            after.push(c);
            continue;
        }
        todo.push_str(&format!("pick {} {}\n", c.0, c.1));
    }

    if before.is_some() && !found_base {
        return Err("重排目标不在提交范围内，已停止以免改写错误历史".into());
    }

    // before 为 None（移到最后）时，攒下来的那些在这里补上
    if !found_base {
        for x in &before_base {
            todo.push_str(&format!("pick {} {}\n", x.0, x.1));
        }
    }
    for c in after {
        todo.push_str(&format!("pick {} {}\n", c.0, c.1));
    }

    run(repo, &todo, last_retained, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_repo::git;

    #[cfg(unix)]
    #[test]
    fn 编辑器把临时文件路径作为字面量而非shell表达式() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("message '$GITCUB_EDITOR_TEST'.txt");
        std::fs::write(&source, "exact message\n").unwrap();
        let input = Temp(source);
        let output = directory.path().join("result.txt");
        let status = std::process::Command::new("sh")
            .args(["-c", &format!("{} \"$1\"", input.as_editor()), "test-editor"])
            .arg(&output)
            .env("GITCUB_EDITOR_TEST", "must-not-expand")
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read_to_string(output).unwrap(), "exact message\n");
    }

    /// 造一串提交：每个提交加一个自己的文件，互不冲突，方便验顺序
    fn repo_with(commits: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        for c in commits {
            std::fs::write(r.join(format!("{c}.txt")), format!("{c}\n")).unwrap();
            git(&r, &["add", "."]);
            git(&r, &["commit", "-qm", c]);
        }
        (d, r)
    }

    /// 从老到新的摘要列表
    fn summaries(r: &Path) -> Vec<String> {
        git(r, &["log", "--format=%s", "--reverse"]).lines().map(str::to_string).collect()
    }

    fn sha_of(r: &Path, summary: &str) -> String {
        git(r, &["log", "--format=%H %s"])
            .lines()
            .find(|l| l.ends_with(summary))
            .and_then(|l| l.split_whitespace().next().map(str::to_string))
            .unwrap()
    }

    #[test]
    fn 压缩两个提交成一个() {
        let (_d, r) = repo_with(&["A", "B", "C"]);
        let b = sha_of(&r, "B");
        let c = sha_of(&r, "C");
        let a = sha_of(&r, "A");

        squash(&r, &[c], &b, Some(&a), "B 和 C 合起来").unwrap();

        assert_eq!(summaries(&r), vec!["A", "B 和 C 合起来"]);
        // 两个提交的内容都要在
        assert!(r.join("B.txt").exists() && r.join("C.txt").exists());
    }

    #[test]
    fn 压缩会保持_log_里的先后顺序() {
        // 原版注释里的例子：A B C D E，把 A 和 E 压到 C 上 → B、A-C-E、D
        let (_d, r) = repo_with(&["A", "B", "C", "D", "E"]);
        let (a, c, e) = (sha_of(&r, "A"), sha_of(&r, "C"), sha_of(&r, "E"));

        squash(&r, &[a, e], &c, None, "压好的").unwrap();

        assert_eq!(summaries(&r), vec!["B", "压好的", "D"]);
        for f in ["A", "B", "C", "D", "E"] {
            assert!(r.join(format!("{f}.txt")).exists(), "{f} 的内容丢了");
        }
    }

    #[test]
    fn 把一个提交往前挪() {
        let (_d, r) = repo_with(&["A", "B", "C", "D"]);
        let (a, b, d_) = (sha_of(&r, "A"), sha_of(&r, "B"), sha_of(&r, "D"));

        // 把 D 挪到 B 之前
        reorder(&r, &[d_], Some(&b), Some(&a)).unwrap();

        assert_eq!(summaries(&r), vec!["A", "D", "B", "C"]);
    }

    #[test]
    fn 挪到最后() {
        let (_d, r) = repo_with(&["A", "B", "C"]);
        let (a, b) = (sha_of(&r, "A"), sha_of(&r, "B"));

        reorder(&r, &[b], None, Some(&a)).unwrap();

        assert_eq!(summaries(&r), vec!["A", "C", "B"]);
    }

    #[test]
    fn 不许把目标提交也算进要压缩的里面() {
        let (_d, r) = repo_with(&["A", "B"]);
        let b = sha_of(&r, "B");
        assert!(squash(&r, std::slice::from_ref(&b), &b, None, "x").is_err());
    }
}
