//! 真实 GitLab 实例的只读验收：分页跟随、令牌失效、权限不足、断网后恢复。
//!
//! 只发 GET，不写远端。实例地址取自 `GITCUB_LIVE_GITLAB_HOST`（只写主机名，可带端口），
//! 令牌经 `git credential fill` 读进内存，输出里主机名一律打码。
//!
//! ```text
//! GITCUB_LIVE_GITLAB_HOST=<host> cargo run --example live_gitlab
//! ```

// 只用到 host_api 的读取函数。
#![allow(dead_code)]

#[path = "../src/host_api.rs"]
mod host_api;

use std::io::Write;
use std::process::{Command, Stdio};

fn token(host: &str) -> String {
    let mut child = Command::new("git")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()
        .expect("git credential fill");
    write!(child.stdin.take().unwrap(), "protocol=https\nhost={host}\nusername=oauth2\n\n").unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("password=").map(str::to_owned))
        .expect("凭据助手里没有这个实例的令牌")
}

/// 服务端自己报的总数（`x-total`），用来核对分页跟随有没有漏页。
async fn server_total(url: &str, token: &str) -> usize {
    let response = host_api::client().get(url).bearer_auth(token).send().await.unwrap();
    response.headers()["x-total"].to_str().unwrap().parse().unwrap()
}

fn check(name: &str, ok: bool, detail: &str) -> bool {
    println!(
        "{} {name}{}",
        if ok { "PASS" } else { "FAIL" },
        if detail.is_empty() { String::new() } else { format!(" — {detail}") }
    );
    ok
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let host = std::env::var("GITCUB_LIVE_GITLAB_HOST").expect("设置 GITCUB_LIVE_GITLAB_HOST");
    let token = token(&host);
    let base = format!("https://{host}/api/v4");
    let redact = |text: String| text.replace(&host, "<host>");
    let mut ok = true;

    let user = host_api::get(&format!("{base}/user"), &token).await;
    ok &= check("令牌有效时读取当前用户", user.is_ok(), &redact(user.err().unwrap_or_default()));

    // 每页一条，逼出多页；GitCub 的仓库列表走同一个 list。
    let url = format!("{base}/projects?membership=true&per_page=1&order_by=id");
    let expected = server_total(&url, &token).await;
    let projects = host_api::list(&url, &token, None).await.unwrap();
    let mut ids: Vec<_> = projects.iter().filter_map(|p| p["id"].as_u64()).collect();
    ids.sort_unstable();
    ids.dedup();
    ok &= check(
        "分页跟随 Link 读完全部页",
        projects.len() == expected && ids.len() == expected && expected > 1,
        &format!("{expected} 页，读到 {} 条，去重 {} 条", projects.len(), ids.len()),
    );

    // 真实的超过 100 条的集合：GitCub 的 MR 列表与这里用同一个 list，按 50 条一页跟随 Link。
    // 项目用数字 ID 从环境变量传入，不把实例里的项目写进代码。
    if let Ok(project) = std::env::var("GITCUB_LIVE_GITLAB_MR_PROJECT") {
        let url = format!("{base}/projects/{project}/merge_requests?state=all&per_page=50&order_by=created_at");
        let expected = server_total(&url, &token).await;
        let merge_requests = host_api::list(&url, &token, None).await.unwrap();
        let mut iids: Vec<_> = merge_requests.iter().filter_map(|mr| mr["iid"].as_u64()).collect();
        iids.sort_unstable();
        iids.dedup();
        ok &= check(
            "超过 100 条的 MR 集合翻页完整、不重复、不截断",
            merge_requests.len() == expected && iids.len() == expected && expected > 100,
            &format!("服务端 x-total {expected}，读到 {} 条，去重 {} 条", merge_requests.len(), iids.len()),
        );
    } else {
        println!("SKIP 超过 100 条的 MR 集合（设置 GITCUB_LIVE_GITLAB_MR_PROJECT=<项目数字 ID>）");
    }

    let rejected = host_api::get(&format!("{base}/user"), "glpat-gitcub-invalid-token").await;
    let error = rejected.err().unwrap_or_default();
    ok &= check("失效令牌报 HTTP 401（界面据此提示重新登录）", error.contains("HTTP 401"), &redact(error));

    let forbidden = host_api::get(&format!("{base}/application/settings"), &token).await;
    let error = forbidden.err().unwrap_or_default();
    ok &= check(
        "权限不足报 HTTP 403，不算凭据失效",
        error.contains("HTTP 403") && !error.contains("HTTP 401"),
        &redact(error),
    );

    let missing = host_api::get(&format!("{base}/projects/gitcub-missing%2Fnot-here"), &token).await;
    let error = missing.err().unwrap_or_default();
    ok &= check("看不到的项目报 HTTP 404，不算凭据失效", error.contains("HTTP 404"), &redact(error));

    let offline = host_api::list("https://127.0.0.1:1/api/v4/projects", &token, None).await;
    let error = offline.err().unwrap_or_default();
    ok &= check("断网报请求失败，不算凭据失效", error.starts_with("请求失败") && !error.contains("HTTP 401"), &error);

    let recovered = host_api::list(&url, &token, None).await;
    ok &= check(
        "网络恢复后同一请求立即成功（断网不留冷却）",
        recovered.as_ref().is_ok_and(|items| items.len() == expected),
        &redact(recovered.err().unwrap_or_default()),
    );

    std::process::exit(if ok { 0 } else { 1 });
}
