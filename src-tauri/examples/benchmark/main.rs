//! 热路径基准：gix 实现与 Desktop 同等 git 命令在同一仓库上的耗时对照。
//! Desktop 一侧只计 git 进程本身（启动、执行、读完输出），不含其 JS 解析，
//! 因此是 Desktop 耗时的下界。
//!
//! Unix 运行完整的生产快路径对照；Windows 运行可移植的 gix/CLI 对照。
#![cfg_attr(unix, expect(dead_code))]

#[cfg(unix)]
include!("run.rs");

#[cfg(windows)]
include!("run_windows.rs");
