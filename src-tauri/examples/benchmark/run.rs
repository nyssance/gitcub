// 基准的实现，由 main.rs 在 unix 下 include!；模块路径相对 examples/benchmark/。
#[path = "../../src/blame.rs"]
mod blame;
#[cfg(unix)]
#[path = "../../src/blame_engine.rs"]
mod blame_engine;
#[path = "../../src/blame_model.rs"]
mod blame_model;
#[path = "../../src/branch.rs"]
mod branch;
#[cfg(unix)]
#[path = "../../src/changed_paths.rs"]
mod changed_paths;
#[path = "../../src/credential_protocol.rs"]
mod credential_protocol;
#[path = "../../src/cygwin.rs"]
mod cygwin;
#[path = "../../src/desktop_import.rs"]
mod desktop_import;
#[path = "../../src/desktop_log.rs"]
mod desktop_log;
#[path = "../../src/file_history.rs"]
mod file_history;
#[path = "../../src/file_system.rs"]
mod file_system;
#[path = "../../src/git.rs"]
mod git;
#[path = "../../src/git_config.rs"]
mod git_config;
#[path = "../../src/gitignore.rs"]
mod gitignore;
#[path = "../../src/graph.rs"]
mod graph;
#[path = "../../src/history.rs"]
mod history;
#[path = "../../src/host_url.rs"]
mod host_url;
#[path = "../../src/image.rs"]
mod image;
#[path = "../../src/index_parser.rs"]
mod index_parser;
#[path = "../../src/interactive.rs"]
mod interactive;
#[path = "../../src/lfs.rs"]
mod lfs;
#[path = "../../src/net.rs"]
mod net;
#[path = "../../src/notifications.rs"]
mod notifications;
#[path = "../../src/ops.rs"]
mod ops;
#[cfg(unix)]
#[path = "../../src/pack_reader.rs"]
mod pack_reader;
#[path = "../../src/porcelain.rs"]
mod porcelain;
#[path = "../../src/process.rs"]
mod process;
#[path = "../../src/progress.rs"]
mod progress;
#[path = "../../src/raw_diff.rs"]
mod raw_diff;
#[path = "../../src/remote.rs"]
mod remote;
#[path = "../../src/remote_ops.rs"]
mod remote_ops;
#[path = "../../src/rename.rs"]
mod rename;
#[path = "../../src/repository.rs"]
mod repository;
#[path = "../../src/search_query.rs"]
mod search_query;
#[path = "../../src/shell_env.rs"]
mod shell_env;
#[path = "../../src/ssh.rs"]
mod ssh;
#[path = "../../src/stage.rs"]
mod stage;
#[path = "../../src/stats_context.rs"]
mod stats_context;
#[path = "../../src/status.rs"]
mod status;
#[path = "../../src/system.rs"]
mod system;
#[path = "../../src/terminal.rs"]
mod terminal;
#[cfg(test)]
#[path = "../../src/test_repo.rs"]
mod test_repo;
#[path = "../../src/trampoline.rs"]
mod trampoline;
#[path = "../../src/windows_integrations.rs"]
mod windows_integrations;
#[path = "../../src/xdiff.rs"]
mod xdiff;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

/// `createLogParser` 在 Vendor/desktop `app/src/lib/git/log.ts` `getCommits` 里的字段表。
const DESKTOP_LOG_FORMAT: &str =
    "%H%x00%h%x00%s%x00%b%x00%an <%ae> %ad%x00%cn <%ce> %cd%x00%P%x00%(trailers:unfold,only)%x00%D";
const DESKTOP_LOG_FORMAT_ARG: &str =
    "--format=%H%x00%h%x00%s%x00%b%x00%an <%ae> %ad%x00%cn <%ce> %cd%x00%P%x00%(trailers:unfold,only)%x00%D";

struct Options {
    repo: PathBuf,
    iterations: usize,
    limit: usize,
    skip: usize,
    /// 只跑 status 分解测量（调优时快速复测用）
    status_only: bool,
    /// 只跑引用读取分解测量
    refs_only: bool,
    /// 只跑老文件 blame 的分段测量
    blame_only: bool,
    /// 分段测量指定这些文件（不给时自动选老文件）
    blame_files: Vec<String>,
    /// 分段测量用 `blame <rev>`（默认是 Desktop 的工作区形式）
    blame_revision: Option<String>,
}

fn parse_args() -> Options {
    let mut options = Options {
        repo: PathBuf::new(),
        iterations: 10,
        limit: 100,
        skip: 2000,
        status_only: false,
        refs_only: false,
        blame_only: false,
        blame_files: Vec::new(),
        blame_revision: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().unwrap_or_else(|| panic!("{name} 需要一个值"));
        match arg.as_str() {
            "--repo" => options.repo = PathBuf::from(value("--repo")),
            "--iterations" => options.iterations = value("--iterations").parse().expect("--iterations 必须是整数"),
            "--limit" => options.limit = value("--limit").parse().expect("--limit 必须是整数"),
            "--skip" => options.skip = value("--skip").parse().expect("--skip 必须是整数"),
            "--status-only" => options.status_only = true,
            "--refs-only" => options.refs_only = true,
            "--blame-only" => options.blame_only = true,
            "--blame-file" => options.blame_files.push(value("--blame-file")),
            "--blame-revision" => options.blame_revision = Some(value("--blame-revision")),
            other => panic!("未知参数: {other}"),
        }
    }
    assert!(options.repo.is_dir(), "--repo 必须指向一个仓库目录");
    assert!(options.iterations > 0, "--iterations 必须大于 0");
    options
}

/// 直接起系统 git，和 dugite 一样不经过本项目的封装。
/// 工作区 blame 的假提交时间是「现在」，两侧跑的时刻可能跨秒：比较前把它抹平
fn without_fake_times(porcelain: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(porcelain.len());
    let mut fake = false;
    for line in porcelain.split_inclusive(|b| *b == b'\n') {
        if fake && (line.starts_with(b"author-time ") || line.starts_with(b"committer-time ")) {
            out.extend_from_slice(&line[..line.iter().position(|b| *b == b' ').unwrap_or(0)]);
            out.extend_from_slice(b" NOW\n");
        } else {
            out.extend_from_slice(line);
        }
        fake = line.ends_with(b"<not.committed.yet>\n");
    }
    out
}

fn git(repo: &Path, args: &[&str]) -> Vec<u8> {
    git_with_codes(repo, args, &[0])
}

/// 带标准输入的 git 调用（`check-attr --stdin`）。
fn git_stdin(repo: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("无法启动 git");
    child.stdin.take().unwrap().write_all(input).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

/// 和 dugite 的 successExitCodes 一样，有些命令用非零退出码表示「没有结果」。
fn git_with_codes(repo: &Path, args: &[&str], codes: &[i32]) -> Vec<u8> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output().expect("无法启动 git");
    assert!(
        out.status.code().is_some_and(|code| codes.contains(&code)),
        "git {} 失败: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

/// `git blame --porcelain HEAD -- <file>` 的逐行归属：(提交, 原始行号, 原始路径)。
/// 关掉按需取 blob，blobless 克隆里缺历史 blob 的文件直接失败而不是走网络。
fn git_blame_rows(repo: &Path, file: &str) -> Option<Vec<(String, u32, String)>> {
    let out = Command::new("git")
        .env("GIT_NO_LAZY_FETCH", "1")
        .arg("-C")
        .arg(repo)
        .args(["blame", "--porcelain", "HEAD", "--", file])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut rows = Vec::new();
    let (mut sha, mut original, mut path) = (String::new(), 0u32, String::new());
    for line in String::from_utf8_lossy(&out.stdout).split('\n') {
        if line.starts_with('\t') {
            rows.push((sha.clone(), original, path.clone()));
            continue;
        }
        let fields: Vec<_> = line.split(' ').collect();
        if fields.len() >= 3 && fields[0].len() >= 40 && fields[0].bytes().all(|ch| ch.is_ascii_hexdigit()) {
            sha = fields[0].into();
            original = fields[1].parse().ok()?;
        } else if let Some(name) = line.strip_prefix("filename ") {
            path = name.into();
        }
    }
    Some(rows)
}

/// gix-blame（gix 自带的 `blame` 特性）对同一文件的逐行归属，形状与 `git_blame_rows` 相同。
fn gix_blame_rows(repo: &Path, file: &str) -> Option<Vec<(String, u32, String)>> {
    use gix::bstr::ByteSlice;
    let repo = gix::open(repo).ok()?;
    let head = repo.head_id().ok()?.detach();
    let options = gix::repository::blame_file::Options {
        diff_algorithm: Some(gix::diff::blob::Algorithm::Myers),
        ranges: Default::default(),
        since: None,
        rewrites: Some(Default::default()),
    };
    let outcome = repo.blame_file(file.as_bytes().as_bstr(), head, options).ok()?;
    let mut rows = Vec::new();
    for entry in &outcome.entries {
        let path = entry.source_file_name.as_ref().map_or_else(|| file.to_string(), ToString::to_string);
        for offset in 0..entry.len.get() {
            rows.push((entry.commit_id.to_string(), entry.start_in_source_file + 1 + offset, path.clone()));
        }
    }
    Some(rows)
}

/// 「老文件」：HEAD 里最后一次改动最早的跟踪文件。`git log --name-only --no-renames HEAD`（不含合并提交的
/// diff）从新到旧扫一遍，路径第一次出现的位置就是它最后一次被改的提交；按这个位置从旧到新排，
/// 同一目录只取一个（同一次导入的文件历史形状相同），取前 `count` 个进程内 blame 不让位的。
/// blame 要从 HEAD 一路走到那次改动，沿途每个提交都要确认这个路径没变：这是路径查找最重的形状。
fn old_files(repo: &Path, count: usize) -> Vec<String> {
    use std::collections::{HashMap, HashSet};
    let log = git(repo, &["-c", "core.quotePath=false", "log", "--format=%x01", "--name-only", "--no-renames", "HEAD"]);
    let mut last_touch: HashMap<&[u8], usize> = HashMap::new();
    let mut commit = 0;
    for line in log.split(|b| *b == b'\n') {
        if line == b"\x01" {
            commit += 1;
        } else if !line.is_empty() {
            last_touch.entry(line).or_insert(commit);
        }
    }
    let mut tracked: Vec<(usize, String)> = git(repo, &["ls-files", "-z"])
        .split(|b| *b == 0)
        .filter_map(|path| Some((*last_touch.get(path)?, String::from_utf8(path.to_vec()).ok()?)))
        .collect();
    tracked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut directories = HashSet::new();
    let mut out = Vec::new();
    for (_, file) in tracked {
        if out.len() == count {
            break;
        }
        let directory = file.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
        if directories.contains(&directory) || blame_engine::porcelain(repo, Some("HEAD"), &file).is_err() {
            continue;
        }
        directories.insert(directory);
        out.push(file);
    }
    out
}

/// 老文件逐个计时：进程内（带分段）与 Desktop 的 `git blame --porcelain -- <file>`，同一次运行里交替跑。
fn blame_breakdown(repo: &Path, files: &[String], revision: Option<&str>, iterations: usize) -> Value {
    let median = |mut samples: Vec<f64>| {
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        samples[samples.len() / 2]
    };
    let ms = |duration: std::time::Duration| duration.as_secs_f64() * 1000.0;
    let mut rows = Vec::new();
    for file in files {
        let mut args = vec!["blame", "--porcelain"];
        args.extend(revision);
        args.extend(["--", file.as_str()]);
        let reference = git(repo, &args);
        let (out, _) = blame_engine::porcelain_profiled(repo, revision, file).expect("进程内 blame 让位");
        assert_eq!(without_fake_times(&out), without_fake_times(&reference), "{file} 与 git 不一致");
        let (mut ours, mut theirs) = (Vec::new(), Vec::new());
        let mut phases: Vec<[f64; 6]> = Vec::new();
        let mut counts = (0, 0, 0, 0);
        for _ in 0..iterations {
            let started = Instant::now();
            let (_, profile) = blame_engine::porcelain_profiled(repo, revision, file).expect("进程内 blame 让位");
            ours.push(ms(started.elapsed()));
            phases.push([
                ms(profile.setup),
                ms(profile.lookup),
                ms(profile.diff),
                ms(profile.rename),
                ms(profile.output),
                ms(profile.diff_inline),
            ]);
            counts = (profile.passes, profile.lookups, profile.diffs_ahead, profile.diffs_inline);
            let started = Instant::now();
            git(repo, &args);
            theirs.push(ms(started.elapsed()));
        }
        let phase = |i: usize| median(phases.iter().map(|p| p[i]).collect());
        let other = median(ours.iter().zip(&phases).map(|(total, p)| total - p.iter().sum::<f64>()).collect());
        rows.push(json!({
            "file": file,
            "gitcub_median_ms": median(ours),
            "desktop_median_ms": median(theirs),
            "setup_ms": phase(0),
            "lookup_ms": phase(1),
            "diff_ms": phase(2),
            "rename_ms": phase(3),
            "output_ms": phase(4),
            "diff_inline_ms": phase(5),
            "other_ms": other,
            "passes": counts.0,
            "lookups": counts.1,
            "diffs_ahead": counts.2,
            "diffs_inline": counts.3,
        }));
    }
    Value::Array(rows)
}

fn measure(iterations: usize, mut run: impl FnMut() -> usize) -> Value {
    measure_prepared(iterations, || (), |()| run())
}

/// 同 [`measure`]，每次计时前先做 `setup`（不计入耗时）。
fn measure_after(iterations: usize, setup: impl FnMut(), mut run: impl FnMut() -> usize) -> Value {
    measure_prepared(iterations, setup, |()| run())
}

/// 每次计时前先跑一遍不计时的 `prepare`（例如翻到要测的那一页之前）。
fn measure_prepared<T>(iterations: usize, mut prepare: impl FnMut() -> T, mut run: impl FnMut(T) -> usize) -> Value {
    let mut samples = Vec::with_capacity(iterations);
    let mut result = 0;
    for _ in 0..iterations {
        let input = prepare();
        let started = Instant::now();
        result = run(input);
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!({
        "samples_ms": samples,
        "min_ms": sorted[0],
        "median_ms": sorted[sorted.len() / 2],
        "max_ms": sorted[sorted.len() - 1],
        "result": result,
    })
}

/// `status::status` 各阶段单独计时：每一阶段都从新打开的仓库开始，和生产路径一样不复用缓存。
/// 生产路径里这些阶段是并行的（HEAD–索引比较、已跟踪文件比较、目录遍历各在自己的线程），
/// 所以各阶段之和大于整体；看的是哪一段决定了整体耗时。线程数扫描是 `tracked_threads` /
/// `walk_threads` 取值的依据。
fn status_breakdown(repo_path: &Path, iterations: usize) -> Value {
    use gix::status::UntrackedFiles;
    let open = || status::open_with_excludes(repo_path).expect("打开仓库失败");
    let gix_status = |untracked: UntrackedFiles, tree_index: bool, threads: Option<usize>| {
        let repo = open();
        let platform = repo
            .status(gix::progress::Discard)
            .expect("status")
            .untracked_files(untracked)
            .index_worktree_options_mut(|options| options.thread_limit = threads);
        if tree_index {
            platform.into_iter(Vec::new()).expect("iter").filter_map(Result::ok).count()
        } else {
            platform.into_index_worktree_iter(Vec::new()).expect("iter").filter_map(Result::ok).count()
        }
    };
    let parallel_walk = |threads: usize| {
        let repo = open();
        let index = repo.index_or_empty().expect("读索引失败");
        status::untracked::Walk::new(&repo, &index).and_then(|walk| walk.run(threads)).expect("并行遍历失败").len()
    };
    // 计时前先断言并行遍历与 gix 自己的单线程遍历报出同一组未跟踪路径。
    {
        let repo = open();
        let index = repo.index_or_empty().expect("读索引失败");
        let mut parallel = status::untracked::Walk::new(&repo, &index)
            .and_then(|walk| walk.run(status::walk_threads()))
            .expect("并行遍历失败");
        parallel.sort();
        let mut serial: Vec<String> = repo
            .status(gix::progress::Discard)
            .expect("status")
            .untracked_files(UntrackedFiles::Files)
            .into_index_worktree_iter(Vec::new())
            .expect("iter")
            .filter_map(Result::ok)
            .filter(|item| matches!(item, gix::status::index_worktree::Item::DirectoryContents { .. }))
            .map(|item| item.rela_path().to_string())
            .collect();
        serial.sort();
        assert_eq!(parallel, serial, "并行遍历与 gix status 的未跟踪集合不同");
        // 已跟踪比较里有多少条目要读文件内容（racy 或 stat 不符）：决定 lstat 之外还有多少工作。
        let mut iter = repo
            .status(gix::progress::Discard)
            .expect("status")
            .untracked_files(UntrackedFiles::None)
            .into_index_worktree_iter(Vec::new())
            .expect("iter");
        for item in iter.by_ref() {
            item.expect("status 项");
        }
        let outcome = iter.into_outcome().expect("outcome").index_worktree.tracked_file_modification;
        eprintln!(
            "已跟踪比较：{} 条目，lstat {} 次，racy {}，读文件 {}（{} 字节），读对象 {}，需更新 stat {}",
            outcome.entries_to_process,
            outcome.symlink_metadata_calls,
            outcome.racy_clean,
            outcome.worktree_files_read,
            outcome.worktree_bytes,
            outcome.odb_objects_read,
            outcome.entries_to_update
        );
    }
    let mut phases: Vec<(String, Value)> = vec![
        ("open (open_with_excludes)".into(), measure(iterations, || usize::from(open().workdir().is_some()))),
        (
            "open + read index".into(),
            measure(iterations, || open().index_or_empty().expect("读索引失败").entries().len()),
        ),
        (
            "open + HEAD tree vs index (tree_index_status)".into(),
            measure(iterations, || {
                let repo = open();
                let index = repo.index_or_empty().expect("读索引失败");
                let tree = repo.head_tree_id_or_empty().expect("HEAD 树");
                let mut changes = 0usize;
                repo.tree_index_status(&tree, &index, None, Default::default(), |_, _, _| {
                    changes += 1;
                    Ok(std::ops::ControlFlow::Continue(()))
                })
                .expect("tree_index_status");
                changes
            }),
        ),
    ];
    // HEAD 与索引按 cache-tree 跳过没变的子树（status::tree_index），计时前断言与 gix 的结果相同。
    {
        let repo = open();
        let index = repo.index_or_empty().expect("读索引失败");
        let head = repo.head_tree_id_or_empty().expect("HEAD 树").detach();
        let (mut fast, outcome) = status::tree_index::changes(&repo, &index).expect("tree_index");
        let mut reference = status::tree_index::via_gix(&repo, &index, head).expect("via_gix");
        fast.sort();
        reference.sort();
        assert_eq!(fast, reference, "cache-tree 快速路径与 gix 的 HEAD–索引比较不同");
        eprintln!("HEAD–索引：{} 处改动，{outcome:?}", fast.len());
    }
    phases.push((
        "open + HEAD tree vs index, cache-tree (tree_index::changes)".into(),
        measure(iterations, || {
            let repo = open();
            let index = repo.index_or_empty().expect("读索引失败");
            status::tree_index::changes(&repo, &index).expect("tree_index").0.len()
        }),
    ));
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    for threads in [1, 4, status::tracked_threads(), cores] {
        let name = format!("open + index vs worktree, tracked only, {threads} threads");
        if !phases.iter().any(|(existing, _)| *existing == name) {
            phases.push((name, measure(iterations, || gix_status(UntrackedFiles::None, false, Some(threads)))));
        }
    }
    // stat 预检（status::preload）：相符的条目不再交给 gix，gix 只比较剩下的子集。
    let preload_with = |threads: usize, dense: usize| {
        let repo = open();
        let index = repo.index_or_empty().expect("读索引失败");
        let settings =
            status::preload::Settings { dense, ..status::preload::Settings::of(&repo).expect("stat 选项") };
        let (rest, outcome) = status::preload::unresolved(&index, repo.workdir().expect("工作区"), settings, threads)
            .expect("稀疏索引不预检");
        let rest = gix::index::File::from_state(rest, repo.index_path());
        (repo, rest, outcome)
    };
    let preload = |threads: usize| preload_with(threads, status::preload::DENSE);
    // gix 的已跟踪改动，按路径与状态比较（子集里的条目序号与完整索引不同）
    let tracked_items = |repo: &gix::Repository, index: gix::worktree::IndexPersistedOrInMemory| {
        let mut items: Vec<String> = repo
            .status(gix::progress::Discard)
            .expect("status")
            .index(index)
            .untracked_files(UntrackedFiles::None)
            .index_worktree_options_mut(|options| options.thread_limit = Some(status::tracked_threads()))
            .into_index_worktree_iter(Vec::new())
            .expect("iter")
            .map(|item| match item.expect("status 项") {
                gix::status::index_worktree::Item::Modification { rela_path, status, .. } => {
                    format!("{rela_path} {status:?}")
                }
                other => format!("{other:?}"),
            })
            .collect();
        items.sort();
        items
    };
    {
        let (repo, rest, outcome) = preload(status::preload_threads());
        let left = rest.entries().len();
        let with = tracked_items(&repo, rest.into());
        let without = tracked_items(&repo, repo.index_or_empty().expect("读索引失败").into());
        assert_eq!(with, without, "预检后 gix 的已跟踪比较结果不同");
        eprintln!("stat 预检：{outcome:?}，留给 gix {left} 个条目，已跟踪改动 {} 项", with.len());
    }
    for threads in [1, 2, 4, 6, cores] {
        let name = format!("open + stat preload (fstatat in dense directories), {threads} threads");
        if !phases.iter().any(|(existing, _)| *existing == name) {
            phases.push((name, measure(iterations, || preload(threads).2.marked)));
        }
    }
    // 打开目录再 fstatat 的门槛：usize::MAX = 全部用完整路径 lstat
    for dense in [1, 4, 64, usize::MAX] {
        let threads = status::preload_threads();
        let label = if dense == usize::MAX { "never".to_string() } else { format!("from {dense} entries") };
        let name = format!("open + stat preload, {threads} threads, fstatat {label} per directory");
        phases.push((name, measure(iterations, || preload_with(threads, dense).2.marked)));
    }
    phases.push((
        "open + stat preload + gix on the rest (production tracked compare)".into(),
        measure(iterations, || {
            let (repo, rest, _) = preload(status::preload_threads());
            if rest.entries().is_empty() { 0 } else { tracked_items(&repo, rest.into()).len() }
        }),
    ));
    phases.push((
        "open + gix single-threaded dirwalk (previous)".into(),
        measure(iterations, || {
            let repo = open();
            let index = repo.index_or_empty().expect("读索引失败");
            let options =
                repo.dirwalk_options().expect("dirwalk").emit_untracked(gix::dir::walk::EmissionMode::Matching);
            repo.dirwalk_iter(index, Vec::<gix::bstr::BString>::new(), Default::default(), options)
                .expect("dirwalk")
                .filter_map(Result::ok)
                .count()
        }),
    ));
    for threads in [1, 2, status::walk_threads(), 8] {
        let name = format!("open + parallel dirwalk (untracked::Walk), {threads} threads");
        if !phases.iter().any(|(existing, _)| *existing == name) {
            phases.push((name, measure(iterations, || parallel_walk(threads))));
        }
    }
    // 未跟踪缓存：冷 = 整体并行遍历 + 每个目录读之前的探测（目录、.git、.gitignore 三次 lstat）+ 建记录；
    // 热 = 并行 lstat 所有记录的目录后直接复用。都从新打开的仓库开始，和 status::status 一样。
    let cache = std::cell::RefCell::new(status::untracked_cache::Cache::default());
    let cached_walk = |cache: &mut status::untracked_cache::Cache| {
        let repo = open();
        let index = repo.index_or_empty().expect("读索引失败");
        let prepared = status::untracked_cache::prepare(&repo, &index);
        assert!(prepared.is_some(), "基准仓库所在的卷不能用未跟踪缓存");
        let walk = status::untracked::Walk::new(&repo, &index).expect("准备遍历失败");
        let found = cache.untracked(prepared, walk, status::walk_threads()).expect("遍历失败");
        found.len()
    };
    phases.push((
        "open + untracked cache, cold (parallel walk + probes + records)".into(),
        measure_after(iterations, || cache.borrow_mut().clear(), || cached_walk(&mut cache.borrow_mut())),
    ));
    cached_walk(&mut cache.borrow_mut());
    phases.push(("open + untracked cache, warm".into(), measure(iterations, || cached_walk(&mut cache.borrow_mut()))));
    let cache = cache.into_inner();
    assert!(!cache.last.full && cache.last.fresh_roots == 0, "热缓存不应重读目录：{:?}", cache.last);
    eprintln!("未跟踪缓存：热调用复用 {} 个目录", cache.last.reused);
    // 缓存热时的两段 lstat：stat 预检（已跟踪文件与它们路径上的各级目录）与未跟踪缓存校验记录（每个记录的
    // 目录与在的 `.gitignore`）。单跑、并跑（这次改动前的生产做法）、先后跑、合并（校验直接用预检取到的
    // 目录 lstat）分开计时，都从已打开的仓库开始。
    {
        let fresh = || {
            let repo = open();
            let index = repo.index_or_empty().expect("读索引失败");
            let prepared = status::untracked_cache::prepare(&repo, &index).expect("能用未跟踪缓存");
            (repo, index, prepared)
        };
        let settings = |repo: &gix::Repository| status::preload::Settings::of(repo).expect("stat 选项");
        let preload_only =
            |repo: &gix::Repository, index: &gix::index::File, dirs: Option<&mut status::preload::DirStats>| {
                let workdir = repo.workdir().expect("工作区");
                status::preload::unresolved_with_dirs(index, workdir, settings(repo), status::preload_threads(), dirs)
                    .expect("稀疏索引不预检")
                    .1
                    .marked
            };
        let (repo, index, prepared) = fresh();
        let mut dirs = status::preload::DirStats::new();
        preload_only(&repo, &index, Some(&mut dirs));
        let records = cache.validate(&prepared).expect("有记录");
        let mut shared = prepared;
        let sender = shared.share_dir_stats();
        let known = dirs.len();
        sender.send(dirs).expect("发送");
        assert_eq!(cache.validate(&shared), Some(records), "用预检的目录 lstat 校验结论不同");
        eprintln!("缓存热：{records} 个目录记录可复用，预检顺带 lstat 了 {known} 个目录");
        phases.extend([
            (
                "warm: prepare + Walk::new (repo open)".to_string(),
                measure_prepared(
                    iterations,
                    || (open(), ()),
                    |(repo, ())| {
                        let index = repo.index_or_empty().expect("读索引失败");
                        let prepared = status::untracked_cache::prepare(&repo, &index);
                        let walk = status::untracked::Walk::new(&repo, &index).expect("准备遍历失败");
                        usize::from(prepared.is_some()) + walk.index().entries().len()
                    },
                ),
            ),
            (
                "warm: stat preload alone (repo open)".to_string(),
                measure_prepared(iterations, fresh, |(repo, index, _)| preload_only(&repo, &index, None)),
            ),
            (
                "warm: untracked cache record check alone (repo open)".to_string(),
                measure_prepared(iterations, fresh, |(_, _, prepared)| cache.validate(&prepared).unwrap_or(0)),
            ),
            (
                "warm: preload ∥ record check, in parallel (before)".to_string(),
                measure_prepared(iterations, fresh, |(repo, index, prepared)| {
                    std::thread::scope(|scope| {
                        let cache = &cache;
                        let checked = scope.spawn(move || cache.validate(&prepared).unwrap_or(0));
                        preload_only(&repo, &index, None) + checked.join().expect("校验")
                    })
                }),
            ),
            (
                "warm: preload, then record check (serial)".to_string(),
                measure_prepared(iterations, fresh, |(repo, index, prepared)| {
                    preload_only(&repo, &index, None) + cache.validate(&prepared).unwrap_or(0)
                }),
            ),
            (
                "warm: preload shares its directory lstats with the record check (merged)".to_string(),
                measure_prepared(iterations, fresh, |(repo, index, mut prepared)| {
                    let sender = prepared.share_dir_stats();
                    std::thread::scope(|scope| {
                        let cache = &cache;
                        let checked = scope.spawn(move || cache.validate(&prepared).unwrap_or(0));
                        let mut dirs = status::preload::DirStats::new();
                        let marked = preload_only(&repo, &index, Some(&mut dirs));
                        let _ = sender.send(dirs);
                        marked + checked.join().expect("校验")
                    })
                }),
            ),
        ]);
    }
    phases.extend([
        (
            "open + full gix status iterator, default threads (previous core)".to_string(),
            measure(iterations, || gix_status(UntrackedFiles::Files, true, None)),
        ),
        (
            "open + read index + conflicts".into(),
            measure(iterations, || status::conflicts(&open().index_or_empty().expect("读索引失败"), repo_path).len()),
        ),
        (
            "open + ahead/behind".into(),
            measure(iterations, || {
                let (_, ahead, behind) = status::ahead_behind(&open());
                (ahead + behind) as usize
            }),
        ),
        (
            "open + remotes, operation".into(),
            measure(iterations, || {
                let repo = open();
                repo.remote_names().len() + usize::from(ops::in_progress(repo.path()).is_some())
            }),
        ),
        (
            // 改动前的 status::status 依次做的事（不含分桶）：一个 gix 迭代器（默认线程、单线程遍历），
            // 再打开一次索引查冲突，然后领先/落后、远端与进行中的操作。
            "previous status::status work, serial".into(),
            measure(iterations, || {
                let changes = gix_status(UntrackedFiles::Files, true, None);
                let repo = open();
                let conflicts = status::conflicts(&repo.open_index().expect("读索引失败"), repo_path).len();
                let (_, ahead, behind) = status::ahead_behind(&repo);
                changes + conflicts + (ahead + behind) as usize + repo.remote_names().len()
            }),
        ),
        (
            "status::status (total, untracked cache cold)".into(),
            measure_after(iterations, status::untracked_cache::clear, || {
                status::status(repo_path).expect("status").changes.len()
            }),
        ),
        ("status::status (total, untracked cache warm)".into(), {
            status::status(repo_path).expect("status");
            measure(iterations, || status::status(repo_path).expect("status").changes.len())
        }),
        ("status::status (total, untracked cache warm, record check lstats on its own)".into(), {
            let tuning = status::Tuning { share_dir_stats: false, ..status::Tuning::default() };
            status::status_tuned(repo_path, tuning).expect("status");
            measure(iterations, || status::status_tuned(repo_path, tuning).expect("status").changes.len())
        }),
    ]);
    Value::Array(phases.into_iter().map(|(name, m)| json!({ "phase": name, "timing": m })).collect())
}

/// 读引用的各段单独计时，每一段都从新打开的仓库开始：`branch::list` 的开销在打开仓库、遍历引用
/// （松散文件逐个读，再与 packed-refs 归并）、读分支配置与拼行之间怎么分。`history::tag_index`
/// 命中缓存时只剩指纹（`refs` 树里每个文件一次 stat）。
fn refs_breakdown(repo_path: &Path, iterations: usize) -> Value {
    let open = || gix::open(repo_path).expect("打开仓库失败");
    let count = |iter: gix::reference::iter::Iter<'_, '_>| iter.filter_map(Result::ok).count();
    let loose_files = || {
        fn walk(path: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(path) else { return };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    walk(&entry.path(), out);
                } else {
                    out.push(entry.path());
                }
            }
        }
        let mut out = Vec::new();
        walk(&open().common_dir().join("refs"), &mut out);
        out
    };
    let phases: Vec<(String, Value)> = vec![
        ("gix::open".into(), measure(iterations, || usize::from(open().is_bare()))),
        (
            "open + references().all()".into(),
            measure(iterations, || count(open().references().expect("引用").all().expect("遍历"))),
        ),
        (
            "open + prefixed(refs/heads/, refs/remotes/)".into(),
            measure(iterations, || {
                let repo = open();
                let platform = repo.references().expect("引用");
                count(platform.prefixed("refs/heads/").expect("遍历"))
                    + count(platform.prefixed("refs/remotes/").expect("遍历"))
            }),
        ),
        (
            "walk refs/ + read every loose file (std::fs)".into(),
            measure(iterations, || {
                loose_files().iter().map(|path| std::fs::read(path).map_or(0, |data| data.len())).sum()
            }),
        ),
        (
            "open + config sections".into(),
            measure(iterations, || open().config_snapshot().plumbing().sections().count()),
        ),
        (
            "branch::records_in_process".into(),
            measure(iterations, || branch::records_in_process(repo_path, None).expect("让位给 git").len()),
        ),
        ("branch::list".into(), measure(iterations, || branch::list(repo_path, None).expect("分支列表失败").len())),
        (
            // 并行读的收益不稳定（同一目录下的 open 在内核里争用，4 线程约快一倍，8 线程又回到串行水平）；
            // 全量扫描只在首次读取和 packed-refs 变化时发生，所以没有绕开 gix 自己并行读松散文件。
            "walk refs/ + read every loose file (4 threads)".into(),
            measure(iterations, || {
                let files = loose_files();
                std::thread::scope(|scope| {
                    let handles: Vec<_> = files
                        .chunks(files.len().div_ceil(4).max(1))
                        .map(|chunk| {
                            scope.spawn(move || {
                                chunk.iter().map(|path| std::fs::read(path).map_or(0, |m| m.len())).sum::<usize>()
                            })
                        })
                        .collect();
                    handles.into_iter().map(|handle| handle.join().unwrap()).sum::<usize>()
                })
            }),
        ),
        (
            "walk refs/ + stat every entry".into(),
            measure(iterations, || {
                loose_files().iter().map(|path| std::fs::metadata(path).map_or(0, |m| m.len() as usize)).sum()
            }),
        ),
        ("walk refs/ only".into(), measure(iterations, || loose_files().len())),
        (
            "open + history::tag_index (cache hit)".into(),
            measure(iterations, || history::tag_index(&open()).expect("标签索引").len()),
        ),
        (
            "open + history ref index rebuild (cache miss)".into(),
            measure(iterations, || history::rebuild_ref_index(&open()).expect("引用索引")),
        ),
        (
            "open + all() + peel every ref".into(),
            measure(iterations, || {
                let repo = open();
                let platform = repo.references().expect("引用");
                platform.all().expect("遍历").filter_map(Result::ok).filter_map(|mut r| r.peel_to_id().ok()).count()
            }),
        ),
        ("status::branches".into(), measure(iterations, || status::branches(repo_path).expect("branches 失败").len())),
    ];
    Value::Array(phases.into_iter().map(|(name, m)| json!({ "phase": name, "timing": m })).collect())
}

fn main() {
    let options = parse_args();
    let repo = options.repo.as_path();
    let iterations = options.iterations;
    if options.status_only {
        let args = ["--no-optional-locks", "status", "--untracked-files=all", "--branch", "--porcelain=2", "-z"];
        let desktop = measure(iterations, || git(repo, &args).len());
        let breakdown = status_breakdown(repo, iterations);
        let report = json!({ "repo": repo, "status_breakdown": breakdown, "desktop_status": desktop });
        println!("{}", serde_json::to_string_pretty(&report).expect("序列化失败"));
        return;
    }
    if options.blame_only {
        let files = if options.blame_files.is_empty() { old_files(repo, 4) } else { options.blame_files.clone() };
        let report = json!({ "repo": repo, "blame_breakdown": blame_breakdown(repo, &files, options.blame_revision.as_deref(), iterations) });
        println!("{}", serde_json::to_string_pretty(&report).expect("序列化失败"));
        return;
    }
    if options.refs_only {
        let args = [
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname)%00%(symref)%00",
            "refs/heads",
            "refs/remotes",
        ];
        let desktop = measure(iterations, || git(repo, &args).len());
        let breakdown = refs_breakdown(repo, iterations);
        let report = json!({ "repo": repo, "refs_breakdown": breakdown, "desktop_for_each_ref": desktop });
        println!("{}", serde_json::to_string_pretty(&report).expect("序列化失败"));
        return;
    }
    let head = String::from_utf8(git(repo, &["rev-parse", "HEAD"])).expect("HEAD 不是 UTF-8").trim().to_string();
    let limit = options.limit.to_string();
    let skip = options.skip.to_string();
    let format = format!("--format={DESKTOP_LOG_FORMAT}");

    let porcelain_entries = |stdout: &[u8]| stdout.split(|b| *b == 0).filter(|line| !line.is_empty()).count();
    let log_records = |stdout: &[u8]| stdout.split(|b| *b == 0).count() / 9;
    let lines = |stdout: &[u8]| stdout.split(|b| *b == b'\n').filter(|line| !line.is_empty()).count();
    let first_entry = |stdout: &[u8]| {
        stdout.split(|b| *b == 0).find(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned())
    };
    // 工作区 diff 用第一个已改动的跟踪文件；工作区干净时退回第一个跟踪文件（空 diff）。
    let tracked = first_entry(&git(repo, &["ls-files", "-z"])).expect("仓库没有跟踪文件");
    let changed =
        first_entry(&git(repo, &["diff", "--name-only", "-z", "HEAD", "--"])).unwrap_or_else(|| tracked.clone());
    let status_args = ["--no-optional-locks", "status", "--untracked-files=all", "--branch", "--porcelain=2", "-z"];
    let log_args = [
        "log",
        "--date=raw",
        "--max-count=100",
        "-z",
        DESKTOP_LOG_FORMAT_ARG,
        "--no-show-signature",
        "--no-color",
        "--",
    ];
    // 提交图行的 git 一侧：GitLens graph.ts 的 `log … --date-order --all`（去掉 refs/pull），输出仍用 Desktop 的格式；
    // `graph::graph` 遍历同一组引用、排同一种序。
    let graph_max_count = format!("--max-count={limit}");
    let graph_log = |skip: usize| -> usize {
        let skip = format!("--skip={skip}");
        let mut args = vec!["log", "--date-order", "--date=raw", graph_max_count.as_str()];
        if skip != "--skip=0" {
            args.push(skip.as_str());
        }
        args.extend([
            "-z",
            format.as_str(),
            "--no-show-signature",
            "--no-color",
            "--exclude=refs/pull/*",
            "--all",
            "--",
        ]);
        log_records(&git(repo, &args))
    };
    // Desktop for-each-ref.ts getBranches 的字段，记录间同样以 NUL 分隔。
    let for_each_ref_args = [
        "for-each-ref",
        "--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname)%00%(symref)%00",
        "refs/heads",
        "refs/remotes",
    ];

    // Desktop `getCommits` 带修订号时的命令：附加参数、奇数个 `--not` 时补一个、`--end-of-options <rev>`。
    let revision_log = |revision: &str, max: usize, additional: &[&str]| {
        let max = format!("--max-count={max}");
        let mut args =
            vec!["log", "--date=raw", max.as_str(), "-z", format.as_str(), "--no-show-signature", "--no-color"];
        args.extend_from_slice(additional);
        if additional.iter().filter(|arg| **arg == "--not").count() % 2 == 1 {
            args.push("--not");
        }
        args.extend(["--end-of-options", revision, "--"]);
        log_records(&git(repo, &args))
    };
    // 本地提交范围的下界：有远端跟踪分支时用 Desktop 的 `upstream..branch`，否则退到 HEAD~5。
    let upstream = git_with_codes(repo, &["rev-parse", "--verify", "-q", "refs/remotes/origin/main"], &[0, 1]);
    let range = if upstream.is_empty() {
        let base = String::from_utf8(git(repo, &["rev-parse", "HEAD~5"])).expect("HEAD~5 不是 UTF-8");
        format!("{}..HEAD", base.trim())
    } else {
        "origin/main..HEAD".to_string()
    };
    let not_remotes = ["--not".to_string(), "--remotes".to_string()];
    // Desktop `getAheadBehind(revSymmetricDifference(branch, upstream))`。
    let symmetric = range.replacen("..", "...", 1);

    // Desktop `getRemotes`（app/src/lib/git/remote.ts），`_refreshRepository` 每次刷新都跑。
    let desktop_remotes = || {
        git(repo, &["rev-parse", "--git-dir"]);
        let config = git_with_codes(repo, &["config", "--null", "--get-regexp", r"^remote\..+\.url$"], &[0, 1]);
        let mut names = std::collections::BTreeSet::new();
        for entry in String::from_utf8_lossy(&config).split_terminator('\0') {
            let (key, value) = entry.split_once('\n').expect("远端配置缺少值");
            let name = key.strip_prefix("remote.").and_then(|key| key.strip_suffix(".url")).expect("远端键格式不对");
            if value.is_empty() {
                names.remove(name);
            } else {
                names.insert(name.to_string());
            }
        }
        names
            .into_iter()
            .map(|name| {
                let url = git(repo, &["-c", "transfer.credentialsInUrl=allow", "ls-remote", "--get-url", "--", &name]);
                (name, String::from_utf8_lossy(url.strip_suffix(b"\n").unwrap_or(&url)).into_owned())
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(remote_ops::list(repo).expect("远端列表失败"), desktop_remotes(), "远端列表与 Desktop 不一致");
    let origin_via_git = || {
        let out = Command::new("git").arg("-C").arg(repo).args(["remote", "get-url", "--", "origin"]).output();
        let out = out.expect("无法启动 git");
        String::from_utf8_lossy(out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout)).into_owned()
    };
    assert_eq!(remote_ops::get_url(repo, "origin").expect("读 origin 失败").unwrap_or_default(), origin_via_git());

    // Desktop `getStashes`（app/src/lib/git/stash.ts），每次刷新都跑；没有 refs/stash 时 git 以 128 退出。
    let stashes_via_git = || {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["log", "-g", "--format=%gD%x00%H%x00%gs%x00%T%x00%P", "refs/stash", "--"])
            .output()
            .expect("无法启动 git");
        String::from_utf8_lossy(&out.stdout).lines().count()
    };
    assert_eq!(ops::stashes(repo).expect("贮藏列表失败").len(), stashes_via_git(), "贮藏数与 git 不一致");

    // Desktop `getConfigValue(repository, "user.name", true)`（app/src/lib/git/config.ts），打开仓库时读本地身份。
    let local_config_via_git = || {
        let out = Command::new("git").arg("-C").arg(repo).args(["config", "-z", "--local", "user.name"]).output();
        out.expect("无法启动 git").stdout.len()
    };
    let local_config = || git_config::get(Some(repo), "user.name", true, false).expect("读本地配置失败");
    assert_eq!(local_config().map_or(0, |value| value.len() + 1), local_config_via_git(), "本地配置与 git 不一致");

    // 进程内的分支记录必须与 git 的 for-each-ref（去掉 symref 行）逐字节相同。
    let via_git = branch::records_via_git(repo, None).expect("for-each-ref 失败").unwrap_or_default();
    let via_git: String = via_git.lines().filter(|line| line.ends_with('\0')).map(|line| format!("{line}\n")).collect();
    assert_eq!(branch::records_in_process(repo, None).as_deref(), Some(via_git.as_str()), "分支记录与 git 不一致");

    // gix-blame 候选（未上线）：按 ls-files 等距抽 8 个两侧都能离线完成的文件，计时前先逐行比对归属。
    // 单个文件说明不了问题：第一个跟踪文件的历史往往很浅，深历史文件才是 blame 的主要开销。
    let all_tracked: Vec<String> = git(repo, &["ls-files", "-z"])
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    let stride = (all_tracked.len() / 8).max(1);
    let mut blame_sample = Vec::new();
    let mut blame_mismatched_files = 0;
    let mut blame_mismatched_lines = 0;
    let mut blame_sample_lines = 0;
    for start in (0..all_tracked.len()).step_by(stride).take(8) {
        // 从等距位置往后找第一个两侧都能离线完成的文件。
        let found = all_tracked[start..]
            .iter()
            .take(32)
            .find_map(|file| Some((file, git_blame_rows(repo, file)?, gix_blame_rows(repo, file)?)));
        let Some((file, reference, candidate)) = found else { continue };
        let differing = reference.iter().zip(&candidate).filter(|(a, b)| a != b).count()
            + reference.len().abs_diff(candidate.len());
        blame_mismatched_files += usize::from(differing > 0);
        blame_mismatched_lines += differing;
        blame_sample_lines += reference.len();
        blame_sample.push(file.clone());
    }
    // 进程内 blame（blame_engine，生产路径）：同一组文件、HEAD 与工作区两种参数，与 git 输出逐字节比对；
    // 让位的照实报告（计时里那些文件走的就是 git）。
    // 老文件（很早加入、之后几乎没改过）：blame 要一路确认每个提交都没动它，见 `old_files`
    let blame_old = old_files(repo, 4);
    let mut engine_identical = 0;
    let mut engine_mismatched = Vec::new();
    let mut engine_refused = Vec::new();
    for file in blame_sample.iter().chain(&blame_old).chain([&tracked]) {
        for revision in [Some("HEAD"), None] {
            let mut args = vec!["blame", "--porcelain"];
            args.extend(revision);
            args.extend(["--", file.as_str()]);
            let reference = git(repo, &args);
            match blame_engine::porcelain(repo, revision, file) {
                Ok(out) if without_fake_times(&out) == without_fake_times(&reference) => engine_identical += 1,
                Ok(_) => engine_mismatched.push(format!("{file} {}", revision.unwrap_or("(worktree)"))),
                Err(reason) => engine_refused.push(format!("{file} {}: {reason}", revision.unwrap_or("(worktree)"))),
            }
        }
    }
    assert!(engine_mismatched.is_empty(), "进程内 blame 与 git 不一致: {engine_mismatched:?}");

    // 工作区 diff：进程内结果先与 Desktop 的 `git diff` 逐字节比对；快速路径让位时照实报告。
    let working_diff_args = |kind: raw_diff::FileKind, file: &str| -> Vec<u8> {
        let mut args = vec!["diff", "--no-ext-diff", "--patch-with-raw", "-z", "--no-color"];
        match kind {
            raw_diff::FileKind::New => args.extend(["--no-index", "--", "/dev/null", file]),
            _ => args.extend(["HEAD", "--", file]),
        }
        git_with_codes(repo, &args, &[0, 1])
    };
    let untracked = first_entry(&git(repo, &["ls-files", "--others", "--exclude-standard", "-z"]));
    let mut working_diff_cases = vec![("working-diff", raw_diff::FileKind::Normal, changed.clone())];
    if let Some(file) = &untracked {
        working_diff_cases.push(("working-diff-new", raw_diff::FileKind::New, file.clone()));
    }
    for (name, kind, file) in &working_diff_cases {
        let via_git = working_diff_args(*kind, file);
        let fast = raw_diff::in_process::working_directory_diff(repo, file, *kind);
        match &fast {
            Ok(bytes) => assert!(*bytes == via_git, "{name} {file}: 进程内 diff 与 git 不一致"),
            Err(reason) => {
                // 让位前白花的时间：回退路径比直接起 git 多出的就是这一段
                let attempt = measure(iterations, || {
                    raw_diff::in_process::working_directory_diff(repo, file, *kind).map_or(0, |bytes| bytes.len())
                });
                eprintln!(
                    "{name} {file}: 快速路径让位给 git（{reason}），尝试耗时中位数 {:.2} ms",
                    attempt["median_ms"].as_f64().unwrap_or(f64::NAN)
                );
            }
        }
        let text =
            raw_diff::working_directory_diff(repo, file, *kind, false).expect("working_directory_diff 失败").text;
        assert_eq!(text, String::from_utf8_lossy(&via_git), "{name} {file}: working_directory_diff 与 git 不一致");
        eprintln!("{name} {file}: {} 字节，进程内作答 {}", via_git.len(), fast.is_ok());
    }

    // 提交文件列表：进程内结果先与 git 输出的解析结果比对；再统计最近 200 个提交里快速路径能作答的比例。
    let commit_files_json = |sha: &str| {
        serde_json::to_string(&history::commit_files_via_git(repo, sha).expect("commit_files 失败")).unwrap()
    };
    match history::commit_files_in_process(repo, &head) {
        Ok(files) => {
            assert_eq!(serde_json::to_string(&files).unwrap(), commit_files_json(&head), "提交文件列表与 git 不一致")
        }
        Err(reason) => eprintln!("commit-files {head}: 快速路径让位给 git（{reason}）"),
    }
    let recent = git(repo, &["rev-list", "--max-count=200", "HEAD"]);
    let recent: Vec<&str> = std::str::from_utf8(&recent).unwrap().lines().collect();
    let (mut answered, mut answered_renames, mut bytes_checked) = (0, 0, 0);
    let mut fallback_reasons: std::collections::BTreeMap<String, usize> = Default::default();
    for sha in &recent {
        match history::commit_files_in_process(repo, sha) {
            Ok(files) => {
                assert_eq!(
                    serde_json::to_string(&files).unwrap(),
                    commit_files_json(sha),
                    "{sha}: 提交文件列表与 git 不一致"
                );
                answered += 1;
                answered_renames += files.iter().any(|file| file.kind == history::CommitFileKind::Renamed) as usize;
            }
            Err(reason) => *fallback_reasons.entry(reason).or_default() += 1,
        }
        // 完整输出（raw 段的状态与分数、numstat 的增删行数）逐字节对照；部分克隆缺对象时 git 不去网络上取
        if let Ok(bytes) = rename::commit_log_output(repo, sha) {
            let full = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["log", "-C", "-M", "-m", "-1", "--no-show-signature", "--first-parent", "--raw"])
                .args(["--format=format:", "--numstat", "-z", "--end-of-options", sha, "--"])
                .env("GIT_NO_LAZY_FETCH", "1")
                .output()
                .expect("无法启动 git");
            if full.status.success() {
                assert!(bytes == full.stdout, "{sha}: 提交文件列表的完整输出与 git 不一致");
                bytes_checked += 1;
            }
        }
    }
    eprintln!(
        "commit-files: 最近 {} 个提交中快速路径作答 {answered} 个（其中含重命名 {answered_renames} 个），\
         完整输出逐字节对照 {bytes_checked} 个，让位原因 {fallback_reasons:?}",
        recent.len()
    );

    // Desktop `getChangedFiles`（app/src/lib/git/log.ts）的 git 命令，只数 raw 记录
    let commit_files_via_cli = |sha: &str| {
        git(
            repo,
            &[
                "log",
                "-C",
                "-M",
                "-m",
                "-1",
                "--no-show-signature",
                "--first-parent",
                "--raw",
                "--format=format:",
                "--numstat",
                "-z",
                "--end-of-options",
                sha,
                "--",
            ],
        )
        .split(|b| *b == 0)
        .filter(|field| field.first() == Some(&b':'))
        .count()
    };

    // 历史里选中文件的 diff：Desktop `getCommitDiff` 的 git 命令；进程内结果先与它逐字节比对。
    // 每个提交取文件列表里的第一个文件（选中提交时默认选中的那个）。
    let commit_diff_via_cli = |sha: &str, file: &str, old_path: Option<&str>| {
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
        args.extend(raw_diff::file_diff_pathspecs(file, old_path));
        git(repo, &args)
    };
    let first_file = |sha: &str| {
        history::commit_files_via_git(repo, sha)
            .expect("commit_files 失败")
            .into_iter()
            .next()
            .map(|file| (sha.to_string(), file.path, file.old_path))
    };
    let (mut commit_diff_answered, mut commit_diff_renames, mut commit_diff_renames_answered) = (0, 0, 0);
    let commit_diff_cases: Vec<_> = recent.iter().filter_map(|sha| first_file(sha)).collect();
    for (sha, file, old_path) in &commit_diff_cases {
        let via_git = commit_diff_via_cli(sha, file, old_path.as_deref());
        commit_diff_renames += old_path.is_some() as usize;
        match raw_diff::in_process::commit_file_diff(repo, sha, file, old_path.as_deref()) {
            Ok(bytes) => {
                assert!(bytes == via_git, "{sha} {file}: 进程内提交 diff 与 git 不一致");
                commit_diff_answered += 1;
                commit_diff_renames_answered += old_path.is_some() as usize;
            }
            Err(reason) => eprintln!("commit-file-diff {sha} {file}: 让位（{reason}）"),
        }
    }
    eprintln!(
        "commit-file-diff: 最近 {} 个提交的第一个文件中快速路径作答 {commit_diff_answered} 个\
         （其中重命名 {commit_diff_renames} 个，作答 {commit_diff_renames_answered} 个）",
        commit_diff_cases.len()
    );
    let commit_diff_head = first_file(&head);
    if let Some((sha, file, old_path)) = &commit_diff_head {
        let text =
            raw_diff::commit_file_diff(repo, sha, file, old_path.as_deref(), false).expect("commit_file_diff 失败");
        assert_eq!(text, String::from_utf8_lossy(&commit_diff_via_cli(sha, file, old_path.as_deref())), "{file}");
        if let Err(reason) = raw_diff::in_process::commit_file_diff(repo, sha, file, old_path.as_deref()) {
            let attempt = measure(iterations, || {
                raw_diff::in_process::commit_file_diff(repo, sha, file, old_path.as_deref()).map_or(0, |b| b.len())
            });
            eprintln!(
                "commit-file-diff {sha} {file}: 快速路径让位给 git（{reason}），尝试耗时中位数 {:.2} ms",
                attempt["median_ms"].as_f64().unwrap_or(f64::NAN)
            );
        }
    }
    let commit_diff_recent = &commit_diff_cases[..commit_diff_cases.len().min(20)];

    // blob 读取（图片预览、语法高亮的两侧内容）：Desktop `getBlobContents` 的 `git show <rev>:<file>`。
    // 取 HEAD 文件列表里第一个在 HEAD 中存在的文件；进程内字节先与 git 比对，HEAD^ 那一侧也比对。
    let show_via_cli = |revision: &str, file: &str| git(repo, &["show", &format!("{revision}:{file}")]);
    let blob_case = history::commit_files_via_git(repo, &head)
        .expect("commit_files 失败")
        .into_iter()
        .find(|file| file.kind != history::CommitFileKind::Deleted)
        .map(|file| file.path);
    if let Some(file) = &blob_case {
        for revision in [head.clone(), format!("{head}^")] {
            let via_git = git_with_codes(repo, &["show", &format!("{revision}:{file}")], &[0, 128]);
            match raw_diff::in_process::blob_contents(repo, &revision, file) {
                Ok(bytes) => assert!(bytes == via_git, "{revision}:{file}: 进程内 blob 与 git 不一致"),
                Err(reason) => eprintln!("blob-read {revision}:{file}: 快速路径让位给 git（{reason}）"),
            }
        }
        assert!(raw_diff::blob_contents(repo, &head, file).expect("blob_contents 失败") == show_via_cli(&head, file));
    }

    // 冲突细节（只有正在合并、变基或弹出贮藏且有冲突的仓库才测）：Desktop `getBinaryPaths`（diff.ts）的
    // `diff --numstat -z <rev>` 加 `check-attr --stdin -z merge`、`getFilesWithConflictMarkers`（diff-check.ts）的
    // `diff --check`；进程内结果先与这三条命令的结果（只看冲突路径）比对。
    let conflict_paths: Vec<String> = {
        let mut paths: Vec<String> = String::from_utf8_lossy(&git(repo, &["ls-files", "-u", "-z"]))
            .split('\0')
            .filter_map(|record| record.split_once('\t').map(|(_, path)| path.to_string()))
            .collect();
        paths.dedup();
        paths
    };
    let conflict_revision = status::conflict_revision(repo);
    let conflict_details_via_cli = || {
        let numstat = git(repo, &["diff", "--numstat", "-z", conflict_revision]);
        let attributes =
            git_stdin(repo, &["check-attr", "--stdin", "-z", "merge"], conflict_paths.join("\0").as_bytes());
        let check = git_with_codes(repo, &["diff", "--check"], &[0, 2]);
        numstat.len() + attributes.len() + check.len()
    };
    if !conflict_paths.is_empty() {
        let via_git_binary: std::collections::HashSet<String> =
            status::binary_paths(repo, conflict_revision, &conflict_paths)
                .expect("binary_paths 失败")
                .into_iter()
                .filter(|path| conflict_paths.contains(path))
                .collect();
        let via_git_markers: std::collections::BTreeMap<String, u32> = status::conflict_markers(repo)
            .expect("conflict_markers 失败")
            .into_iter()
            .filter(|(path, _)| conflict_paths.contains(path))
            .collect();
        match raw_diff::in_process::conflict_details(repo, conflict_revision, &conflict_paths) {
            Ok((binary, markers)) => {
                assert_eq!(binary, via_git_binary, "冲突二进制判定与 git 不一致");
                assert_eq!(markers, via_git_markers, "冲突标记数与 git 不一致");
            }
            Err(reason) => eprintln!("conflict-details: 快速路径让位给 git（{reason}）"),
        }
        let first = &conflict_paths[0];
        let via_git = git(repo, &["show", &format!(":2:{first}"), "--"]);
        match raw_diff::in_process::index_stage_blob(repo, 2, first) {
            Ok(bytes) => assert!(bytes == via_git, "{first}: 索引阶段读取与 git 不一致"),
            Err(reason) => eprintln!("conflict-stage-read: 快速路径让位给 git（{reason}）"),
        }
        eprintln!("conflicts: {} 个冲突路径，比较 {conflict_revision}", conflict_paths.len());
    }

    // 文件历史（History 的「查看文件历史」）：取最近 200 个提交里改得最多的文件——历史深、跨过改名的
    // 概率也高。Desktop 没有文件历史，对照 GitLens getLogForPath 的原样命令（getLogCore 加
    // gitConfigsLogWithFiles，fileHistory 默认不跟合并、跟改名，多取一条判断 hasMore）。
    // 进程内结果先与同一参数的 git 命令（Desktop 提交格式）逐字节比对：首页、第二页与全量。
    let file_history_case = {
        let names = git(repo, &["log", "--max-count=200", "--no-merges", "--name-only", "--format=", "-z"]);
        let mut counts: std::collections::HashMap<String, usize> = Default::default();
        for name in String::from_utf8_lossy(&names).split('\0').map(|n| n.trim_matches('\n')).filter(|n| !n.is_empty())
        {
            *counts.entry(name.to_string()).or_default() += 1;
        }
        let tracked: std::collections::HashSet<String> =
            String::from_utf8_lossy(&git(repo, &["ls-files", "-z"])).split('\0').map(str::to_string).collect();
        let mut counts: Vec<_> = counts.into_iter().filter(|(name, _)| tracked.contains(name)).collect();
        counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        counts.into_iter().next().map(|(name, _)| name)
    };
    // GitLens getLogForPath（packages/git-cli/src/providers/commits.ts）：第一页从 HEAD 起；
    // 「加载更多」从上一页最后一个提交的父提交起，路径换成那个提交的原路径。
    let gitlens_file_log = |rev: Option<&str>, file: &str, limit: usize| {
        let n = format!("-n{}", limit + 1);
        let mut args = vec![
            "-c",
            "log.showSignature=false",
            "-c",
            "diff.renameLimit=0",
            "log",
            "--format=%x1E%H%x1D%aN%x1D%aE%x1D%at%x1D%cN%x1D%cE%x1D%ct%x1D%P%x1D%D%x1D%B%x1D",
            "--numstat",
            "--raw",
            "-M",
            "--use-mailmap",
            "--no-merges",
            &n,
            "--follow",
        ];
        args.extend(rev);
        args.extend(["--", file]);
        git(repo, &args).split(|b| *b == 0x1e).filter(|record| !record.is_empty()).count()
    };
    let mut file_history_total = 0;
    // GitLens 第二页、第三页的起点：上一页最后一个提交的父提交，路径换成那个提交改名前的路径。
    let mut gitlens_pages: Vec<(String, String)> = Vec::new();
    if let Some(file) = &file_history_case {
        let full = file_history::follow_via_git(repo, file, 1 << 30).expect("git 文件历史失败");
        file_history_total = full.len();
        match file_history::follow_in_process(repo, file, 1 << 30) {
            Ok(fast) => assert!(fast == full, "{file}: 进程内文件历史与 git 不一致"),
            Err(reason) => eprintln!("file-history {file}: 快速路径让位给 git（{reason}）"),
        }
        // 带游标逐页翻（最多 50 页），每一页都必须是 git 全量的对应切片；前三页再和不带游标的从头走比一次。
        let (mut cursor, mut shown, mut pages, mut resumed) = (None::<String>, 0, 0, 0);
        loop {
            let page = file_history::file_history(repo, file, shown, options.limit, cursor.as_deref())
                .expect("file_history 失败");
            let end = (shown + options.limit).min(full.len());
            assert!(page.commits[..] == full[shown.min(end)..end], "{file}: 第 {shown} 条起的一页与 git 不一致");
            assert_eq!(page.has_more, full.len() > shown + options.limit, "{file}: hasMore 与 git 不一致");
            if pages < 3 {
                let fresh =
                    file_history::file_history(repo, file, shown, options.limit, None).expect("file_history 失败");
                assert!(fresh.commits == page.commits && fresh.has_more == page.has_more, "{file}: 游标与从头走不一致");
            }
            resumed += usize::from(page.resumed);
            shown += page.commits.len();
            pages += 1;
            if !page.has_more || pages == 50 {
                break;
            }
            cursor = page.cursor;
        }
        eprintln!(
            "file-history {file}: 全部 {} 个提交，进程内与 git 一致；带游标翻 {pages} 页（{resumed} 页接着游标）逐页一致",
            full.len()
        );
        let (mut rev, mut path) = (None::<String>, file.clone());
        for page_index in 1..=2 {
            // 只有一页时 GitLens 不会再取。
            if full.len() <= page_index * options.limit {
                break;
            }
            let n = format!("-n{}", options.limit);
            let mut args = vec![
                "-c",
                "diff.renameLimit=0",
                "log",
                "--format=%x1E%H",
                "--name-status",
                "-M",
                "--no-merges",
                &n,
                "--follow",
            ];
            args.extend(rev.as_deref());
            args.extend(["--", path.as_str()]);
            let page = String::from_utf8_lossy(&git(repo, &args)).into_owned();
            let Some(last) = page.split('\x1e').rfind(|record| !record.trim().is_empty()) else { break };
            let mut lines = last.lines().filter(|line| !line.is_empty());
            let sha = lines.next().unwrap_or_default().to_string();
            let next = lines
                .next()
                .and_then(|status| {
                    let fields: Vec<&str> = status.split('\t').collect();
                    match fields.as_slice() {
                        [kind, old, _] if kind.starts_with('R') || kind.starts_with('C') => Some(old.to_string()),
                        [_, path] => Some(path.to_string()),
                        _ => None,
                    }
                })
                .unwrap_or_else(|| path.clone());
            rev = Some(format!("{sha}^"));
            path = next;
            gitlens_pages.push((format!("{sha}^"), path.clone()));
        }
    }

    let mut workloads = vec![
        (
            "branch-details",
            "branch::list (分支详情与上游)",
            measure(iterations, || branch::list(repo, None).expect("分支列表失败").len()),
            // Desktop `getBranches`（for-each-ref.ts）。
            measure(iterations, || {
                git(repo, &for_each_ref_args).split(|b| *b == 0).filter(|p| !p.is_empty()).count() / 5
            }),
        ),
        (
            "local-config",
            "git_config::get --local user.name (打开仓库)",
            measure(iterations, || local_config().map_or(0, |value| value.len())),
            measure(iterations, local_config_via_git),
        ),
        (
            "stashes",
            "ops::stashes (getStashes，每次刷新)",
            measure(iterations, || ops::stashes(repo).expect("贮藏列表失败").len()),
            measure(iterations, stashes_via_git),
        ),
        (
            "remotes",
            "remote_ops::list (getRemotes，每次刷新)",
            measure(iterations, || remote_ops::list(repo).expect("远端列表失败").len()),
            measure(iterations, || desktop_remotes().len()),
        ),
        (
            "origin-url",
            "remote_ops::get_url origin (每次刷新)",
            measure(iterations, || {
                remote_ops::get_url(repo, "origin").expect("读 origin 失败").map_or(0, |url| url.len())
            }),
            measure(iterations, || origin_via_git().len()),
        ),
        (
            "lfs-state",
            "lfs_state (打开仓库和每次 Git 操作后)",
            measure(iterations, || usize::from(lfs::state(repo).used)),
            measure(iterations, || {
                // Desktop `isUsingLFS`（app/src/lib/git/lfs.ts）；Desktop 只在添加仓库时跑。
                let out = Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["lfs", "track", "--json"])
                    .env("GIT_LFS_TRACK_NO_INSTALL_HOOKS", "1")
                    .output()
                    .expect("无法启动 git lfs");
                usize::from(String::from_utf8_lossy(&out.stdout).contains("\"tracked\":true"))
            }),
        ),
        (
            "ahead-behind",
            "left_right_counts (getAheadBehind)",
            measure(iterations, || {
                let (ahead, behind) = history::left_right_counts(repo, &symmetric).expect("left_right_counts 失败");
                (ahead + behind) as usize
            }),
            measure(iterations, || {
                let out = git(repo, &["rev-list", "--left-right", "--count", "--end-of-options", &symmetric, "--"]);
                String::from_utf8_lossy(&out).split_whitespace().filter_map(|n| n.parse::<usize>().ok()).sum()
            }),
        ),
        (
            "history-commit",
            "commit_details (getCommit)",
            measure(iterations, || {
                history::query_details(repo, Some(&head), Some(1), None, &[]).expect("query_details 失败").len()
            }),
            measure(iterations, || revision_log(&head, 1, &[])),
        ),
        (
            "history-range",
            "commit_details (upstream..branch)",
            measure(iterations, || {
                history::query_details(repo, Some(&range), Some(options.limit), None, &[])
                    .expect("query_details 失败")
                    .len()
            }),
            measure(iterations, || revision_log(&range, options.limit, &[])),
        ),
        (
            "history-not-remotes",
            "commit_details (HEAD --not --remotes)",
            measure(iterations, || {
                history::query_details(repo, Some("HEAD"), Some(options.limit), None, &not_remotes)
                    .expect("query_details 失败")
                    .len()
            }),
            measure(iterations, || revision_log("HEAD", options.limit, &["--not", "--remotes"])),
        ),
        (
            "status",
            "repo_status (untracked cache cold)",
            // 每次都丢掉未跟踪缓存：和打开仓库后的第一次调用一样
            measure_after(iterations, status::untracked_cache::clear, || {
                status::status(repo).expect("status 失败").changes.len()
            }),
            measure(iterations, || {
                // Desktop `getStatus` 的参数；输出里 `#` 开头的分支行一起计数。
                porcelain_entries(&git(
                    repo,
                    &["--no-optional-locks", "status", "--untracked-files=all", "--branch", "--porcelain=2", "-z"],
                ))
            }),
        ),
        (
            "status-warm",
            "repo_status (untracked cache warm)",
            // 先调一次填好缓存，之后每次都是文件监听触发的那种重复调用
            {
                status::status(repo).expect("status 失败");
                measure(iterations, || status::status(repo).expect("status 失败").changes.len())
            },
            measure(iterations, || {
                porcelain_entries(&git(
                    repo,
                    &["--no-optional-locks", "status", "--untracked-files=all", "--branch", "--porcelain=2", "-z"],
                ))
            }),
        ),
        (
            "history-first-page",
            "commit_details",
            measure(iterations, || {
                history::query_details(repo, None, Some(options.limit), Some(0), &[]).expect("query_details 失败").len()
            }),
            measure(iterations, || {
                log_records(&git(
                    repo,
                    &[
                        "log",
                        "--date=raw",
                        &format!("--max-count={limit}"),
                        "-z",
                        &format,
                        "--no-show-signature",
                        "--no-color",
                        "--",
                    ],
                ))
            }),
        ),
        (
            // 第一页冷：每次先丢掉缓存的序列，计入整条 `--date-order` 排序；git 没有缓存，每次都是这个开销。
            "history-graph-cold",
            "graph (History 标签页，第一页冷：整条序列重排)",
            measure_after(
                iterations,
                || graph::forget(repo),
                || graph::graph(repo, options.limit, 0, None).expect("graph 失败").rows.len(),
            ),
            measure(iterations, || graph_log(0)),
        ),
        (
            "history-graph-page",
            "graph (History 标签页)",
            measure(iterations, || graph::graph(repo, options.limit, 0, None).expect("graph 失败").rows.len()),
            // Desktop 没有提交图；git 一侧是 GitLens 提交图的命令形状（`log --all --date-order`，去掉 refs/pull）
            // 配 Desktop 的输出格式，两侧遍历同一组引用、排同一种序。
            measure(iterations, || graph_log(0)),
        ),
        (
            // 提交图翻页按「跳过前 skip 行」从缓存的序列里取切片（全部引用 + 贮藏）；游标只影响泳道，不影响遍历。
            "history-graph-deep-page",
            "graph (History 标签页，翻到第 skip 行)",
            measure(iterations, || {
                graph::graph(repo, options.limit, options.skip, None).expect("graph 失败").rows.len()
            }),
            measure(iterations, || graph_log(options.skip)),
        ),
        (
            "history-deep-page",
            "commit_details",
            measure(iterations, || {
                history::query_details(repo, None, Some(options.limit), Some(options.skip), &[])
                    .expect("query_details 失败")
                    .len()
            }),
            measure(iterations, || {
                log_records(&git(
                    repo,
                    &[
                        "log",
                        "--date=raw",
                        &format!("--max-count={limit}"),
                        &format!("--skip={skip}"),
                        "-z",
                        &format,
                        "--no-show-signature",
                        "--no-color",
                        "--",
                    ],
                ))
            }),
        ),
        (
            "commit-files",
            "commit_files",
            measure(iterations, || history::commit_files(repo, &head).expect("commit_files 失败").len()),
            measure(iterations, || {
                // HEAD 那个提交；快速路径让位时两边是同一条 git 命令
                commit_files_via_cli(&head)
            }),
        ),
        (
            "commit-files-recent",
            "commit_files (最近 20 个提交逐个选中)",
            measure(iterations, || {
                recent[..recent.len().min(20)]
                    .iter()
                    .map(|sha| history::commit_files(repo, sha).expect("commit_files 失败").len())
                    .sum()
            }),
            measure(iterations, || recent[..recent.len().min(20)].iter().map(|sha| commit_files_via_cli(sha)).sum()),
        ),
        (
            "commit-file-diff-recent",
            "commit_file_diff (最近 20 个提交各自的第一个文件)",
            measure(iterations, || {
                commit_diff_recent
                    .iter()
                    .map(|(sha, file, old)| {
                        raw_diff::commit_file_diff(repo, sha, file, old.as_deref(), false).expect("diff 失败").len()
                    })
                    .sum()
            }),
            measure(iterations, || {
                commit_diff_recent
                    .iter()
                    .map(|(sha, file, old)| commit_diff_via_cli(sha, file, old.as_deref()).len())
                    .sum()
            }),
        ),
        (
            "tag-index",
            "tag_index",
            measure(iterations, || {
                let repo = gix::open(repo).expect("打开仓库失败");
                history::tag_index(&repo).expect("tag_index 失败").len()
            }),
            // Desktop tag.ts getAllTags：peeled 标签列表。
            measure(iterations, || lines(&git_with_codes(repo, &["show-ref", "--tags", "-d"], &[0, 1]))),
        ),
        (
            "blame",
            "blame",
            measure(iterations, || blame::blame(repo, &tracked).expect("blame 失败").len()),
            measure(iterations, || lines(&git(repo, &["blame", "--porcelain", "--", &tracked]))),
        ),
        (
            "blame-sample",
            "blame × 8 个抽样文件（Desktop 参数：blame --porcelain -- <file>）",
            measure(iterations, || {
                blame_sample.iter().map(|file| blame::blame(repo, file).expect("blame 失败").len()).sum()
            }),
            measure(iterations, || {
                blame_sample.iter().map(|file| lines(&git(repo, &["blame", "--porcelain", "--", file]))).sum()
            }),
        ),
        (
            "blame-old",
            "blame × 4 个老文件（最后一次改动最早，每目录一个；Desktop 参数）",
            measure(iterations, || {
                blame_old.iter().map(|file| blame::blame(repo, file).expect("blame 失败").len()).sum()
            }),
            measure(iterations, || {
                blame_old.iter().map(|file| lines(&git(repo, &["blame", "--porcelain", "--", file]))).sum()
            }),
        ),
        (
            "blame-gix-candidate",
            "gix blame_file × 8 个抽样文件（未上线）",
            measure(iterations, || {
                blame_sample.iter().map(|file| gix_blame_rows(repo, file).expect("gix blame 失败").len()).sum()
            }),
            measure(iterations, || {
                blame_sample.iter().map(|file| git_blame_rows(repo, file).expect("git blame 失败").len()).sum()
            }),
        ),
        (
            "open-repository",
            "branches + repo_status + log + remotes",
            measure_after(iterations, status::untracked_cache::clear, || {
                let branches = status::branches(repo).expect("branches 失败").len();
                let changes = status::status(repo).expect("status 失败").changes.len();
                let commits = history::query_details(repo, None, Some(options.limit), Some(0), &[])
                    .expect("query_details 失败")
                    .len();
                let remotes = system::remotes(repo).expect("remotes 失败").len();
                branches + changes + commits + remotes
            }),
            measure(iterations, || {
                let branches = git(repo, &for_each_ref_args).split(|b| *b == 0).filter(|p| !p.is_empty()).count() / 5;
                let changes = porcelain_entries(&git(repo, &status_args));
                let commits = log_records(&git(repo, &log_args));
                let remotes = lines(&git(repo, &["remote", "-v"])) / 2;
                branches + changes + commits + remotes
            }),
        ),
    ];
    // 引用刚变过（提交、fetch 之后）的第一页历史：GitCub 的引用索引要按指纹差异刷新，git 每次都整表读。
    // 不能改被测仓库，所以在临时目录里照搬它的 HEAD、packed-refs 与 refs/ 树（松散文件保持松散），
    // 对象经 alternates 借用；每次计时前（不计时）把一个分支在两个提交之间来回移动。
    {
        let scratch = tempfile::tempdir().expect("临时目录");
        let copy = scratch.path();
        git(copy, &["init", "-q"]);
        let source = gix::open(repo).expect("打开仓库失败");
        let common = source.common_dir().to_path_buf();
        let target = copy.join(".git");
        std::fs::write(target.join("objects/info/alternates"), format!("{}\n", common.join("objects").display()))
            .expect("写 alternates");
        fn copy_tree(from: &Path, to: &Path) {
            if from.is_dir() {
                std::fs::create_dir_all(to).expect("建目录");
                for entry in std::fs::read_dir(from).expect("读目录").flatten() {
                    copy_tree(&entry.path(), &to.join(entry.file_name()));
                }
            } else {
                std::fs::copy(from, to).expect("复制引用");
            }
        }
        std::fs::remove_dir_all(target.join("refs")).expect("清空 refs");
        copy_tree(&common.join("refs"), &target.join("refs"));
        if common.join("packed-refs").is_file() {
            std::fs::copy(common.join("packed-refs"), target.join("packed-refs")).expect("复制 packed-refs");
        }
        std::fs::copy(source.git_dir().join("HEAD"), target.join("HEAD")).expect("复制 HEAD");
        let parent = String::from_utf8(git(repo, &["rev-parse", "HEAD~1"])).expect("HEAD~1 不是 UTF-8");
        let tips = [head.clone(), parent.trim().to_string()];
        let mut flip = 0;
        let mut move_branch = || {
            flip += 1;
            git(copy, &["update-ref", "refs/heads/benchmark-ref-change", &tips[flip % 2]]);
        };
        let gitcub = measure_prepared(iterations, &mut move_branch, |()| {
            history::query_details(copy, None, Some(options.limit), Some(0), &[]).expect("query_details 失败").len()
        });
        let desktop = measure_prepared(iterations, &mut move_branch, |()| log_records(&git(copy, &log_args)));
        workloads.push(("history-first-page-after-ref-change", "commit_details（刚移动过一个分支）", gitcub, desktop));
    }

    for (name, kind, file) in &working_diff_cases {
        workloads.push((
            name,
            "working_directory_diff",
            measure(iterations, || {
                raw_diff::working_directory_diff(repo, file, *kind, false)
                    .expect("working_directory_diff 失败")
                    .text
                    .len()
            }),
            measure(iterations, || working_diff_args(*kind, file).len()),
        ));
    }
    if !conflict_paths.is_empty() {
        workloads.push((
            "conflict-details",
            "status::conflict_details (冲突文件的二进制判定与标记数)",
            measure(iterations, || {
                let (binary, markers) = status::conflict_details(repo, &conflict_paths);
                binary.len() + markers.len()
            }),
            measure(iterations, conflict_details_via_cli),
        ));
        let first = conflict_paths[0].clone();
        workloads.push((
            "conflict-stage-read",
            "index_stage_blob (getResolutionDiff 的 git show :2:<file>)",
            measure(iterations, || {
                raw_diff::in_process::index_stage_blob(repo, 2, &first)
                    .or_else(|_| Ok::<_, String>(git(repo, &["show", &format!(":2:{first}"), "--"])))
                    .unwrap()
                    .len()
            }),
            measure(iterations, || git(repo, &["show", &format!(":2:{first}"), "--"]).len()),
        ));
    }
    if let Some(file) = &blob_case {
        workloads.push((
            "blob-read",
            "raw_diff::blob_contents (HEAD 的第一个文件)",
            measure(iterations, || raw_diff::blob_contents(repo, &head, file).expect("blob_contents 失败").len()),
            measure(iterations, || show_via_cli(&head, file).len()),
        ));
    }
    if let Some((sha, file, old_path)) = &commit_diff_head {
        workloads.push((
            "commit-file-diff",
            "commit_file_diff (HEAD 的第一个文件)",
            measure(iterations, || {
                raw_diff::commit_file_diff(repo, sha, file, old_path.as_deref(), false).expect("diff 失败").len()
            }),
            measure(iterations, || commit_diff_via_cli(sha, file, old_path.as_deref()).len()),
        ));
    }

    if let Some(file) = &file_history_case {
        let gitcub_args = |max: usize| file_history::follow_via_git(repo, file, max).expect("git 文件历史失败").len();
        workloads.push((
            "file-history",
            "file_history 第一页 (GitLens getLogForPath)",
            measure(iterations, || {
                file_history::file_history(repo, file, 0, options.limit, None).expect("file_history 失败").commits.len()
            }),
            measure(iterations, || gitlens_file_log(None, file, options.limit)),
        ));
        // 翻到第 `pages` 页之前的游标（不计时），和前端滚到底时手里的一样。
        let cursor_before = |pages: usize| {
            let mut cursor = None;
            for page in 0..pages {
                let result =
                    file_history::file_history(repo, file, page * options.limit, options.limit, cursor.as_deref())
                        .expect("file_history 失败");
                cursor = result.cursor;
            }
            cursor
        };
        let page_with_cursor = |page: usize, cursor: Option<String>| {
            let result = file_history::file_history(repo, file, page * options.limit, options.limit, cursor.as_deref())
                .expect("file_history 失败");
            assert!(result.resumed, "{file}: 第 {} 页没有接着游标走", page + 1);
            result.commits.len()
        };
        // 只有一页的历史没有「加载更多」。GitLens 的「加载更多」：`<上一页最后一个提交>^ -- <原路径>`，
        // 只走剩下的历史，但会丢掉从侧分支并入、日期比那个提交更早的提交（见 docs/benchmarks.md）。
        if let Some((rev, path)) = gitlens_pages.first() {
            workloads.push((
                "file-history-second-page",
                "file_history 第二页（接着第一页的游标走）",
                measure_prepared(iterations, || cursor_before(1), |cursor| page_with_cursor(1, cursor)),
                measure(iterations, || gitlens_file_log(Some(rev), path, options.limit)),
            ));
            workloads.push((
                "file-history-second-page-rewalk",
                "file_history 第二页（不带游标，按前 skip+limit+1 条重走）",
                measure(iterations, || {
                    file_history::file_history(repo, file, options.limit, options.limit, None)
                        .expect("file_history 失败")
                        .commits
                        .len()
                }),
                measure(iterations, || gitlens_file_log(Some(rev), path, options.limit)),
            ));
        }
        if let Some((rev, path)) = gitlens_pages.get(1) {
            workloads.push((
                "file-history-third-page",
                "file_history 第三页（接着第二页的游标走）",
                measure_prepared(iterations, || cursor_before(2), |cursor| page_with_cursor(2, cursor)),
                measure(iterations, || gitlens_file_log(Some(rev), path, options.limit)),
            ));
        }
        workloads.push((
            "file-history-full",
            "file_history 全部（同参数 git 命令，Desktop 提交格式）",
            measure(iterations, || {
                file_history::follow(repo, file, file_history_total + 1).expect("file_history 失败").len()
            }),
            measure(iterations, || gitcub_args(file_history_total + 1)),
        ));
    }

    let report = json!({
        "repo": repo,
        "head": head,
        "iterations": iterations,
        "limit": options.limit,
        "skip": options.skip,
        "commits": String::from_utf8_lossy(&git(repo, &["rev-list", "--count", "HEAD"])).trim().parse::<u64>().unwrap_or(0),
        "tracked_files": git(repo, &["ls-files", "-z"]).split(|b| *b == 0).filter(|p| !p.is_empty()).count(),
        "file_history": { "file": file_history_case, "commits": file_history_total },
        "blame_engine": {
            "files": blame_sample.iter().chain(&blame_old).chain([&tracked]).collect::<Vec<_>>(),
            "identical": engine_identical,
            "refused": engine_refused,
        },
        "blame_gix_candidate": {
            "files": blame_sample,
            "lines": blame_sample_lines,
            "mismatched_files": blame_mismatched_files,
            "mismatched_lines": blame_mismatched_lines,
        },
        "blame_breakdown": blame_breakdown(repo, &blame_old, None, iterations),
        "status_breakdown": status_breakdown(repo, iterations),
        "refs_breakdown": refs_breakdown(repo, iterations),
        "workloads": workloads
            .into_iter()
            .map(|(name, command, gitcub, desktop)| json!({ "name": name, "command": command, "gitcub": gitcub, "desktop": desktop }))
            .collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&report).expect("序列化失败"));
}
