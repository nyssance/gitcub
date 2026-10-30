//! Desktop API URL construction, shared by real GitHub account requests.
pub const DOT_COM_API_ENDPOINT: &str = "https://api.github.com";
pub fn absolute_url(endpoint: &str, path: &str) -> Result<String, String> {
    let relative = path.strip_prefix('/').unwrap_or(path);
    let relative = relative.strip_prefix("api/v3/").unwrap_or(relative);
    let base = if endpoint.ends_with('/') { endpoint.to_string() } else { format!("{endpoint}/") };
    reqwest::Url::parse(&base).and_then(|url| url.join(relative)).map(|url| url.to_string()).map_err(|e| e.to_string())
}
