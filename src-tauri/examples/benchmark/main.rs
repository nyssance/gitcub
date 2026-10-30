//! 热路径基准：gix 实现与 Desktop 同等 git 命令在同一仓库上的耗时对照。
//! Desktop 一侧只计 git 进程本身（启动、执行、读完输出），不含其 JS 解析，
//! 因此是 Desktop 耗时的下界。
//!
//! 对照的进程内快路径（blame_engine、raw_diff::in_process、status 预载与未跟踪缓存）只在 unix 上编译，
//! 基准因此也只在 unix 上构建；其它平台的入口只说明这一点。
// 与 conformance 相同的模块集合，未用到的入口的 dead_code 与应用构建无关。
#![allow(dead_code)]

#[cfg(unix)]
include!("run.rs");

#[cfg(not(unix))]
fn main() {
    eprintln!("benchmark 对照的进程内快路径只在 unix 上编译，请在 macOS 或 Linux 上运行");
    std::process::exit(1);
}
