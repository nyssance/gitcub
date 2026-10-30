//! 应用状态持久化。
//!
//! Desktop 会记住仓库列表、上次选中的仓库、侧栏宽度和当前标签页，
//! 重开应用直接回到上次的位置。这里存成 app 配置目录下的一个 JSON。
//!
//! 放在 Rust 侧而不是 localStorage：仓库列表是应用级数据，
//! 清浏览器数据不该把它清掉；而且 webview 的存储在 Tauri 各平台上
//! 落盘位置不一致，排查起来麻烦。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    /// 最近打开过的仓库，最新的排最前（对齐 Desktop 仓库下拉的顺序）
    pub repositories: Vec<String>,
    pub selected_repository: Option<String>,
    pub desktop_import_handled: bool,
    pub canvas_trackpad_gestures: bool,
    pub sidebar_width: u32,
    pub selected_tab: String,
    /// light | dark | system
    pub theme: String,
    /// 界面语言；空字符串表示跟随系统
    pub language: String,
    pub external_editor: String,
    pub external_terminal: String,
    /// 仓库归属的手动修正：路径 -> "mine" | "third"。
    /// 自动判定（origin 的 owner 对上账号 login）之外的例外由用户在右键菜单里定，
    /// 手动结果优先于自动判定。
    #[serde(default)]
    pub repo_ownership: std::collections::HashMap<String, String>,
    /// 手动加过的实例主机名（自建 GitLab 等）
    #[serde(default)]
    pub account_hosts: Vec<String>,
    /// 各实例的 OAuth client_id。**不是密钥**（设备码流程不需要 client secret），
    /// 所以进配置文件而不是钥匙串；每个自建实例的应用都不一样，写死没有意义。
    #[serde(default)]
    pub oauth_clients: std::collections::HashMap<String, String>,
    pub oauth_providers: std::collections::HashMap<String, crate::account::Kind>,
    /// 提交信息里的 issue 引用规则（GitLens autolinks），全局生效
    #[serde(default)]
    pub autolinks: Vec<AutolinkRule>,
    /// 欢迎流程走完（或跳过）了。Desktop 记在 localStorage，macOS 的 WKWebView 对 tauri:// 页面不落盘，
    /// 每次启动都会再进一次欢迎页，所以记在这里。
    #[serde(default)]
    pub welcomed: bool,
}

/// 一条自动链接规则：`prefix` 后跟编号，`url` 里的 `<num>` 换成编号。
/// 与前端 src/models/app-state.ts 的 AutolinkRule 对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutolinkRule {
    pub prefix: String,
    pub url: String,
    #[serde(default)]
    pub alphanumeric: bool,
    #[serde(default)]
    pub ignore_case: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            repositories: Vec::new(),
            selected_repository: None,
            desktop_import_handled: false,
            canvas_trackpad_gestures: false,
            repo_ownership: std::collections::HashMap::new(),
            account_hosts: Vec::new(),
            oauth_clients: std::collections::HashMap::new(),
            oauth_providers: std::collections::HashMap::new(),
            autolinks: Vec::new(),
            welcomed: false,
            sidebar_width: 250, // Desktop: defaultSidebarWidth
            selected_tab: "changes".into(),
            theme: "system".into(),
            language: String::new(),
            external_editor: String::new(),
            external_terminal: String::new(),
        }
    }
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("取配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建配置目录失败: {e}"))?;
    Ok(dir.join("state.json"))
}

pub fn load(app: &tauri::AppHandle) -> AppState {
    // 读不到或解析失败都退回默认值：状态文件损坏不该让应用起不来
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, mut state: AppState) -> Result<(), String> {
    // 去重并把当前选中的仓库提到最前
    state.repositories.retain(|r| !r.is_empty());
    state.repositories.dedup();
    if let Some(sel) = state.selected_repository.clone() {
        state.repositories.retain(|r| r != &sel);
        state.repositories.insert(0, sel);
    }
    let p = path(app)?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| format!("序列化失败: {e}"))?;
    use std::io::Write;
    let mut file =
        tempfile::NamedTempFile::new_in(p.parent().ok_or("Invalid state directory")?).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(p).map_err(|e| format!("写状态文件失败: {e}"))?;
    Ok(())
}

/// 用户添加过的实例标识（`host[:port][/子路径]`），远端 URL 按它们匹配实例。读状态文件放到阻塞线程池。
pub async fn known_instances(app: &tauri::AppHandle) -> Vec<String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || load(&app).account_hosts).await.unwrap_or_default()
}

/// 已经不存在或不再是 git 仓库的路径要从列表里剔除，
/// 否则用户删掉目录后下拉里会一直留着死条目。
pub fn prune(mut state: AppState) -> AppState {
    state.repositories.retain(|r| std::path::Path::new(r).join(".git").exists());
    if let Some(sel) = &state.selected_repository
        && !state.repositories.contains(sel)
    {
        state.selected_repository = None;
    }
    state
}

pub fn merge_desktop_import(state: &mut AppState, data: crate::desktop_import::DesktopImport) {
    for host in &data.account_hosts {
        if !state.account_hosts.contains(host) {
            state.account_hosts.push(host.clone());
        }
    }
    let mut known = state
        .repositories
        .iter()
        .map(|p| std::path::Path::new(p).canonicalize().unwrap_or_else(|_| PathBuf::from(p)))
        .collect::<std::collections::HashSet<_>>();
    for path in data.repositories {
        let canonical = std::path::Path::new(&path).canonicalize().unwrap_or_else(|_| PathBuf::from(&path));
        if known.insert(canonical) {
            state.repositories.push(path);
        }
    }
    if state.selected_repository.is_none() {
        state.selected_repository = data
            .selected_repository
            .filter(|path| state.repositories.contains(path))
            .or_else(|| state.repositories.first().cloned());
    }
    if let Some(value) = data.theme {
        state.theme = value;
    }
    if let Some(value) = data.sidebar_width {
        state.sidebar_width = value;
    }
    if let Some(value) = data.external_editor {
        state.external_editor = value;
    }
    if let Some(value) = data.external_terminal {
        state.external_terminal = value;
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn canvas_trackpad_is_opt_in_for_new_and_existing_profiles() {
        assert!(!AppState::default().canvas_trackpad_gestures);
        let old: AppState = serde_json::from_str("{}").unwrap();
        assert!(!old.canvas_trackpad_gestures);
        let enabled: AppState = serde_json::from_str(r#"{"canvasTrackpadGestures":true}"#).unwrap();
        let restored: AppState = serde_json::from_str(&serde_json::to_string(&enabled).unwrap()).unwrap();
        assert!(restored.canvas_trackpad_gestures);
    }

    #[test]
    fn autolink_rules_default_to_empty_and_roundtrip() {
        let old: AppState = serde_json::from_str("{}").unwrap();
        assert!(old.autolinks.is_empty());
        let saved: AppState = serde_json::from_str(
            r#"{"autolinks":[{"prefix":"JIRA-","url":"https://jira.example.com/browse/JIRA-<num>","alphanumeric":false,"ignoreCase":true,"title":"Issue <num>"}]}"#,
        )
        .unwrap();
        let restored: AppState = serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(restored.autolinks, saved.autolinks);
        assert_eq!(restored.autolinks[0].prefix, "JIRA-");
        assert!(restored.autolinks[0].ignore_case);
        assert_eq!(restored.autolinks[0].title.as_deref(), Some("Issue <num>"));
    }

    #[test]
    fn merge_keeps_current_repository_and_roundtrips_onboarding_choice() {
        let mut state = AppState {
            repositories: vec!["existing".into()],
            selected_repository: Some("existing".into()),
            ..Default::default()
        };
        merge_desktop_import(
            &mut state,
            crate::desktop_import::DesktopImport {
                repositories: vec!["existing".into(), "new".into()],
                selected_repository: Some("new".into()),
                theme: Some("dark".into()),
                ..Default::default()
            },
        );
        assert_eq!(state.repositories, ["existing", "new"]);
        assert_eq!(state.selected_repository.as_deref(), Some("existing"));
        assert_eq!(state.theme, "dark");
        state.desktop_import_handled = true;
        let restored: AppState = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert!(restored.desktop_import_handled);
        let legacy: AppState = serde_json::from_str("{}").unwrap();
        assert!(!legacy.desktop_import_handled);
    }
}
