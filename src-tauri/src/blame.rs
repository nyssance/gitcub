//! 逐行追溯（blame）与单文件历史。
//!
//! GitLens 的招牌能力，Desktop 完全没有。用 `git blame --porcelain`：
//! 它的输出是稳定的机器格式，不像默认输出那样随终端宽度变化。
//!
//! porcelain 的结构：每个「块」以 `<sha> <原行号> <新行号> <行数>` 开头，
//! 后面跟若干 `key value` 头部，最后一行以 TAB 开头的是源码本身。
//! 同一个提交第二次出现时 git 会省略头部，所以要自己记住每个 sha 的信息。

use crate::git::Git;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Unix 秒
    pub time: i64,
    pub summary: String,
    pub content: String,
}

pub fn blame(repo: &Path, file: &str) -> Result<Vec<BlameLine>, String> {
    // 进程内实现与 `git blame --porcelain -- <file>` 逐字节一致；不能保证一致的情形让位给 git
    #[cfg(unix)]
    match crate::blame_engine::porcelain(repo, None, file) {
        Ok(out) => return Ok(parse(&String::from_utf8_lossy(&out))),
        Err(reason) => log::debug!("blame 交给 git：{reason}"),
    }
    let out = Git::new(Some(repo)).args(["blame", "--porcelain", "--", file]).stdout()?;
    Ok(parse(&out))
}

pub fn parse(porcelain: &str) -> Vec<BlameLine> {
    let Some(parsed) = crate::blame_model::parse("", Some(porcelain), None, None) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut line_no = 0usize;
    let mut sha = "";
    for raw in porcelain.lines() {
        if let Some(content) = raw.strip_prefix('\t') {
            // porcelain 重复 SHA 的非连续块也会省略 filename；增量格式的
            // lines 表只包含已结束的块，内容行应直接复用缓存的 commit。
            let Some(commit) = parsed.commits.get(sha) else { continue };
            out.push(BlameLine {
                line: line_no as u32,
                sha: sha.into(),
                short_sha: sha.chars().take(7).collect(),
                author: commit.author.name.clone(),
                time: commit.author.date / 1000,
                summary: commit.summary.clone(),
                content: content.into(),
            });
        } else {
            let fields: Vec<_> = raw.split(' ').collect();
            if fields.len() >= 3
                && fields[0].bytes().all(|ch| ch.is_ascii_hexdigit())
                && let Ok(number) = fields[2].parse()
            {
                line_no = number;
                sha = fields[0];
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
1111111111111111111111111111111111111111 1 1 2
author 张三
author-time 1700000000
summary 第一次提交
filename a.txt
\tfirst line
1111111111111111111111111111111111111111 2 2
\tsecond line
2222222222222222222222222222222222222222 3 3 1
author 李四
author-time 1800000000
summary 改了第三行
filename a.txt
\tthird line
";

    #[test]
    fn 解析_porcelain_的行归属() {
        let lines = parse(SAMPLE);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].author, "张三");
        assert_eq!(lines[0].content, "first line");
        assert_eq!(lines[0].line, 1);
    }

    #[test]
    fn 同一提交第二次出现时头部被省略也要带上信息() {
        let lines = parse(SAMPLE);
        // 第二行属于同一个提交，git 不会重复给 author/summary
        assert_eq!(lines[1].sha, lines[0].sha);
        assert_eq!(lines[1].author, "张三", "头部省略时要用记住的");
        assert_eq!(lines[1].summary, "第一次提交");
        assert_eq!(lines[1].line, 2);
    }

    #[test]
    fn 不同提交的行各归各的() {
        let lines = parse(SAMPLE);
        assert_eq!(lines[2].author, "李四");
        assert_eq!(lines[2].time, 1800000000);
        assert_eq!(lines[2].short_sha, "2222222");
    }

    #[test]
    fn 非连续重复提交省略头部仍保留行() {
        let text = format!("{SAMPLE}1111111111111111111111111111111111111111 4 4 1\n\tfourth line\n");
        let lines = parse(&text);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[3].author, "张三");
        assert_eq!(lines[3].content, "fourth line");
        assert_eq!(lines[3].line, 4);
    }
}
