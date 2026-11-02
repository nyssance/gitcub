//! 验证应用作为 git 的 GIT_ASKPASS 被拉起时的行为。
//!
//! 这条链路只能对**真正编译出的二进制**测：`main()` 里在初始化 Tauri 之前
//! 有一段短路，单元测试里 `main()` 不会执行，测不到。
//! 集成测试能拿到 `CARGO_BIN_EXE_gitcub`，所以放在这里。

use std::process::Command;

fn ask(prompt: &str) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_gitcub"))
        .arg(prompt)
        .env("GITCUB_ASKPASS_TOKEN", "ghp_secret_value")
        .env("GITCUB_ASKPASS_USER", "oauth2")
        .output()
        .expect("启动 gitcub 失败");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn 作为_askpass_被调用时返回凭据且不启动窗口() {
    assert_eq!(ask("Username for 'https://github.com': "), "oauth2");
    assert_eq!(ask("Password for 'https://github.com': "), "ghp_secret_value");
    // GitLab 的措辞不同，同样要走对分支
    assert_eq!(ask("User name for 'https://gitlab.com': "), "oauth2");
}

#[test]
fn 认不出的提示按密码处理() {
    // 给错用户名只是认证失败；给错密码才会把 token 发给对端
    assert_eq!(ask("Enter passphrase for key: "), "ghp_secret_value");
}

// 注：不能在这里测「没有 token 时不拦截」——那条路径会真的启动 Tauri 并开窗口，
// 测试进程会一直挂住。该分支由 net.rs 的单元测试 `非_askpass_启动时不拦截` 覆盖。
