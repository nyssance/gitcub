//! Desktop status-parser.ts porcelain-v2 records; conformance reference only since status moved to gix (2026-10-27).
//!
//! Also the GitLens `statusParser.ts` line parsers (`parse_gitlens`, `fold_matching_ignored`), which the original
//! GitLens suite drives through the conformance bridge. GitLens splits `1`/`2`/`u` records positionally and never
//! validates the mode or hash fields (its fixtures use oids such as `prev1234`), while the Desktop regexes below
//! reject anything that is not hex, so the two shapes keep separate record splitting.
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum StatusItem {
    Header {
        value: String,
    },
    Entry {
        path: String,
        status_code: String,
        submodule_status_code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        old_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rename_or_copy_score: Option<u32>,
    },
}
static CHANGED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^1 ([MADRCUTX?!.]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([\s\S]*?)$")
        .unwrap()
});
static RENAMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^2 ([MADRCUTX?!.]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([RC]\d+) ([\s\S]*?)$").unwrap()
});
static UNMERGED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^u ([DAU]{2}) (N\.\.\.|S[C.][M.][U.]) (\d+) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([a-f0-9]+) ([\s\S]*?)$").unwrap()
});
static AHEAD_V1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ahead ([0-9]+)").unwrap());
static BEHIND_V1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"behind ([0-9]+)").unwrap());

pub fn parse(output: &[u8]) -> Result<Vec<StatusItem>, String> {
    let output = String::from_utf8_lossy(output);
    let mut records = output.split('\0');
    let mut entries = Vec::new();
    while let Some(field) = records.next() {
        if let Some(header) = field.strip_prefix("# ").filter(|s| !s.is_empty()) {
            entries.push(StatusItem::Header { value: header.to_owned() });
            continue;
        }
        let Some(kind) = field.as_bytes().first().copied() else { continue };
        if kind == b'?' {
            entries.push(StatusItem::Entry {
                path: field.get(2..).unwrap_or("").to_owned(),
                status_code: "??".into(),
                submodule_status_code: "????".into(),
                old_path: None,
                rename_or_copy_score: None,
            });
            continue;
        }
        let (pattern, path_index, description) = match kind {
            b'1' => (&*CHANGED, 8, "changed"),
            b'2' => (&*RENAMED, 9, "renamed or copied"),
            b'u' => (&*UNMERGED, 10, "unmerged"),
            _ => continue,
        };
        let captures =
            pattern.captures(field).ok_or_else(|| format!("Failed to parse status line for {description} entry"))?;
        let old_path = if kind == b'2' {
            Some(
                records
                    .next()
                    .filter(|value| !value.is_empty())
                    .ok_or("Failed to parse renamed or copied entry, could not parse old path")?
                    .to_owned(),
            )
        } else {
            None
        };
        entries.push(StatusItem::Entry {
            path: captures[path_index].to_owned(),
            status_code: captures[1].to_owned(),
            submodule_status_code: captures[2].to_owned(),
            old_path,
            rename_or_copy_score: if kind == b'2' { captures[8][1..].parse().ok() } else { None },
        });
    }
    Ok(entries)
}

/// GitLens `{ oid, previousOid }` read from the hash fields of a submodule record.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitLensSubmodule {
    pub oid: String,
    pub previous_oid: String,
}

/// The `GitStatusFile` constructor arguments GitLens derives from one status line: the raw `x`/`y` codes
/// (`.` and blanks already dropped), the path, the rename source and the submodule oids.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitLensStatusFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<String>,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submodule: Option<GitLensSubmodule>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitLensUpstreamState {
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitLensUpstream {
    pub name: String,
    pub missing: bool,
    pub state: GitLensUpstreamState,
}

/// GitLens `GitStatus` constructor arguments before the model normalizes the repo path and detached HEAD.
#[derive(Serialize, Debug, PartialEq)]
pub struct GitLensStatus {
    pub branch: String,
    pub sha: String,
    pub files: Vec<GitLensStatusFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<GitLensUpstream>,
}

/// GitLens `parseGitStatus` without its model layer. `Ok(None)` is its `undefined` for input without lines;
/// `Err` stands in for the `TypeError` it throws on a `##` header without a branch, a `branch.ab` header
/// without counts, or an `R`/`C` v1 line without ` -> `.
pub fn parse_gitlens(data: &str, porcelain_version: u32) -> Result<Option<GitLensStatus>, String> {
    let lines: Vec<&str> = data.split('\n').filter(|line| !line.is_empty()).collect();
    if lines.is_empty() {
        return Ok(None);
    }
    Ok(Some(if porcelain_version < 2 { parse_gitlens_v1(&lines)? } else { parse_gitlens_v2(&lines)? }))
}

fn parse_gitlens_v1(lines: &[&str]) -> Result<GitLensStatus, String> {
    let mut branch = None;
    let mut upstream = None;
    let mut missing = false;
    let mut state = GitLensUpstreamState { ahead: 0, behind: 0 };
    let mut files = Vec::new();
    for line in lines {
        if line.starts_with("##") {
            let mut parts = line.split(' ');
            parts.next();
            let names = parts.next().ok_or("Failed to parse status header: `##` without a branch")?;
            // JS `split('...')` keeps the first two pieces: `a...b...c` tracks `b`.
            let mut names = names.split("...");
            branch = names.next();
            upstream = names.next();
            let status: Vec<&str> = parts.collect();
            if !status.is_empty() {
                let status = status.join(" ");
                if status == "[gone]" {
                    missing = true;
                    state = GitLensUpstreamState { ahead: 0, behind: 0 };
                } else {
                    state = GitLensUpstreamState {
                        ahead: count_v1(&AHEAD_V1, &status),
                        behind: count_v1(&BEHIND_V1, &status),
                    };
                }
            }
            continue;
        }
        // `substring(0, 2)` / `substring(3)`: the code, the separating space, then the path.
        let raw: String = line.chars().take(2).collect();
        let file: String = line.chars().skip(3).collect();
        if raw.starts_with('R') || raw.starts_with('C') {
            let unquoted = file.replace('"', "");
            let (source, target) =
                unquoted.split_once(" -> ").ok_or("Failed to parse status line: rename without ` -> `")?;
            let target = target.split(" -> ").next().unwrap_or("");
            files.push(gitlens_file(&raw, target.trim(), Some(source.trim()), None));
        } else {
            files.push(gitlens_file(&raw, &file, None, None));
        }
    }
    Ok(GitLensStatus {
        branch: branch.unwrap_or("").to_owned(),
        sha: String::new(),
        files,
        upstream: gitlens_upstream(upstream, missing, state),
    })
}

fn count_v1(pattern: &Regex, status: &str) -> u64 {
    pattern.captures(status).and_then(|captures| captures[1].parse().ok()).unwrap_or(0)
}

fn parse_gitlens_v2(lines: &[&str]) -> Result<GitLensStatus, String> {
    let mut branch = None;
    let mut sha = None;
    let mut upstream = None;
    let mut missing = true;
    let mut state = GitLensUpstreamState { ahead: 0, behind: 0 };
    let mut files = Vec::new();
    for line in lines {
        if line.starts_with('#') {
            let parts: Vec<&str> = line.split(' ').collect();
            match parts.get(1).copied() {
                Some("branch.oid") => sha = parts.get(2).copied(),
                Some("branch.head") => branch = parts.get(2).copied(),
                Some("branch.upstream") => upstream = parts.get(2).copied(),
                Some("branch.ab") => {
                    missing = false;
                    let count = |index: usize| -> Result<u64, String> {
                        let part =
                            parts.get(index).ok_or("Failed to parse status header: `branch.ab` without counts")?;
                        Ok(part.get(1..).and_then(|digits| digits.parse().ok()).unwrap_or(0))
                    };
                    state = GitLensUpstreamState { ahead: count(2)?, behind: count(3)? };
                }
                _ => {}
            }
            continue;
        }
        let Some(kind) = line.as_bytes().first().copied() else { continue };
        let xy: String = line.chars().skip(2).take(2).collect();
        // `<sub>` starts at offset 5; `S` marks a submodule, `N` a regular path.
        let submodule = |previous: &str, current: &str| {
            (line.as_bytes().get(5) == Some(&b'S'))
                .then(|| GitLensSubmodule { oid: current.to_owned(), previous_oid: previous.to_owned() })
        };
        match kind {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            b'1' => {
                let Some(parts) = fields(line, 9) else { continue };
                files.push(gitlens_file(&xy, parts[8], None, submodule(parts[6], parts[7])));
            }
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
            b'2' => {
                let Some(parts) = fields(line, 10) else { continue };
                let (path, original) = match parts[9].split_once('\t') {
                    Some((path, original)) => (path, Some(original)),
                    None => (parts[9], None),
                };
                files.push(gitlens_file(&xy, path, original, submodule(parts[6], parts[7])));
            }
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            b'u' => {
                let Some(parts) = fields(line, 11) else { continue };
                files.push(gitlens_file(&xy, parts[10], None, submodule(parts[7], parts[9])));
            }
            b'?' => files.push(gitlens_file("??", &line.chars().skip(2).collect::<String>(), None, None)),
            _ => {}
        }
    }
    Ok(GitLensStatus {
        branch: branch.unwrap_or("").to_owned(),
        sha: sha.unwrap_or("").to_owned(),
        files,
        upstream: gitlens_upstream(upstream, missing, state),
    })
}

/// The first `count - 1` space-separated fields and the remainder (`indexAfterNthSpace`); `None` when the
/// line has fewer spaces, which GitLens skips.
fn fields(line: &str, count: usize) -> Option<Vec<&str>> {
    let parts: Vec<&str> = line.splitn(count, ' ').collect();
    (parts.len() == count).then_some(parts)
}

fn gitlens_file(
    raw: &str, path: &str, original_path: Option<&str>, submodule: Option<GitLensSubmodule>,
) -> GitLensStatusFile {
    // `.` means unchanged on that side; a blank is trimmed away. Either becomes `undefined`.
    let code = |code: Option<char>| code.filter(|code| *code != '.' && !code.is_whitespace()).map(String::from);
    let mut codes = raw.chars();
    GitLensStatusFile {
        x: code(codes.next()),
        y: code(codes.next()),
        path: path.to_owned(),
        original_path: original_path.map(str::to_owned),
        submodule,
    }
}

fn gitlens_upstream(name: Option<&str>, missing: bool, state: GitLensUpstreamState) -> Option<GitLensUpstream> {
    name.filter(|name| !name.is_empty()).map(|name| GitLensUpstream { name: name.to_owned(), missing, state })
}

/// GitLens `foldMatchingIgnored`: `status --ignored=matching --untracked-files=all` records of new untracked
/// folders folded into what `--ignored=traditional --untracked-files=normal` reports. A folder under a new
/// untracked folder that holds no untracked content is wholly ignored, so it stands in for the ignored paths
/// beneath it.
#[allow(dead_code)] // GitLens-only shape; the app never lists ignored paths, so only the upstream conformance bridge calls it.
pub fn fold_matching_ignored<'a>(records: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut dirty = HashSet::new();
    let mut ignored = Vec::new();
    for record in records {
        if record.chars().count() < 4 {
            continue;
        }
        if let Some(path) = record.strip_prefix("!! ") {
            ignored.push(path);
        } else if let Some(path) = record.strip_prefix("?? ") {
            for (index, _) in path.match_indices('/') {
                dirty.insert(&path[..=index]);
            }
        }
    }
    let mut entries: Vec<String> = Vec::new();
    for path in ignored {
        let mut entry = path;
        for (index, _) in path.match_indices('/') {
            if index + 1 >= path.len() {
                break;
            }
            let folder = &path[..=index];
            if !dirty.contains(folder) {
                entry = folder;
                break;
            }
        }
        if !entries.iter().any(|existing| existing == entry) {
            entries.push(entry.to_owned());
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(x: Option<&str>, y: Option<&str>, path: &str) -> GitLensStatusFile {
        GitLensStatusFile {
            x: x.map(str::to_owned),
            y: y.map(str::to_owned),
            path: path.to_owned(),
            original_path: None,
            submodule: None,
        }
    }

    #[test]
    fn gitlens_空输入与纯换行返回_none() {
        assert_eq!(parse_gitlens("", 1).unwrap(), None);
        assert_eq!(parse_gitlens("\n\n", 2).unwrap(), None);
    }

    #[test]
    fn gitlens_v1_表头给出上游与领先落后() {
        let status = parse_gitlens("## main...origin/main [ahead 2, behind 1]", 1).unwrap().unwrap();
        assert_eq!(status.branch, "main");
        assert_eq!(status.sha, "");
        let upstream = status.upstream.unwrap();
        assert_eq!(upstream.name, "origin/main");
        assert!(!upstream.missing);
        assert_eq!(upstream.state, GitLensUpstreamState { ahead: 2, behind: 1 });

        let gone = parse_gitlens("## main...origin/main [gone]", 1).unwrap().unwrap().upstream.unwrap();
        assert!(gone.missing);
        assert_eq!(gone.state, GitLensUpstreamState { ahead: 0, behind: 0 });

        let local = parse_gitlens("## feature-branch\nM  src/foo.ts", 1).unwrap().unwrap();
        assert_eq!(local.branch, "feature-branch");
        assert_eq!(local.upstream, None);
        assert_eq!(local.files, vec![file(Some("M"), None, "src/foo.ts")]);
    }

    #[test]
    fn gitlens_v1_文件行保留原始代码并给重命名去引号() {
        let status = parse_gitlens(" M src/foo.ts\n?? new.ts\nMT typed.ts\nR  \"old path.ts\" -> \"new path.ts\"", 1)
            .unwrap()
            .unwrap();
        assert_eq!(status.branch, "");
        assert_eq!(status.files[0], file(None, Some("M"), "src/foo.ts"));
        assert_eq!(status.files[1], file(Some("?"), Some("?"), "new.ts"));
        assert_eq!(status.files[2], file(Some("M"), Some("T"), "typed.ts"));
        assert_eq!(
            status.files[3],
            GitLensStatusFile { original_path: Some("old path.ts".into()), ..file(Some("R"), None, "new path.ts") }
        );
        assert!(parse_gitlens("R  lonely.ts", 1).is_err());
        assert!(parse_gitlens("##", 1).is_err());
    }

    #[test]
    fn gitlens_v2_表头与子模块_oid() {
        let data = "# branch.oid abc1234def5678\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n\
                    1 .M S.M. 160000 160000 160000 prev1234 curr5678 libs/sub mod\n\
                    u UU S... 160000 160000 160000 160000 base1111 ours2222 theirs3333 libs/sub";
        let status = parse_gitlens(data, 2).unwrap().unwrap();
        assert_eq!(status.sha, "abc1234def5678");
        assert_eq!(status.branch, "main");
        let upstream = status.upstream.unwrap();
        assert!(!upstream.missing);
        assert_eq!(upstream.state, GitLensUpstreamState { ahead: 2, behind: 1 });
        assert_eq!(
            status.files[0].submodule,
            Some(GitLensSubmodule { oid: "curr5678".into(), previous_oid: "prev1234".into() })
        );
        assert_eq!(status.files[0].path, "libs/sub mod");
        assert_eq!(
            status.files[1].submodule,
            Some(GitLensSubmodule { oid: "theirs3333".into(), previous_oid: "base1111".into() })
        );
        assert_eq!((status.files[1].x.as_deref(), status.files[1].y.as_deref()), (Some("U"), Some("U")));

        let missing = parse_gitlens("# branch.oid abc\n# branch.upstream origin/gone", 2).unwrap().unwrap();
        assert!(missing.upstream.unwrap().missing);
        assert!(parse_gitlens("# branch.ab", 2).is_err());
    }

    #[test]
    fn gitlens_v2_重命名按制表符拆出原路径_其余记录跳过或忽略() {
        let data = "2 R. N... 100644 100644 100644 abc1234 def5678 R100 new dir/new name.ts\told dir/old name.ts\n\
                    2 R. N... 100644 100644 100644 abc1234 def5678 R100 new name.ts\n\
                    1 .M N... 100644 100644\n\
                    ! ignored.ts\n\
                    ? nested-repo/";
        let status = parse_gitlens(data, 2).unwrap().unwrap();
        assert_eq!(status.branch, "");
        assert_eq!(status.sha, "");
        assert_eq!(status.upstream, None);
        assert_eq!(status.files.len(), 3);
        assert_eq!(status.files[0].path, "new dir/new name.ts");
        assert_eq!(status.files[0].original_path.as_deref(), Some("old dir/old name.ts"));
        assert_eq!(status.files[1].path, "new name.ts");
        assert_eq!(status.files[1].original_path, None);
        assert_eq!(status.files[1].submodule, None);
        assert_eq!(status.files[2], file(Some("?"), Some("?"), "nested-repo/"));
    }

    #[test]
    fn gitlens_v2_六十四位哈希与含空格路径() {
        let data = format!("1 M. N... 100644 100644 100644 {} {} src/a b.ts", "a".repeat(64), "b".repeat(64));
        let status = parse_gitlens(&data, 2).unwrap().unwrap();
        assert_eq!(status.files, vec![file(Some("M"), None, "src/a b.ts")]);
    }

    #[test]
    fn 折叠完全被忽略的目录() {
        assert_eq!(
            fold_matching_ignored(["?? newpkg/index.ts", "!! newpkg/logs/1.log", "!! newpkg/logs/2.log"]),
            vec!["newpkg/logs/"]
        );
        assert_eq!(
            fold_matching_ignored([
                "?? newpkg/mixed/keep.ts",
                "!! newpkg/mixed/m.log",
                "!! newpkg/mixed/node_modules/"
            ]),
            vec!["newpkg/mixed/m.log", "newpkg/mixed/node_modules/"]
        );
        assert_eq!(
            fold_matching_ignored([
                "?? newpkg/nested/inner/keep.ts",
                "!! newpkg/nested/inner/logs/x.log",
                "!! newpkg/nested/inner/logs/deep/y.log",
                "!! other/sub/a/b.log",
                "?? other/keep.ts"
            ]),
            vec!["newpkg/nested/inner/logs/", "other/sub/"]
        );
        assert_eq!(
            fold_matching_ignored(["?? newpkg/repo/", "!! newpkg/a.log", "!! newpkg/repo/x.log"]),
            vec!["newpkg/a.log", "newpkg/repo/x.log"]
        );
        assert_eq!(fold_matching_ignored(["", "!! ", "?? a/b.ts", "!! a/c/1.log", "!! a/c/2.log"]), vec!["a/c/"]);
    }

    #[test]
    fn desktop_解析保持_nul_记录与哈希校验() {
        let parsed =
            parse(b"# branch.head main\x001 .M N... 100644 100644 100644 abc1234 def5678 a.ts\x00? b.ts\x00").unwrap();
        assert_eq!(parsed.len(), 3);
        assert!(parse(b"1 .M N... 100644 100644 100644 prev1234 curr5678 a.ts\0").is_err());
    }
}
