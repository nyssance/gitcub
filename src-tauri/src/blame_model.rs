//! GitLens packages/git-cli/src/parsers/blameParser.ts 的同步增量解析语义。
//! 保留 commit 去重、原始行号、previous、作者汇总和当前用户规则。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Default, Deserialize)]
pub struct User {
    pub name: Option<String>,
    pub email: Option<String>,
    pub username: Option<String>,
}

#[derive(Clone, Default, Serialize)]
pub struct Identity {
    pub name: String,
    pub email: Option<String>,
    /// 与 GitLens Date.getTime() 一致，毫秒。
    pub date: i64,
    pub current: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub sha: String,
    pub previous_sha: Option<String>,
    pub original_line: usize,
    pub line: usize,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub path: String,
    pub original_path: Option<String>,
    pub previous_sha: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Commit {
    pub sha: String,
    pub author: Identity,
    pub committer: Identity,
    pub summary: String,
    pub file: File,
    pub lines: Vec<Line>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub line_count: usize,
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub repo_path: String,
    pub authors: Vec<(String, Author)>,
    pub commits: BTreeMap<String, Commit>,
    pub lines: Vec<Option<Line>>,
}

#[derive(Default)]
struct Entry {
    sha: String,
    original_line: usize,
    line: usize,
    count: usize,
    author: Identity,
    committer: Identity,
    summary: String,
    file: File,
}

fn email(value: &str) -> String {
    value.split_once('<').map_or(value, |(_, rest)| rest.split_once('>').map_or(rest, |(mail, _)| mail)).into()
}

fn matches(user: Option<&User>, identity: &Identity) -> bool {
    user.is_some_and(|user| {
        (user.name.is_some() || user.email.is_some() || user.username.is_some())
            && user.name.as_ref().is_none_or(|name| name == &identity.name)
            && user.email.as_ref().is_none_or(|mail| Some(mail) == identity.email.as_ref())
            && user.username.is_none()
    })
}

pub fn parse(repo: &str, data: Option<&str>, user: Option<&User>, modified_time: Option<i64>) -> Option<Blame> {
    let data = data.filter(|data| !data.is_empty())?;
    let mut result = Blame { repo_path: repo.into(), authors: vec![], commits: BTreeMap::new(), lines: vec![] };
    let mut entry: Option<Entry> = None;
    for raw in data.split('\n') {
        let Some((key, value)) = raw.split_once(' ') else { continue };
        let fields: Vec<&str> = value.split(' ').collect();
        if key.bytes().all(|ch| ch.is_ascii_hexdigit())
            && fields.len() >= 2
            && let (Ok(original_line), Ok(line)) = (fields[0].parse(), fields[1].parse())
        {
            entry = Some(Entry {
                sha: key.into(),
                original_line,
                line,
                count: fields.get(2).and_then(|value| value.parse().ok()).unwrap_or(1),
                ..Entry::default()
            });
            continue;
        }
        let Some(e) = entry.as_mut() else { continue };
        match key {
            "author" => e.author.name = value.into(),
            "author-mail" => e.author.email = Some(email(value)),
            "author-time" => e.author.date = value.parse::<i64>().unwrap_or(0).saturating_mul(1000),
            "committer" => e.committer.name = value.into(),
            "committer-mail" => e.committer.email = Some(email(value)),
            "committer-time" => e.committer.date = value.parse::<i64>().unwrap_or(0).saturating_mul(1000),
            "summary" => e.summary = value.into(),
            "previous" => {
                if let Some((sha, path)) = value.split_once(' ') {
                    e.file.previous_sha = Some(sha.into());
                    e.file.original_path = Some(path.into());
                }
            }
            "filename" => {
                // A filename line without its header is malformed porcelain; GitLens throws here too.
                let mut e = entry.take()?;
                e.file.path = value.into();
                if e.file.original_path.as_deref() == Some(value) {
                    e.file.original_path = None;
                }
                if !result.commits.contains_key(&e.sha) {
                    if e.sha == "0000000000000000000000000000000000000000" {
                        e.author.name = user.and_then(|user| user.name.clone()).unwrap_or_default();
                        e.author.email = user.and_then(|user| user.email.clone());
                        e.author.current = true;
                        e.author.date = modified_time.unwrap_or(e.author.date);
                        e.committer = e.author.clone();
                    } else {
                        e.author.current = matches(user, &e.author);
                        e.committer.current = matches(user, &e.committer);
                    }
                    if !result.authors.iter().any(|(name, _)| name == &e.author.name) {
                        result.authors.push((
                            e.author.name.clone(),
                            Author { name: e.author.name.clone(), line_count: 0, current: e.author.current },
                        ));
                    }
                    result.commits.insert(
                        e.sha.clone(),
                        Commit {
                            sha: e.sha.clone(),
                            author: e.author,
                            committer: e.committer,
                            summary: e.summary,
                            file: e.file.clone(),
                            lines: vec![],
                        },
                    );
                }
                let commit = result.commits.get_mut(&e.sha)?;
                if !commit.author.name.is_empty()
                    && let Some((_, author)) = result.authors.iter_mut().find(|(name, _)| name == &commit.author.name)
                {
                    author.line_count += e.count;
                }
                for offset in 0..e.count {
                    let line = Line {
                        sha: e.sha.clone(),
                        previous_sha: e.file.previous_sha.clone().or_else(|| commit.file.previous_sha.clone()),
                        original_line: e.original_line + offset,
                        line: e.line + offset,
                    };
                    if line.line == 0 {
                        continue;
                    }
                    result.lines.resize(result.lines.len().max(line.line), None);
                    result.lines[line.line - 1] = Some(line.clone());
                    commit.lines.push(line);
                }
            }
            _ => {}
        }
    }
    result.authors.sort_by_key(|a| std::cmp::Reverse(a.1.line_count));
    Some(result)
}
