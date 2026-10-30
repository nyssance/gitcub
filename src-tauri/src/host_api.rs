//! GitHub / GitLab 共用的列表请求。跟随服务端分页，不把第一页当成完整结果。
use reqwest::{Client, Url, header::HeaderMap};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent(concat!("GitCub/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("API redirect loop")
                } else if !attempt.url().username().is_empty()
                    || attempt.url().password().is_some()
                    || attempt.previous().first().is_some_and(|first| first.origin() != attempt.url().origin())
                    || attempt.previous().first().is_some_and(|first| !same_api_root(first, attempt.url()))
                {
                    attempt.error("API redirect crosses origin")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("HTTP client configuration")
    })
}

fn status_error(status: reqwest::StatusCode, headers: &HeaderMap) -> String {
    match headers.get("retry-after").and_then(|value| value.to_str().ok()).filter(|value| !value.is_empty()) {
        Some(retry) => format!("HTTP {status}，Retry-After: {retry}"),
        None => format!("HTTP {status}"),
    }
}

/// 同一主机上可以有多个部署在不同子路径下的 GitLab 实例，同源不等于同一实例：
/// 起始地址带 `/api/v4/`（或 `/api/v3/`）时，分页和重定向只能留在同一个接口根下。
fn same_api_root(first: &Url, next: &Url) -> bool {
    let path = first.path();
    ["/api/v4/", "/api/v3/"]
        .iter()
        .filter_map(|marker| path.find(marker).map(|index| &path[..index + marker.len()]))
        .min_by_key(|root| root.len())
        .is_none_or(|root| next.path().starts_with(root))
}

fn next_page(current: &Url, headers: &HeaderMap) -> Result<Option<Url>, String> {
    for header in headers.get_all(reqwest::header::LINK) {
        let header = header.to_str().map_err(|_| "无效分页响应头")?;
        // URL 中可能含逗号；先读完整 <URL>，再分析它后面的 rel 参数。
        let mut remaining = header;
        while let Some(start) = remaining.find('<') {
            let rest = &remaining[start + 1..];
            let end = rest.find('>').ok_or("无效分页链接")?;
            let target = &rest[..end];
            let params = &rest[end + 1..];
            let (params, tail) = params.split_once(',').unwrap_or((params, ""));
            let is_next = params.split(';').filter_map(|p| p.trim().split_once('=')).any(|(key, value)| {
                key.trim() == "rel" && value.trim().trim_matches('"').split_whitespace().any(|rel| rel == "next")
            });
            if is_next {
                let url = current.join(target).map_err(|_| "无效分页地址")?;
                if url.origin() != current.origin()
                    || !same_api_root(current, &url)
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err("拒绝向其他实例发送分页凭据".into());
                }
                return Ok(Some(url));
            }
            remaining = tail;
        }
    }
    Ok(None)
}

/// field 为 None 时响应是数组；GitHub 搜索/check-runs 等使用指定的数组字段。
pub async fn list(url: &str, token: &str, field: Option<&str>) -> Result<Vec<Value>, String> {
    let mut url = Url::parse(url).map_err(|_| "无效 API 地址")?;
    let mut visited = HashSet::new();
    let mut items = Vec::new();
    loop {
        if visited.len() >= 1000 || !visited.insert(url.to_string()) {
            return Err("API 分页重复或超过 1000 页，未返回不完整结果".into());
        }
        let response = read_response(&url, token).await?;
        let status = response.status();
        let next = next_page(response.url(), response.headers())?;
        let value: Value = response.json().await.map_err(|_| format!("API 返回无效 JSON（HTTP {status}）"))?;
        if value.get("incomplete_results").and_then(Value::as_bool) == Some(true)
            || (field == Some("items")
                && value.get("total_count").and_then(Value::as_u64).is_some_and(|count| count > 1000))
        {
            return Err("服务端搜索结果不完整，请缩小查询范围或重试".into());
        }
        let page =
            field.map_or(Some(&value), |key| value.get(key)).and_then(Value::as_array).ok_or("API 返回的不是列表")?;
        items.extend(page.iter().cloned());
        match next {
            Some(next) => url = next,
            None => return Ok(items),
        }
    }
}

// Honor a provider's cooldown across account, repository and paginated reads.
// Credentials remain in memory and keep different accounts' limits separate.
type Cooldowns = HashMap<(String, String), (Instant, String)>;
static COOLDOWNS: LazyLock<Mutex<Cooldowns>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn read_response(url: &Url, token: &str) -> Result<reqwest::Response, String> {
    let key = (url.origin().ascii_serialization(), token.to_owned());
    {
        let mut cooldowns = COOLDOWNS.lock().map_err(|_| "API cooldown lock unavailable")?;
        cooldowns.retain(|_, (until, _)| *until > Instant::now());
        if let Some((_, error)) = cooldowns.get(&key) {
            return Err(error.clone());
        }
    }
    let response = client()
        .get(url.clone())
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e.without_url()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let headers = response.headers();
    let retry = headers.get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    let reset = headers.get("x-ratelimit-reset").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    let exhausted = headers.get("x-ratelimit-remaining").is_some_and(|v| v == "0");
    let status_message = status_error(status, headers);
    let detail = response
        .json::<Value>()
        .await
        .ok()
        .and_then(|body| body.get("message").or_else(|| body.get("error")).and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    let rate_limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN
            && (exhausted || retry.is_some() || detail.to_lowercase().contains("rate limit")));
    let detail = if token.is_empty() { detail } else { detail.replace(token, "[redacted]") };
    let error = if detail.is_empty() {
        status_message
    } else {
        format!("{status_message}：{}", detail.chars().take(512).collect::<String>())
    };
    if rate_limited {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let seconds = retry.or_else(|| reset.map(|reset| reset.saturating_sub(now))).unwrap_or(60).max(1);
        let until = Instant::now()
            .checked_add(Duration::from_secs(seconds))
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        COOLDOWNS.lock().map_err(|_| "API cooldown lock unavailable")?.insert(key, (until, error.clone()));
    }
    Err(error)
}

pub async fn get(url: &str, token: &str) -> Result<Value, String> {
    let response = read_response(&Url::parse(url).map_err(|_| "无效 API 地址")?, token).await?;
    let status = response.status();
    response.json().await.map_err(|_| format!("API 返回无效 JSON（HTTP {status}）"))
}

pub async fn post(url: &str, token: &str, payload: &Value) -> Result<Value, String> {
    let response = client()
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e.without_url()))?;
    let status = response.status();
    let error = status_error(status, response.headers());
    let bytes = response.bytes().await.map_err(|_| "读取 API 响应失败")?;
    // Proxies and rate limiters can return HTML or an empty body. Preserve the
    // HTTP failure and retry advice instead of misreporting a JSON parse error.
    if !status.is_success() {
        let detail = serde_json::from_slice::<Value>(&bytes).ok().and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .map(|message| message.as_str().map(str::to_string).unwrap_or_else(|| message.to_string()))
        });
        return Err(match detail {
            Some(detail) if !detail.is_empty() => format!("{error}：{detail}"),
            _ => error,
        });
    }
    if status.is_success() && bytes.is_empty() {
        return Ok(Value::Null);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| format!("HTTP {status}：响应不是 JSON"))?;
    Ok(value)
}

/// 测试用的单次 HTTP 服务：按顺序回放给定响应，返回收到的原始请求。
#[cfg(test)]
pub(crate) mod mock {
    use std::io::{Read, Write};

    pub(crate) fn serve(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(std::time::Duration::from_millis(5))
                        }
                        Err(e) => panic!("mock server: {e}"),
                    }
                };
                // macOS 上 accept 的连接会继承监听器的非阻塞标志；read_timeout 不会清除此标志。
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    assert_eq!(stream.read(&mut byte).unwrap(), 1);
                    request.push(byte[0]);
                }
                let mut request = String::from_utf8(request).unwrap();
                let length = request
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                request.push_str(&String::from_utf8(body).unwrap());
                requests.push(request);
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (url, thread)
    }

    pub(crate) fn response(status: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}", body.len())
    }
}

#[cfg(test)]
mod tests {
    use super::mock::{response, serve};
    use super::*;

    #[test]
    fn 分页保留查询逗号并拒绝跨域凭据() {
        let url = Url::parse("https://git.example/api/v4/projects").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "link",
            "</api/v4/projects?tags=a,b&page=2>; rel=\"next\", </api/v4/projects?page=1>; rel=\"prev\""
                .parse()
                .unwrap(),
        );
        assert_eq!(next_page(&url, &headers).unwrap().unwrap().query(), Some("tags=a,b&page=2"));
        for target in [
            "https://other.example/page",
            "http://git.example/page",
            "https://git.example:8443/page",
            "https://user:pass@git.example/page",
        ] {
            headers.insert("link", format!("<{target}>; rel=\"next\"").parse().unwrap());
            assert!(next_page(&url, &headers).is_err());
        }
    }

    #[test]
    fn rate_limit_stops_other_reads_until_provider_cooldown_expires() {
        let (url, server) =
            serve(vec![response("403 Forbidden", "Retry-After: 120\r\n", r#"{"message":"API rate limit exceeded"}"#)]);
        tauri::async_runtime::block_on(async {
            let first = get(&format!("{url}/user"), "account-a").await.unwrap_err();
            assert!(first.contains("rate limit exceeded"));
            assert_eq!(server.join().unwrap().len(), 1);
            // The server is gone. Receiving the identical provider error proves no new connection was attempted.
            assert_eq!(list(&format!("{url}/user/repos"), "account-a", None).await.unwrap_err(), first);
            assert_eq!(get(&format!("{url}/repos/owner/project"), "account-a").await.unwrap_err(), first);
            assert_ne!(get(&url, "account-b").await.unwrap_err(), first);
            COOLDOWNS.lock().unwrap().get_mut(&(url.clone(), "account-a".into())).unwrap().0 = Instant::now();
            assert_ne!(get(&url, "account-a").await.unwrap_err(), first);
        });
    }

    #[test]
    fn retry_advice_survives_detail_and_write_failures() {
        for body in ["", "<html>proxy rate limit</html>", r#"{"message":"rate limited"}"#] {
            let (url, server) = serve(vec![response("429 Too Many Requests", "Retry-After: 30\r\n", body)]);
            let error = tauri::async_runtime::block_on(post(&url, "test", &Value::Null)).unwrap_err();
            assert!(error.contains("429") && error.contains("Retry-After: 30"), "{error}");
            assert!(!error.contains("不是 JSON"));
            if body.starts_with('{') {
                assert!(error.contains("rate limited"));
            }
            server.join().unwrap();
        }
        let (url, server) = serve(vec![response("503 Service Unavailable", "Retry-After: 60\r\n", "")]);
        let error = tauri::async_runtime::block_on(get(&url, "test")).unwrap_err();
        assert!(error.contains("503") && error.contains("Retry-After: 60"));
        server.join().unwrap();
    }

    #[test]
    fn redirects_do_not_send_credentials_to_another_origin() {
        let destination = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let location = format!("Location: http://{}/private\r\n", destination.local_addr().unwrap());
        let (url, server) = serve(vec![response("302 Found", &location, "")]);
        assert!(tauri::async_runtime::block_on(get(&url, "test-secret")).is_err());
        assert!(server.join().unwrap()[0].contains("authorization: Bearer test-secret"));
        assert_eq!(destination.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn subpath_instances_paginate_within_their_own_api_root() {
        let (url, server) = serve(vec![
            response("200 OK", "Link: </gitlab/api/v4/projects?page=2>; rel=\"next\"\r\n", "[1]"),
            response("200 OK", "", "[2]"),
        ]);
        let items =
            tauri::async_runtime::block_on(list(&format!("{url}/gitlab/api/v4/projects"), "test", None)).unwrap();
        assert_eq!(items, vec![serde_json::json!(1), serde_json::json!(2)]);
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /gitlab/api/v4/projects "));
        assert!(requests[1].starts_with("GET /gitlab/api/v4/projects?page=2 "));

        // 同一主机上另一个子路径实例：同源也不能把这个实例的令牌带过去。
        for next in ["/other/api/v4/projects?page=2", "/api/v4/projects?page=2"] {
            let (url, server) = serve(vec![response("200 OK", &format!("Link: <{next}>; rel=\"next\"\r\n"), "[1]")]);
            let error = tauri::async_runtime::block_on(list(&format!("{url}/gitlab/api/v4/projects"), "secret", None))
                .unwrap_err();
            assert!(error.contains("拒绝"), "{error}");
            assert_eq!(server.join().unwrap().len(), 1);
        }
        let (url, server) = serve(vec![response("302 Found", "Location: /other/api/v4/user\r\n", "")]);
        assert!(tauri::async_runtime::block_on(get(&format!("{url}/gitlab/api/v4/user"), "secret")).is_err());
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn same_origin_redirects_and_keyset_pagination_preserve_server_urls() {
        let (url, server) = serve(vec![
            response("302 Found", "Location: /api/v4/projects/new\r\n", ""),
            response("200 OK", "Link: <?pagination=keyset&id_after=42&sort=asc>; rel=\"next\"\r\n", "[1]"),
            response("200 OK", "", "[2]"),
        ]);
        let items = tauri::async_runtime::block_on(list(&format!("{url}/old"), "test", None)).unwrap();
        assert_eq!(items, vec![serde_json::json!(1), serde_json::json!(2)]);
        let requests = server.join().unwrap();
        assert!(requests[2].starts_with("GET /api/v4/projects/new?pagination=keyset&id_after=42&sort=asc "));
        assert!(requests.iter().all(|request| request.contains("authorization: Bearer test")));
    }

    #[test]
    fn 实际请求合并两页并携带认证() {
        let (url, server) = serve(vec![
            response("200 OK", "Link: </items?page=2>; rel=\"next\"\r\n", "[1]"),
            response("200 OK", "", "[2,3]"),
        ]);
        let items = tauri::async_runtime::block_on(list(&format!("{url}/items"), "test-token", None)).unwrap();
        assert_eq!(items, vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)]);
        let requests = server.join().unwrap();
        assert!(requests[1].starts_with("GET /items?page=2 "));
        assert!(requests.iter().all(|r| r.contains("authorization: Bearer test-token")));
    }

    #[test]
    fn 第二页失败不伪装成完整列表() {
        let (url, server) = serve(vec![
            response("200 OK", "Link: </items?page=2>; rel=\"next\"\r\n", "[1]"),
            response("429 Too Many Requests", "Retry-After: 30\r\n", "rate limited"),
        ]);
        let error = tauri::async_runtime::block_on(list(&format!("{url}/items"), "test", None)).unwrap_err();
        assert!(error.contains("429") && error.contains("30"));
        server.join().unwrap();
    }

    #[test]
    fn 搜索包装与循环分页() {
        let (url, server) = serve(vec![response("200 OK", "", "{\"items\":[1]}")]);
        assert_eq!(tauri::async_runtime::block_on(list(&url, "test", Some("items"))).unwrap().len(), 1);
        server.join().unwrap();
        let (url, server) = serve(vec![response("200 OK", "Link: </>; rel=\"next\"\r\n", "[]")]);
        let error = tauri::async_runtime::block_on(list(&url, "test", None)).unwrap_err();
        assert!(error.contains("分页重复"), "{error}");
        server.join().unwrap();
    }

    #[test]
    fn 搜索超出平台上限不能伪装为完整结果() {
        let (url, server) =
            serve(vec![response("200 OK", "", r#"{"items":[1],"total_count":1001,"incomplete_results":false}"#)]);
        let error = tauri::async_runtime::block_on(list(&url, "test", Some("items"))).unwrap_err();
        assert!(error.contains("不完整"));
        server.join().unwrap();
    }

    #[test]
    fn 详情请求失败不能成为无状态结果() {
        let (url, server) = serve(vec![response("403 Forbidden", "", r#"{"message":"Forbidden"}"#)]);
        let error = tauri::async_runtime::block_on(get(&url, "test")).unwrap_err();
        assert!(error.contains("403") && error.contains("Forbidden"));
        server.join().unwrap();
    }

    #[test]
    fn 账号错误保留限流原因并隐藏凭据() {
        let (url, server) = serve(vec![response(
            "403 Forbidden",
            "Retry-After: 60\r\n",
            r#"{"message":"API rate limit exceeded (secret-token)"}"#,
        )]);
        let error = tauri::async_runtime::block_on(get(&url, "secret-token")).unwrap_err();
        assert!(error.contains("403") && error.contains("Retry-After: 60"));
        assert!(error.contains("API rate limit exceeded"));
        assert!(!error.contains("secret-token"));
        server.join().unwrap();
    }

    /// 令牌过期或被吊销（401）要和权限不足（403）、断网分开：只有前者需要重新登录。
    #[test]
    fn 只有_401_算作凭据失效() {
        let (url, server) = serve(vec![response("401 Unauthorized", "", r#"{"message":"401 Unauthorized"}"#)]);
        let error = tauri::async_runtime::block_on(get(&format!("{url}/api/v4/user"), "expired")).unwrap_err();
        server.join().unwrap();
        assert!(crate::account::is_unauthorized(&error), "{error}");
        assert!(!error.contains("expired"), "错误里不能带令牌: {error}");

        let (url, server) = serve(vec![response("403 Forbidden", "", r#"{"message":"403 Forbidden"}"#)]);
        let error = tauri::async_runtime::block_on(get(&format!("{url}/api/v4/projects/1"), "token")).unwrap_err();
        server.join().unwrap();
        assert!(!crate::account::is_unauthorized(&error), "{error}");

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let error = tauri::async_runtime::block_on(get(&format!("http://{address}/api/v4/user"), "token")).unwrap_err();
        assert!(!crate::account::is_unauthorized(&error), "断网不是凭据失效: {error}");
    }

    #[test]
    fn 无响应体的成功操作不能报解析失败() {
        // 使用空 payload：mock 只需接收 headers；没有真实账号写操作。
        for status in ["202 Accepted", "204 No Content"] {
            let (url, server) = serve(vec![response(status, "", "")]);
            let result = tauri::async_runtime::block_on(post(&url, "test", &Value::Null)).unwrap();
            assert_eq!(result, Value::Null);
            assert!(server.join().unwrap()[0].starts_with("POST / "));
        }
    }
}
