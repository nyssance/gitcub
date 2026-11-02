//! Parse OpenSSH's host identity prompt without accepting or storing a host key.
use std::sync::OnceLock;
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPrompt {
    pub host: String,
    pub ip: String,
    pub key_type: String,
    pub fingerprint: String,
}
pub fn parse_host_prompt(prompt: &str) -> Option<HostPrompt> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r"^The authenticity of host '([^ ]+) \(([^)]+)\)' can't be established[^.]*\.\n([^ ]+) key fingerprint is:? ([^\s.]+)\.?\r?\n").expect("Desktop SSH prompt expression"));
    let matched = pattern.captures(prompt)?;
    Some(HostPrompt {
        host: matched[1].into(),
        ip: matched[2].into(),
        key_type: matched[3].into(),
        fingerprint: matched[4].into(),
    })
}
