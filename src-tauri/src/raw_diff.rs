//! 原始 diff 与补丁应用 —— 1:1 照搬 GitHub Desktop 的 git 调用。
//!
//! 来源：app/src/lib/git/diff.ts 的 `getWorkingDirectoryDiff`
//!      app/src/lib/git/apply.ts 的 `applyPatchToIndex`
//!
//! 和我原先 gix 直接改写 index blob 的做法相比，这条路是原版经年验证的：
//! 输出交给移植过来的 diff-parser 解析，行选择由 patch-formatter 生成补丁，
//! 再 `git apply --cached` 落盘。
//!
//! 注意语义差异：原版 diff 的基准是 **HEAD** 而不是 index——
//! 它把 index 完全藏在界面之后，由勾选状态决定什么进入提交。

use crate::git::Git;
use serde::Serialize;
use std::path::Path;

/// 文件在工作区里的状态，决定用哪套 diff 参数。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    /// 新增或未跟踪：走 --no-index 和 /dev/null 比
    New,
    /// 重命名：只给路径，不给 HEAD
    Renamed,
    /// 其余：和 HEAD 比
    Normal,
}

/// 行尾被 git 改写了。`core.autocrlf` 开着时，提交进去的内容和你本地看到的
/// 不是同一份——这件事只在 `git diff` 的 **stderr** 里说一句，不转述的话
/// 用户根本不知道。原版（parseLineEndingsWarning）也是从 stderr 里捞。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEndingsChange {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDiff {
    /// 原始 diff 文本，交给前端移植过来的解析器
    pub text: String,
    /// git 说它会改写行尾时才有值
    pub line_endings: Option<LineEndingsChange>,
}

/// 从 stderr 里认出那句行尾警告。git 的原话形如：
/// `warning: in the working copy of 'a.txt', LF will be replaced by CRLF the next time Git touches it`
fn parse_line_endings(stderr: &str) -> Option<LineEndingsChange> {
    let rest = stderr.split("', ").nth(1)?;
    let words: Vec<&str> = rest.split_whitespace().collect();
    // 形如 `LF will be replaced by CRLF the next time ...`：
    // 第一个词是原来的行尾，"by" 后面那个是换成的。不按固定位置数，
    // 是因为这句话在不同 git 版本里措辞有出入。
    let from = *words.first()?;
    let to = *words.iter().skip_while(|w| **w != "by").nth(1)?;
    let ok = |s: &str| matches!(s, "CRLF" | "CR" | "LF");
    (ok(from) && ok(to)).then(|| LineEndingsChange { from: from.to_string(), to: to.to_string() })
}

pub fn working_directory_diff(
    repo: &Path, file: &str, kind: FileKind, hide_whitespace: bool,
) -> Result<RawDiff, String> {
    // 进程内快速路径只在能证明与 git 逐字节一致时作答；其余（含 -w）都交给 git。
    #[cfg(unix)]
    if !hide_whitespace && let Ok(bytes) = in_process::working_directory_diff(repo, file, kind) {
        return Ok(RawDiff { text: String::from_utf8_lossy(&bytes).into_owned(), line_endings: None });
    }
    working_directory_diff_via_git(repo, file, kind, hide_whitespace)
}

pub fn working_directory_diff_via_git(
    repo: &Path, file: &str, kind: FileKind, hide_whitespace: bool,
) -> Result<RawDiff, String> {
    // 只读：`git diff HEAD` 会顺手刷新并回写索引，抢 index.lock 会让用户自己的 git 命令失败（status.rs 同一规则）
    let mut g = Git::new(Some(repo)).args(["--no-optional-locks", "diff"]);
    if hide_whitespace {
        g = g.arg("-w");
    }
    // --no-ext-diff：忽略用户配置的 diff.external，否则输出格式不可控
    g = g.args(["--no-ext-diff", "--patch-with-raw", "-z", "--no-color"]);
    g = match kind {
        FileKind::New => g.args(["--no-index", "--", "/dev/null", file]),
        FileKind::Renamed => g.args(["--", file]),
        FileKind::Normal => g.args(["HEAD", "--", file]),
    };

    let out = g.output()?;
    let code = out.status.code().unwrap_or(-1);
    // --no-index 会照 diff(1) 的约定用退出码 1 表示「有差异」，那不是错误
    let ok = code == 0 || (matches!(kind, FileKind::New) && code == 1);
    if !ok {
        return Err(crate::git::stderr_of(&out));
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok(RawDiff { text: String::from_utf8_lossy(&out.stdout).into_owned(), line_endings: parse_line_endings(&stderr) })
}

/// 把补丁应用到**工作区**。用于「只丢弃这几行」——补丁是反着的
/// （formatPatchToDiscardChanges 把选中的增行写成删、删行写成增），
/// 应用到工作区就等于把那几行的改动撤掉。参数照原版 discardChangesFromSelection。
pub fn apply_patch_to_worktree(repo: &Path, patch: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["apply", "--unidiff-zero", "--whitespace=nowarn", "-"]).stdin(patch).run()
}

/// 把补丁应用到 index。补丁由前端的 patch-formatter 生成（移植自原版）。
pub fn apply_patch_to_index(repo: &Path, patch: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"]).stdin(patch).run()
}

/// 把某个文件的暂存内容重置回 HEAD。
///
/// 部分暂存前要先清掉该文件在 index 里的旧状态，否则补丁会叠加在
/// 已暂存的内容上。对应原版 applyPatchToIndex 开头的 `reset`。
pub fn reset_file_in_index(repo: &Path, file: &str) -> Result<(), String> {
    // 不显式传 HEAD，Git 在新仓库也能重置。锁失败等错误必须传回调用者。
    Git::new(Some(repo)).args(["reset", "--", file]).run()
}

/// 某个文件在某次提交里的原始 diff 文本。
///
/// 照搬 GitHub Desktop 的 `getCommitDiff`（app/src/lib/git/diff.ts）：
///
/// ```text
/// git log <sha> [-w] -m -1 --first-parent --patch-with-raw \
///         --format= -z --no-color -- <path>
/// ```
///
/// `-m -1 --first-parent` 让合并提交也能和第一父比出内容。
/// Desktop `getCommitDiff`（app/src/lib/git/diff.ts）：重命名或复制时把旧路径一并作为 pathspec，
/// git 才能在这两个路径之间做重命名检测，否则只会看到一个新增文件。
pub fn commit_file_diff(
    repo: &Path, sha: &str, file: &str, old_path: Option<&str>, hide_whitespace: bool,
) -> Result<String, String> {
    #[cfg(unix)]
    if !hide_whitespace && let Ok(bytes) = in_process::commit_file_diff(repo, sha, file, old_path) {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    commit_file_diff_via_git(repo, sha, file, old_path, hide_whitespace)
}

pub fn commit_file_diff_via_git(
    repo: &Path, sha: &str, file: &str, old_path: Option<&str>, hide_whitespace: bool,
) -> Result<String, String> {
    let mut g = Git::new(Some(repo)).args(["log", sha]);
    if hide_whitespace {
        g = g.arg("-w");
    }
    g = g.args([
        "-m",
        "-1",
        "--no-show-signature",
        "--first-parent",
        "--patch-with-raw",
        "--format=",
        "-z",
        "--no-color",
        "--",
    ]);
    g.args(file_diff_pathspecs(file, old_path)).stdout()
}

/// 单个文件 diff 的 pathspec：新路径，重命名或复制时再加旧路径（GitLens `getFileDiffPathspecs`，
/// Desktop `getCommitDiff` 同样追加 `oldPath`）。空的旧路径不算——git 拒绝空 pathspec。
pub fn file_diff_pathspecs<'a>(file: &'a str, old_path: Option<&'a str>) -> Vec<&'a str> {
    std::iter::once(file).chain(old_path.filter(|path| !path.is_empty())).collect()
}

/// 某个文件在某次提交时的完整内容，供语法高亮用。
///
/// 根提交的父（`<sha>^`）不存在时 git 会报错，调用方按空内容处理。
pub fn file_at_commit(repo: &Path, sha: &str, file: &str) -> Result<String, String> {
    blob_contents(repo, sha, file).map(|data| String::from_utf8_lossy(&data).into_owned())
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum ResolutionTarget {
    Content { content: String },
    Stage { stage: crate::ops::Resolution },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionDiff {
    pub raw: String,
    pub old_contents: String,
    pub new_contents: String,
}

/// Desktop getResolutionDiff: preview against disk without changing the index.
pub fn resolution_diff(
    repo: &Path, file: &str, target: ResolutionTarget, hide_whitespace: bool,
) -> Result<ResolutionDiff, String> {
    use std::io::Write;
    let old_contents =
        String::from_utf8_lossy(&std::fs::read(repo.join(file)).map_err(|e| e.to_string())?).into_owned();
    let new_contents = match target {
        ResolutionTarget::Content { content } => content,
        ResolutionTarget::Stage { stage } => {
            let number = if stage == crate::ops::Resolution::Ours { 2 } else { 3 };
            #[cfg(unix)]
            let fast = in_process::index_stage_blob(repo, number, file).ok();
            #[cfg(not(unix))]
            let fast: Option<Vec<u8>> = None;
            match fast {
                Some(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                None => {
                    let output = Git::new(Some(repo)).args(["show", &format!(":{number}:{file}"), "--"]).output()?;
                    if output.status.success() {
                        String::from_utf8_lossy(&output.stdout).into_owned()
                    } else {
                        String::new()
                    }
                }
            }
        }
    };
    let mut base = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut target = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    base.write_all(old_contents.as_bytes()).map_err(|e| e.to_string())?;
    target.write_all(new_contents.as_bytes()).map_err(|e| e.to_string())?;
    let mut command = Git::new(Some(repo)).arg("diff");
    if hide_whitespace {
        command = command.arg("-w");
    }
    let output = command
        .args(["--no-ext-diff", "--patch-with-raw", "-z", "--no-color", "--no-index", "--"])
        .arg(base.path())
        .arg(target.path())
        .output()?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(ResolutionDiff { raw: String::from_utf8_lossy(&output.stdout).into_owned(), old_contents, new_contents })
}

fn blob_revision(repo: &Path, revision: &str) -> Result<String, String> {
    if revision.starts_with('-') { crate::history::resolve_revision(repo, revision) } else { Ok(revision.into()) }
}

pub fn blob_contents(repo: &Path, revision: &str, file: &str) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    if let Ok(bytes) = in_process::blob_contents(repo, revision, file) {
        return Ok(bytes);
    }
    let revision = blob_revision(repo, revision)?;
    let output = Git::new(Some(repo)).args(["show", &format!("{revision}:{file}")]).output()?;
    if matches!(output.status.code(), Some(0 | 1)) { Ok(output.stdout) } else { Err(crate::git::stderr_of(&output)) }
}

pub fn partial_blob_contents(
    repo: &Path, revision: &str, file: &str, length: usize,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(unix)]
    if let Ok(mut bytes) = in_process::blob_contents(repo, revision, file) {
        bytes.truncate(length);
        return Ok(Some(bytes));
    }
    // Verify first even when a zero-byte preview is requested.
    let revision = crate::history::resolve_revision(repo, revision)?;
    let (output, truncated) =
        Git::new(Some(repo)).args(["show", &format!("{revision}:{file}")]).output_prefix(length.max(1))?;
    if truncated || output.status.success() {
        return Ok(Some(output.stdout.into_iter().take(length).collect()));
    }
    let error = crate::git::stderr_of(&output);
    if error.contains("exists on disk, but not in") { Ok(None) } else { Err(error) }
}

pub fn merge_base_diff(
    repo: &Path, from: &str, to: &str, file: &str, old_path: Option<&str>, hide_whitespace: bool,
) -> Result<String, String> {
    let mut git = Git::new(Some(repo)).args([
        "--literal-pathspecs",
        "diff",
        "--merge-base",
        "--no-ext-diff",
        "--patch-with-raw",
        "-z",
        "--no-color",
    ]);
    if hide_whitespace {
        git = git.arg("-w");
    }
    git = git.args(["--end-of-options", from, to, "--", file]);
    if let Some(old_path) = old_path {
        git = git.arg(old_path);
    }
    git.stdout()
}

/// `git diff --no-ext-diff --patch-with-raw -z --no-color (HEAD -- <file> | --no-index -- /dev/null <file>)`
/// 的进程内实现（git v2.54.0 diff.c `builtin_diff`、`fill_metainfo`、`diff_flush_raw`，
/// diff-lib.c `show_modified`，read-cache.c `ie_match_stat`，xdiff 见 `crate::xdiff`）。
///
/// `Err` 只表示「这个文件或这个仓库不走快速路径」：只要有一项设置、属性或文件形状
/// 可能让 git 的输出不同，就让位给 git。宁可多起一次进程，也不能给出不同的字节——
/// 行选择补丁就是照这份文本拼出来的。
#[cfg(unix)]
pub(crate) mod in_process {
    use super::FileKind;
    use gix::bstr::{BStr, ByteSlice};
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    /// 超过这个大小交给 git（git 自己的 `core.bigFileThreshold` 默认 512 MiB 才当二进制）
    const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
    /// diff.c `buffer_is_binary` 只看前 8000 字节里有没有 NUL
    const FIRST_FEW_BYTES: usize = 8000;
    /// 会改变内容转换、二进制判定或 diff 驱动的属性；`binary` 是 `-diff -merge -text` 的宏
    const RELEVANT_ATTRIBUTES: [&str; 8] =
        ["text", "crlf", "eol", "filter", "ident", "working-tree-encoding", "diff", "binary"];
    /// git 会读、且会改变输出或比较语义的环境变量
    pub(crate) const RELEVANT_ENV: [&str; 9] = [
        "GIT_DIFF_OPTS",
        "GIT_PRINT_SHA1_ELLIPSIS",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_LITERAL_PATHSPECS",
        "GIT_GLOB_PATHSPECS",
        "GIT_NOGLOB_PATHSPECS",
        "GIT_ICASE_PATHSPECS",
    ];

    type Fallback = String;

    /// gix 读到的配置。用打包的 git 时它读的是 `GIT_CONFIG_SYSTEM` 指向的那份系统配置，
    /// gix 看到的本机系统配置要排除掉，换成那份文件。
    pub(crate) struct Config<'r> {
        snapshot: gix::config::Snapshot<'r>,
        bundled: Option<gix::config::File>,
    }

    impl Config<'_> {
        fn keep(&self) -> impl FnMut(&gix::config::file::Metadata) -> bool + use<> {
            let bundled = self.bundled.is_some();
            move |meta| {
                !(bundled && matches!(meta.source, gix::config::Source::System | gix::config::Source::GitInstallation))
            }
        }

        pub(crate) fn string(&self, key: &str) -> Option<gix::bstr::BString> {
            self.snapshot
                .plumbing()
                .string_filter(key, self.keep())
                .or_else(|| self.bundled.as_ref().and_then(|file| file.string(key)))
        }

        /// 布尔值；写成 git 不认的形式时让位
        pub(crate) fn boolean(&self, key: &str) -> Result<Option<bool>, Fallback> {
            let value = match self.snapshot.plumbing().boolean_filter(key, self.keep()) {
                Ok(None) => self.bundled.as_ref().map_or(Ok(None), |file| file.boolean(key)),
                other => other,
            };
            value.map_err(|_| format!("{key} 不是布尔值"))
        }

        pub(crate) fn present(&self, key: &str) -> bool {
            self.string(key).is_some() || !matches!(self.boolean(key), Ok(None))
        }
    }

    fn check_config(config: &Config) -> Result<(), Fallback> {
        // 出现即让位：改算法、上下文、前缀、行尾或二进制阈值
        for key in [
            "diff.algorithm",
            "diff.context",
            "diff.interHunkContext",
            "diff.srcPrefix",
            "diff.dstPrefix",
            "core.eol",
            "core.bigFileThreshold",
            "core.checkStat",
        ] {
            if config.present(key) {
                return Err(key.into());
            }
        }
        // 只接受 git 的默认值
        for (key, default) in [
            ("diff.noprefix", false),
            ("diff.mnemonicPrefix", false),
            ("diff.relative", false),
            ("diff.suppressBlankEmpty", false),
            ("diff.indentHeuristic", true),
            ("diff.autoRefreshIndex", true),
            ("core.autocrlf", false),
            ("core.fsmonitor", false),
            ("core.trustctime", true),
            ("core.filemode", true),
        ] {
            if config.present(key) && config.boolean(key)? != Some(default) {
                return Err(key.into());
            }
        }
        Ok(())
    }

    /// 路径必须正好是一个规范的仓库相对路径，不能被 git 当成 glob 或 pathspec 魔法。
    pub(crate) fn check_path(file: &str) -> Result<(), Fallback> {
        let plain = !file.is_empty()
            && !file.starts_with(':')
            && !file.bytes().any(|b| matches!(b, b'*' | b'?' | b'[' | b'\\' | 0))
            && file.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
        if plain { Ok(()) } else { Err(format!("pathspec {file:?}")) }
    }

    /// quote.c `cq_lookup`：1 = 八进制，可见字符 = 反斜杠加这个字符，-1 = 原样，0 = 看 core.quotePath
    fn cq_lookup(c: u8) -> i16 {
        match c {
            0x07 => b'a' as i16,
            0x08 => b'b' as i16,
            0x09 => b't' as i16,
            0x0a => b'n' as i16,
            0x0b => b'v' as i16,
            0x0c => b'f' as i16,
            0x0d => b'r' as i16,
            0x00..=0x1f | 0x7f => 1,
            b'"' => b'"' as i16,
            b'\\' => b'\\' as i16,
            0x20..=0x7e => -1,
            _ => 0,
        }
    }

    /// diff.c `quote_two`（`quote_c_style(…, CQUOTE_NODQ)` 两段拼接，需要时整体加引号）
    pub(crate) fn quote_two(prefix: &str, name: &[u8], fully: bool) -> Vec<u8> {
        let must_quote = |c: u8| cq_lookup(c) + fully as i16 > 0;
        let mut out = Vec::new();
        if !prefix.bytes().chain(name.iter().copied()).any(must_quote) {
            out.extend_from_slice(prefix.as_bytes());
            out.extend_from_slice(name);
            return out;
        }
        out.push(b'"');
        for c in prefix.bytes().chain(name.iter().copied()) {
            if !must_quote(c) {
                out.push(c);
                continue;
            }
            out.push(b'\\');
            let lookup = cq_lookup(c);
            if lookup >= b' ' as i16 {
                out.push(lookup as u8);
            } else {
                out.extend_from_slice(&[b'0' + ((c >> 6) & 3), b'0' + ((c >> 3) & 7), b'0' + (c & 7)]);
            }
        }
        out.push(b'"');
        out
    }

    /// `repo_find_unique_abbrev(oid, DEFAULT_ABBREV)`：从自动长度起，只要还有别的对象
    /// 共享这个前缀就加长（odb.c `odb_find_abbrev_len`，对象不在库里时同样适用）。
    pub(crate) fn abbrev(repo: &gix::Repository, oid: &gix::ObjectId, min_len: usize) -> Result<String, Fallback> {
        let hexsz = oid.kind().len_in_hex();
        let mut len = min_len;
        while len < hexsz {
            let prefix = gix::hash::Prefix::new(oid, len).map_err(|e| e.to_string())?;
            match repo.objects.lookup_prefix(prefix, None).map_err(|e| e.to_string())? {
                None => break,
                Some(Ok(found)) if found == *oid => break,
                Some(_) => len += 1,
            }
        }
        let hex = oid.to_hex().to_string();
        Ok(hex[..len.min(hexsz)].to_string())
    }

    fn mode_from_metadata(metadata: &std::fs::Metadata) -> u32 {
        if metadata.mode() & 0o100 != 0 { 0o100755 } else { 0o100644 }
    }

    fn read_regular(path: &Path) -> Result<(std::fs::Metadata, Vec<u8>), Fallback> {
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() {
            return Err("不是普通文件".into());
        }
        if metadata.len() > MAX_FILE_SIZE {
            return Err("文件太大".into());
        }
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        // 读的过程中被改了：让 git 自己去读
        if data.len() as u64 != metadata.len() {
            return Err("读取时文件在变".into());
        }
        Ok((metadata, data))
    }

    fn is_binary(data: &[u8]) -> bool {
        data[..data.len().min(FIRST_FEW_BYTES)].contains(&0)
    }

    /// read-cache.c `ie_match_stat`（diff-index 不带 `--cached`，非 skip-worktree、非
    /// assume-unchanged、非 ita）。git 编译时是否带 `USE_NSEC` / `USE_STDEV` 看不出来，
    /// 四种组合都算一遍，结论不一致就让位。返回 `true` 表示 git 认为工作区「脏」。
    fn stat_dirty(
        entry: &gix::index::Entry, metadata: &std::fs::Metadata, timestamp: gix::index::entry::stat::Time,
        content_matches_index: bool,
    ) -> Result<bool, Fallback> {
        let sd = &entry.stat;
        let empty_blob = gix::ObjectId::empty_blob(entry.id.kind());
        let base = (entry.mode.bits() ^ metadata.mode()) & 0o100 != 0
            || sd.mtime.secs != metadata.mtime() as u32
            || sd.ctime.secs != metadata.ctime() as u32
            || sd.uid != metadata.uid()
            || sd.gid != metadata.gid()
            || sd.ino != metadata.ino() as u32
            || sd.size != metadata.size() as u32
            || (sd.size == 0 && entry.id != empty_blob);
        let nsec = sd.mtime.nsecs != metadata.mtime_nsec() as u32 || sd.ctime.nsecs != metadata.ctime_nsec() as u32;
        let dev = sd.dev != metadata.dev() as u32;
        let verdict = |use_nsec: bool, use_stdev: bool| {
            if base || (use_nsec && nsec) || (use_stdev && dev) {
                return true;
            }
            let racy = timestamp.secs != 0
                && if use_nsec {
                    timestamp.secs < sd.mtime.secs
                        || (timestamp.secs == sd.mtime.secs && timestamp.nsecs <= sd.mtime.nsecs)
                } else {
                    timestamp.secs <= sd.mtime.secs
                };
            racy && !content_matches_index
        };
        let first = verdict(false, false);
        if [verdict(true, false), verdict(false, true), verdict(true, true)].iter().any(|v| *v != first) {
            return Err("stat 结论取决于 git 的编译选项".into());
        }
        Ok(first)
    }

    /// 这个路径上生效的属性（每个属性取优先级最高的那条），和 `git check-attr -a` 读的来源相同：
    /// 工作区 `.gitattributes`（缺失时读索引里的）、`info/attributes`、`core.attributesFile`。
    /// 非空的系统级属性文件让位。
    fn attribute_matches(
        repo: &gix::Repository, index: &gix::index::State, file: &str,
    ) -> Result<Vec<(String, gix::attrs::State)>, Fallback> {
        let system = crate::lfs::system_attributes().ok_or("GIT_ATTR_SYSTEM 未知")?;
        match std::fs::read(&system) {
            Ok(content) if content.iter().any(|b| !b.is_ascii_whitespace()) => {
                return Err("系统级 gitattributes".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut stack = repo
            .attributes_only(index, gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping)
            .map_err(|e| e.to_string())?;
        let mut outcome = stack.attribute_matches();
        let platform =
            stack.at_entry(BStr::new(file), Some(gix::index::entry::Mode::FILE)).map_err(|e| e.to_string())?;
        platform.matching_attributes(&mut outcome);
        Ok(outcome.iter().map(|m| (m.assignment.name.as_str().to_string(), m.assignment.state.to_owned())).collect())
    }

    /// 给一批路径复用同一个属性栈的 `check_attributes`（重命名检测要对每个算相似度的路径检查）。
    /// 裸仓库、稀疏索引、非空的系统级属性文件让位。
    pub(crate) fn attribute_checker<'r>(
        repo: &'r gix::Repository,
    ) -> Result<crate::rename::AttributeCheck<'r>, Fallback> {
        let mut list = attribute_lister(repo)?;
        Ok(Box::new(move |path: &BStr| {
            if let Some((name, _)) =
                list(path)?.into_iter().find(|(name, _)| RELEVANT_ATTRIBUTES.contains(&name.as_str()))
            {
                return Err(format!("属性 {name}"));
            }
            Ok(())
        }))
    }

    /// 一个路径上生效的属性（每个属性取优先级最高的那条，宏已展开），一批路径复用同一个属性栈。
    /// 让位条件同 [`attribute_checker`]。
    pub(crate) type AttributeList<'r> =
        Box<dyn FnMut(&BStr) -> Result<Vec<(String, gix::attrs::State)>, Fallback> + 'r>;

    pub(crate) fn attribute_lister<'r>(repo: &'r gix::Repository) -> Result<AttributeList<'r>, Fallback> {
        let system = crate::lfs::system_attributes().ok_or("GIT_ATTR_SYSTEM 未知")?;
        match std::fs::read(&system) {
            Ok(content) if content.iter().any(|b| !b.is_ascii_whitespace()) => {
                return Err("系统级 gitattributes".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        repo.workdir().ok_or("裸仓库")?;
        let index = repo.open_index().map_err(|e| e.to_string())?;
        if index.is_sparse() {
            return Err("稀疏索引".into());
        }
        let mut stack = repo
            .attributes_only(&index, gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping)
            .map_err(|e| e.to_string())?;
        Ok(Box::new(move |path: &BStr| {
            let mut outcome = stack.attribute_matches();
            let platform = stack.at_entry(path, Some(gix::index::entry::Mode::FILE)).map_err(|e| e.to_string())?;
            platform.matching_attributes(&mut outcome);
            Ok(outcome
                .iter()
                .map(|m| (m.assignment.name.as_str().to_string(), m.assignment.state.to_owned()))
                .collect())
        }))
    }

    /// 重命名检测会读的设置：`diff.renameLimit`（超限判断）、`GIT_BASENAME_FACTOR`（文件名配对门槛），
    /// 以及可能借 `-c` 改配置的环境变量。出现即让位。
    pub(crate) fn check_rename_settings(repo: &gix::Repository) -> Result<(), Fallback> {
        if let Some(key) =
            RELEVANT_ENV.iter().chain(&["GIT_BASENAME_FACTOR"]).find(|key| std::env::var_os(key).is_some())
        {
            return Err((*key).into());
        }
        if config(repo)?.present("diff.renameLimit") {
            return Err("diff.renameLimit".into());
        }
        Ok(())
    }

    /// `--numstat` 与完整 raw 输出还会受这些影响：xdiff 的算法与选项（`check_config`）、
    /// `diff.orderFile` 改变队列顺序，以及 `--raw` 对象名的 `GIT_PRINT_SHA1_ELLIPSIS`。
    pub(crate) fn check_numstat_settings(repo: &gix::Repository) -> Result<(), Fallback> {
        if let Some(key) = RELEVANT_ENV.iter().find(|key| std::env::var_os(key).is_some()) {
            return Err((*key).into());
        }
        let config = config(repo)?;
        check_config(&config)?;
        if config.present("diff.orderFile") {
            return Err("diff.orderFile".into());
        }
        Ok(())
    }

    fn check_attributes(repo: &gix::Repository, index: &gix::index::State, file: &str) -> Result<(), Fallback> {
        if let Some((name, _)) = attribute_matches(repo, index, file)?
            .into_iter()
            .find(|(name, _)| RELEVANT_ATTRIBUTES.contains(&name.as_str()))
        {
            return Err(format!("属性 {name}"));
        }
        Ok(())
    }

    /// 只读打开：对象库只扫一次 pack 目录；路径在子目录里时交给 git
    /// （`git -C <子目录>` 的 pathspec 和输出路径都相对子目录）。
    pub(crate) fn open(repo_path: &Path) -> Result<gix::Repository, Fallback> {
        let mut repo = gix::open(repo_path).map_err(|e| e.to_string())?;
        repo.object_cache_size_if_unset(4 * 1024 * 1024);
        repo.objects.refresh_never();
        let workdir = repo.workdir().ok_or("裸仓库")?;
        if std::fs::canonicalize(workdir).ok() != std::fs::canonicalize(repo_path).ok() {
            return Err("不在工作区根目录".into());
        }
        Ok(repo)
    }

    pub(crate) fn config(repo: &gix::Repository) -> Result<Config<'_>, Fallback> {
        let bundled = match crate::git::bundled_system_config() {
            Some(path) => Some(bundled_system_file(path)?),
            None => None,
        };
        Ok(Config { snapshot: repo.config_snapshot(), bundled })
    }

    /// 打包 git 的系统配置（dugite 的 etc/gitconfig 开头就是 `[include] path=/etc/gitconfig`）照 git 的 include 语义展开：
    /// 被包含的文件按位置插进去，后面的同名键覆盖它；被包含的文件不存在时 git 静默跳过（config.c `handle_path_include`）。
    /// 只认开头连续的无条件 include、绝对路径、被包含的文件里不再有 include；其余形状让位。
    pub(crate) fn bundled_system_file(path: std::path::PathBuf) -> Result<gix::config::File, Fallback> {
        use gix::config::{File, Source};
        let include = |name: &BStr| name.eq_ignore_ascii_case(b"include") || name.eq_ignore_ascii_case(b"includeIf");
        let file = File::from_path_no_includes(path, Source::System).map_err(|e| e.to_string())?;
        let sections: Vec<_> = file
            .sections()
            .map(|s| (s.header().name().to_owned(), s.header().subsection_name().is_some(), s.values("path")))
            .collect();
        let leading =
            sections.iter().take_while(|(name, sub, _)| name.eq_ignore_ascii_case(b"include") && !sub).count();
        if sections[leading..].iter().any(|(name, ..)| include(name.as_bstr())) {
            return Err("打包的系统配置里 include 不在开头或带条件".into());
        }
        if leading == 0 {
            return Ok(file);
        }
        let mut merged = File::new(gix::config::file::Metadata::from(Source::System));
        for target in sections[..leading].iter().flat_map(|(.., paths)| paths) {
            let target = std::path::PathBuf::from(target.to_str().map_err(|_| "include 路径不是 UTF-8")?);
            if !target.is_absolute() {
                return Err("include 路径不是绝对路径".into());
            }
            if !target.exists() {
                continue;
            }
            let inner = File::from_path_no_includes(target, Source::System).map_err(|e| e.to_string())?;
            if inner.sections().any(|s| include(s.header().name())) {
                return Err("被包含的系统配置还有 include".into());
            }
            merged.append(inner).map_err(|e| e.to_string())?;
        }
        // include 段本身也留着：`git config --get include.path` 照样读得到
        merged.append(file).map_err(|e| e.to_string())?;
        Ok(merged)
    }

    struct Header<'a> {
        status: u8,
        mode_one: u32,
        mode_two: u32,
        raw_one: String,
        raw_two: String,
        index_one: String,
        index_two: String,
        path: &'a [u8],
        fully: bool,
        /// 重命名（状态 `R`）：来源路径和 diffcore-rename 的分数，模式两边相同
        rename: Option<(&'a [u8], u64)>,
    }

    /// 任一侧是二进制时 diff.c `builtin_diff` 的输出：补丁头之后只有一行
    /// `Binary files <lbl0> and <lbl1> differ`，标签照 `quote_two`、无效的一侧是 `/dev/null`，
    /// 没有 `---`/`+++` 行，也不补 TAB。两侧内容相同的情形调用方先排除（git 只输出头部或什么都不输出）。
    /// 重命名不走这里（相似度要按二进制算，调用方让位）。
    fn assemble_binary(header: Header) -> Vec<u8> {
        debug_assert!(header.rename.is_none());
        let label = |prefix: &str, valid: bool| {
            if valid { quote_two(prefix, header.path, header.fully) } else { b"/dev/null".to_vec() }
        };
        let (one, two) = (label("a/", header.status != b'A'), label("b/", header.status != b'D'));
        let mut out = assemble(header, b"");
        out.extend_from_slice(b"Binary files ");
        out.extend_from_slice(&one);
        out.extend_from_slice(b" and ");
        out.extend_from_slice(&two);
        out.extend_from_slice(b" differ\n");
        out
    }

    /// raw 记录 + 分隔符 + 补丁头 + xdiff 正文
    fn assemble(header: Header, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(body.len() + 256);
        out.extend_from_slice(
            format!(
                ":{:06o} {:06o} {} {} {}",
                header.mode_one, header.mode_two, header.raw_one, header.raw_two, header.status as char
            )
            .as_bytes(),
        );
        // diff_flush_raw：带分数时 `%c%03d`，重命名先写来源路径
        let one_path = match header.rename {
            Some((old_path, score)) => {
                out.extend_from_slice(format!("{:03}", crate::rename::similarity_index(score)).as_bytes());
                out.push(0);
                out.extend_from_slice(old_path);
                old_path
            }
            None => header.path,
        };
        out.push(0);
        out.extend_from_slice(header.path);
        out.push(0);
        // --patch-with-raw 在 raw 与 patch 之间的 DIFF_SYMBOL_SEPARATOR（-z 时是 NUL）
        out.push(0);
        let a = quote_two("a/", one_path, header.fully);
        let b = quote_two("b/", header.path, header.fully);
        out.extend_from_slice(b"diff --git ");
        out.extend_from_slice(&a);
        out.push(b' ');
        out.extend_from_slice(&b);
        out.push(b'\n');
        match header.status {
            b'A' => out.extend_from_slice(format!("new file mode {:06o}\n", header.mode_two).as_bytes()),
            b'D' => out.extend_from_slice(format!("deleted file mode {:06o}\n", header.mode_one).as_bytes()),
            _ => {}
        }
        // fill_metainfo：重命名的相似度与两个路径（`quote_c_style`，不带前缀），对象相同时没有 index 行
        if let Some((old_path, score)) = header.rename {
            out.extend_from_slice(format!("similarity index {}%\n", crate::rename::similarity_index(score)).as_bytes());
            out.extend_from_slice(b"rename from ");
            out.extend_from_slice(&quote_two("", old_path, header.fully));
            out.extend_from_slice(b"\nrename to ");
            out.extend_from_slice(&quote_two("", header.path, header.fully));
            out.push(b'\n');
        }
        if header.rename.is_none() || header.index_one != header.index_two {
            out.extend_from_slice(format!("index {}..{}", header.index_one, header.index_two).as_bytes());
            if header.mode_one == header.mode_two {
                out.extend_from_slice(format!(" {:06o}", header.mode_one).as_bytes());
            }
            out.push(b'\n');
        }
        if !body.is_empty() {
            // DIFF_SYMBOL_FILEPAIR_MINUS / PLUS：标签里有空格时行尾补一个 TAB
            let label = |out: &mut Vec<u8>, sign: &[u8], line: &[u8]| {
                out.extend_from_slice(sign);
                out.extend_from_slice(line);
                if line.contains(&b' ') {
                    out.push(b'\t');
                }
                out.push(b'\n');
            };
            let (one, two): (&[u8], &[u8]) = match header.status {
                b'A' => (b"/dev/null", &b),
                b'D' => (&a, b"/dev/null"),
                _ => (&a, &b),
            };
            label(&mut out, b"--- ", one);
            label(&mut out, b"+++ ", two);
            out.extend_from_slice(body);
        }
        out
    }

    /// HEAD 或提交树里的普通文件条目：`None` 表示不存在；目录、符号链接、子模块让位
    fn tree_blob(tree: &gix::Tree, file: &str) -> Result<Option<(u32, gix::ObjectId)>, Fallback> {
        let Some(entry) = tree.lookup_entry_by_path(file).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let mode = match entry.mode().kind() {
            gix::object::tree::EntryKind::Blob => 0o100644,
            gix::object::tree::EntryKind::BlobExecutable => 0o100755,
            _ => return Err("树里不是普通文件".into()),
        };
        Ok(Some((mode, entry.object_id())))
    }

    /// 读 blob：太大时让位
    fn blob_data(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>, Fallback> {
        let header = repo.find_header(id).map_err(|e| e.to_string())?;
        if header.size() > MAX_FILE_SIZE {
            return Err("文件太大".into());
        }
        Ok(repo.find_object(id).map_err(|e| e.to_string())?.detach().data)
    }

    /// 读 blob：太大或二进制时让位
    fn text_blob(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>, Fallback> {
        let data = blob_data(repo, id)?;
        if is_binary(&data) {
            return Err("二进制".into());
        }
        Ok(data)
    }

    /// Desktop `getCommitDiff`：`git log <sha> -m -1 --no-show-signature --first-parent --patch-with-raw
    /// --format= -z --no-color -- <file> [<oldPath>]`，不带 `-w`。
    ///
    /// 和第一父（根提交为空树）比较这一个路径；这个提交没改它时 git 会往前找改过它的提交，交给 git。
    /// pathspec 只有一个路径时 diffcore_rename 找不到配对；
    /// 带旧路径且旧路径在这次提交里也变了（可能被识别成重命名或复制）时让位。log 的 diff 同样从工作区读
    /// gitattributes、同样默认允许 textconv，所以属性与配置检查和工作区 diff 相同；另外 `diff.external`
    /// 会被 `git log -p` 使用，出现即让位。任一侧前 8000 字节有 NUL 时照 `builtin_diff` 输出
    /// `Binary files … differ`（二进制的重命名让位）。模式变化、符号链接、子模块、目录、超过 16 MiB 都交给 git。
    pub fn commit_file_diff(
        repo_path: &Path, sha: &str, file: &str, old_path: Option<&str>,
    ) -> Result<Vec<u8>, Fallback> {
        if let Some(key) = RELEVANT_ENV.iter().chain(&["GIT_EXTERNAL_DIFF"]).find(|key| std::env::var_os(key).is_some())
        {
            return Err((*key).into());
        }
        check_path(file)?;
        let old_path = old_path.filter(|path| !path.is_empty() && *path != file);
        if let Some(old_path) = old_path {
            check_path(old_path)?;
        }
        let (repo, old_tree, new_tree) = crate::history::commit_trees_in_process(repo_path, sha, true)?;
        let workdir = repo.workdir().ok_or("裸仓库")?;
        if std::fs::canonicalize(workdir).ok() != std::fs::canonicalize(repo_path).ok() {
            return Err("不在工作区根目录".into());
        }
        let config = config(&repo)?;
        check_config(&config)?;
        if config.present("diff.external") {
            return Err("diff.external".into());
        }
        let fully = config.boolean("core.quotePath")?.unwrap_or(true);
        for path in std::iter::once(file).chain(old_path) {
            if !path.is_ascii()
                && config.boolean("core.precomposeUnicode")?.unwrap_or(false)
                && (gix::utils::str::precompose(path.into()) != path || path.chars().any(|c| c > '\u{ffff}'))
            {
                return Err("路径需要 precompose".into());
            }
        }
        let min_len = crate::history::abbreviation_length(&repo)?;
        let index = repo.open_index().map_err(|e| e.to_string())?;
        if index.is_sparse() {
            return Err("稀疏索引".into());
        }
        let old_tree = match old_tree {
            Some(id) => repo.find_tree(id).map_err(|e| e.to_string())?,
            None => repo.empty_tree(),
        };
        let new_tree = repo.find_tree(new_tree).map_err(|e| e.to_string())?;
        let (one, two) = (tree_blob(&old_tree, file)?, tree_blob(&new_tree, file)?);
        let mut source = None;
        if let Some(old_path) = old_path {
            let (old_one, old_two) = (tree_blob(&old_tree, old_path)?, tree_blob(&new_tree, old_path)?);
            if old_one != old_two {
                // pathspec 只留下这两个路径：旧路径被删、新路径是新增时 diffcore-rename 是一对一
                match (old_one, old_two, one, two) {
                    (Some(src), None, None, Some(_)) => source = Some((old_path, src)),
                    _ => return Err("旧路径也有变化，不是一删一增".into()),
                }
            }
        }
        if one == two {
            // 这个提交没改这个路径：带 pathspec 的 `git log -1` 会顺着第一父往前找最近一次改它的提交
            return Err("提交没有改这个路径".into());
        }
        check_attributes(&repo, &index, file)?;
        if let Some((old_path, (mode_one, id_one))) = source {
            // `git log -p` 的重命名检测来自 diff.renames（默认 rename），出现即让位；GIT_BASENAME_FACTOR、
            // diff.renameLimit 对一对一的结果没有影响，照样让位以免依赖这个推理
            check_rename_settings(&repo)?;
            if config.present("diff.renames") {
                return Err("diff.renames".into());
            }
            check_attributes(&repo, &index, old_path)?;
            let (mode_two, id_two) = two.expect("新增");
            if mode_one != mode_two {
                return Err("模式变化".into());
            }
            let (old, new) = (text_blob(&repo, id_one)?, text_blob(&repo, id_two)?);
            // find_exact_renames 给满分；否则文件名阶段（同名时门槛更高）和矩阵在一对一时结论相同：
            // 分数只取决于这一对，过了 50% 就配上
            let score = if id_one == id_two {
                crate::rename::MAX_SCORE
            } else {
                crate::rename::text_similarity(&old, &new, crate::rename::DEFAULT_RENAME_SCORE)
            };
            if score < crate::rename::DEFAULT_RENAME_SCORE {
                return Err("没有配成重命名，git 会分别输出删除和新增".into());
            }
            let (abbrev_one, abbrev_two) = (abbrev(&repo, &id_one, min_len)?, abbrev(&repo, &id_two, min_len)?);
            let body = crate::xdiff::unified_diff(&old, &new);
            let header = Header {
                status: b'R',
                mode_one,
                mode_two,
                raw_one: abbrev_one.clone(),
                raw_two: abbrev_two.clone(),
                index_one: abbrev_one,
                index_two: abbrev_two,
                path: file.as_bytes(),
                fully,
                rename: Some((old_path.as_bytes(), score)),
            };
            return Ok(assemble(header, &body));
        }
        let null = gix::ObjectId::null(repo.object_hash());
        let (status, (mode_one, id_one), (mode_two, id_two)) = match (one, two) {
            (None, Some(two)) => (b'A', (0, null), two),
            (Some(one), None) => (b'D', one, (0, null)),
            (Some(one), Some(two)) if one.0 == two.0 => (b'M', one, two),
            _ => return Err("模式变化".into()),
        };
        let old = if id_one.is_null() { Vec::new() } else { blob_data(&repo, id_one)? };
        let new = if id_two.is_null() { Vec::new() } else { blob_data(&repo, id_two)? };
        let (abbrev_one, abbrev_two) = (abbrev(&repo, &id_one, min_len)?, abbrev(&repo, &id_two, min_len)?);
        // 对象不同（上面 one != two 且模式相同）所以内容不同，不会落到 git 的「内容相同只输出头部」
        let binary = is_binary(&old) || is_binary(&new);
        let body = if binary { Vec::new() } else { crate::xdiff::unified_diff(&old, &new) };
        let header = Header {
            status,
            mode_one,
            mode_two,
            raw_one: abbrev_one.clone(),
            raw_two: abbrev_two.clone(),
            index_one: abbrev_one,
            index_two: abbrev_two,
            path: file.as_bytes(),
            fully,
            rename: None,
        };
        Ok(if binary { assemble_binary(header) } else { assemble(header, &body) })
    }

    /// `git show <rev>:<file>` 的进程内实现：`rev` 只能是完整对象名或 `HEAD`，可带一个 `^`（第一父）。
    ///
    /// `git show` 输出 blob 时只有命令行给了 `--textconv` 才做转换（builtin/log.c `show_blob_object`），
    /// 不做 textconv、不做行尾或 filter 转换，输出就是 blob 的原始字节，所以这里不看属性和配置。
    /// 路径不存在、是目录或子模块、对象缺失（部分克隆要懒加载）以及 `commit_trees_in_process` 让位的情形
    /// （浅克隆、移植、替换对象）都交给 git，由它给出原样的错误和退出码。
    pub fn blob_contents(repo_path: &Path, revision: &str, file: &str) -> Result<Vec<u8>, Fallback> {
        check_path(file)?;
        let (commit, parent) = match revision.strip_suffix('^') {
            Some(commit) => (commit, true),
            None => (revision, false),
        };
        let (repo, old_tree, new_tree) = crate::history::commit_trees_in_process(repo_path, commit, false)?;
        let tree = if parent { old_tree.ok_or("根提交没有父提交")? } else { new_tree };
        let tree = repo.find_tree(tree).map_err(|e| e.to_string())?;
        let entry = tree.lookup_entry_by_path(file).map_err(|e| e.to_string())?.ok_or("路径不存在")?;
        if !entry.mode().is_blob_or_symlink() {
            return Err("不是 blob".into());
        }
        let object = repo.find_object(entry.object_id()).map_err(|e| e.to_string())?;
        if object.kind != gix::object::Kind::Blob {
            return Err("不是 blob".into());
        }
        Ok(object.detach().data)
    }

    /// `git show :<stage>:<file>`：索引里这个阶段的 blob 原样输出（和 `git show <rev>:<file>` 一样不做转换）。
    /// 没有这个阶段、不是普通文件或符号链接、替换对象都交给 git。
    pub fn index_stage_blob(repo_path: &Path, stage: u8, file: &str) -> Result<Vec<u8>, Fallback> {
        check_path(file)?;
        let repo = open(repo_path)?;
        let references = repo.references().map_err(|e| e.to_string())?;
        if references.prefixed("refs/replace/").map_err(|e| e.to_string())?.next().is_some() {
            return Err("refs/replace".into());
        }
        let index = repo.open_index().map_err(|e| e.to_string())?;
        if index.is_sparse() {
            return Err("稀疏索引".into());
        }
        let entries = index.entry_range(BStr::new(file)).map(|range| &index.entries()[range]).unwrap_or_default();
        let entry = entries.iter().find(|entry| entry.stage_raw() == u32::from(stage)).ok_or("没有这个阶段")?;
        if !matches!(
            entry.mode,
            gix::index::entry::Mode::FILE | gix::index::entry::Mode::FILE_EXECUTABLE | gix::index::entry::Mode::SYMLINK
        ) {
            return Err("不是普通文件".into());
        }
        let object = repo.find_object(entry.id).map_err(|e| e.to_string())?;
        if object.kind != gix::object::Kind::Blob {
            return Err("不是 blob".into());
        }
        Ok(object.detach().data)
    }

    /// 冲突文件的两项细节，只对冲突路径作答（`status::conflicts` 只用到这些路径）：
    ///
    /// - `binary`：Desktop `getBinaryPaths` 认为是二进制的冲突文件——`git diff --numstat -z <rev>` 给出 `-\t-\t`
    ///   的，加上 `git check-attr merge` 为 `binary` 的；
    /// - `markers`：Desktop `getFilesWithConflictMarkers` 的 `git diff --check` 报的「leftover conflict marker」条数。
    ///
    /// diff-index（不带 `--cached`）对冲突路径比较 `<rev>` 树里的 blob 和工作区文件，内容相同就被
    /// skip_stat_unmatch 丢掉；numstat 只要任一侧是二进制（前 8000 字节有 NUL）就记为 `-\t-\t`。
    /// diff-files 对冲突路径只比较 stage 2 与工作区（`diff_unmerged_stage` 默认 2，`--check` 不走 combined
    /// diff），没有 stage 2 就只有一条 unmerged 记录、不检查。builtin_checkdiff 只看新的一侧是不是二进制，
    /// 对 xdiff 的每条 `+` 行调用 `is_conflict_marker`（标记长 7，结尾的不完整行被补上换行）。
    /// 组的上下滑动只在相同的行之间移动，`+` 行的多重集合不变，所以缩进启发开不开都不影响条数。
    ///
    /// `<rev>` 树里没有这个路径（工作区是新增，可能和别的删除配成重命名）、工作区缺这个文件（同理是删除）、
    /// 模式变化、符号链接或子模块、`.gitattributes` 自身冲突、会改变转换或驱动的属性和 `conflict-marker-size`、
    /// `attr.tree`、`GIT_ATTR_SOURCE`、超过 16 MiB，以及工作区 diff 那一套配置检查都让位给 git。
    pub fn conflict_details(
        repo_path: &Path, revision: &str, paths: &[String],
    ) -> Result<(std::collections::HashSet<String>, std::collections::BTreeMap<String, u32>), Fallback> {
        if let Some(key) = RELEVANT_ENV
            .iter()
            .chain(&["GIT_ATTR_SOURCE", "GIT_EXTERNAL_DIFF"])
            .find(|key| std::env::var_os(key).is_some())
        {
            return Err((*key).into());
        }
        for path in paths {
            check_path(path)?;
            if path.contains('\n') || path == ".gitattributes" || path.ends_with("/.gitattributes") {
                return Err(format!("路径 {path:?}"));
            }
        }
        let probe = open(repo_path)?;
        let commit = match revision {
            "HEAD" => "HEAD".to_string(),
            "MERGE_HEAD" | "REBASE_HEAD" => {
                // refs.c 读伪引用文件：开头一个完整对象名，后面是空白或文件结束（MERGE_HEAD 可能有多行）
                let content = std::fs::read(probe.git_dir().join(revision)).map_err(|e| e.to_string())?;
                let hex = probe.object_hash().len_in_hex();
                if content.len() < hex
                    || !content[..hex].iter().all(u8::is_ascii_hexdigit)
                    || content.get(hex).is_some_and(|b| !b.is_ascii_whitespace())
                {
                    return Err(format!("{revision} 不是对象名"));
                }
                String::from_utf8_lossy(&content[..hex]).to_ascii_lowercase()
            }
            _ => return Err("修订号".into()),
        };
        drop(probe);
        let (repo, _, tree) = crate::history::commit_trees_in_process(repo_path, &commit, false)?;
        let workdir = repo.workdir().ok_or("裸仓库")?.to_path_buf();
        if std::fs::canonicalize(&workdir).ok() != std::fs::canonicalize(repo_path).ok() {
            return Err("不在工作区根目录".into());
        }
        let config = config(&repo)?;
        check_config(&config)?;
        if config.present("attr.tree") {
            return Err("attr.tree".into());
        }
        for path in paths {
            if !path.is_ascii()
                && config.boolean("core.precomposeUnicode")?.unwrap_or(false)
                && (gix::utils::str::precompose(path.as_str().into()) != path.as_str()
                    || path.chars().any(|c| c > '\u{ffff}'))
            {
                return Err("路径需要 precompose".into());
            }
        }
        let index = repo.open_index().map_err(|e| e.to_string())?;
        if index.is_sparse() {
            return Err("稀疏索引".into());
        }
        let tree = repo.find_tree(tree).map_err(|e| e.to_string())?;
        let mut binary = std::collections::HashSet::new();
        let mut markers = std::collections::BTreeMap::new();
        for path in paths {
            let attributes = attribute_matches(&repo, &index, path)?;
            if let Some((name, _)) = attributes
                .iter()
                .find(|(name, _)| RELEVANT_ATTRIBUTES.contains(&name.as_str()) || name == "conflict-marker-size")
            {
                return Err(format!("属性 {name}"));
            }
            let merge_binary = attributes.iter().any(|(name, state)| {
                name == "merge"
                    && matches!(state, gix::attrs::State::Value(value) if value.as_ref().as_bstr() == "binary")
            });

            let mut dir_prefix = path.as_bytes().to_vec();
            dir_prefix.push(b'/');
            if index.prefixed_entries(dir_prefix.as_bstr()).is_some_and(|entries| !entries.is_empty()) {
                return Err("索引里有同名目录".into());
            }
            let entries = index.entry_range(BStr::new(path)).map(|range| &index.entries()[range]).unwrap_or_default();
            if entries.is_empty() || entries.iter().all(|entry| entry.stage_raw() == 0) {
                return Err("不是冲突路径".into());
            }
            use gix::index::entry::Flags;
            let special = Flags::ASSUME_VALID | Flags::SKIP_WORKTREE | Flags::INTENT_TO_ADD | Flags::FSMONITOR_VALID;
            if entries.iter().any(|entry| {
                entry.flags.intersects(special)
                    || !matches!(entry.mode, gix::index::entry::Mode::FILE | gix::index::entry::Mode::FILE_EXECUTABLE)
            }) {
                return Err("索引条目带特殊标志或不是普通文件".into());
            }
            let mut dir = workdir.clone();
            let parts: Vec<&str> = path.split('/').collect();
            for part in &parts[..parts.len() - 1] {
                dir.push(part);
                match std::fs::symlink_metadata(&dir) {
                    Ok(metadata) if metadata.file_type().is_dir() => {}
                    _ => return Err("上级目录不是普通目录".into()),
                }
            }
            let (metadata, worktree) = read_regular(&workdir.join(path))?;
            // 冲突条目的 stat 是合并时写的；要是和工作区对上了，git 会拿索引里的对象当工作区内容
            if entries.iter().any(|entry| {
                entry.stat.mtime.secs == metadata.mtime() as u32 && entry.stat.size == metadata.size() as u32
            }) {
                return Err("冲突条目的 stat 与工作区一致".into());
            }
            let worktree_mode = mode_from_metadata(&metadata);

            // `git diff --numstat <rev>`：<rev> 树里的 blob 对工作区文件
            let (rev_mode, rev_id) = tree_blob(&tree, path)?.ok_or("修订号里没有这个路径")?;
            if rev_mode != worktree_mode {
                return Err("模式变化".into());
            }
            let rev_blob = repo.find_object(rev_id).map_err(|e| e.to_string())?.detach().data;
            if rev_blob.len() as u64 > MAX_FILE_SIZE {
                return Err("文件太大".into());
            }
            if merge_binary || (rev_blob != worktree && (is_binary(&rev_blob) || is_binary(&worktree))) {
                binary.insert(path.clone());
            }

            // `git diff --check`：stage 2 对工作区
            let Some(ours) = entries.iter().find(|entry| entry.stage_raw() == 2) else {
                continue;
            };
            if is_binary(&worktree) {
                continue;
            }
            let ours = repo.find_object(ours.id).map_err(|e| e.to_string())?.detach().data;
            if ours.len() as u64 > MAX_FILE_SIZE {
                return Err("文件太大".into());
            }
            let count = crate::xdiff::unified_diff(&ours, &worktree)
                .split_inclusive(|b| *b == b'\n')
                .filter(|line| line.first() == Some(&b'+') && is_conflict_marker(&line[1..], 7))
                .count();
            if count > 0 {
                markers.insert(path.clone(), count as u32);
            }
        }
        Ok((binary, markers))
    }

    /// diff.c `is_conflict_marker`；`line` 带着换行（不完整的末行在 xdiff 输出里也被补了换行）
    fn is_conflict_marker(line: &[u8], marker_size: usize) -> bool {
        line.len() > marker_size
            && matches!(line[0], b'=' | b'>' | b'<' | b'|')
            && line[1..marker_size].iter().all(|b| *b == line[0])
            && matches!(line[marker_size], b' ' | b'\t' | b'\n' | b'\r')
    }

    /// Desktop `getWorkingDirectoryDiff`（app/src/lib/git/diff.ts）：新增或未跟踪文件是
    /// `git diff --no-ext-diff --patch-with-raw -z --no-color --no-index -- /dev/null <file>`，其余是
    /// `… HEAD -- <file>`。冲突文件也走后者：app-store.ts `updateChangesWorkingDirectoryDiff` 对选中的文件
    /// 不分是否冲突，`AppFileStatusKind.Conflicted` 落在 `else` 分支。
    ///
    /// diff-index HEAD（builtin/diff.c `builtin_diff_index` → diff-lib.c `run_diff_index`）不带 `--cached`，
    /// 也没有 `-c`/`--cc`，冲突路径不走 combined diff：unpack_trees 把这个路径阶段最小的索引条目当作 idx
    /// （`find_cache_entry`，其余阶段 `mark_ce_used_same_name`），`do_oneway_diff` 交给 `show_modified`
    /// （HEAD 里有）或 `show_new_file`（HEAD 里没有）；`get_stat_data` 拿这个条目的 stat 对工作区做
    /// `ie_match_stat`（preload 跳过有阶段的条目，所以它从来不是 uptodate），脏了就比工作区内容、raw 第二个
    /// 对象全零，干净时比这个条目的对象。和普通条目相比，区别只在拿哪个条目比 stat。条目带 CE_VALID 或
    /// skip-worktree 时 git 改走 `diff_unmerge`，让位。
    pub fn working_directory_diff(repo_path: &Path, file: &str, kind: FileKind) -> Result<Vec<u8>, Fallback> {
        if matches!(kind, FileKind::Renamed) {
            return Err("重命名".into());
        }
        if let Some(key) = RELEVANT_ENV.iter().find(|key| std::env::var_os(key).is_some()) {
            return Err((*key).into());
        }
        check_path(file)?;
        let repo = open(repo_path)?;
        let workdir = repo.workdir().ok_or("裸仓库")?.to_path_buf();
        let config = config(&repo)?;
        check_config(&config)?;
        let fully = config.boolean("core.quotePath")?.unwrap_or(true);
        if !file.is_ascii()
            && config.boolean("core.precomposeUnicode")?.unwrap_or(false)
            && (gix::utils::str::precompose(file.into()) != file || file.chars().any(|c| c > '\u{ffff}'))
        {
            return Err("路径需要 precompose".into());
        }
        let index = repo.open_index().map_err(|e| e.to_string())?;
        if index.is_sparse() {
            return Err("稀疏索引".into());
        }
        let min_len = crate::history::abbreviation_length(&repo)?;
        check_attributes(&repo, &index, file)?;
        let hash = repo.object_hash();
        let null = gix::ObjectId::null(hash);
        let null_abbrev = abbrev(&repo, &null, min_len)?;
        let path = workdir.join(file);

        if matches!(kind, FileKind::New) {
            let (metadata, data) = read_regular(&path)?;
            let id = gix::objs::compute_hash(hash, gix::objs::Kind::Blob, &data).map_err(|e| e.to_string())?;
            let header = Header {
                status: b'A',
                mode_one: 0,
                mode_two: mode_from_metadata(&metadata),
                raw_one: null_abbrev.clone(),
                raw_two: null_abbrev.clone(),
                index_one: null_abbrev,
                index_two: abbrev(&repo, &id, min_len)?,
                path: file.as_bytes(),
                fully,
                rename: None,
            };
            if is_binary(&data) {
                return Ok(assemble_binary(header));
            }
            return Ok(assemble(header, &crate::xdiff::unified_diff(&[], &data)));
        }

        // diff-index HEAD：基准是 HEAD 树里的 blob，不是 index
        let tree = repo.head_tree().map_err(|e| e.to_string())?;
        let head = tree_blob(&tree, file)?;
        // pathspec 也会匹配 `file/` 下的条目（blob 在索引里变成目录时）
        let mut dir_prefix = file.as_bytes().to_vec();
        dir_prefix.push(b'/');
        if index.prefixed_entries(dir_prefix.as_bstr()).is_some_and(|entries| !entries.is_empty()) {
            return Err("索引里有同名目录".into());
        }
        // 索引按（路径，阶段）排序：冲突路径的第一个条目就是 unpack_trees 交给 diff 的那个
        let entries = index.entry_range(BStr::new(file)).map(|range| &index.entries()[range]).unwrap_or_default();
        if entries.len() > 1 && entries.iter().any(|entry| entry.stage_raw() == 0) {
            return Err("同一路径既有阶段 0 又有冲突阶段".into());
        }
        use gix::index::entry::Flags;
        let special = Flags::ASSUME_VALID | Flags::SKIP_WORKTREE | Flags::INTENT_TO_ADD | Flags::FSMONITOR_VALID;
        if entries.iter().any(|entry| {
            entry.flags.intersects(special)
                || !matches!(entry.mode, gix::index::entry::Mode::FILE | gix::index::entry::Mode::FILE_EXECUTABLE)
        }) {
            return Err("索引条目带特殊标志".into());
        }
        let entry = entries.first();
        // 路径上的任何一级是符号链接时 git 认为文件不存在（`has_symlink_leading_path`）
        let mut dir = workdir.clone();
        let parts: Vec<&str> = file.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            dir.push(part);
            match std::fs::symlink_metadata(&dir) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                _ => return Err("上级目录不是普通目录".into()),
            }
        }
        let deleted = |head_mode: u32, head_id: gix::ObjectId| -> Result<Vec<u8>, Fallback> {
            let old = blob_data(&repo, head_id)?;
            let head_abbrev = abbrev(&repo, &head_id, min_len)?;
            let header = Header {
                status: b'D',
                mode_one: head_mode,
                mode_two: 0,
                raw_one: head_abbrev.clone(),
                raw_two: null_abbrev.clone(),
                index_one: head_abbrev,
                index_two: null_abbrev.clone(),
                path: file.as_bytes(),
                fully,
                rename: None,
            };
            if is_binary(&old) {
                return Ok(assemble_binary(header));
            }
            Ok(assemble(header, &crate::xdiff::unified_diff(&old, &[])))
        };
        let missing = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(error.to_string()),
            Ok(_) => false,
        };
        let Some(entry) = entry else {
            // 索引里没有：HEAD 里有就是 `diff_index_show_file("-")`（不看工作区），也没有就什么都不匹配
            return match head {
                Some((head_mode, head_id)) => deleted(head_mode, head_id),
                None => Ok(Vec::new()),
            };
        };
        if missing {
            // get_stat_data 的 check_removed：show_modified 报删除，show_new_file 什么都不输出
            return match head {
                Some((head_mode, head_id)) => deleted(head_mode, head_id),
                None => Ok(Vec::new()),
            };
        }
        let (metadata, data) = read_regular(&path)?;
        let worktree_mode = mode_from_metadata(&metadata);
        if head.is_some_and(|(head_mode, _)| head_mode != worktree_mode) {
            return Err("模式变化".into());
        }
        let worktree_id = gix::objs::compute_hash(hash, gix::objs::Kind::Blob, &data).map_err(|e| e.to_string())?;
        if head.is_some_and(|(_, head_id)| head_id == worktree_id && entry.id == worktree_id) {
            // 工作区、条目与 HEAD 三者相同：stat 干净时 diff-index 不会排进队列，stat 脏时
            // diffcore_skip_stat_unmatch 把它丢掉，不论 stat 结论如何输出都为空
            return Ok(Vec::new());
        }
        let timestamp = index.timestamp();
        let timestamp = gix::index::entry::stat::Time {
            secs: timestamp.unix_seconds().try_into().map_err(|_| "索引时间戳越界")?,
            nsecs: timestamp.nanoseconds(),
        };
        let dirty = stat_dirty(entry, &metadata, timestamp, worktree_id == entry.id)?;
        if !dirty && worktree_id != entry.id {
            // git 会认为工作区与索引一致，展示的是索引里的内容
            return Err("stat 与内容不符".into());
        }
        // 干净时 git 用条目的对象与模式；它与工作区内容相同，模式的执行位 ie_match_stat 也比过
        let raw_two = if dirty { null_abbrev.clone() } else { abbrev(&repo, &entry.id, min_len)? };
        let index_two = abbrev(&repo, &worktree_id, min_len)?;
        let Some((head_mode, head_id)) = head else {
            // show_new_file：HEAD 里没有，和空的一侧比
            let header = Header {
                status: b'A',
                mode_one: 0,
                mode_two: worktree_mode,
                raw_one: null_abbrev.clone(),
                raw_two,
                index_one: null_abbrev,
                index_two,
                path: file.as_bytes(),
                fully,
                rename: None,
            };
            if is_binary(&data) {
                return Ok(assemble_binary(header));
            }
            return Ok(assemble(header, &crate::xdiff::unified_diff(&[], &data)));
        };
        if worktree_id == head_id {
            // 内容与 HEAD 相同：stat 干净时 diff-index 不会排进队列，
            // stat 脏时 diffcore_skip_stat_unmatch 把它丢掉，输出都为空
            return Ok(Vec::new());
        }
        let old = blob_data(&repo, head_id)?;
        let head_abbrev = abbrev(&repo, &head_id, min_len)?;
        let header = Header {
            status: b'M',
            mode_one: head_mode,
            mode_two: worktree_mode,
            raw_one: head_abbrev.clone(),
            raw_two,
            index_one: head_abbrev,
            index_two,
            path: file.as_bytes(),
            fully,
            rename: None,
        };
        if is_binary(&old) || is_binary(&data) {
            return Ok(assemble_binary(header));
        }
        Ok(assemble(header, &crate::xdiff::unified_diff(&old, &data)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得出_git_的行尾警告() {
        let w = "warning: in the working copy of 'a.txt', LF will be replaced by CRLF the next time Git touches it\n";
        let c = parse_line_endings(w).expect("应认出来");
        assert_eq!(c.from, "LF");
        assert_eq!(c.to, "CRLF");

        assert!(parse_line_endings("").is_none());
        assert!(parse_line_endings("fatal: 什么别的错").is_none());
    }

    /// 打包 git 的系统配置展开 include 后，每个键的取值与 `GIT_CONFIG_SYSTEM=<文件> git config --system --includes` 相同
    /// （git 命令读系统配置时总是展开 include；`git config` 指定了作用域时要显式加 `--includes`）
    #[cfg(unix)]
    #[test]
    fn 打包的系统配置按_git_的语义展开_include() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, text).unwrap();
            path
        };
        let included =
            write("etc-gitconfig", "[core]\n\tquotePath = false\n\tautocrlf = input\n[diff]\n\tnoprefix = true\n");
        let missing = dir.path().join("missing");
        let git_value = |system: &std::path::Path, key: &str| {
            let out = std::process::Command::new("git")
                .args(["config", "--system", "--includes", "--get", key])
                .env("GIT_CONFIG_SYSTEM", system)
                .env_remove("GIT_CONFIG_NOSYSTEM")
                .output()
                .unwrap();
            out.status.success().then(|| String::from_utf8(out.stdout).unwrap().trim_end().to_string())
        };
        let ours = |file: &gix::config::File, key: &str| file.string(key).map(|v| v.to_string());
        // dugite 的形状：开头 include 本机系统配置，后面自己的段覆盖它
        for target in [&included, &missing] {
            let bundled = write(
                "bundled",
                &format!(
                    "[include]\n  path={}\n\n[core]\n\tautocrlf = false\n[credential \"https://dev.azure.com\"]\n  useHttpPath = true\n",
                    target.display()
                ),
            );
            let file = in_process::bundled_system_file(bundled.clone()).unwrap();
            for key in [
                "core.quotePath",
                "core.autocrlf",
                "diff.noprefix",
                "credential.https://dev.azure.com.useHttpPath",
                "include.path",
            ] {
                assert_eq!(ours(&file, key), git_value(&bundled, key), "{key} via {}", target.display());
            }
        }
        // 只认开头的无条件、绝对路径、不再嵌套的 include
        for text in [
            "[core]\n\tautocrlf = false\n[include]\n\tpath = /etc/gitconfig\n".to_string(),
            "[includeIf \"gitdir:/x/\"]\n\tpath = /etc/gitconfig\n".to_string(),
            "[include]\n\tpath = relative\n".to_string(),
            format!(
                "[include]\n\tpath = {}\n",
                write("nested", &format!("[include]\n\tpath = {}\n", included.display())).display()
            ),
        ] {
            assert!(in_process::bundled_system_file(write("bundled", &text)).is_err(), "{text}");
        }
    }

    /// 工作区 diff 的进程内快速路径对照 git 本身：同一个仓库、同一个文件，
    /// 字节必须完全相同；快速路径让位（`Err`）的形状单独断言。
    #[cfg(unix)]
    mod working_diff_differential {
        use super::super::{FileKind, in_process};
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        use std::process::Command;

        fn git(repo: &Path, args: &[&str]) -> Vec<u8> {
            let out = Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        }

        /// Desktop `getWorkingDirectoryDiff` 的参数，和 `working_directory_diff_via_git` 相同
        fn git_diff(repo: &Path, file: &str, kind: FileKind) -> Vec<u8> {
            let mut args = vec!["diff", "--no-ext-diff", "--patch-with-raw", "-z", "--no-color"];
            match kind {
                FileKind::New => args.extend(["--no-index", "--", "/dev/null", file]),
                _ => args.extend(["HEAD", "--", file]),
            }
            let out = Command::new("git").arg("-C").arg(repo).args(&args).output().unwrap();
            assert!(matches!(out.status.code(), Some(0 | 1)), "{file}: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        }

        fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
            let d = tempfile::tempdir().unwrap();
            let r = d.path().join("repo");
            std::fs::create_dir_all(&r).unwrap();
            git(&r, &["init", "-q", "-b", "main", "."]);
            git(&r, &["config", "user.email", "t@t.t"]);
            git(&r, &["config", "user.name", "t"]);
            // commit 之后 git 会在后台自动维护（失败现场出现了新 pack 和 multi-pack-index），快速路径读对象
            // 恰好撞上重新打包时会让位给 git；差分测试要确定地走快速路径，关掉自动维护
            git(&r, &["config", "maintenance.auto", "false"]);
            git(&r, &["config", "gc.auto", "0"]);
            (d, r)
        }

        fn write(repo: &Path, file: &str, data: &[u8]) {
            let path = repo.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, data).unwrap();
        }

        /// 对照一个文件；返回快速路径是否作答
        fn check(repo: &Path, file: &str, kind: FileKind) -> Result<(), String> {
            let expected = git_diff(repo, file, kind);
            let fast = in_process::working_directory_diff(repo, file, kind)?;
            assert!(
                fast == expected,
                "{file}: 与 git 不同\n--- 进程内\n{}\n--- git\n{}",
                String::from_utf8_lossy(&fast).replace('\0', "\\0"),
                String::from_utf8_lossy(&expected).replace('\0', "\\0"),
            );
            Ok(())
        }

        fn numbered(range: std::ops::RangeInclusive<usize>) -> String {
            range.map(|i| format!("line {i}\n")).collect()
        }

        fn replace_line(text: &str, n: usize, with: &str) -> String {
            text.lines()
                .enumerate()
                .map(|(i, l)| if i + 1 == n { format!("{with}\n") } else { format!("{l}\n") })
                .collect()
        }

        const C_OLD: &str =
            "#include <stdio.h>\n\nint first(void)\n{\n\treturn 1;\n}\n\nint third(void)\n{\n\treturn 3;\n}\n";
        const C_NEW: &str = "#include <stdio.h>\n\nint first(void)\n{\n\treturn 1;\n}\n\nint second(void)\n{\n\treturn 2;\n}\n\nint third(void)\n{\n\treturn 3;\n}\n";
        const PY_OLD: &str = "def a():\n    if x:\n        return 1\n    return 0\n\n\ndef c():\n    return 3\n";
        const PY_NEW: &str = "def a():\n    if x:\n        return 1\n    return 0\n\n\ndef b():\n    if y:\n        return 2\n    return 0\n\n\ndef c():\n    return 3\n";

        /// (路径, HEAD 内容, 工作区内容)
        fn modified_shapes() -> Vec<(String, Vec<u8>, Vec<u8>)> {
            let base = numbered(1..=30);
            let mut shapes: Vec<(&str, String, String)> = vec![
                ("edit-start.txt", base.clone(), replace_line(&base, 1, "first")),
                ("edit-middle.txt", base.clone(), replace_line(&base, 15, "middle")),
                ("edit-end.txt", base.clone(), replace_line(&base, 30, "last")),
                ("append.txt", base.clone(), format!("{base}line 31\n")),
                ("prepend.txt", base.clone(), format!("line 0\n{base}")),
                ("merge-6.txt", base.clone(), replace_line(&replace_line(&base, 5, "x"), 12, "y")),
                ("split-7.txt", base.clone(), replace_line(&replace_line(&base, 5, "x"), 13, "y")),
                ("split-8.txt", base.clone(), replace_line(&replace_line(&base, 5, "x"), 14, "y")),
                ("delete-block.txt", base.clone(), format!("{}{}", numbered(1..=10), numbered(21..=30))),
                (
                    "insert-block.txt",
                    base.clone(),
                    format!("{}new a\nnew b\nnew c\n{}", numbered(1..=10), numbered(11..=30)),
                ),
                ("no-eol-old.txt", base.trim_end().to_string(), base.clone()),
                ("no-eol-new.txt", base.clone(), base.trim_end().to_string()),
                ("no-eol-both.txt", base.trim_end().to_string(), format!("{}changed", numbered(1..=29))),
                (
                    "no-eol-context.txt",
                    base.trim_end().to_string(),
                    replace_line(&base, 27, "near end").trim_end().to_string(),
                ),
                ("crlf.txt", base.replace('\n', "\r\n"), replace_line(&base, 9, "crlf edit").replace('\n', "\r\n")),
                ("crlf-mixed.txt", base.replace('\n', "\r\n"), replace_line(&base, 9, "lf now")),
                ("unicode.txt", "你好\n世界\n😀 emoji\nçà\n".into(), "你好\n地球\n😀 emoji\nçà\n".into()),
                ("empty-old.txt", String::new(), base.clone()),
                ("empty-new.txt", base.clone(), String::new()),
                ("one-line.txt", "a\n".into(), "b\n".into()),
                ("whitespace.txt", "a\nb\nc\n".into(), "a\nb \nc\n".into()),
                ("blank-only.txt", "\n\n\n".into(), "\n\n\n\n".into()),
                ("c-indent.c", C_OLD.into(), C_NEW.into()),
                ("py-indent.py", PY_OLD.into(), PY_NEW.into()),
                ("dir/sub/file name.txt", base.clone(), replace_line(&base, 3, "spaced path")),
                ("中文 路径.txt", base.clone(), replace_line(&base, 3, "unicode path")),
                ("quote\"d.txt", base.clone(), replace_line(&base, 3, "quoted path")),
                ("tab\tname.txt", base.clone(), replace_line(&base, 3, "tab path")),
                ("dollar$name.txt", base.clone(), replace_line(&base, 3, "dollar path")),
            ];
            // 函数名：超过 80 字节截断、截在 UTF-8 中间、尾部空白、`$` 与 `_` 开头、跨块沿用
            let long = format!("int very_long_function_name_{}(void)\n", "x".repeat(90));
            let cjk = format!("func {}()\n", "函数名".repeat(30));
            // U+FFFF 在 git 的 UTF-8 校验里不合法（Rust 认为合法）：hunk 头截在它前面
            let nonchar = format!("noncharacter_{}\u{ffff}tail()\n", "y".repeat(40));
            let indented: String = (1..=12).map(|i| format!("    body {i}\n")).collect();
            let mut body = String::new();
            for header in
                [long.as_str(), "_private()   \t\n", "$var = 1\n", cjk.as_str(), nonchar.as_str(), "\tindented()\n"]
            {
                body.push_str(header);
                body.push_str(&indented);
            }
            let edited = body.replace("    body 8\n", "    body eight\n");
            shapes.push(("funcnames.txt", body.clone(), edited));
            let mut far = String::from("top_function()\n");
            far.push_str(&numbered(1..=60));
            shapes.push(("funcname-reuse.txt", far.clone(), replace_line(&replace_line(&far, 20, "a"), 50, "b")));
            // 大量重复行（空行、右括号）：xdl_cleanup_records 的 INVESTIGATE 分支
            let mut braces = String::new();
            for i in 0..80 {
                braces.push_str(&format!("fn f{i}() {{\n    body {}\n}}\n\n", i % 7));
            }
            let braces_new = braces.replace("body 3\n", "body three\n}\n\n").replace("fn f40", "fn g40");
            shapes.push(("braces.rs", braces, braces_new));
            // 编辑代价超过 256 且有长于 20 行的蛇：xdl_split 的「有趣路径」启发
            let unique: Vec<String> = (0..12_000).map(|i| format!("unique {i}\n")).collect();
            let sparse: String = unique
                .iter()
                .enumerate()
                .map(|(i, l)| if i % 30 < 4 { format!("changed {i}\n") } else { l.clone() })
                .collect();
            shapes.push(("snakes.txt", unique.concat(), sparse));
            // 对面没有的行之间夹着大量重复行：xdl_clean_mmatch 会把这些重复行也丢掉
            let mut interleaved_old = String::new();
            let mut interleaved_new = String::new();
            for i in 0..400 {
                for part in ["a", "b", "c", "d"] {
                    interleaved_old.push_str(&format!("old {i} {part}\n"));
                    interleaved_new.push_str(&format!("new {i} {part}\n"));
                }
                interleaved_old.push('\n');
                interleaved_new.push('\n');
            }
            shapes.push(("interleaved.txt", interleaved_old, interleaved_new));
            shapes.into_iter().map(|(p, a, b)| (p.to_string(), a.into_bytes(), b.into_bytes())).collect()
        }

        #[test]
        fn 工作区_diff_进程内与_git_逐字节一致() {
            let (_d, r) = repo();
            let shapes = modified_shapes();
            for (path, old, _) in &shapes {
                write(&r, path, old);
            }
            write(&r, "unchanged.txt", b"same\n");
            write(&r, "staged.txt", numbered(1..=20).as_bytes());
            write(&r, "staged-only.txt", numbered(1..=20).as_bytes());
            write(&r, "exec.sh", b"#!/bin/sh\necho 1\n");
            std::fs::set_permissions(r.join("exec.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            for gone in ["gone.txt", "gone-empty.txt", "gone-removed.txt", "dir/gone no eol.txt"] {
                let content = if gone == "gone-empty.txt" { "" } else { "bye\nnow" };
                write(&r, gone, content.as_bytes());
            }
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", "base"]);

            for (path, _, new) in &shapes {
                write(&r, path, new);
            }
            // 已暂存再改：基准仍是 HEAD；raw 第二个对象是 0000000
            write(&r, "staged.txt", replace_line(&numbered(1..=20), 2, "staged").as_bytes());
            git(&r, &["add", "staged.txt"]);
            write(
                &r,
                "staged.txt",
                replace_line(&replace_line(&numbered(1..=20), 2, "staged"), 18, "then edited").as_bytes(),
            );
            // 只暂存不再改：raw 第二个对象是索引里的 blob
            write(&r, "staged-only.txt", replace_line(&numbered(1..=20), 7, "staged only").as_bytes());
            git(&r, &["add", "staged-only.txt"]);
            write(&r, "exec.sh", b"#!/bin/sh\necho 2\n");
            for gone in ["gone.txt", "gone-empty.txt", "dir/gone no eol.txt"] {
                std::fs::remove_file(r.join(gone)).unwrap();
            }
            git(&r, &["rm", "-q", "gone-removed.txt"]);

            let mut fast = 0;
            let mut normal: Vec<String> = shapes.iter().map(|(p, _, _)| p.clone()).collect();
            normal.extend(
                [
                    "unchanged.txt",
                    "staged.txt",
                    "staged-only.txt",
                    "exec.sh",
                    "gone.txt",
                    "gone-empty.txt",
                    "gone-removed.txt",
                    "dir/gone no eol.txt",
                ]
                .map(String::from),
            );
            for path in &normal {
                check(&r, path, FileKind::Normal).unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
                fast += 1;
            }

            // 未跟踪的新文件：--no-index 对 /dev/null
            let new_files: Vec<(&str, &[u8])> = vec![
                ("new.txt", b"new\nfile\n"),
                ("new empty.txt", b""),
                ("new-noeol.txt", b"no newline"),
                ("new-crlf.txt", b"a\r\nb\r\n"),
                ("新 文件.txt", "内容\n".as_bytes()),
                ("deep/dir/new.c", C_NEW.as_bytes()),
            ];
            for (path, data) in &new_files {
                write(&r, path, data);
            }
            write(&r, "new-exec.sh", b"#!/bin/sh\n");
            std::fs::set_permissions(r.join("new-exec.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            for path in new_files.iter().map(|(p, _)| *p).chain(["new-exec.sh"]) {
                check(&r, path, FileKind::New).unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
                fast += 1;
            }
            // 已暂存的新文件同样走 --no-index
            git(&r, &["add", "new.txt"]);
            check(&r, "new.txt", FileKind::New).unwrap();
            fast += 1;
            assert_eq!(fast, normal.len() + new_files.len() + 2);

            // core.quotePath=false：非 ASCII 路径不再转义
            git(&r, &["config", "core.quotePath", "false"]);
            check(&r, "中文 路径.txt", FileKind::Normal).unwrap();
            check(&r, "新 文件.txt", FileKind::New).unwrap();
            git(&r, &["config", "--unset", "core.quotePath"]);
            // core.abbrev 固定长度
            git(&r, &["config", "core.abbrev", "12"]);
            check(&r, "edit-middle.txt", FileKind::Normal).unwrap();
            check(&r, "new.txt", FileKind::New).unwrap();
            git(&r, &["config", "--unset", "core.abbrev"]);
        }

        #[test]
        fn 工作区_diff_无法证明一致的形状交给_git() {
            let (_d, r) = repo();
            let base = numbered(1..=10);
            for path in ["binary.bin", "mode.sh", "attr.txt", "plain.txt", "renamed.txt"] {
                write(&r, path, base.as_bytes());
            }
            std::os::unix::fs::symlink("plain.txt", r.join("link")).unwrap();
            write(&r, ".gitattributes", b"attr.txt text\n");
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", "base"]);
            write(&r, "binary.bin", b"line 1\n\0binary\n");
            std::fs::set_permissions(r.join("mode.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            write(&r, "attr.txt", b"changed\n");
            write(&r, "plain.txt", b"changed\n");
            std::fs::remove_file(r.join("link")).unwrap();
            std::os::unix::fs::symlink("attr.txt", r.join("link")).unwrap();

            let fallback = |file: &str, kind: FileKind| {
                let reason = check(&r, file, kind).expect_err(file);
                assert!(!reason.is_empty());
            };
            check(&r, "binary.bin", FileKind::Normal).unwrap();
            fallback("mode.sh", FileKind::Normal);
            fallback("attr.txt", FileKind::Normal);
            fallback("link", FileKind::Normal);
            fallback("renamed.txt", FileKind::Renamed);
            fallback("plain.*", FileKind::Normal);
            check(&r, "plain.txt", FileKind::Normal).unwrap();
            for (key, value) in [
                ("diff.algorithm", "histogram"),
                ("diff.context", "5"),
                ("diff.interHunkContext", "2"),
                ("diff.noprefix", "true"),
                ("diff.mnemonicPrefix", "true"),
                ("diff.indentHeuristic", "false"),
                ("diff.suppressBlankEmpty", "true"),
                ("core.autocrlf", "true"),
                ("core.autocrlf", "input"),
                ("core.eol", "crlf"),
                ("core.bigFileThreshold", "1k"),
                ("core.trustctime", "false"),
                ("core.filemode", "false"),
            ] {
                git(&r, &["config", key, value]);
                fallback("plain.txt", FileKind::Normal);
                git(&r, &["config", "--unset-all", key]);
            }
            check(&r, "plain.txt", FileKind::Normal).unwrap();
        }

        /// 确定性的伪随机：xorshift64*
        struct Rng(u64);

        impl Rng {
            fn next(&mut self) -> u64 {
                self.0 ^= self.0 >> 12;
                self.0 ^= self.0 << 25;
                self.0 ^= self.0 >> 27;
                self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
            }

            fn below(&mut self, n: usize) -> usize {
                (self.next() % n as u64) as usize
            }
        }

        /// 小词表造行，重复多、空行和缩进多，让滑动、缩进启发和 INVESTIGATE 都有机会触发。
        fn random_line(rng: &mut Rng) -> String {
            const WORDS: [&str; 12] = [
                "",
                "}",
                "{",
                "return x;",
                "if (a) {",
                "foo()",
                "bar",
                "  baz",
                "\tqux",
                "    nested",
                "_under",
                "$dollar",
            ];
            match rng.below(10) {
                0 => format!("unique {}", rng.next() % 100_000),
                1 => "函数 中文".into(),
                _ => WORDS[rng.below(WORDS.len())].into(),
            }
        }

        fn random_file(rng: &mut Rng, lines: usize) -> Vec<String> {
            (0..lines).map(|_| random_line(rng)).collect()
        }

        fn mutate(rng: &mut Rng, lines: &[String]) -> Vec<String> {
            let mut out = lines.to_vec();
            for _ in 0..1 + rng.below(8) {
                let at = rng.below(out.len() + 1);
                match rng.below(4) {
                    0 => {
                        let n = 1 + rng.below(5);
                        for _ in 0..n {
                            out.insert(at.min(out.len()), random_line(rng));
                        }
                    }
                    1 if !out.is_empty() => {
                        let end = (at + 1 + rng.below(5)).min(out.len());
                        out.drain(at.min(out.len() - 1)..end.max(at.min(out.len() - 1) + 1).min(out.len()));
                    }
                    2 if at < out.len() => out[at] = random_line(rng),
                    _ => {
                        // 把一段挪走：制造可以上下滑动的组
                        if out.len() > 4 {
                            let line = out.remove(rng.below(out.len()));
                            out.insert(rng.below(out.len() + 1), line);
                        }
                    }
                }
            }
            out
        }

        fn join(lines: &[String], rng: &mut Rng, crlf: bool) -> Vec<u8> {
            let eol = if crlf { "\r\n" } else { "\n" };
            let mut text: String = lines.iter().map(|l| format!("{l}{eol}")).collect();
            if !text.is_empty() && rng.below(5) == 0 {
                text.truncate(text.len() - eol.len());
            }
            text.into_bytes()
        }

        #[test]
        fn 工作区_diff_随机形状与_git_逐字节一致() {
            let (_d, r) = repo();
            let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
            let mut pairs = Vec::new();
            for i in 0..300 {
                // 偶尔来一个大文件，让 Myers 的代价上限（mxcost）和蛇形启发生效；
                // 低熵大文件（三种行）编辑代价高、对角线上的蛇也长
                if i % 50 == 25 {
                    const ABC: [&str; 3] = ["a", "b", "c"];
                    let old: Vec<String> = (0..6000).map(|_| ABC[rng.below(3)].to_string()).collect();
                    let new: Vec<String> = old
                        .iter()
                        .map(|l| if rng.below(10) == 0 { ABC[rng.below(3)].into() } else { l.clone() })
                        .collect();
                    let path = format!("fuzz/{i:03}.txt");
                    write(&r, &path, &join(&old, &mut rng, false));
                    pairs.push((path, join(&new, &mut rng, false)));
                    continue;
                }
                let size = if i % 50 == 0 { 2000 + rng.below(2000) } else { rng.below(60) };
                let old = random_file(&mut rng, size);
                let new = if i % 50 == 0 {
                    old.iter().map(|l| if rng.below(3) == 0 { random_line(&mut rng) } else { l.clone() }).collect()
                } else {
                    mutate(&mut rng, &old)
                };
                let crlf = rng.below(8) == 0;
                let path = format!("fuzz/{i:03}.txt");
                let old = join(&old, &mut rng, crlf);
                let new = join(&new, &mut rng, crlf);
                write(&r, &path, &old);
                pairs.push((path, new));
            }
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", "base"]);
            for (path, new) in &pairs {
                write(&r, path, new);
            }
            let mut fast = 0;
            for (path, _) in &pairs {
                check(&r, path, FileKind::Normal).unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
                fast += 1;
                // 同一份内容当新文件
                check(&r, path, FileKind::New).unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
                fast += 1;
            }
            assert_eq!(fast, 600);
        }

        /// xdl_split 的「有趣路径」启发只在编辑代价超过 256 时才可能生效，而代价上限
        /// `mxcost = bogosqrt(ndiags)` 要超过 256，两边合计得有六万多行。
        #[test]
        fn 工作区_diff_超大文件的蛇形启发与_git_逐字节一致() {
            let (_d, r) = repo();
            let mut rng = Rng(42);
            let mut pairs = Vec::new();
            for kind in 0..4 {
                let n = 35_000 + rng.below(10_000);
                let voc = 2 + rng.below(30);
                let old: Vec<String> = (0..n).map(|_| format!("l{}", rng.below(voc))).collect();
                let mut new = Vec::new();
                let mut i = 0;
                while i < old.len() {
                    match kind {
                        // 零散替换
                        0 => {
                            new.push(if rng.below(10) == 0 { format!("l{}", rng.below(voc)) } else { old[i].clone() });
                            i += 1;
                        }
                        // 成段替换
                        1 if rng.below(40) == 0 => {
                            new.extend((0..rng.below(30)).map(|_| format!("x{}", rng.below(voc))));
                            i += rng.below(30);
                        }
                        // 高密度替换
                        2 => {
                            new.push(if rng.below(3) == 0 { format!("l{}", rng.below(voc)) } else { old[i].clone() });
                            i += 1;
                        }
                        // 成段删除与插入
                        3 => {
                            if rng.below(60) == 0 {
                                i += rng.below(200);
                            } else {
                                new.push(old[i].clone());
                                i += 1;
                            }
                            if rng.below(60) == 0 {
                                new.extend((0..rng.below(200)).map(|_| format!("l{}", rng.below(voc))));
                            }
                        }
                        _ => {
                            new.push(old[i].clone());
                            i += 1;
                        }
                    }
                }
                let path = format!("big-{kind}.txt");
                write(&r, &path, &join(&old, &mut rng, false));
                pairs.push((path, join(&new, &mut rng, false)));
            }
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", "base"]);
            for (path, new) in &pairs {
                write(&r, path, new);
            }
            for (path, _) in &pairs {
                check(&r, path, FileKind::Normal).unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
            }
        }

        /// 自动缩写长度遇到前缀相同的对象时必须和 git 一样加长。
        #[test]
        fn 工作区_diff_缩写在前缀冲突时加长() {
            let (_d, r) = repo();
            // 生日碰撞：找两个前 7 位十六进制相同的 blob
            let mut seen = std::collections::HashMap::new();
            let (a, b) = (0u64..)
                .find_map(|i| {
                    let data = format!("collide {i}\n");
                    let id =
                        gix::objs::compute_hash(gix::hash::Kind::Sha1, gix::objs::Kind::Blob, data.as_bytes()).unwrap();
                    let key = id.to_hex_with_len(7).to_string();
                    seen.insert(key, data.clone()).map(|other| (other, data))
                })
                .unwrap();
            write(&r, "c.txt", a.as_bytes());
            git(&r, &["add", "c.txt"]);
            git(&r, &["commit", "-qm", "base"]);
            write(&r, "other.txt", b.as_bytes());
            git(&r, &["hash-object", "-w", "other.txt"]);
            std::fs::remove_file(r.join("other.txt")).unwrap();
            write(&r, "c.txt", b"changed\n");
            check(&r, "c.txt", FileKind::Normal).unwrap();
            let out = in_process::working_directory_diff(&r, "c.txt", FileKind::Normal).unwrap();
            let raw = String::from_utf8_lossy(&out);
            let old = raw.split(' ').nth(2).unwrap();
            assert_eq!(old.len(), 8, "{raw}");
            // 新文件的 blob 恰好与已有对象同前缀
            write(&r, "n.txt", b.as_bytes());
            check(&r, "n.txt", FileKind::New).unwrap();
        }

        /// Desktop `getCommitDiff` 的参数，和 `commit_file_diff_via_git` 相同（不带 `-w`）
        fn git_commit_diff(repo: &Path, sha: &str, file: &str, old_path: Option<&str>) -> Vec<u8> {
            let mut args = vec![
                "log",
                sha,
                "-m",
                "-1",
                "--no-show-signature",
                "--first-parent",
                "--patch-with-raw",
                "--format=",
                "-z",
                "--no-color",
                "--",
            ];
            args.extend(super::super::file_diff_pathspecs(file, old_path));
            git(repo, &args)
        }

        /// 对照一个提交里的一个文件；`Err` 是快速路径让位的原因
        fn check_commit(repo: &Path, sha: &str, file: &str, old_path: Option<&str>) -> Result<(), String> {
            let expected = git_commit_diff(repo, sha, file, old_path);
            let fast = in_process::commit_file_diff(repo, sha, file, old_path)?;
            assert!(
                fast == expected,
                "{sha} {file}: 与 git 不同\n--- 进程内\n{}\n--- git\n{}",
                String::from_utf8_lossy(&fast).replace('\0', "\\0"),
                String::from_utf8_lossy(&expected).replace('\0', "\\0"),
            );
            Ok(())
        }

        fn head(repo: &Path) -> String {
            String::from_utf8(git(repo, &["rev-parse", "HEAD"])).unwrap().trim().to_string()
        }

        fn commit(repo: &Path, message: &str) -> String {
            git(repo, &["add", "-A"]);
            git(repo, &["commit", "-qm", message, "--allow-empty"]);
            head(repo)
        }

        #[test]
        fn 提交_diff_进程内与_git_逐字节一致() {
            let (_d, r) = repo();
            let shapes = modified_shapes();
            for (path, old, _) in &shapes {
                write(&r, path, old);
            }
            write(&r, "unchanged.txt", b"same\n");
            write(&r, "exec.sh", b"#!/bin/sh\necho 1\n");
            std::fs::set_permissions(r.join("exec.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            for gone in ["gone.txt", "gone-empty.txt", "dir/gone no eol.txt"] {
                let content = if gone == "gone-empty.txt" { "" } else { "bye\nnow" };
                write(&r, gone, content.as_bytes());
            }
            let root = commit(&r, "base");
            for (path, _, new) in &shapes {
                write(&r, path, new);
            }
            write(&r, "exec.sh", b"#!/bin/sh\necho 2\n");
            for gone in ["gone.txt", "gone-empty.txt", "dir/gone no eol.txt"] {
                std::fs::remove_file(r.join(gone)).unwrap();
            }
            for (path, data) in [("added.txt", "a\nb\n"), ("added-empty.txt", ""), ("新 目录/added no eol", "x")] {
                write(&r, path, data.as_bytes());
            }
            let second = commit(&r, "edit");

            let mut fast = 0;
            let mut files: Vec<String> = shapes.iter().map(|(p, _, _)| p.clone()).collect();
            files.extend(["exec.sh", "gone.txt", "gone-empty.txt", "dir/gone no eol.txt"].map(Into::into));
            files.extend(["added.txt", "added-empty.txt", "新 目录/added no eol"].map(Into::into));
            for file in &files {
                check_commit(&r, &second, file, None).unwrap_or_else(|reason| panic!("{file} 应走快速路径: {reason}"));
                fast += 1;
            }
            // 根提交：和空树比，全是新增
            for (path, _, _) in &shapes {
                check_commit(&r, &root, path, None).unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
                fast += 1;
            }
            // 带旧路径但旧路径没变：和只给新路径一样
            check_commit(&r, &second, "added.txt", Some("unchanged.txt")).unwrap();
            fast += 1;
            assert_eq!(fast, files.len() + shapes.len() + 1);
            // 这个提交没改的文件：git 往前找到根提交，快速路径让位
            assert!(in_process::commit_file_diff(&r, &second, "unchanged.txt", None).is_err());

            // 合并提交：和第一父比
            git(&r, &["checkout", "-q", "-b", "side"]);
            write(&r, "side.txt", b"side\n");
            write(&r, "edit-start.txt", &numbered(1..=30).into_bytes());
            commit(&r, "side");
            git(&r, &["checkout", "-q", "main"]);
            write(&r, "edit-end.txt", b"main\n");
            commit(&r, "main");
            git(&r, &["merge", "-q", "--no-ff", "--no-edit", "side"]);
            let merge = head(&r);
            for file in ["side.txt", "edit-start.txt"] {
                check_commit(&r, &merge, file, None).unwrap_or_else(|reason| panic!("合并 {file}: {reason}"));
            }
            // 只在第一父那边改过：合并和第一父相同，git 往前找到 main 上那个提交
            assert!(in_process::commit_file_diff(&r, &merge, "edit-end.txt", None).is_err());

            // core.quotePath=false 与 core.abbrev
            git(&r, &["config", "core.quotePath", "false"]);
            check_commit(&r, &second, "中文 路径.txt", None).unwrap();
            git(&r, &["config", "core.abbrev", "12"]);
            check_commit(&r, &second, "edit-middle.txt", None).unwrap();
            check_commit(&r, &second, "added.txt", None).unwrap();
        }

        #[test]
        fn 提交_diff_无法证明一致的形状交给_git() {
            let (_d, r) = repo();
            let body = numbered(1..=20);
            write(&r, "old.txt", body.as_bytes());
            write(&r, "bin.dat", b"a\0b\n");
            write(&r, "mode.sh", b"echo\n");
            write(&r, "attr.txt", b"x\n");
            write(&r, "dir-swap", b"file\n");
            write(&r, ".gitattributes", b"attr.txt diff=custom\n");
            commit(&r, "base");
            git(&r, &["mv", "old.txt", "new.txt"]);
            write(&r, "bin.dat", b"a\0c\n");
            std::fs::set_permissions(r.join("mode.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            write(&r, "attr.txt", b"y\n");
            std::fs::remove_file(r.join("dir-swap")).unwrap();
            write(&r, "dir-swap/inner", b"dir\n");
            std::os::unix::fs::symlink("new.txt", r.join("link")).unwrap();
            let sha = commit(&r, "edit");
            for (file, old_path) in
                [("mode.sh", None), ("attr.txt", None), ("dir-swap", None), ("link", None), ("*.txt", None)]
            {
                let expected = git_commit_diff(&r, &sha, file, old_path);
                assert!(
                    in_process::commit_file_diff(&r, &sha, file, old_path).is_err(),
                    "{file} 应让位给 git:\n{}",
                    String::from_utf8_lossy(&expected)
                );
            }
            // 只给新路径时 git 看不到重命名：一个新增文件，快速路径照样作答；二进制照 builtin_diff 作答
            check_commit(&r, &sha, "new.txt", None).unwrap();
            check_commit(&r, &sha, "bin.dat", None).unwrap();
            // 短 SHA、会改变输出的配置
            assert!(in_process::commit_file_diff(&r, &sha[..12], "new.txt", None).is_err());
            for (key, value) in [("diff.external", "true"), ("diff.context", "5"), ("diff.algorithm", "patience")] {
                git(&r, &["config", key, value]);
                assert!(in_process::commit_file_diff(&r, &sha, "new.txt", None).is_err(), "{key}");
                git(&r, &["config", "--unset", key]);
            }
        }

        #[test]
        fn 提交_diff_重命名与_git_逐字节一致() {
            let (_d, r) = repo();
            let body = numbered(1..=40);
            let names = [
                "exact.txt",
                "edit.txt",
                "far.txt",
                "near.txt",
                "空 格/中文.txt",
                "crlf.txt",
                "empty.txt",
                "mode.sh",
                "bin.dat",
                "kept.txt",
                "tab\tname.txt",
            ];
            for name in names {
                let data: Vec<u8> = match name {
                    "empty.txt" => Vec::new(),
                    "bin.dat" => b"\0bin\n".repeat(20),
                    _ => format!("{name}\n{body}").into_bytes(),
                };
                write(&r, name, &data);
            }
            commit(&r, "base");
            let renamed = |from: &str, to: &str, data: Option<Vec<u8>>| {
                let data = data.unwrap_or_else(|| std::fs::read(r.join(from)).unwrap());
                std::fs::remove_file(r.join(from)).unwrap();
                write(&r, to, &data);
            };
            renamed("exact.txt", "moved/exact.txt", None);
            renamed(
                "edit.txt",
                "edit2.txt",
                Some(format!("edit.txt\n{}", replace_line(&body, 5, "five")).into_bytes()),
            );
            // 一半的行相同（低于 50% 门槛，git 分别输出删除和新增）与三分之二相同
            let far: String =
                (1..=40).map(|i| if i % 2 == 0 { format!("line {i}\n") } else { format!("x{i}\n") }).collect();
            renamed("far.txt", "far2.txt", Some(far.into_bytes()));
            let near: String =
                (1..=40).map(|i| if i % 3 == 0 { format!("x{i}\n") } else { format!("line {i}\n") }).collect();
            renamed("near.txt", "near2.txt", Some(near.into_bytes()));
            renamed("空 格/中文.txt", "新 目录/中文 2.txt", None);
            renamed("crlf.txt", "crlf2.txt", Some(format!("crlf.txt\n{body}").replace('\n', "\r\n").into_bytes()));
            renamed("empty.txt", "empty2.txt", None);
            renamed("mode.sh", "mode2.sh", None);
            std::fs::set_permissions(r.join("mode2.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            renamed("bin.dat", "bin2.dat", None);
            renamed("tab\tname.txt", "tab\tname2.txt", None);
            write(&r, "kept.txt", format!("kept.txt\n{body}changed\n").as_bytes());
            write(&r, "kept-copy.txt", format!("kept.txt\n{body}").as_bytes());
            let sha = commit(&r, "renames");

            let mut fast = Vec::new();
            for (file, old_path) in [
                ("moved/exact.txt", "exact.txt"),
                ("edit2.txt", "edit.txt"),
                ("far2.txt", "far.txt"),
                ("near2.txt", "near.txt"),
                ("新 目录/中文 2.txt", "空 格/中文.txt"),
                ("crlf2.txt", "crlf.txt"),
                ("empty2.txt", "empty.txt"),
                ("tab\tname2.txt", "tab\tname.txt"),
                ("mode2.sh", "mode.sh"),
                ("bin2.dat", "bin.dat"),
                // 旧路径只是修改：-M 只拿删除当来源，git 分别输出两个文件
                ("kept-copy.txt", "kept.txt"),
            ] {
                match check_commit(&r, &sha, file, Some(old_path)) {
                    Ok(()) => fast.push(file),
                    Err(reason) => eprintln!("{file}: {reason}"),
                }
            }
            assert_eq!(
                fast,
                [
                    "moved/exact.txt",
                    "edit2.txt",
                    "near2.txt",
                    "新 目录/中文 2.txt",
                    "crlf2.txt",
                    "empty2.txt",
                    "tab\tname2.txt"
                ]
            );
            let exact = git_commit_diff(&r, &sha, "moved/exact.txt", Some("exact.txt"));
            assert!(String::from_utf8_lossy(&exact).contains("similarity index 100%\nrename from exact.txt\n"));
            // core.quotePath=false 时中文路径不转义；core.abbrev
            git(&r, &["config", "core.quotePath", "false"]);
            check_commit(&r, &sha, "新 目录/中文 2.txt", Some("空 格/中文.txt")).unwrap();
            git(&r, &["config", "core.abbrev", "12"]);
            check_commit(&r, &sha, "edit2.txt", Some("edit.txt")).unwrap();
            // 关掉或改变重命名检测的设置让位
            for (key, value) in [("diff.renames", "false"), ("diff.renames", "copies"), ("diff.renameLimit", "1")] {
                git(&r, &["config", key, value]);
                assert!(in_process::commit_file_diff(&r, &sha, "edit2.txt", Some("edit.txt")).is_err(), "{key}");
                git(&r, &["config", "--unset", key]);
            }
            // 属性落在旧路径上也让位
            write(&r, ".gitattributes", b"edit.txt diff=custom\n");
            assert!(in_process::commit_file_diff(&r, &sha, "edit2.txt", Some("edit.txt")).is_err());
        }

        /// 随机的一删一增：相似度从 0 到 100% 都有，配上与配不上（git 分别输出两个文件，让位）都和 git 对照
        #[test]
        fn 提交_diff_随机重命名与_git_逐字节一致() {
            let (_d, r) = repo();
            let mut rng = Rng(0x5151_7a7a_0303_c0c0);
            let mut pairs = Vec::new();
            for i in 0..150 {
                let size = 1 + rng.below(40);
                let old = random_file(&mut rng, size);
                let mut new = old.clone();
                for _ in 0..rng.below(4) {
                    new = mutate(&mut rng, &new);
                }
                let crlf = rng.below(8) == 0;
                let old = join(&old, &mut rng, crlf);
                let new_crlf = crlf && rng.below(2) == 0;
                let new = join(&new, &mut rng, new_crlf);
                let from = format!("src/{i:03}.txt");
                let to = if rng.below(2) == 0 { format!("dst/{i:03}.txt") } else { format!("dst/renamed-{i:03}.txt") };
                write(&r, &from, &old);
                pairs.push((from, to, new));
            }
            commit(&r, "base");
            for (from, to, new) in &pairs {
                std::fs::remove_file(r.join(from)).unwrap();
                write(&r, to, new);
            }
            let sha = commit(&r, "renames");
            let (mut fast, mut renamed) = (0, 0);
            for (from, to, _) in &pairs {
                let expected = git_commit_diff(&r, &sha, to, Some(from));
                let is_rename = expected.split(|b| *b == 0).next().is_some_and(|raw| raw.contains(&b'R'));
                match check_commit(&r, &sha, to, Some(from)) {
                    Ok(()) => {
                        fast += 1;
                        assert!(is_rename);
                    }
                    Err(reason) => assert!(!is_rename, "{to} 是重命名却让位：{reason}"),
                }
                renamed += is_rename as usize;
            }
            eprintln!("随机重命名 diff：{fast} 个由快速路径作答，git 配成重命名 {renamed} 个");
            assert!(fast >= 60 && renamed < 150, "{fast} / {renamed}");
        }

        #[test]
        fn 提交_diff_随机形状与_git_逐字节一致() {
            let (_d, r) = repo();
            let mut rng = Rng(0x0123_4567_89ab_cdef);
            let mut pairs = Vec::new();
            for i in 0..300 {
                let size = if i % 50 == 0 { 2000 + rng.below(2000) } else { rng.below(60) };
                let old = random_file(&mut rng, size);
                let new = mutate(&mut rng, &old);
                let crlf = rng.below(8) == 0;
                let path = format!("fuzz/{i:03}.txt");
                let old = join(&old, &mut rng, crlf);
                write(&r, &path, &old);
                pairs.push((path, old, join(&new, &mut rng, crlf)));
            }
            let root = commit(&r, "base");
            for (path, _, new) in &pairs {
                write(&r, path, new);
            }
            let sha = commit(&r, "edit");
            let (mut fast, mut unchanged) = (0, 0);
            for (path, old, new) in &pairs {
                for commit in [&sha, &root] {
                    // 变异后内容可能和原来一样：这个提交没改它，git 会往前找，快速路径必须让位
                    if commit == &sha && old == new {
                        assert!(in_process::commit_file_diff(&r, commit, path, None).is_err());
                        unchanged += 1;
                        continue;
                    }
                    check_commit(&r, commit, path, None)
                        .unwrap_or_else(|reason| panic!("{path} 应走快速路径: {reason}"));
                    fast += 1;
                }
            }
            assert_eq!(fast + unchanged, 600);
            assert!(fast >= 580, "快速路径只作答了 {fast}");
        }

        /// `git show <rev>:<file>` 的原始字节与退出码
        fn git_show(repo: &Path, revision: &str, file: &str) -> Option<Vec<u8>> {
            let out =
                Command::new("git").arg("-C").arg(repo).args(["show", &format!("{revision}:{file}")]).output().unwrap();
            out.status.success().then_some(out.stdout)
        }

        #[test]
        fn blob_读取进程内与_git_show_逐字节一致() {
            let (_d, r) = repo();
            // 属性、textconv、行尾与 filter 配置齐全：git show 输出 blob 时一概不用
            write(&r, ".gitattributes", b"*.txt diff=upper text eol=crlf\n*.dat filter=rot\n");
            git(&r, &["config", "diff.upper.textconv", "tr a-z A-Z <"]);
            git(&r, &["config", "filter.rot.smudge", "tr a-z n-za-m"]);
            git(&r, &["config", "filter.rot.clean", "cat"]);
            git(&r, &["config", "core.autocrlf", "true"]);
            write(&r, "text.txt", b"lower case\nline two\n");
            write(&r, "crlf.txt", b"a\r\nb\r\n");
            write(&r, "data.dat", b"hello\n");
            write(&r, "bin.png", b"\x89PNG\r\n\x1a\n\0\0\0binary");
            write(&r, "empty", b"");
            write(&r, "dir/中文 name.txt", b"nested\n");
            std::os::unix::fs::symlink("text.txt", r.join("link")).unwrap();
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", "base"]);
            let root = String::from_utf8(git(&r, &["rev-parse", "HEAD"])).unwrap().trim().to_string();
            write(&r, "text.txt", b"changed\n");
            write(&r, "bin.png", b"\x89PNG\r\n\x1a\n\0\0\0other");
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", "edit"]);
            let head = String::from_utf8(git(&r, &["rev-parse", "HEAD"])).unwrap().trim().to_string();
            let files =
                ["text.txt", "crlf.txt", "data.dat", "bin.png", "empty", "dir/中文 name.txt", "link", ".gitattributes"];
            let mut fast = 0;
            for revision in [head.clone(), format!("{head}^"), root.clone(), "HEAD".into(), "HEAD^".into()] {
                for file in files {
                    let expected = git_show(&r, &revision, file).expect("git show 应成功");
                    let got = in_process::blob_contents(&r, &revision, file)
                        .unwrap_or_else(|reason| panic!("{revision}:{file} 应走快速路径: {reason}"));
                    assert!(got == expected, "{revision}:{file} 与 git show 不同");
                    assert_eq!(super::super::blob_contents(&r, &revision, file).unwrap(), expected);
                    for length in [0, 1, 5, 4096] {
                        let partial = super::super::partial_blob_contents(&r, &revision, file, length).unwrap();
                        assert_eq!(partial.as_deref(), Some(&expected[..expected.len().min(length)]));
                    }
                    fast += 1;
                }
            }
            assert_eq!(fast, 5 * files.len());
            // 让位：路径不存在、目录、根提交的父、短 SHA、其他修订号写法、glob 路径
            for (revision, file) in [
                (head.as_str(), "missing.txt"),
                (head.as_str(), "dir"),
                (&format!("{root}^"), "text.txt"),
                (&head[..12], "text.txt"),
                ("main", "text.txt"),
                ("HEAD~1", "text.txt"),
                (head.as_str(), "*.txt"),
                (head.as_str(), "./text.txt"),
            ] {
                assert!(in_process::blob_contents(&r, revision, file).is_err(), "{revision}:{file}");
            }
            // 让位后的结果仍是 git 的：不存在的路径报错，partial 在文件只在磁盘上时返回 None
            assert!(super::super::blob_contents(&r, &head, "missing.txt").is_err());
            write(&r, "untracked.txt", b"disk only\n");
            assert_eq!(super::super::partial_blob_contents(&r, &head, "untracked.txt", 4).unwrap(), None);
            // 替换对象：git show 会换成替换后的 blob
            let blob = String::from_utf8(git(&r, &["rev-parse", &format!("{head}:text.txt")])).unwrap();
            let other = String::from_utf8(git(&r, &["rev-parse", &format!("{head}:data.dat")])).unwrap();
            git(&r, &["replace", blob.trim(), other.trim()]);
            assert!(in_process::blob_contents(&r, &head, "text.txt").is_err());
            assert_eq!(
                super::super::blob_contents(&r, &head, "text.txt").unwrap(),
                git_show(&r, &head, "text.txt").unwrap()
            );
        }

        /// 允许失败的 git（合并、变基、贮藏弹出遇到冲突时退出码非零）
        fn git_status(repo: &Path, args: &[&str]) -> i32 {
            let out = Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
            out.status.code().unwrap_or(-1)
        }

        /// 一个文件在 HEAD 与工作区之间的 diff 必须走快速路径且与 git 逐字节相同；返回 git 的输出
        fn answered(repo: &Path, file: &str, kind: FileKind, label: &str) -> Vec<u8> {
            check(repo, file, kind).unwrap_or_else(|reason| panic!("{label} {file} 应走快速路径: {reason}"));
            git_diff(repo, file, kind)
        }

        fn has(haystack: &[u8], needle: &str) -> bool {
            haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
        }

        /// 路径、提交前的内容、提交后的内容（`None` 是删除）
        type BinaryChange<'a> = (&'a str, &'a [u8], Option<&'a [u8]>);

        /// 前 8000 字节里有 NUL 就是二进制：`builtin_diff` 在补丁头之后只写 `Binary files … differ`，
        /// 标签按 `quote_two` 转义、新增或删除的一侧是 `/dev/null`。工作区与提交两条路径都对照。
        #[test]
        fn 二进制文件的_diff_与_git_逐字节一致() {
            let (_d, r) = repo();
            let mut late_nul = vec![b'x'; 7999];
            late_nul.extend_from_slice(b"\n\0tail\n");
            let mut late_nul_new = late_nul.clone();
            late_nul_new.extend_from_slice(b"more\n");
            let mut edge_nul = vec![b'y'; 7999];
            edge_nul.push(0);
            let changes: Vec<BinaryChange> = vec![
                ("bin.dat", b"a\0b\n", Some(b"a\0c\n")),
                ("text-to-bin.txt", b"text\n", Some(b"now\0binary\n")),
                ("bin-to-text.txt", b"\0was binary", Some(b"text\n")),
                ("space name.png", b"\x89PNG\0\0one", Some(b"\x89PNG\0\0two")),
                ("dir/中文.bin", b"\0one", Some(b"\0two")),
                ("tab\tname.bin", b"\0one", Some(b"\0three")),
                ("gone.bin", b"\0bye", None),
                ("late-nul.txt", &late_nul, Some(&late_nul_new)),
                ("edge-nul.txt", b"plain\n", Some(&edge_nul)),
                ("empty-to-bin", b"", Some(b"\0")),
                ("bin-to-empty", b"\0", Some(b"")),
            ];
            for (path, base, _) in &changes {
                write(&r, path, base);
            }
            write(&r, "same.bin", b"\0same");
            let root = commit(&r, "base");
            for (path, _, new) in &changes {
                match new {
                    Some(data) => write(&r, path, data),
                    None => std::fs::remove_file(r.join(path)).unwrap(),
                }
            }
            // 二进制内容与 HEAD 相同、但 stat 变了：skip_stat_unmatch 丢掉，输出为空
            write(&r, "same.bin", b"\0same");
            let mut binary_outputs = 0;
            for path in changes.iter().map(|(p, _, _)| *p).chain(["same.bin"]) {
                let out = answered(&r, path, FileKind::Normal, "工作区");
                binary_outputs += has(&out, "Binary files ") as usize;
            }
            // late-nul（NUL 在第 8001 字节）不算二进制，正好第 8000 字节的算
            assert_eq!(binary_outputs, changes.len() - 1);
            // 未跟踪与已暂存的新二进制文件：--no-index 对 /dev/null
            write(&r, "new.bin", b"\0new");
            write(&r, "新 文件.png", b"\x89PNG\0new");
            for path in ["new.bin", "新 文件.png"] {
                assert!(has(&answered(&r, path, FileKind::New, "未跟踪"), "Binary files /dev/null and "));
            }
            git(&r, &["add", "new.bin"]);
            answered(&r, "new.bin", FileKind::New, "已暂存");
            // 同一个已暂存的新文件按 `HEAD --` 比：diff-index 的 show_new_file
            assert!(has(&answered(&r, "new.bin", FileKind::Normal, "已暂存"), "Binary files /dev/null and b/new.bin"));
            // core.quotePath=false 时标签里的中文不再转义
            git(&r, &["config", "core.quotePath", "false"]);
            answered(&r, "dir/中文.bin", FileKind::Normal, "quotePath");
            answered(&r, "新 文件.png", FileKind::New, "quotePath");
            git(&r, &["config", "--unset", "core.quotePath"]);

            let sha = commit(&r, "edit");
            for path in changes.iter().map(|(p, _, _)| *p).chain(["new.bin", "新 文件.png"]) {
                check_commit(&r, &sha, path, None).unwrap_or_else(|reason| panic!("提交 {path}: {reason}"));
            }
            for (path, _, _) in &changes {
                check_commit(&r, &root, path, None).unwrap_or_else(|reason| panic!("根提交 {path}: {reason}"));
            }
            check_commit(&r, &root, "same.bin", None).unwrap();
            git(&r, &["config", "core.abbrev", "12"]);
            check_commit(&r, &sha, "bin.dat", None).unwrap();
            answered(&r, "bin.dat", FileKind::Normal, "core.abbrev");
            git(&r, &["config", "--unset", "core.abbrev"]);
            // diff/binary 属性改变二进制判定或输出：让位
            write(&r, ".gitattributes", b"*.dat binary\n*.png diff\n");
            assert!(in_process::commit_file_diff(&r, &sha, "bin.dat", None).is_err());
            assert!(in_process::commit_file_diff(&r, &sha, "space name.png", None).is_err());
            write(&r, "bin.dat", b"\0again");
            assert!(in_process::working_directory_diff(&r, "bin.dat", FileKind::Normal).is_err());
        }

        /// 冲突的工作区 diff：Desktop 对冲突文件同样是 `git diff … HEAD -- <file>`，diff-index 拿这个路径
        /// 阶段最小的索引条目比 stat，比较 HEAD 与工作区（不是 combined diff）。各种冲突形状、部分解决、
        /// 全部解决、删掉工作区文件、`git add`/`git rm` 之后都与 git 逐字节相同。
        #[test]
        fn 冲突文件的工作区_diff_与_git_逐字节一致() {
            let lines = |tag: &str| -> String { (1..=30).map(|i| format!("{tag} {i}\n")).collect() };
            let edit = |n: &[usize], tag: &str| -> String {
                (1..=30).map(|i| if n.contains(&i) { format!("{tag} {i}\n") } else { format!("line {i}\n") }).collect()
            };
            let crlf = |text: &str| text.replace('\n', "\r\n");
            let base_text = lines("line");
            let base: Vec<(&str, Vec<u8>)> = vec![
                ("one.txt", base_text.clone().into_bytes()),
                ("many.txt", base_text.clone().into_bytes()),
                ("pre-existing.txt", b"a\n=======\nb\n<<<<<<< old\n".to_vec()),
                ("crlf.txt", crlf(&base_text).into_bytes()),
                ("no-eol.txt", b"x".to_vec()),
                ("bin.dat", b"\0base".to_vec()),
                ("text-vs-bin.txt", b"text\n".to_vec()),
                ("dir/中文 文件.txt", base_text.clone().into_bytes()),
                ("modify-delete.txt", base_text.clone().into_bytes()),
                ("delete-modify.txt", base_text.clone().into_bytes()),
                ("exec.sh", b"#!/bin/sh\necho base\n".to_vec()),
            ];
            let ours: Vec<(&str, Vec<u8>)> = vec![
                ("one.txt", edit(&[5], "ours").into_bytes()),
                ("many.txt", edit(&[3, 15, 27], "ours").into_bytes()),
                ("pre-existing.txt", b"a\n=======\nours\n<<<<<<< old\n".to_vec()),
                ("crlf.txt", crlf(&edit(&[5], "ours")).into_bytes()),
                ("no-eol.txt", b"ours".to_vec()),
                ("bin.dat", b"\0ours".to_vec()),
                ("text-vs-bin.txt", b"ours text\n".to_vec()),
                ("dir/中文 文件.txt", edit(&[5], "ours").into_bytes()),
                ("modify-delete.txt", edit(&[5], "ours").into_bytes()),
                ("add-add.txt", b"ours add\n".to_vec()),
                ("exec.sh", b"#!/bin/sh\necho ours\n".to_vec()),
            ];
            let theirs: Vec<(&str, Vec<u8>)> = vec![
                ("one.txt", edit(&[5], "theirs").into_bytes()),
                ("many.txt", edit(&[3, 15, 27], "theirs").into_bytes()),
                ("pre-existing.txt", b"a\n=======\ntheirs\n<<<<<<< old\n".to_vec()),
                ("crlf.txt", crlf(&edit(&[5], "theirs")).into_bytes()),
                ("no-eol.txt", b"theirs".to_vec()),
                ("bin.dat", b"\0theirs".to_vec()),
                ("text-vs-bin.txt", b"\0theirs bin\n".to_vec()),
                ("dir/中文 文件.txt", edit(&[5], "theirs").into_bytes()),
                ("delete-modify.txt", edit(&[5], "theirs").into_bytes()),
                ("add-add.txt", b"theirs add\n".to_vec()),
                ("added-by-them.txt", b"clean add\n".to_vec()),
                ("theirs-only.txt", b"x\n".to_vec()),
                ("exec.sh", b"#!/bin/sh\necho theirs\n".to_vec()),
            ];
            let (_d, r) = repo();
            let apply = |files: &[(&str, Vec<u8>)]| {
                for (path, data) in files {
                    write(&r, path, data);
                }
                std::fs::set_permissions(r.join("exec.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            };
            apply(&base);
            write(&r, "theirs-only.txt", b"base\n");
            commit(&r, "base");
            git(&r, &["checkout", "-q", "-b", "side"]);
            apply(&theirs);
            std::fs::remove_file(r.join("modify-delete.txt")).unwrap();
            commit(&r, "theirs");
            git(&r, &["checkout", "-q", "main"]);
            apply(&ours);
            std::fs::remove_file(r.join("delete-modify.txt")).unwrap();
            commit(&r, "ours");
            assert_eq!(git_status(&r, &["merge", "-q", "side"]), 1);
            let unmerged = String::from_utf8(git(&r, &["ls-files", "-u", "-z"])).unwrap();
            let mut paths: Vec<&str> = base.iter().chain(&ours).chain(&theirs).map(|(p, _)| *p).collect();
            paths.sort();
            paths.dedup();
            for path in &paths {
                if !["added-by-them.txt", "theirs-only.txt"].contains(path) {
                    assert!(unmerged.contains(&format!("\t{path}\0")), "{path} 应是冲突路径:\n{unmerged}");
                }
            }
            let check_all = |label: &str| -> usize {
                paths.iter().filter(|path| !answered(&r, path, FileKind::Normal, label).is_empty()).count()
            };
            // 合并刚停下：文本冲突带标记；二进制、modify/delete 的工作区是 ours（= HEAD，输出为空）；
            // delete/modify 与 added-by-them 在 HEAD 里没有，是新增
            let one = answered(&r, "one.txt", FileKind::Normal, "合并");
            assert!(has(&one, "+<<<<<<< HEAD\n") && has(&one, ":100644 100644 "), "{}", String::from_utf8_lossy(&one));
            assert!(has(&answered(&r, "delete-modify.txt", FileKind::Normal, "合并"), "new file mode 100644\n"));
            assert!(answered(&r, "bin.dat", FileKind::Normal, "合并").is_empty());
            assert!(check_all("合并") >= 9);

            // 部分解决：删掉一组标记、改动二进制、在不完整的末行留一个标记
            let text = std::fs::read_to_string(r.join("one.txt")).unwrap();
            let partly: String = text.lines().filter(|l| !l.starts_with("=======")).map(|l| format!("{l}\n")).collect();
            write(&r, "one.txt", format!("{partly}>>>>>>>").as_bytes());
            write(&r, "bin.dat", b"\0resolved by hand");
            write(&r, "text-vs-bin.txt", b"\0now binary\n");
            write(&r, "modify-delete.txt", b"kept and edited\n");
            write(&r, "no-eol.txt", b"<<<<<<<");
            assert!(has(
                &answered(&r, "bin.dat", FileKind::Normal, "部分解决"),
                "Binary files a/bin.dat and b/bin.dat"
            ));
            check_all("部分解决");
            // 全部解决：回到 ours（与 HEAD 相同，输出为空）或取 theirs
            write(&r, "one.txt", edit(&[5], "ours").as_bytes());
            write(&r, "many.txt", edit(&[3, 15, 27], "theirs").as_bytes());
            assert!(answered(&r, "one.txt", FileKind::Normal, "全部解决").is_empty());
            check_all("全部解决");
            // 工作区删掉冲突文件：HEAD 里有就是删除，HEAD 里没有就什么都不输出
            std::fs::remove_file(r.join("crlf.txt")).unwrap();
            std::fs::remove_file(r.join("delete-modify.txt")).unwrap();
            assert!(has(&answered(&r, "crlf.txt", FileKind::Normal, "删掉"), "deleted file mode"));
            assert!(answered(&r, "delete-modify.txt", FileKind::Normal, "删掉").is_empty());
            check_all("删掉");
            // 标成已解决（阶段 0）、从索引删掉（HEAD 里有，git 不看工作区，报删除）
            git(&r, &["add", "many.txt", "add-add.txt"]);
            git(&r, &["rm", "-q", "--cached", "modify-delete.txt"]);
            assert!(has(&answered(&r, "modify-delete.txt", FileKind::Normal, "rm"), "deleted file mode"));
            check_all("add/rm");
            // core.abbrev 与 core.quotePath 照样作答
            git(&r, &["config", "core.abbrev", "12"]);
            git(&r, &["config", "core.quotePath", "false"]);
            check_all("配置");
            // HEAD 与索引里都没有（未跟踪）：pathspec 什么都不匹配，输出为空
            write(&r, "untracked.txt", b"untracked\n");
            assert!(answered(&r, "untracked.txt", FileKind::Normal, "未跟踪").is_empty());

            // 阶段最小的条目的 stat 与工作区一致（解决回 base 的内容后把 stage 1 的 stat 写成工作区的）：
            // get_stat_data 认为干净，raw 第二个对象是 stage 1 的对象而不是全零。stage 3 的 stat 仍是零
            write(&r, "one.txt", base_text.as_bytes());
            let index_path = r.join(".git/index");
            let mut index =
                gix::index::File::at(&index_path, gix::hash::Kind::Sha1, false, Default::default()).unwrap();
            let stage1 = index
                .entries()
                .iter()
                .position(|e| e.path(&index) == "one.txt" && e.stage_raw() == 1)
                .expect("one.txt 的 stage 1");
            let metadata = gix::index::fs::Metadata::from_path_no_follow(&r.join("one.txt")).unwrap();
            index.entries_mut()[stage1].stat = gix::index::entry::Stat::from_fs(&metadata).unwrap();
            index.write(Default::default()).unwrap();
            let clean = answered(&r, "one.txt", FileKind::Normal, "stage 1 干净");
            assert!(!has(&clean, " 000000000000 M"), "{}", String::from_utf8_lossy(&clean));
        }

        #[test]
        fn 变基贮藏与拣选冲突的工作区_diff_与_git_逐字节一致() {
            // 变基：HEAD 是上游（被拣过来的那个提交是 theirs）
            let (_d, r) = repo();
            write(&r, "a.txt", b"1\n2\n3\n");
            write(&r, "b.bin", b"\0one");
            commit(&r, "base");
            git(&r, &["checkout", "-q", "-b", "topic"]);
            write(&r, "a.txt", b"1\ntopic\n3\n");
            write(&r, "b.bin", b"\0topic");
            commit(&r, "topic");
            git(&r, &["checkout", "-q", "main"]);
            write(&r, "a.txt", b"1\nmain\n3\n");
            write(&r, "b.bin", b"\0main");
            commit(&r, "main");
            git(&r, &["checkout", "-q", "topic"]);
            assert_ne!(git_status(&r, &["rebase", "-q", "main"]), 0);
            assert!(r.join(".git/REBASE_HEAD").exists());
            assert!(has(&answered(&r, "a.txt", FileKind::Normal, "变基"), ">>>>>>> "));
            answered(&r, "b.bin", FileKind::Normal, "变基");
            write(&r, "b.bin", b"\0merged");
            assert!(has(&answered(&r, "b.bin", FileKind::Normal, "变基"), "Binary files"));

            // 贮藏弹出：HEAD 是弹出时的提交，冲突条目没有 MERGE_HEAD
            let (_d2, r) = repo();
            write(&r, "s.txt", b"1\n2\n3\n");
            write(&r, "keep.txt", b"keep\n");
            commit(&r, "base");
            write(&r, "s.txt", b"1\nstash\n3\n");
            git(&r, &["stash", "-q"]);
            write(&r, "s.txt", b"1\nhead\n3\n");
            commit(&r, "head");
            assert_ne!(git_status(&r, &["stash", "pop", "-q"]), 0);
            assert!(has(&answered(&r, "s.txt", FileKind::Normal, "贮藏"), "+=======\n"));
            answered(&r, "keep.txt", FileKind::Normal, "贮藏");

            // 拣选：add/add 与 CRLF 冲突
            let (_d3, r) = repo();
            write(&r, "c.txt", b"1\r\n2\r\n3\r\n");
            commit(&r, "base");
            git(&r, &["checkout", "-q", "-b", "pick"]);
            write(&r, "c.txt", b"1\r\npick\r\n3\r\n");
            write(&r, "both.txt", b"pick\n");
            let pick = commit(&r, "pick");
            git(&r, &["checkout", "-q", "main"]);
            write(&r, "c.txt", b"1\r\nmain\r\n3");
            write(&r, "both.txt", b"main");
            commit(&r, "main");
            assert_ne!(git_status(&r, &["cherry-pick", &pick]), 0);
            for file in ["c.txt", "both.txt"] {
                assert!(!answered(&r, file, FileKind::Normal, "拣选").is_empty());
            }
        }
    }
}
