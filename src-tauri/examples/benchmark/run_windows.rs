// Windows 基准：只测跨平台生产路径，明确把 Unix 专属 status/blame 快路径排除在报告外。
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

struct Options {
    repo: PathBuf,
    iterations: usize,
}

fn options() -> Options {
    let mut repo = None;
    let mut iterations = 10;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => repo = args.next().map(PathBuf::from),
            "--iterations" => {
                iterations = args.next().expect("--iterations 需要值").parse().expect("iterations 必须是整数")
            }
            _ if arg.starts_with("--") => {
                let _ = args.next();
            }
            _ => {}
        }
    }
    let repo = repo.expect("--repo 必须指向仓库");
    assert!(repo.is_dir(), "--repo 必须指向仓库目录");
    Options { repo, iterations: iterations.max(1) }
}

fn cli(repo: &Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output().expect("启动 git 失败");
    assert!(out.status.success(), "git {:?} 失败: {}", args, String::from_utf8_lossy(&out.stderr));
    out.stdout
}

fn measure(iterations: usize, mut f: impl FnMut() -> usize) -> Value {
    let mut samples = Vec::with_capacity(iterations);
    let mut result = 0;
    for _ in 0..iterations {
        let start = Instant::now();
        result = f();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!({"samples_ms": samples, "min_ms": sorted[0], "median_ms": sorted[sorted.len()/2], "max_ms": sorted[sorted.len()-1], "result": result})
}

fn main() {
    let options = options();
    let repo = gix::open(&options.repo).expect("打开仓库失败");
    let head = repo.head_id().map(|id| id.to_string()).unwrap_or_default();
    let tracked = cli(&options.repo, &["ls-files", "-z"]);
    let tracked_files = tracked.split(|b| *b == 0).filter(|p| !p.is_empty()).count();
    let workloads = vec![
        json!({"name":"open-head","command":"git rev-parse HEAD", "gitcub": measure(options.iterations, || { let Ok(repo) = gix::open(&options.repo) else { return 0 }; usize::from(repo.head_id().is_ok()) }), "desktop": measure(options.iterations, || usize::from(!cli(&options.repo, &["rev-parse", "HEAD"]).is_empty()))}),
        json!({"name":"index-entries","command":"git ls-files -z", "gitcub": measure(options.iterations, || { let Ok(repo) = gix::open(&options.repo) else { return 0 }; repo.index_or_empty().map_or(0, |i| i.entries().len()) }), "desktop": measure(options.iterations, || cli(&options.repo, &["ls-files", "-z"]).split(|b| *b == 0).filter(|p| !p.is_empty()).count())}),
        json!({"name":"refs","command":"git for-each-ref --format=%(refname)", "gitcub": measure(options.iterations, || { let Ok(repo) = gix::open(&options.repo) else { return 0 }; let Ok(refs) = repo.references() else { return 0 }; let Ok(iter) = refs.all() else { return 0 }; iter.filter_map(Result::ok).count() }), "desktop": measure(options.iterations, || cli(&options.repo, &["for-each-ref", "--format=%(refname)"]).split(|b| *b == b'\n').filter(|p| !p.is_empty()).count())}),
        json!({"name":"status","command":"git status --porcelain=2 -z --untracked-files=all", "gitcub": measure(options.iterations, || { let Ok(repo) = gix::open(&options.repo) else { return 0 }; let Ok(platform) = repo.status(gix::progress::Discard) else { return 0 }; platform.untracked_files(gix::status::UntrackedFiles::Files).into_index_worktree_iter(Vec::new()).map_or(0, |items| items.filter_map(Result::ok).count()) }), "desktop": measure(options.iterations, || cli(&options.repo, &["status", "--porcelain=2", "-z", "--untracked-files=all"]).split(|b| *b == 0).filter(|p| !p.is_empty()).count())}),
    ];
    let commits = String::from_utf8_lossy(&cli(&options.repo, &["rev-list", "--count", "HEAD"]))
        .trim()
        .parse::<u64>()
        .unwrap_or(0);
    let report = json!({"repo": options.repo, "head": head, "iterations": options.iterations, "limit": 100, "skip": 0, "commits": commits, "tracked_files": tracked_files, "workloads": workloads, "blame_engine":{"files":[],"identical":0,"refused":["Windows: Unix-only in-process blame path excluded"]}, "blame_breakdown":[], "status_breakdown":[], "refs_breakdown":[], "coverage":{"platform":"windows","excluded":["Unix status preload/untracked cache","Unix in-process blame/raw diff" ]}});
    println!("{}", serde_json::to_string_pretty(&report).expect("序列化失败"));
}
