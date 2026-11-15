//! Local Desktop migration. Source: desktop bebc062c, RepositoriesDatabase
//! (`Database` / `repositories`) and app-store/application-theme localStorage keys.
//! Profile inspection is read-only. Credentials are imported only by import_profile().
#[path = "desktop_import_log.rs"]
mod storage_log;

use chromium_storage_indexeddb_core::{RecordValue, V8Value};
use chromium_storage_localstorage_core::LocalStorageRecord;
use leveldb_core::Record;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopImport {
    pub repositories: Vec<String>,
    pub selected_repository: Option<String>,
    pub theme: Option<String>,
    pub sidebar_width: Option<u32>,
    pub external_editor: Option<String>,
    pub external_terminal: Option<String>,
    pub skipped: Vec<String>,
    pub account_hosts: Vec<String>,
    #[serde(skip)]
    pub(crate) accounts: Vec<DesktopAccount>,
}

pub fn profile_path() -> Result<PathBuf, String> {
    #[cfg(feature = "hasgard-testing")]
    if let Some(path) = std::env::var_os("GITCUB_TEST_DESKTOP_PROFILE") {
        return Ok(PathBuf::from(path));
    }
    profile_for(std::env::consts::OS, |key| std::env::var_os(key).map(PathBuf::from))
}

fn profile_for(platform: &str, env: impl Fn(&str) -> Option<PathBuf>) -> Result<PathBuf, String> {
    match platform {
        "macos" => Ok(env("HOME").ok_or("HOME is unavailable")?.join("Library/Application Support/GitHub Desktop")),
        "windows" => Ok(env("APPDATA").ok_or("APPDATA is unavailable")?.join("GitHub Desktop")),
        _ => Ok(env("XDG_CONFIG_HOME")
            .or_else(|| env("HOME").map(|p| p.join(".config")))
            .ok_or("Config directory is unavailable")?
            .join("GitHub Desktop")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub installed: bool,
    pub has_data: bool,
    pub handled: bool,
}

pub fn detect(handled: bool) -> Result<Detection, String> {
    let profile = profile_path()?;
    let has_data = profile.join("IndexedDB/file__0.indexeddb.leveldb/CURRENT").is_file();
    #[cfg(feature = "hasgard-testing")]
    if std::env::var_os("GITCUB_TEST_DESKTOP_PROFILE").is_some() {
        return Ok(Detection { installed: profile.is_dir(), has_data, handled });
    }
    let installed = if cfg!(target_os = "macos") {
        Path::new("/Applications/GitHub Desktop.app").is_dir()
            || std::env::var_os("HOME").is_some_and(|h| Path::new(&h).join("Applications/GitHub Desktop.app").is_dir())
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .is_some_and(|root| windows_install_exists(&PathBuf::from(root).join("GitHubDesktop")))
    } else {
        false
    };
    Ok(Detection { installed: installed || has_data, has_data, handled })
}

fn windows_install_exists(root: &Path) -> bool {
    root.join("GitHubDesktop.exe").is_file()
        || std::fs::read_dir(root).is_ok_and(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                entry.file_name().to_string_lossy().starts_with("app-")
                    && entry.path().join("GitHubDesktop.exe").is_file()
            })
        })
}

// Resolve versions BEFORE decoding metadata or values. In particular, a deleted
// record must not resurrect an older repository or preference from an SSTable.
fn live_records(records: Vec<Record>) -> Vec<Record> {
    let mut latest = BTreeMap::<Vec<u8>, Record>::new();
    for record in records {
        match latest.get(&record.key) {
            Some(previous) if previous.seq > record.seq => {}
            _ => {
                latest.insert(record.key.clone(), record);
            }
        }
    }
    latest.into_values().filter(|r| !r.deleted).collect()
}

type Inventory = BTreeMap<PathBuf, (u64, std::time::SystemTime)>;
fn inventory(dir: &Path) -> Result<Inventory, String> {
    let mut result = BTreeMap::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !matches!(path.extension().and_then(|v| v.to_str()), Some("ldb" | "sst" | "log")) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("Invalid Desktop storage file".into());
        }
        result.insert(path, (metadata.len(), metadata.modified().map_err(|e| e.to_string())?));
    }
    Ok(result)
}

fn read_store(dir: &Path) -> Result<Vec<Record>, String> {
    let current = std::fs::read_to_string(dir.join("CURRENT")).map_err(|e| e.to_string())?;
    let name = current.trim();
    if !name.starts_with("MANIFEST-") || !name[9..].bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid Desktop manifest name".into());
    }
    let manifest_path = dir.join(name);
    let manifest = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let active = storage_log::manifest(&manifest)?;
    let before = inventory(dir)?;
    for table in &active.tables {
        if !before.keys().any(|p| {
            p.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u64>().ok()) == Some(*table)
                && p.extension().is_some_and(|s| s == "ldb" || s == "sst")
        }) {
            return Err("Missing Desktop storage table".into());
        }
    }
    let mut records = Vec::new();
    let mut size = 0u64;
    for (path, (length, _)) in &before {
        if !active.contains(path) {
            continue;
        }
        size = size.saturating_add(*length);
        if size > 128 * 1024 * 1024 {
            return Err("Desktop storage exceeds the import size limit".into());
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let parsed = if path.extension().is_some_and(|v| v == "log") {
            {
                storage_log::validate_batches(&bytes)?;
                leveldb_core::parse_log_bytes(&bytes, path)
            }
        } else {
            leveldb_core::parse_table_bytes(&bytes, path)
        };
        records.extend(parsed.map_err(|e| format!("Cannot decode Desktop storage: {e}"))?);
    }
    if before != inventory(dir)?
        || current != std::fs::read_to_string(dir.join("CURRENT")).map_err(|e| e.to_string())?
        || manifest != std::fs::read(manifest_path).map_err(|e| e.to_string())?
    {
        return Err("Desktop storage changed during import. Quit GitHub Desktop and retry.".into());
    }
    Ok(live_records(records))
}

fn property<'a>(value: &'a V8Value, key: &str) -> Option<&'a str> {
    let V8Value::Object(properties) = value else {
        return None;
    };
    properties.iter().find_map(|(name, value)| match value {
        V8Value::String(text) if name == key => Some(text.as_str()),
        _ => None,
    })
}

pub fn read_profile(profile: &Path) -> Result<DesktopImport, String> {
    let indexed = profile.join("IndexedDB/file__0.indexeddb.leveldb");
    if !indexed.is_dir() {
        return Err("No local GitHub Desktop repository database found".into());
    }
    let records = read_store(&indexed)?;
    let settings_path = profile.join("Local Storage/leveldb");
    let settings = if settings_path.is_dir() { preferences(read_store(&settings_path)?) } else { BTreeMap::new() };
    let accounts = credential_accounts(&settings);
    let mut result = DesktopImport {
        account_hosts: accounts.iter().map(|a| a.host.clone()).collect(),
        accounts,
        ..DesktopImport::default()
    };
    let selected = settings.get("last-selected-repository-id").and_then(|s| s.parse::<f64>().ok());
    let mut seen = std::collections::HashMap::<PathBuf, String>::new();
    for record in chromium_storage_indexeddb_core::decode_records(&records) {
        if record.database.as_deref() != Some("Database") || record.object_store.as_deref() != Some("repositories") {
            continue;
        }
        let value = match record.value {
            RecordValue::V8(value) => value,
            RecordValue::Undecoded { raw, .. } => decode_padded_value(raw)?,
        };
        let path = property(&value, "path").ok_or("Desktop repository has no path")?;
        if !Path::new(path).is_absolute() {
            result.skipped.push(path.into());
            continue;
        }
        match crate::repository::working_directory(Path::new(path)) {
            Ok(root) => {
                let canonical = root.canonicalize().map_err(|e| e.to_string())?;
                let root = root.to_string_lossy().into_owned();
                let selected_path = seen.get(&canonical).cloned().unwrap_or_else(|| root.clone());
                if let chromium_storage_indexeddb_core::IdbKey::Number(id) = record.key
                    && selected == Some(id)
                {
                    result.selected_repository = Some(selected_path);
                }
                if let std::collections::hash_map::Entry::Vacant(entry) = seen.entry(canonical) {
                    entry.insert(root.clone());
                    result.repositories.push(root);
                }
            }
            Err(_) => result.skipped.push(path.into()),
        }
    }
    result.theme = settings.get("theme").filter(|v| matches!(v.as_str(), "light" | "dark" | "system")).cloned();
    result.sidebar_width =
        settings.get("sidebar-width").and_then(|v| v.parse::<u32>().ok()).filter(|v| (200..=800).contains(v));
    // Desktop stores display names; GitCub stores native bundle identifiers.
    let catalog: Vec<serde_json::Value> = if cfg!(windows) {
        crate::windows_integrations::available()
    } else {
        serde_json::from_str(include_str!("desktop-integrations.json")).map_err(|e| e.to_string())?
    };
    let integration = |key: &str, kind: &str| {
        settings.get(key).and_then(|name| {
            catalog
                .iter()
                .find(|item| item["name"].as_str() == Some(name.as_str()) && item["kind"] == kind)
                .and_then(|item| item["bundleId"].as_str())
                .map(str::to_owned)
        })
    };
    if cfg!(target_os = "macos") || cfg!(windows) {
        result.external_editor = integration("externalEditor", "editor");
        result.external_terminal = integration("shell", "terminal");
    }
    Ok(result)
}

/// Public account metadata from Desktop localStorage; never contains a token.
#[derive(Clone, Debug)]
pub struct DesktopAccount {
    pub host: String,
    pub endpoint: String,
    pub login: String,
}

fn credential_accounts(settings: &BTreeMap<String, String>) -> Vec<DesktopAccount> {
    let mut accounts = Vec::new();
    let mut add = |endpoint: &str, login: &str| {
        let Ok(url) = reqwest::Url::parse(endpoint) else { return };
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || login.is_empty()
        {
            return;
        }
        let Some(host) = url.host_str() else { return };
        let host = if host == "api.github.com" {
            "github.com".to_string()
        } else if let Some(port) = url.port() {
            format!("{host}:{port}")
        } else {
            host.to_owned()
        };
        accounts.push(DesktopAccount { host, endpoint: endpoint.to_owned(), login: login.to_owned() });
    };
    if let Some(users) = settings.get("users").and_then(|v| serde_json::from_str::<Vec<serde_json::Value>>(v).ok()) {
        for user in users {
            if let (Some(endpoint), Some(login)) = (user["endpoint"].as_str(), user["login"].as_str()) {
                add(endpoint, login);
            }
        }
    }
    for (key, login) in settings {
        if let Some(endpoint) = key.strip_prefix("genericGitAuth/username/") {
            add(endpoint, login);
        }
    }
    accounts
}

#[cfg(test)]
fn generic_login_from_records(records: Vec<Record>, endpoint: &str) -> Option<String> {
    let key = format!("genericGitAuth/username/{endpoint}");
    chromium_storage_localstorage_core::decode_records(&live_records(records)).into_iter().find_map(|record| {
        if let LocalStorageRecord::Data { origin, script_key, value, deleted: false, .. } = record
            && origin == "file://"
            && !script_key.lossy
            && !value.lossy
            && script_key.text == key
            && !value.text.is_empty()
        {
            Some(value.text)
        } else {
            None
        }
    })
}

fn preferences(records: Vec<Record>) -> BTreeMap<String, String> {
    chromium_storage_localstorage_core::decode_records(&records)
        .into_iter()
        .filter_map(|r| {
            if let LocalStorageRecord::Data { origin, script_key, value, deleted: false, .. } = r
                && origin == "file://"
                && !script_key.lossy
                && !value.lossy
                && (script_key.text.starts_with("genericGitAuth/username/")
                    || matches!(
                        script_key.text.as_str(),
                        "theme"
                            | "sidebar-width"
                            | "externalEditor"
                            | "shell"
                            | "last-selected-repository-id"
                            | "users"
                    ))
            {
                Some((script_key.text, value.text))
            } else {
                None
            }
        })
        .collect()
}

// blob-decoder 0.2 does not implement V8 kPadding. Remove ONLY a padding tag
// reported at a parser value boundary, never arbitrary NULs inside UTF-16 data.
// V8 src/objects/value-serializer.cc: ValueDeserializer::ReadTag / PeekTag.
fn decode_padded_value(mut bytes: Vec<u8>) -> Result<V8Value, String> {
    use blob_decoder::v8_value::{V8Error, V8Limits, deserialize_blink_with_limits};
    if bytes.len() > 1024 * 1024 {
        return Err("Desktop repository record exceeds size limit".into());
    }
    for _ in 0..256 {
        match deserialize_blink_with_limits(&bytes, V8Limits { max_depth: 32, max_nodes: 4096 }) {
            Ok(value) => return Ok(value),
            Err(V8Error::UnsupportedTag { offset, tag: 0 }) if bytes.get(offset) == Some(&0) => {
                bytes.remove(offset);
            }
            Err(error) => return Err(format!("Cannot decode a Desktop repository record: {error}")),
        }
    }
    Err("Too many padding tags in Desktop repository record".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_metadata_preserves_keychain_endpoint_and_maps_api_hosts() {
        let settings = BTreeMap::from([
            ("users".into(), r#"[{"endpoint":"https://api.github.com","login":"octocat"},{"endpoint":"http://unsafe.example","login":"skip"},{"endpoint":"https://user:secret@unsafe.example","login":"skip"}]"#.into()),
            ("genericGitAuth/username/https://gitlab.example:8443/".into(), "fixture".into()),
        ]);
        let accounts = credential_accounts(&settings);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].host, "github.com");
        assert_eq!(accounts[0].endpoint, "https://api.github.com");
        assert_eq!(accounts[1].host, "gitlab.example:8443");
        assert_eq!(accounts[1].endpoint, "https://gitlab.example:8443/");
    }

    #[test]
    fn windows_profile_uses_roaming_data_not_install_directory() {
        let actual = profile_for("windows", |key| match key {
            "APPDATA" => Some(PathBuf::from("roaming")),
            "LOCALAPPDATA" => Some(PathBuf::from("local")),
            _ => None,
        })
        .unwrap();
        assert_eq!(actual, Path::new("roaming").join("GitHub Desktop"));
        assert!(profile_for("windows", |_| None).is_err());
    }
    #[test]
    fn windows_install_detection_handles_squirrel_version_directories() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!windows_install_exists(temp.path()));
        let version = temp.path().join("app-3.4.0");
        std::fs::create_dir(&version).unwrap();
        std::fs::write(version.join("GitHubDesktop.exe"), []).unwrap();
        assert!(windows_install_exists(temp.path()));
    }
    fn record(key: &[u8], seq: u64, deleted: bool, value: &[u8]) -> Record {
        Record { key: key.to_vec(), value: value.to_vec(), seq, deleted, origin_file: PathBuf::from("fixture.log") }
    }
    #[test]
    fn latest_versions_and_tombstones_apply_before_decoding() {
        let records = live_records(vec![
            record(b"deleted", 4, true, b""),
            record(b"deleted", 1, false, b"old"),
            record(b"updated", 3, false, b"new"),
            record(b"updated", 2, false, b"old"),
        ]);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].value, b"new");
    }
    #[test]
    fn preferences_are_allowlisted_and_local_only() {
        let settings = preferences(live_records(vec![
            record(b"_file://\0\x01theme", 1, false, b"\x01dark"),
            record(b"_https://github.com\0\x01theme", 2, false, b"\x01light"),
            record(b"_file://\0\x01token", 3, false, b"\x01not-exported"),
            record(b"_file://\0\x01externalEditor", 4, false, b"\x01Atom"),
            record(b"_file://\0\x01externalEditor", 5, true, b""),
        ]));
        assert_eq!(settings, BTreeMap::from([("theme".into(), "dark".into())]));
    }

    #[test]
    fn generic_login_respects_origin_endpoint_and_deletion() {
        let key = b"_file://\0\x01genericGitAuth/username/https://gitlab.example/";
        let records = || {
            vec![
                record(key, 1, false, b"\x01old-user"),
                record(key, 2, false, b"\x01current-user"),
                record(
                    b"_https://evil.example\0\x01genericGitAuth/username/https://gitlab.example/",
                    3,
                    false,
                    b"\x01wrong-origin",
                ),
            ]
        };
        assert_eq!(generic_login_from_records(records(), "https://gitlab.example/"), Some("current-user".into()));
        assert_eq!(generic_login_from_records(records(), "https://other.example/"), None);
        let mut deleted = records();
        deleted.push(record(key, 4, true, b""));
        assert_eq!(generic_login_from_records(deleted, "https://gitlab.example/"), None);
    }

    fn varint(mut value: u64, bytes: &mut Vec<u8>) {
        while value >= 128 {
            bytes.push(value as u8 | 128);
            value >>= 7;
        }
        bytes.push(value as u8);
    }
    fn length_prefixed(value: &[u8], bytes: &mut Vec<u8>) {
        varint(value.len() as u64, bytes);
        bytes.extend_from_slice(value);
    }
    fn framed(payload: &[u8]) -> Vec<u8> {
        let checksum = crc32c::crc32c_append(crc32c::crc32c(&[1]), payload).rotate_left(17).wrapping_add(0xa282_ead8);
        let mut bytes = checksum.to_le_bytes().to_vec();
        bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        bytes.push(1);
        bytes.extend_from_slice(payload);
        bytes
    }
    fn write_store(path: &Path, entries: &[Record]) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("CURRENT"), "MANIFEST-000001\n").unwrap();
        std::fs::write(path.join("MANIFEST-000001"), framed(&[2, 1])).unwrap();
        let mut log = Vec::new();
        for entry in entries {
            let mut batch = entry.seq.to_le_bytes().to_vec();
            batch.extend_from_slice(&1u32.to_le_bytes());
            batch.push(u8::from(!entry.deleted));
            length_prefixed(&entry.key, &mut batch);
            if !entry.deleted {
                length_prefixed(&entry.value, &mut batch);
            }
            log.extend(framed(&batch));
        }
        std::fs::write(path.join("000001.log"), log).unwrap();
    }
    fn string16(value: &str) -> Vec<u8> {
        value.encode_utf16().flat_map(u16::to_be_bytes).collect()
    }
    fn repo_record(id: f64, seq: u64, path: &str) -> Record {
        let mut key = vec![0, 1, 1, 1, 3];
        key.extend(id.to_le_bytes());
        // IndexedDB version, Blink version, V8 version, object, path property.
        let mut value = vec![1, 255, 21, 255, 15, b'o', b'"', 4, b'p', b'a', b't', b'h', 0, b'c'];
        let text: Vec<u8> = path.encode_utf16().flat_map(u16::to_le_bytes).collect();
        length_prefixed(&text, &mut value);
        value.extend([b'{', 1]);
        record(&key, seq, false, &value)
    }
    #[test]
    fn full_profile_import_preserves_unicode_and_skips_deleted_missing_and_duplicate_paths() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("中文仓库");
        std::fs::create_dir(&repo).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).arg(&repo).status().unwrap().success());
        let profile = temp.path().join("profile");
        let mut name = vec![0, 0, 0, 0, 201, 7];
        name.extend(string16("file://"));
        name.push(8);
        name.extend(string16("Database"));
        let valid = repo_record(1.0, 3, repo.to_str().unwrap());
        let removed = repo_record(2.0, 4, repo.to_str().unwrap());
        let entries = vec![
            record(&name, 1, false, &[1]),
            record(&[0, 1, 0, 0, 50, 1, 0], 2, false, &string16("repositories")),
            valid,
            removed.clone(),
            record(&removed.key, 5, true, &[]),
            repo_record(3.0, 6, temp.path().join("missing").to_str().unwrap()),
            repo_record(4.0, 7, repo.to_str().unwrap()),
        ];
        write_store(&profile.join("IndexedDB/file__0.indexeddb.leveldb"), &entries);
        write_store(
            &profile.join("Local Storage/leveldb"),
            &[
                record(b"_file://\0\x01theme", 1, false, b"\x01dark"),
                record(b"_file://\0\x01last-selected-repository-id", 2, false, b"\x011"),
            ],
        );
        let imported = read_profile(&profile).unwrap();
        assert_eq!(imported.repositories, vec![repo.to_str().unwrap()]);
        assert_eq!(imported.selected_repository.as_deref(), repo.to_str());
        assert_eq!(imported.theme.as_deref(), Some("dark"));
        assert_eq!(imported.skipped.len(), 1);
    }
    #[test]
    fn corrupt_log_is_rejected_instead_of_recovering_old_settings() {
        let temp = tempfile::tempdir().unwrap();
        write_store(temp.path(), &[record(b"key", 1, false, b"value")]);
        let path = temp.path().join("000001.log");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[0] ^= 1;
        std::fs::write(path, bytes).unwrap();
        assert!(read_store(temp.path()).unwrap_err().contains("checksum"));
    }
    #[test]
    fn obsolete_logs_are_not_imported() {
        let temp = tempfile::tempdir().unwrap();
        write_store(temp.path(), &[record(b"key", 1, false, b"value")]);
        std::fs::write(temp.path().join("000000.log"), b"obsolete-corrupt-file").unwrap();
        assert_eq!(read_store(temp.path()).unwrap().len(), 1);
    }
    #[test]
    fn missing_profile_is_an_error_not_empty_success() {
        let temp = tempfile::tempdir().unwrap();
        assert!(read_profile(temp.path()).is_err());
    }
}
