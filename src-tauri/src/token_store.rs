//! GitCub-only credential namespace; never opens Desktop's keychain entries.
/// 2026-10-30 改名前的命名空间；老条目还在钥匙串里，读的时候认，新写入只用新名字。
const LEGACY_PREFIXES: [&str; 2] = ["Quipu - ", "Quipu Dev - "];
fn strip_namespace(service: &str) -> Option<&str> {
    service
        .strip_prefix("GitCub - ")
        .or_else(|| service.strip_prefix("GitCub Dev - "))
        .or_else(|| LEGACY_PREFIXES.iter().find_map(|prefix| service.strip_prefix(prefix)))
}
/// 新名字对应的旧名字（`GitCub - X` → `Quipu - X`），迁移期读不到新条目时再试一次旧的
fn legacy_service(service: &str) -> Option<String> {
    service
        .strip_prefix("GitCub - ")
        .map(|key| format!("Quipu - {key}"))
        .or_else(|| service.strip_prefix("GitCub Dev - ").map(|key| format!("Quipu Dev - {key}")))
}
fn allowed_service(service: &str) -> bool {
    let Some(key) = strip_namespace(service) else {
        return false;
    };
    key == "Copilot BYOK provider"
        || reqwest::Url::parse(key)
            .is_ok_and(|url| matches!(url.scheme(), "https" | "http") && url.host_str().is_some())
}
fn entry(service: &str, login: &str) -> Result<keyring::Entry, String> {
    if !allowed_service(service) {
        return Err("Unsupported credential namespace".into());
    }
    keyring::Entry::new(service, login).map_err(|e| e.to_string())
}

fn credential_host(service: &str) -> Option<String> {
    let endpoint = strip_namespace(service)?;
    let url = reqwest::Url::parse(endpoint).ok()?;
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    let host = url.host_str()?;
    let mapped = if host == "api.github.com" {
        "github.com".into()
    } else {
        host.strip_prefix("api.").filter(|_| host.ends_with(".ghe.com")).unwrap_or(host).to_string()
    };
    Some(match url.port() {
        Some(port) => format!("{mapped}:{port}"),
        None => mapped,
    })
}

pub fn get(service: &str, login: &str) -> Result<Option<String>, String> {
    if let Some(host) = credential_host(service) {
        if crate::settings::is_ignored(&host) {
            return Ok(None);
        }
        if let Some(value) = crate::settings::stored_credential(&host) {
            return Ok(Some(crate::oauth::desktop_storage(&value)?.unwrap_or(value)));
        }
    }
    #[cfg(feature = "hasgard-testing")]
    if std::env::var_os("GITCUB_TEST_DATA_DIR").is_some() {
        return Ok(None);
    }
    let found = match entry(service, login)?.get_password() {
        Ok(value) => Some(value),
        Err(keyring::Error::NoEntry) => match legacy_service(service) {
            Some(legacy) => match entry(&legacy, login)?.get_password() {
                Ok(value) => Some(value),
                Err(keyring::Error::NoEntry) => None,
                Err(e) => return Err(e.to_string()),
            },
            None => None,
        },
        Err(e) => return Err(e.to_string()),
    };
    if let Some(value) = found {
        if let Some(host) = credential_host(service) {
            crate::settings::set_host_token(&host, &value)?;
        }
        return Ok(Some(value));
    }
    Ok(None)
}
pub fn set(service: &str, login: &str, value: &str) -> Result<(), String> {
    if let Some(host) = credential_host(service) {
        return crate::oauth::change_account(&host, || {
            if crate::settings::is_ignored(&host) {
                return Err("The account has signed out".into());
            }
            if let Some(stored) = crate::settings::stored_credential(&host)
                && let Some(current) = crate::oauth::desktop_storage(&stored)?
            {
                let equivalent = current
                    .strip_prefix("github-desktop-oauth:")
                    .zip(value.strip_prefix("github-desktop-oauth:"))
                    .is_some_and(|(left, right)| {
                        serde_json::from_str::<serde_json::Value>(left).ok()
                            == serde_json::from_str::<serde_json::Value>(right).ok()
                    });
                return if equivalent
                    || current == value
                    || crate::settings::access_token(&current).as_deref() == Some(value)
                {
                    Ok(())
                } else {
                    Err("The account has been replaced".into())
                };
            }
            if let Some(stored) = crate::settings::stored_credential(&host)
                && !stored.starts_with("github-desktop-oauth:")
                && stored != value
            {
                return Err("The account has been replaced".into());
            }
            crate::settings::set_host_token(&host, value)
        });
    }
    entry(service, login)?.set_password(value).map_err(|e| e.to_string())
}
pub fn delete(service: &str, login: &str) -> Result<bool, String> {
    if let Some(host) = credential_host(service) {
        return crate::oauth::change_account(&host, || {
            crate::settings::set_ignored(&host, true)?;
            crate::settings::set_host_token(&host, "")?;
            Ok(true)
        });
    }
    match entry(service, login)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn credential_namespaces_are_gitcub_only() {
        for service in
            [
                "GitCub - https://api.github.com",
                "GitCub Dev - https://ghe.test/api/v3",
                "GitCub - Copilot BYOK provider",
                "Quipu - https://api.github.com"
            ]
        {
            assert!(super::allowed_service(service));
        }
        for service in [
            "GitHub - https://api.github.com",
            "GitHub Desktop - Copilot BYOK provider",
            "GitCub - file:///tmp/key",
            "GitCub - invalid",
        ] {
            assert!(!super::allowed_service(service));
        }
    }
}
