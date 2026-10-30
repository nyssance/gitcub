//! External credentials are read only during an explicit import, then persisted locally.
//! Background account requests only read GitCub-owned credentials.

use crate::desktop_import::DesktopAccount;
use crate::git::Git;
use crate::settings;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// 设置里粘的令牌
    Settings,
    /// git 凭据助手
    GitCredential,
    /// Imported from the GitHub Desktop OS credential store.
    Desktop,
    /// gh / glab
    Cli,
}

pub struct Found {
    pub token: String,
    pub source: Source,
    /// OAuth 登录时选过的平台；粘贴的令牌不知道是哪家。
    pub kind: Option<crate::account::Kind>,
}

pub fn find(host: &str) -> Option<Found> {
    // 用户显式登出过这个实例：连系统里已有的凭据也不再用
    if settings::is_ignored(host) {
        return None;
    }
    let stored = settings::stored_credential(host)?;
    let token = settings::access_token(&stored)?;
    Some(Found { token, source: Source::Settings, kind: crate::oauth::kind(&stored) })
}

/// `git credential fill` 会去问已配置的凭据助手。GIT_TERMINAL_PROMPT=0 由
/// Git 封装统一设过，所以找不到就是空输出，不会卡在交互提示上。
fn from_git_credential(host: &str) -> Option<String> {
    let mut input = crate::credential_protocol::format(&credential_request(host)).ok()?;
    input.push('\n');
    let out = Git::new(None).args(["credential", "fill"]).stdin(input).stdout().ok()?;
    crate::credential_protocol::parse(&out)
        .into_iter()
        .find_map(|(key, value)| (key == "password" && !value.is_empty()).then_some(value))
}

/// git 凭据协议只有 protocol / host / path：子路径实例的子路径放进 `path`，
/// 是否参与匹配由用户的 `credential.useHttpPath` 决定，与 git 自己访问这个实例时一致。
fn credential_request(instance: &str) -> Vec<(String, String)> {
    let (authority, path) = crate::remote::split_instance(instance);
    let mut request = vec![("protocol".into(), "https".into()), ("host".into(), authority.into())];
    if !path.is_empty() {
        request.push(("path".into(), path.into()));
    }
    request
}

fn from_cli(host: &str) -> Option<String> {
    // gh / glab 的 --hostname 只认主机名：子路径实例读到的会是同主机根实例的令牌，不导入。
    if !crate::remote::split_instance(host).1.is_empty() {
        return None;
    }
    // Both CLIs support custom hosts. Try each without changing their configuration.
    for executable in ["gh", "glab"] {
        let mut command = std::process::Command::new(executable);
        command.args(["auth", "token", "--hostname", host]);
        if let Some(token) = run(command) {
            return Some(token);
        }
    }
    None
}

fn run(cmd: std::process::Command) -> Option<String> {
    let out = crate::process::execute_command(cmd, 10_000, 64 * 1024).ok()?;
    let token = out.stdout.trim().to_string();
    (!token.is_empty()).then_some(token)
}

/// Explicit import only; normal startup and account discovery do not call this.
/// `known` 是用户已添加的实例标识，仓库 origin 按它们归到子路径实例。
pub fn import_profile(
    profile: &std::path::Path, known: &[String],
) -> Result<crate::desktop_import::DesktopImport, String> {
    static IMPORT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = IMPORT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut result = crate::desktop_import::read_profile(profile)?;
    let hosts = result
        .repositories
        .iter()
        .filter_map(|repo| crate::remote::origin(std::path::Path::new(repo)).ok().flatten())
        .map(|remote| crate::remote::credential_instance(&remote, known))
        .collect::<Vec<_>>();
    import_accounts(&result.accounts, &hosts)?;
    result.account_hosts.extend(hosts);
    result.account_hosts.sort();
    result.account_hosts.dedup();
    Ok(result)
}

/// Called only by the user's import action. Existing GitCub credentials win,
/// including across process restarts. A denied external read is not retried by find().
pub fn import_accounts(accounts: &[DesktopAccount], hosts: &[String]) -> Result<(), String> {
    #[cfg(feature = "hasgard-testing")]
    if std::env::var_os("GITCUB_TEST_DATA_DIR").is_some() {
        return Ok(());
    }
    import_accounts_with(
        accounts,
        hosts,
        |host| settings::stored_credential(host).is_some() || settings::is_ignored(host),
        settings::set_host_token,
        |account| read_desktop_credential(&format!("GitHub - {}", account.endpoint), &account.login),
        |host| {
            from_git_credential(host)
                .map(|token| Found { token, source: Source::GitCredential, kind: None })
                .or_else(|| from_cli(host).map(|token| Found { token, source: Source::Cli, kind: None }))
        },
    )
}

fn import_accounts_with(
    accounts: &[DesktopAccount], hosts: &[String], should_skip: impl Fn(&str) -> bool,
    save: impl Fn(&str, &str) -> Result<(), String>, read_desktop: impl Fn(&DesktopAccount) -> Option<String>,
    read_fallback: impl Fn(&str) -> Option<Found>,
) -> Result<(), String> {
    let mut handled = std::collections::HashSet::new();
    for account in accounts {
        if !handled.insert(account.host.clone()) || should_skip(&account.host) {
            continue;
        }
        if let Some(token) = read_desktop(account) {
            save(&account.host, &token)?;
            log::info!("Imported credential for {} from {:?}", account.host, Source::Desktop);
        }
    }
    for host in hosts {
        if !handled.insert(host.clone()) || should_skip(host) {
            continue;
        }
        if let Some(found) = read_fallback(host) {
            save(host, &found.token)?;
            log::info!("Imported credential for {host} from {:?}", found.source);
        }
    }
    Ok(())
}

pub async fn find_async(host: &str) -> Option<Found> {
    let host = host.to_owned();
    tauri::async_runtime::spawn_blocking(move || find(&host)).await.ok().flatten()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn read_desktop_credential(service: &str, login: &str) -> Option<String> {
    use std::ffi::{CString, c_char};
    unsafe extern "C" {
        fn gitcub_read_desktop_credential(
            service: *const c_char, account: *const c_char, buffer: *mut u8, capacity: usize, length: *mut usize,
        ) -> i32;
    }
    let service = CString::new(service).ok()?;
    let login = CString::new(login).ok()?;
    let mut bytes = vec![0u8; 64 * 1024];
    let mut length = 0;
    // Both strings are NUL-terminated and the output capacity matches the allocation.
    let status = unsafe {
        gitcub_read_desktop_credential(service.as_ptr(), login.as_ptr(), bytes.as_mut_ptr(), bytes.len(), &mut length)
    };
    if status != 0 || length == 0 || length > bytes.len() {
        return None;
    }
    bytes.truncate(length);
    String::from_utf8(bytes).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_desktop_credential(_service: &str, _login: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_credentials_survive_reimport_without_external_reads() {
        let directory = tempfile::tempdir().unwrap();
        let accounts = vec![DesktopAccount {
            host: "gitlab.example".into(),
            endpoint: "https://gitlab.example/".into(),
            login: "fixture".into(),
        }];
        let hosts = vec!["gitlab.example".into(), "github.com".into()];
        let run_import = |external_allowed: bool| {
            import_accounts_with(
                &accounts,
                &hosts,
                |host| directory.path().join(host).exists(),
                |host, token| std::fs::write(directory.path().join(host), token).map_err(|e| e.to_string()),
                |account| {
                    assert!(external_allowed, "persisted Desktop account must not be read again");
                    assert_eq!(account.endpoint, "https://gitlab.example/");
                    Some("desktop-fixture".into())
                },
                |host| {
                    assert!(external_allowed, "persisted helper credential must not be read again");
                    assert_eq!(host, "github.com");
                    Some(Found { token: "helper-fixture".into(), source: Source::GitCredential, kind: None })
                },
            )
            .unwrap();
        };
        run_import(true);
        // All import state is local to each call; the second call only has the persisted files.
        run_import(false);
        assert_eq!(std::fs::read_to_string(directory.path().join("gitlab.example")).unwrap(), "desktop-fixture");
        assert_eq!(std::fs::read_to_string(directory.path().join("github.com")).unwrap(), "helper-fixture");
    }

    #[test]
    fn subpath_instance_credential_request_carries_the_path() {
        let pairs =
            |items: &[(&str, &str)]| items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert_eq!(
            credential_request("git.example:8443"),
            pairs(&[("protocol", "https"), ("host", "git.example:8443")])
        );
        assert_eq!(
            credential_request("git.example:8443/gitlab"),
            pairs(&[("protocol", "https"), ("host", "git.example:8443"), ("path", "gitlab")])
        );
        // CLI 只按主机名存令牌，子路径实例不从 CLI 导入，避免拿到同主机根实例的令牌。
        assert_eq!(from_cli("git.example/gitlab"), None);
    }

    #[test]
    fn denied_desktop_read_is_not_retried_via_helper_and_ignored_hosts_are_skipped() {
        let account = DesktopAccount {
            host: "gitlab.example".into(),
            endpoint: "https://gitlab.example/".into(),
            login: "fixture".into(),
        };
        let reads = std::cell::Cell::new(0);
        import_accounts_with(
            &[account.clone(), account],
            &["gitlab.example".into(), "ignored.example".into()],
            |host| host == "ignored.example",
            |_, _| panic!("denied credentials must not be saved"),
            |_| {
                reads.set(reads.get() + 1);
                None
            },
            |_| panic!("denied or ignored accounts must not fall through to another prompt"),
        )
        .unwrap();
        assert_eq!(reads.get(), 1);
    }
    // Writes only a unique test credential, never reads an installed Desktop account.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_reads_keytar_utf8_blob_and_exact_account() {
        use windows::Win32::Security::Credentials::{
            CRED_PERSIST_SESSION, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredWriteW,
        };
        use windows::core::{PCWSTR, PWSTR};
        let unique = tempfile::tempdir().unwrap();
        let service = format!("GitCub-test-{}", unique.path().file_name().unwrap().to_string_lossy());
        let account = "test-熊";
        let mut target: Vec<u16> = format!("{service}/{account}").encode_utf16().chain(Some(0)).collect();
        let mut user: Vec<u16> = account.encode_utf16().chain(Some(0)).collect();
        let mut blob = "fixture-token-熊".as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            UserName: PWSTR(user.as_mut_ptr()),
            CredentialBlob: blob.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            Persist: CRED_PERSIST_SESSION,
            ..Default::default()
        };
        struct Cleanup(Vec<u16>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                unsafe {
                    let _ = CredDeleteW(PCWSTR(self.0.as_ptr()), CRED_TYPE_GENERIC, None);
                }
            }
        }
        unsafe {
            CredWriteW(&credential, 0).unwrap();
        }
        let cleanup = Cleanup(target);
        assert_eq!(read_desktop_credential(&service, account).as_deref(), Some("fixture-token-熊"));
        assert_eq!(read_desktop_credential(&service, "other-account"), None);
        drop(cleanup);
        assert_eq!(read_desktop_credential(&service, account), None);
    }
}
