//! 前端能调用的命令。
//!
//! 只做参数转换和错误转字符串，逻辑都在各自模块里。
//! 保持薄是有意的——GitHub Desktop 把状态和逻辑全堆进一个万行的
//! app-store.ts，任何操作完成都触发大面积重渲染。

use crate::{
    account, blame, branch, cache, file_history, graph, history, image, interactive, lfs, net, oauth, ops, raw_diff,
    remote, settings, stage, status, store, system, watch,
};
/// 各类结果的保鲜期。过期不等于作废——拉不动时照样用旧的（见 cache.rs）。
mod ttl {
    use std::time::Duration;
    /// 自己的仓库与 star 列表，一刻钟
    pub const LISTS: Duration = Duration::from_secs(15 * 60);
    /// 登录名和所属组织很少变
    pub const ACCOUNT: Duration = Duration::from_secs(6 * 60 * 60);
    /// 私有/fork 基本不变，一天
    pub const REPO_META: Duration = Duration::from_secs(24 * 60 * 60);
}
use std::path::Path;

#[tauri::command]
pub async fn load_state(app: tauri::AppHandle) -> Result<store::AppState, String> {
    tauri::async_runtime::spawn_blocking(move || store::prune(store::load(&app)))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_desktop_import(app: tauri::AppHandle) -> Result<crate::desktop_import::DesktopImport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let known = store::load(&app).account_hosts;
        let data = crate::credentials::import_profile(&crate::desktop_import::profile_path()?, &known)?;
        for host in &data.account_hosts {
            cache::invalidate(&app, &format!("account-{host}"));
        }
        Ok(data)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_state(app: tauri::AppHandle, state: store::AppState) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store::save(&app, state)).await.map_err(|error| error.to_string())?
}

/// origin 远端的 host / owner / 名字。没有 origin 或 URL 不认识就是 None。
#[tauri::command]
pub async fn repo_remote(app: tauri::AppHandle, repo: String) -> Result<Option<remote::Remote>, String> {
    cache::get_or_fetch(&app, &format!("remote-{repo}"), std::time::Duration::ZERO, false, || async {
        tauri::async_runtime::spawn_blocking(move || remote::origin(Path::new(&repo)))
            .await
            .map_err(|error| error.to_string())?
    })
    .await
}

/// 按 host 取账号：登录名、命名空间（含组织/群组）、凭据来源。
/// host 由前端从各仓库的 origin 收集，自建实例因此也能用。
#[tauri::command]
pub async fn account_info(
    app: tauri::AppHandle, hosts: Vec<String>, refresh: bool,
) -> std::collections::HashMap<String, account::Account> {
    type ByHost = std::collections::HashMap<String, account::Account>;
    let mut out = ByHost::new();
    for host in hosts {
        // 一个 host 一条缓存：某个实例连不上，不该让别的实例也跟着重拉
        let key = format!("account-{host}");
        if !refresh && let Some((value, false)) = cache::read::<ByHost>(&app, &key, ttl::ACCOUNT) {
            out.extend(value);
            continue;
        }
        // 过期或要求刷新时必须真的验证一次：失败要带着原因交给界面，不能悄悄沿用旧缓存，
        // 否则令牌过期后界面一直显示已登录。
        let fetched = cache::get_or_fetch(&app, &key, ttl::ACCOUNT, true, || async {
            account::one(&host, refresh).await.map(|account| ByHost::from([(host.clone(), account)]))
        })
        .await;
        match fetched {
            Ok(value) => out.extend(value),
            Err(error) => {
                let mut last = cache::read::<ByHost>(&app, &key, ttl::ACCOUNT)
                    .and_then(|(mut value, _)| value.remove(&host))
                    .unwrap_or_default();
                last.unauthorized = account::is_unauthorized(&error);
                last.error = Some(error);
                out.insert(host, last);
            }
        }
    }
    out
}

/// 仓库元信息：私有 / fork。左栏用它选图标（照原版 iconForRepository）。
#[tauri::command]
pub async fn repo_meta(
    app: tauri::AppHandle, host: String, owner: String, name: String, kind: account::Kind,
) -> Option<account::RepoMeta> {
    let key = format!("meta-{host}-{owner}-{name}");
    cache::get_or_fetch(&app, &key, ttl::REPO_META, false, || async {
        account::repo_meta(&host, &owner, &name, kind).await.ok_or("取不到仓库信息".to_string())
    })
    .await
    .ok()
}

/// 为某个实例存令牌。host 是主机名（github.com / gitlab.com / 自建域名）。
/// 传空串表示清除。
#[tauri::command]
pub async fn set_token(host: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        oauth::change_account(&host, || {
            settings::set_host_token(&host, &token)?;
            settings::set_ignored(&host, false)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 你在某个实例上的仓库（含私有、组织的）。
#[tauri::command]
pub async fn my_repos(app: tauri::AppHandle, host: String, refresh: bool) -> Result<Vec<account::RemoteRepo>, String> {
    cache::get_or_fetch(&app, &format!("repos-{host}"), ttl::LISTS, refresh, || account::user_repos(&host, refresh))
        .await
}

/// 你在某个实例上 star 过的仓库。
#[tauri::command]
pub async fn my_stars(app: tauri::AppHandle, host: String, refresh: bool) -> Result<Vec<account::RemoteRepo>, String> {
    cache::get_or_fetch(&app, &format!("stars-{host}"), ttl::LISTS, refresh, || account::starred(&host, refresh)).await
}

/// 各实例内置的应用 ID。用 github.com 的人零配置就能登录。
#[tauri::command]
pub fn oauth_default_clients() -> std::collections::HashMap<String, String> {
    ["github.com"]
        .into_iter()
        .filter_map(|h| oauth::default_client_id(h).map(|id| (h.to_string(), id.to_string())))
        .collect()
}

/// 开始设备码登录：拿到给用户看的短码和验证地址。
/// client_id 传空就用内置的。
#[tauri::command]
pub async fn oauth_device_start(
    host: String, client_id: String, kind: Option<account::Kind>, attempt_id: String,
) -> Result<oauth::DeviceStart, String> {
    let id = oauth::client_id_for(&host, Some(&client_id)).ok_or_else(|| format!("{host} 还没有应用 ID"))?;
    oauth::device_start(&host, &id, kind, &attempt_id).await
}

/// 轮询一次。成功时令牌直接进钥匙串，不经过前端。
#[tauri::command]
pub async fn oauth_device_poll(
    host: String, client_id: String, device_code: String, attempt_id: String,
) -> Result<oauth::PollStatus, String> {
    let id = oauth::client_id_for(&host, Some(&client_id)).ok_or_else(|| format!("{host} 还没有应用 ID"))?;
    oauth::device_poll(&host, &id, &device_code, &attempt_id).await
}

#[tauri::command]
pub async fn oauth_device_cancel(host: String, attempt_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || oauth::cancel(&host, &attempt_id))
        .await
        .map_err(|error| error.to_string())?
}

/// 退出登录 / 重新启用某个实例。登出会连系统里已有的凭据（gh、凭据助手）
/// 一起停用，否则删掉自己的令牌后又会被自动捡回来。
#[tauri::command]
pub async fn set_account_ignored(host: String, ignored: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        oauth::change_account(&host, || {
            settings::set_ignored(&host, ignored)?;
            if ignored {
                settings::set_host_token(&host, "")?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_identity(repo: Option<String>) -> Result<settings::GitIdentity, String> {
    tauri::async_runtime::spawn_blocking(move || settings::git_identity(repo.as_deref().map(Path::new)))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_git_identity(repo: Option<String>, name: String, email: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings::set_git_identity(repo.as_deref().map(Path::new), &settings::GitIdentity { name, email })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn repo_status(repo: String) -> Result<status::RepoStatus, String> {
    // Tauri executes synchronous commands on the macOS event loop. Status can
    // hash large working-tree files, so even a read must run off that thread.
    tauri::async_runtime::spawn_blocking(move || status::status(Path::new(&repo))).await.map_err(|e| e.to_string())?
}

/// 待办页用的轻量摘要：不遍历工作区，见 `status::summary`。
#[tauri::command]
pub async fn repo_summary(repo: String) -> Result<status::RepoSummary, String> {
    tauri::async_runtime::spawn_blocking(move || status::summary(Path::new(&repo))).await.map_err(|e| e.to_string())?
}

/// 盯住这个仓库的文件变化，事件从 `repo-changed` 发出来。
/// 传 None = 不盯任何仓库（比如切到了「发现」页）。
#[tauri::command]
pub async fn watch_repo(app: tauri::AppHandle, repo: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<watch::Watching>();
        match repo {
            Some(r) => watch::watch(&app, Path::new(&r), &state),
            None => {
                *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
                Ok(())
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn branches(repo: String) -> Result<Vec<status::Branch>, String> {
    tauri::async_runtime::spawn_blocking(move || status::branches(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_branch(
    repo: String, name: String, start_point: Option<String>, no_track: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        branch::create(Path::new(&repo), &name, start_point.as_deref(), no_track)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_branch(repo: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || branch::delete_local(Path::new(&repo), &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_remote_branch(
    app: tauri::AppHandle, repo: String, remote: String, name: String,
) -> Result<(), String> {
    let p = Path::new(&repo);
    let token = settings::token_for_push(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth_hint(branch::delete_remote(Path::new(&repo), &remote, &name, token.as_deref()), token.is_some())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 丢弃改动。文件先进废纸篓再复位，捞得回来。
#[tauri::command]
pub async fn discard_changes(repo: String, files: Vec<branch::DiscardFile>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || branch::discard(Path::new(&repo), &files))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clone_repo(app: tauri::AppHandle, url: String, path: String) -> Result<(), String> {
    // 克隆时还没有仓库，拿不到远端 URL 来判定用哪份 token，按 URL 直接判
    let token = settings::token_for_url(&app, &url).await?;
    tauri::async_runtime::spawn_blocking(move || branch::clone(&url, Path::new(&path), token.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn checkout(repo: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || net::checkout(Path::new(&repo), &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn log(repo: String, limit: usize, skip: usize) -> Result<Vec<history::CommitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || history::log(Path::new(&repo), limit, skip))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit_files(repo: String, sha: String) -> Result<Vec<history::CommitFile>, String> {
    tauri::async_runtime::spawn_blocking(move || history::commit_files(Path::new(&repo), &sha))
        .await
        .map_err(|error| error.to_string())?
}

/// 某次提交里某个文件的原始 diff 文本，交给前端移植自原版的解析器。
#[tauri::command]
pub async fn commit_file_diff_raw(
    repo: String, sha: String, file: String, old_path: Option<String>, hide_whitespace: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        raw_diff::commit_file_diff(Path::new(&repo), &sha, &file, old_path.as_deref(), hide_whitespace.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 原始 diff 文本，交给前端移植自原版的 diff-parser 解析。
#[tauri::command]
pub async fn working_directory_diff(
    repo: String, file: String, kind: raw_diff::FileKind, hide_whitespace: bool,
) -> Result<raw_diff::RawDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        raw_diff::working_directory_diff(Path::new(&repo), &file, kind, hide_whitespace)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 只丢弃选中的那几行：把反向补丁打到工作区。
#[tauri::command]
pub async fn discard_lines(repo: String, patch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || raw_diff::apply_patch_to_worktree(Path::new(&repo), &patch))
        .await
        .map_err(|error| error.to_string())?
}

/// 部分暂存：先把该文件在 index 里重置回 HEAD，再应用补丁。
#[tauri::command]
pub async fn apply_patch_to_index(repo: String, file: String, patch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&repo);
        raw_diff::reset_file_in_index(p, &file)?;
        raw_diff::apply_patch_to_index(p, &patch)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_at_commit(repo: String, sha: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || raw_diff::file_at_commit(Path::new(&repo), &sha, &file))
        .await
        .map_err(|error| error.to_string())?
}

/// 这些文件里哪些又大又没走 LFS —— 提交前问一句，免得推上去才被拒。
#[tauri::command]
pub async fn oversized_files(repo: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || system::oversized_files(Path::new(&repo), &paths))
        .await
        .map_err(|error| error.to_string())
}

/// 仓库里的 PR 模板。走 API 建 PR 时 GitHub 不会自己填，得我们读。
#[tauri::command]
pub async fn pr_template(repo: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || system::pr_template(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())
}

/// 这个仓库和 LFS 的关系：用没用、有没有 git-lfs、装没装过滤器。
#[tauri::command]
pub async fn lfs_state(repo: String) -> Result<lfs::LfsState, String> {
    tauri::async_runtime::spawn_blocking(move || lfs::state(Path::new(&repo))).await.map_err(|error| error.to_string())
}

/// 给这个仓库装上 LFS 过滤器。
#[tauri::command]
pub async fn lfs_install(repo: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || lfs::install(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

/// 两版图片本身（base64），给图片 diff 用。
/// `sha` 给了是看某次提交，没给是看工作区。
#[tauri::command]
pub async fn image_diff(repo: String, file: String, sha: Option<String>) -> Result<image::ImageDiff, String> {
    tauri::async_runtime::spawn_blocking(move || image::image_diff(Path::new(&repo), &file, sha.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

/// 子模块的细节（地址、记录的提交 vs 实际的提交、内部有多少没提交的东西）。
#[tauri::command]
pub async fn submodule_info(repo: String, file: String) -> Result<system::SubmoduleInfo, String> {
    tauri::async_runtime::spawn_blocking(move || system::submodule_info(Path::new(&repo), &file))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_contents(repo: String, file: String) -> Result<stage::FileContents, String> {
    tauri::async_runtime::spawn_blocking(move || stage::file_contents(Path::new(&repo), &file))
        .await
        .map_err(|error| error.to_string())?
}

/// 一次把整份勾选状态落到 index。提交前调一次，取代过去的「一个文件一次」。
#[tauri::command]
pub async fn apply_selection(repo: String, files: Vec<stage::StageFile>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stage::apply_selection(Path::new(&repo), &files))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit(
    repo: String, summary: String, description: String, options: net::CommitOptions,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || net::commit(Path::new(&repo), &summary, &description, options))
        .await
        .map_err(|error| error.to_string())?
}

/// token 由后端自己从钥匙串取，**完全不经过前端**。
/// 它只进 git 子进程的环境变量，不进 argv —— 理由见 net.rs。
///
/// 取不到不算错：SSH 远端、本地远端、以及用户自己配好的 credential helper
/// 都不需要 token。真的缺凭据时由 git 报出来，再翻译成 NO_TOKEN
/// （界面据此引导去登录），而不是一上来就拦着不让推。
async fn token_of(app: &tauri::AppHandle, repo: &Path, remote: &str) -> Result<Option<String>, String> {
    settings::token_for(app, repo, remote).await
}

/// git 的「你没凭据」报错长什么样。认出来才好把它换成界面能处理的 NO_TOKEN。
fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("authentication failed")
        || m.contains("could not read username")
        || m.contains("could not read password")
        || m.contains("terminal prompts disabled")
        || m.contains("permission denied (publickey)")
        || m.contains("403 forbidden")
}

/// 没 token 又确实是认证问题 → 报 NO_TOKEN，界面提示去登录。
fn with_auth_hint(r: Result<(), String>, had_token: bool) -> Result<(), String> {
    match r {
        Err(e) if !had_token && is_auth_error(&e) => Err("NO_TOKEN".into()),
        other => other,
    }
}

#[tauri::command]
pub async fn push(
    app: tauri::AppHandle, repo: String, remote: String, refspec: String, set_upstream: bool, force_with_lease: bool,
) -> Result<(), String> {
    let p = Path::new(&repo);
    let token = settings::token_for_push(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth_hint(
            net::push(Path::new(&repo), &remote, &refspec, set_upstream, force_with_lease, token.as_deref(), None),
            token.is_some(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn fetch(app: tauri::AppHandle, repo: String, remote: String) -> Result<(), String> {
    let p = Path::new(&repo);
    let token = token_of(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth_hint(net::fetch(Path::new(&repo), &remote, token.as_deref(), None), token.is_some())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pull(app: tauri::AppHandle, repo: String, remote: String) -> Result<(), String> {
    let p = Path::new(&repo);
    let token = token_of(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth_hint(net::pull(Path::new(&repo), &remote, token.as_deref(), None), token.is_some())
    })
    .await
    .map_err(|error| error.to_string())?
}

// ── 分支操作 ────────────────────────────────────────────────────────

/// 合之前先算一下会不会冲突。
#[tauri::command]
pub async fn merge_preview(repo: String, ours: String, theirs: String) -> Result<ops::MergePreview, String> {
    tauri::async_runtime::spawn_blocking(move || ops::merge_preview(Path::new(&repo), &ours, &theirs))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn merge_branch(repo: String, branch: String, squash: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::merge(Path::new(&repo), &branch, squash))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rebase_branch(
    repo: String, base: String, output: tauri::ipc::Channel<crate::git::TerminalChunk>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = ops::rebase_branch_stream(Path::new(&repo), &base, None, |chunk| {
            let _ = output.send(chunk);
        })?;
        match outcome.result {
            ops::RebaseResult::CompletedWithoutError | ops::RebaseResult::AlreadyUpToDate => Ok(()),
            _ => Err(outcome.diagnostic),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 收尾/中止正在进行的那个操作。具体是哪个由 repo_status 的 operation 给出，
/// 前端不用猜（以前是「先试 rebase --continue，失败再当成合并」）。
#[tauri::command]
pub async fn continue_operation(repo: String, operation: ops::Operation) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::continue_operation(Path::new(&repo), operation))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn abort_operation(repo: String, operation: ops::Operation) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::abort_operation(Path::new(&repo), operation))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rename_branch(repo: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::rename_branch(Path::new(&repo), &from, &to))
        .await
        .map_err(|error| error.to_string())?
}

/// 相对某个分支领先/落后多少提交，比较分支时用。
#[tauri::command]
pub async fn compare_branches(repo: String, ours: String, theirs: String) -> Result<(u32, u32), String> {
    tauri::async_runtime::spawn_blocking(move || ops::ahead_behind(Path::new(&repo), &ours, &theirs))
        .await
        .map_err(|error| error.to_string())?
}

/// 两条分支差在哪些提交上（不只是几个）。
#[tauri::command]
pub async fn compare_commits(
    repo: String, ours: String, theirs: String, limit: usize,
) -> Result<history::Comparison, String> {
    tauri::async_runtime::spawn_blocking(move || history::compare(Path::new(&repo), &ours, &theirs, limit))
        .await
        .map_err(|error| error.to_string())?
}

// ── 贮藏 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn stashes(repo: String) -> Result<Vec<ops::StashEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::stashes(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stash_push(repo: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::stash_push(Path::new(&repo), &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stash_pop(repo: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::stash_pop(Path::new(&repo), &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stash_drop(repo: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::stash_drop(Path::new(&repo), &name))
        .await
        .map_err(|error| error.to_string())?
}

// ── 撤销与历史操作 ──────────────────────────────────────────────────

#[tauri::command]
pub async fn undo_commit(repo: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::undo_commit(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn amend_commit(repo: String, summary: String, description: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::amend(Path::new(&repo), &summary, &description))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn reset_to(repo: String, mode: ops::ResetMode, target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::reset(Path::new(&repo), mode, &target))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn revert_commit(repo: String, sha: String, is_merge: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::revert(Path::new(&repo), &sha, is_merge))
        .await
        .map_err(|error| error.to_string())?
}

/// 把若干提交压成一个。会重写历史。
#[tauri::command]
pub async fn squash_commits(
    repo: String, to_squash: Vec<String>, onto: String, last_retained: Option<String>, message: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        interactive::squash(Path::new(&repo), &to_squash, &onto, last_retained.as_deref(), &message)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 把若干提交挪到 `before` 之前（None = 挪到最后）。会重写历史。
#[tauri::command]
pub async fn reorder_commits(
    repo: String, to_move: Vec<String>, before: Option<String>, last_retained: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        interactive::reorder(Path::new(&repo), &to_move, before.as_deref(), last_retained.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn cherry_pick(
    repo: String, shas: Vec<String>, output: tauri::ipc::Channel<crate::git::TerminalChunk>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ops::cherry_pick_stream(Path::new(&repo), &shas, |chunk| {
            let _ = output.send(chunk);
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

// ── 标签 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn tags(repo: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::tags(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_tag(repo: String, name: String, sha: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::create_tag(Path::new(&repo), &name, &sha))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_tag(repo: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::delete_tag(Path::new(&repo), &name))
        .await
        .map_err(|error| error.to_string())?
}

// ── 工作树 ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn worktrees(repo: String) -> Result<Vec<ops::Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::worktrees(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn add_worktree(repo: String, path: String, branch: String, create: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::add_worktree(Path::new(&repo), Path::new(&path), &branch, create))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_worktree(repo: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::remove_worktree(Path::new(&repo), &path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn move_worktree(repo: String, old_path: String, new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::move_worktree(Path::new(&repo), &old_path, &new_path))
        .await
        .map_err(|error| error.to_string())?
}

// ── 冲突 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn resolve_conflict(repo: String, file: String, keep: ops::Resolution) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::resolve_conflict(Path::new(&repo), &file, keep))
        .await
        .map_err(|error| error.to_string())?
}

/// 提交图：带泳道的一页提交。`cursor` 是上一页末尾的泳道状态，下一页从那里接着算。
#[tauri::command]
pub async fn graph(
    repo: String, limit: usize, skip: usize, cursor: Option<graph::GraphCursor>,
) -> Result<graph::GraphPage, String> {
    tauri::async_runtime::spawn_blocking(move || graph::graph(Path::new(&repo), limit, skip, cursor))
        .await
        .map_err(|error| error.to_string())?
}

/// 某个仓库的开放 PR / MR。
#[tauri::command]
pub async fn pull_requests(
    app: tauri::AppHandle, host: String, owner: String, name: String, refresh: bool,
) -> Result<Vec<account::PullRequest>, String> {
    let key = format!("prs-{host}-{owner}-{name}");
    cache::get_or_fetch(&app, &key, ttl::LISTS, refresh, || account::pull_requests(&host, &owner, &name)).await
}

/// 跟我有关的 PR：等我评审的 / 我开的。用搜索接口一次问完。
#[tauri::command]
pub async fn involved_prs(
    app: tauri::AppHandle, host: String, kind: account::InvolvedKind, refresh: bool,
) -> Result<Vec<account::PullRequest>, String> {
    let key = format!("involved-{host}-{kind:?}");
    cache::get_or_fetch(&app, &key, ttl::LISTS, refresh, || account::involved_prs(&host, kind)).await
}

/// 某个提交上的检查项（CI 的各个 job）。
#[tauri::command]
pub async fn check_runs(
    host: String, owner: String, name: String, sha: String,
) -> Result<Vec<account::CheckRun>, String> {
    account::check_runs(&host, &owner, &name, &sha).await
}

/// 重跑失败的任务。
#[tauri::command]
pub async fn rerun_failed_jobs(
    host: String, owner: String, name: String, target: account::CheckRetry,
) -> Result<(), String> {
    account::rerun_failed_jobs(&host, &owner, &name, target).await
}

/// 写提交信息时 `#` 补全用的 issue 号。缓存一刻钟——号码不会一直变。
#[tauri::command]
pub async fn issues_for_completion(
    app: tauri::AppHandle, host: String, owner: String, name: String,
) -> Result<Vec<account::Issue>, String> {
    let key = format!("issues-{host}-{owner}-{name}");
    cache::get_or_fetch(&app, &key, ttl::LISTS, false, || account::issues(&host, &owner, &name)).await
}

/// Fork 到自己名下，返回克隆地址。
#[tauri::command]
pub async fn fork_repo(host: String, owner: String, name: String) -> Result<String, String> {
    account::fork_repo(&host, &owner, &name).await
}

/// 这个仓库 fork 自哪里（`owner/name`）。不是 fork 就是 None。
#[tauri::command]
pub async fn upstream_of(host: String, owner: String, name: String) -> Option<String> {
    account::upstream_of(&host, &owner, &name).await
}

/// 同步上游：拉源仓库的分支并快进。
#[tauri::command]
pub async fn sync_upstream(repo: String, upstream_url: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::sync_upstream(Path::new(&repo), &upstream_url, &branch))
        .await
        .map_err(|error| error.to_string())?
}

/// 新建 PR / MR，返回网页地址。
#[tauri::command]
pub async fn create_pull_request(
    host: String, owner: String, name: String, title: String, body: String, head: String, base: String,
) -> Result<String, String> {
    account::create_pull_request(&host, &owner, &name, &title, &body, &head, &base).await
}

/// 在远端建一个空仓库，返回克隆地址。「发布」本地仓库用。
#[tauri::command]
pub async fn create_remote_repo(host: String, name: String, private: bool) -> Result<String, String> {
    account::create_remote_repo(&host, &name, private).await
}

/// 逐行追溯：每一行最后是谁、在哪次提交改的。
#[tauri::command]
pub async fn blame(repo: String, file: String) -> Result<Vec<blame::BlameLine>, String> {
    tauri::async_runtime::spawn_blocking(move || blame::blame(Path::new(&repo), &file))
        .await
        .map_err(|error| error.to_string())?
}

/// 搜索提交：GitLens 查询语法（`message:` `author:` `file:` `change:` `#sha` …）。
#[tauri::command]
pub async fn search_commits(
    repo: String, query: crate::search_query::SearchQuery, limit: usize, skip: usize,
) -> Result<Vec<history::CommitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || history::search(Path::new(&repo), &query, limit, skip))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    commits: Vec<history::CommitInfo>,
    has_more: bool,
    cursor: Option<String>,
}

/// 单个文件的提交历史（跟过改名），从第 skip 条起最多 limit 条，最新的在前；形状同 History 列表。
/// `cursor` 是上一页返回的续走游标，对不上时后端从头走，结果相同。
#[tauri::command]
pub async fn file_history(
    repo: String, file: String, skip: usize, limit: usize, cursor: Option<String>,
) -> Result<FileHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_history::file_history(Path::new(&repo), &file, skip, limit, cursor.as_deref()).map(|page| {
            log::debug!("file history from {skip}: {}", if page.resumed { "resumed" } else { "walked from HEAD" });
            FileHistoryPage {
                commits: page.commits.iter().map(history::CommitDetails::to_info).collect(),
                has_more: page.has_more,
                cursor: page.cursor,
            }
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

// ── 交给系统上的其他工具 ────────────────────────────────────────────

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::reveal(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_in_terminal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = store::load(&app).external_terminal;
        if !selected.is_empty() {
            return system::open_integration(&selected, Path::new(&path));
        }
        system::open_terminal(Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_in_editor(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = store::load(&app).external_editor;
        if !selected.is_empty() {
            return system::open_integration(&selected, Path::new(&path));
        }
        system::open_editor(Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

// ── 新建与发布 ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn init_repo(path: String, default_branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::init_repo(Path::new(&path), &default_branch))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn add_remote(repo: String, name: String, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::add_remote(Path::new(&repo), &name, &url))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remotes(repo: String) -> Result<Vec<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || system::remotes(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remote_push_url(repo: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::remote_ops::push_url(Path::new(&repo), &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_remote_url(repo: String, name: String, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::set_remote_url(Path::new(&repo), &name, &url))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_remote(repo: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::remove_remote(Path::new(&repo), &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_gitignore(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || system::read_gitignore(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_gitignore(repo: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::write_gitignore(Path::new(&repo), &content))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn append_ignore_rules(repo: String, patterns: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::gitignore::append_rules(Path::new(&repo), &patterns))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn append_ignore_files(repo: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::gitignore::append_files(Path::new(&repo), &paths))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn repository_type(path: String) -> Result<crate::repository::RepositoryType, String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository::repository_type(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn repository_root(path: String) -> Result<std::path::PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository::working_directory(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn add_safe_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_config::add_safe_directory(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn global_git_config_path() -> Result<std::path::PathBuf, String> {
    tauri::async_runtime::spawn_blocking(crate::git_config::global_path).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn index_entries(repo: String) -> Result<Vec<crate::index_parser::IndexFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = crate::git::Git::new(Some(Path::new(&repo))).args(["ls-files", "--stage", "-z"]).stdout()?;
        Ok(crate::index_parser::staged(Some(&data)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn branch_details(repo: String, pattern: Option<String>) -> Result<Vec<branch::BranchInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || branch::list(Path::new(&repo), pattern.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn repository_tip(repo: String) -> Result<branch::Tip, String> {
    tauri::async_runtime::spawn_blocking(move || branch::tip(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn branches_pointed_at(repo: String, revision: String) -> Result<Option<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || branch::pointed_at(Path::new(&repo), &revision))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn merge_base(repo: String, first: String, second: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::merge_base(Path::new(&repo), &first, &second))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn branches_differing_from_upstream(repo: String) -> Result<Vec<branch::TrackingBranch>, String> {
    tauri::async_runtime::spawn_blocking(move || branch::differing_from_upstream(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn resolution_diff(
    repo: String, file: String, target: raw_diff::ResolutionTarget, hide_whitespace: bool,
) -> Result<raw_diff::ResolutionDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        raw_diff::resolution_diff(Path::new(&repo), &file, target, hide_whitespace)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn tags_to_push(
    app: tauri::AppHandle, repo: String, remote: String, branch: String,
) -> Result<Vec<String>, String> {
    let token = token_of(&app, Path::new(&repo), &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        ops::tags_to_push(Path::new(&repo), &remote, &branch, token.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn tag_targets(repo: String) -> Result<std::collections::BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::all_tags(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn push_with_tags(
    app: tauri::AppHandle, repo: String, remote: String, branch: String, tags: Vec<String>,
    options: Option<net::PushOptions>,
) -> Result<(), String> {
    let path = Path::new(&repo);
    let token = settings::token_for_push(&app, path, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth_hint(
            net::push_with_tags(
                Path::new(&repo),
                &remote,
                &branch,
                &tags,
                options.unwrap_or_default(),
                token.as_deref(),
                None,
            ),
            token.is_some(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn worktrees_from_git_dir(git_dir: String) -> Result<Vec<ops::Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::worktrees_from_git_dir(Path::new(&git_dir)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn main_worktree_path(
    repo: String, main_path: Option<String>, git_dir: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ops::main_worktree_path(
            Path::new(&repo),
            main_path.as_deref().map(Path::new),
            git_dir.as_deref().map(Path::new),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn repository_description(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository::description(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn recent_branches(repo: String, limit: usize) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::recent_branches(Path::new(&repo), limit))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn branch_checkouts(
    repo: String, after: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::branch_checkouts(Path::new(&repo), &after))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn list_submodules(repo: String) -> Result<Vec<ops::SubmoduleEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::list_submodules(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn reset_submodules(repo: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::reset_submodules(Path::new(&repo), &paths))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn format_patch(repo: String, base: String, head: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::format_patch(Path::new(&repo), &base, &head))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn using_lfs(repo: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || ops::using_lfs(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn tracked_by_lfs(repo: String, file: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || ops::tracked_by_lfs(Path::new(&repo), &file))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn files_not_tracked_by_lfs(repo: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::files_not_tracked_by_lfs(Path::new(&repo), &paths))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn fast_forward_branches(repo: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&repo);
        branch::fast_forward_branches(path, &branch::differing_from_upstream(path)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn last_branch_stash(repo: String, branch: String) -> Result<Option<ops::StashEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::last_branch_stash(Path::new(&repo), &branch))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn drop_stash_sha(repo: String, sha: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::drop_stash_sha(Path::new(&repo), &sha))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn pop_stash_sha(repo: String, sha: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::pop_stash_sha(Path::new(&repo), &sha))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn merge_base_files(
    repo: String, from: String, to: String, latest: String,
) -> Result<Option<history::Changeset>, String> {
    tauri::async_runtime::spawn_blocking(move || history::merge_base_changes(Path::new(&repo), &from, &to, &latest))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn merge_base_diff(
    repo: String, from: String, to: String, file: String, old_path: Option<String>, hide_whitespace: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        raw_diff::merge_base_diff(Path::new(&repo), &from, &to, &file, old_path.as_deref(), hide_whitespace)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn partial_blob_contents(
    repo: String, revision: String, file: String, length: usize,
) -> Result<Option<Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        raw_diff::partial_blob_contents(Path::new(&repo), &revision, &file, length)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn commits_in_range(repo: String, range: String) -> Result<Option<Vec<history::CommitOneLine>>, String> {
    tauri::async_runtime::spawn_blocking(move || history::commits_in_range(Path::new(&repo), &range))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn has_merges_after(repo: String, revision: Option<String>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || history::has_merges_after(Path::new(&repo), revision.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn working_image(repo: String, file: String) -> Result<Option<image::ImageSide>, String> {
    tauri::async_runtime::spawn_blocking(move || image::working_image(Path::new(&repo), &file))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn blob_image(repo: String, file: String, revision: String) -> Result<Option<image::ImageSide>, String> {
    tauri::async_runtime::spawn_blocking(move || image::blob_image(Path::new(&repo), &file, &revision))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rebase_snapshot(repo: String) -> Result<Option<ops::RebaseSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::rebase_snapshot(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn rebase_with_progress(
    repo: String, base: String, target: Option<String>,
) -> Result<ops::RebaseOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || ops::rebase_branch(Path::new(&repo), &base, target.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn continue_rebase_with_resolutions(
    repo: String, paths: Vec<String>, resolutions: Vec<(String, ops::Resolution)>,
) -> Result<ops::RebaseOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ops::continue_rebase_with_resolutions(Path::new(&repo), &paths, &resolutions, None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn cherry_pick_snapshot(repo: String) -> Result<Option<ops::CherryPickSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::cherry_pick_snapshot(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn cherry_pick_with_progress(
    repo: String, commits: Vec<history::CommitOneLine>,
) -> Result<ops::CherryPickOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || ops::cherry_pick_commits(Path::new(&repo), &commits))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn continue_cherry_pick(
    repo: String, paths: Vec<String>, resolutions: Vec<(String, ops::Resolution)>,
) -> Result<ops::CherryPickOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || ops::continue_cherry_pick(Path::new(&repo), &paths, &resolutions))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clone_repo_output(
    app: tauri::AppHandle, url: String, path: String, options: branch::CloneOptions,
    progress: tauri::ipc::Channel<crate::progress::Progress>,
) -> Result<serde_json::Value, String> {
    let token = settings::token_for_url(&app, &url).await?;

    let output = tauri::async_runtime::spawn_blocking(move || {
        branch::clone_output_stream(&url, Path::new(&path), token.as_deref(), &options, |event| {
            let _ = progress.send(event);
        })
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(
        serde_json::json!({ "exitCode": output.status.code(), "stdout": String::from_utf8_lossy(&output.stdout), "stderr": String::from_utf8_lossy(&output.stderr), "progress": Vec::<crate::progress::Progress>::new() }),
    )
}
#[tauri::command]
pub async fn write_git_attributes(repo: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository::write_git_attributes(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn parse_lfs_progress(
    state: Option<crate::progress::LfsParser>, line: String,
) -> (crate::progress::LfsParser, crate::progress::Progress) {
    let mut parser = state.unwrap_or_default();
    let progress = parser.parse(&line);
    (parser, progress)
}

#[tauri::command]
pub async fn format_commit_message(
    repo: String, summary: String, description: Option<String>, trailers: Vec<net::Trailer>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        net::format_commit_message(Path::new(&repo), &summary, description.as_deref(), &trailers)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn write_default_readme(repo: String, name: String, description: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::repository::write_default_readme(Path::new(&repo), &name, description.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_hash(path: String, algorithm: String) -> Result<String, crate::file_system::FileError> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::file_hash(Path::new(&path), &algorithm))
        .await
        .map_err(|error| crate::file_system::FileError::from(std::io::Error::other(error.to_string())))?
}
#[tauri::command]
pub async fn resolve_within(root: String, segments: Vec<String>) -> Result<Option<std::path::PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::resolve_within(Path::new(&root), &segments))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn encode_path_url(segments: Vec<String>) -> Result<String, String> {
    crate::file_system::encode_path_url(&segments)
}
#[tauri::command]
pub fn is_application_bundle_metadata(metadata: String) -> Result<bool, String> {
    crate::file_system::is_application_bundle_metadata(&metadata)
}

#[tauri::command]
pub async fn fetch_output(
    app: tauri::AppHandle, repo: String, remote: String, options: net::RemoteOptions,
) -> Result<net::RemoteOutput, String> {
    let p = Path::new(&repo);
    let token = token_of(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        net::fetch_output(Path::new(&repo), &remote, options, token.as_deref(), None)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn pull_output(
    app: tauri::AppHandle, repo: String, remote: String, options: net::RemoteOptions,
) -> Result<net::RemoteOutput, String> {
    let p = Path::new(&repo);
    let token = token_of(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        net::pull_output(Path::new(&repo), &remote, options, token.as_deref(), None)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn fetch_refspec(app: tauri::AppHandle, repo: String, remote: String, refspec: String) -> Result<(), String> {
    let p = Path::new(&repo);
    let token = token_of(&app, p, &remote).await?;
    tauri::async_runtime::spawn_blocking(move || {
        net::fetch_refspec(Path::new(&repo), &remote, &refspec, token.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn add_worktree_at(
    repo: String, path: String, create_branch: Option<String>, commitish: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ops::add_worktree_at(Path::new(&repo), Path::new(&path), create_branch.as_deref(), commitish.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn temporary_file_path(name: String) -> Result<std::path::PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::temporary_file_path(&name))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn read_partial_file(path: String, start: u64, end: u64) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::read_partial_file(Path::new(&path), start, end))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn parse_ssh_host_prompt(prompt: String) -> Option<crate::ssh::HostPrompt> {
    crate::ssh::parse_host_prompt(&prompt)
}
#[tauri::command]
pub async fn config_lock_file_path(repo: String, stderr: String) -> Result<Option<std::path::PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git::config_lock_path(Path::new(&repo), &stderr))
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn git_execute(
    repo: String, args: Vec<String>, env: std::collections::HashMap<String, String>, stdin: Option<String>,
    success_exit_codes: Vec<i32>, expected_errors: Vec<String>, output: tauri::ipc::Channel<crate::git::TerminalChunk>,
) -> Result<crate::git::ExecutionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = crate::git::Git::new(Some(Path::new(&repo))).args(args);
        for (key, value) in env {
            command = command.env(key, value);
        }
        if let Some(input) = stdin {
            command = command.stdin(input);
        }
        let out = command.output_stream(|chunk| {
            let _ = output.send(chunk);
        })?;
        crate::git::checked_result(Path::new(&repo), out, &success_exit_codes, &expected_errors)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn terminal_tail(capacity: usize, chunks: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
    if capacity == 0 {
        return Err("The capacity argument must be greater than 0".into());
    }
    let mut tail = crate::terminal::Tail::default();
    for chunk in chunks {
        tail.push(capacity, &chunk);
    }
    Ok(tail.bytes())
}

#[tauri::command]
pub async fn get_config_value(repo: String, key: String, only_local: Option<bool>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_config::get(Some(Path::new(&repo)), &key, only_local.unwrap_or(false), false)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit_details(
    repo: String, revision: Option<String>, limit: Option<usize>, skip: Option<usize>, additional: Vec<String>,
) -> Result<Vec<history::CommitDetails>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history::query_details(Path::new(&repo), revision.as_deref(), limit, skip, &additional)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn file_size(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::file_size(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn read_conflict_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::read_conflict_text(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn working_directory() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::env::current_dir().map(|path| path.to_string_lossy().into_owned()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn token_store_get(service: String, login: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::token_store::get(&service, &login))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn token_store_set(service: String, login: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::token_store::set(&service, &login, &value))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn token_store_delete(service: String, login: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::token_store::delete(&service, &login))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn get_boolean_config_value(repo: String, key: String) -> Result<Option<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_config::get(Some(Path::new(&repo)), &key, false, true).map(|v| v.map(|s| s == "true"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ahead_behind_range(repo: String, range: String) -> Result<Option<(u32, u32)>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::ahead_behind_range(Path::new(&repo), &range))
        .await
        .map_err(|error| error.to_string())?
}

/// Notify only when a modal opens in an inactive window, matching Desktop.
#[tauri::command]
pub async fn desktop_dialog_did_open(window: tauri::Window) -> Result<(), String> {
    if window.is_focused().map_err(|e| e.to_string())? {
        return Ok(());
    }
    window.request_user_attention(Some(tauri::UserAttentionType::Critical)).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    tauri::async_runtime::spawn_blocking(|| {
        let status = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", "beep"])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() { Ok(()) } else { Err("Unable to play system alert".to_string()) }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn file_metadata(path: String) -> Result<crate::file_system::FileMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::metadata(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn remove_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::remove_file(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::path_exists(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::trash_path(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn global_config_value(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_config::get(None, &key, false, false))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn set_global_config_value(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_config::set(None, &key, &value))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn rebase_internal_state(repo: String) -> Result<Option<ops::RebaseState>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::rebase_state(Path::new(&repo)))
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn git_metadata_exists(repo: String, name: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !["SQUASH_MSG", "MERGE_HEAD", "CHERRY_PICK_HEAD"].contains(&name.as_str()) {
            return Err("Unknown Git metadata".into());
        }
        let path = crate::git::Git::new(Some(Path::new(&repo))).args(["rev-parse", "--git-path", &name]).stdout()?;
        let path = Path::new(path.trim());
        crate::file_system::path_exists(&if path.is_absolute() {
            path.to_path_buf()
        } else {
            Path::new(&repo).join(path)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn get_remote_head(repo: String, remote: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::remote_ops::head(Path::new(&repo), &remote))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn update_remote_head(repo: String, name: String, background: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = background;
        crate::remote_ops::update_head(Path::new(&repo), &name, None, None)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn desktop_beep() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("/usr/bin/osascript")
                .args(["-e", "beep"])
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("System alert failed".into());
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::io::Write;
            std::io::stderr().write_all(b"\x07").map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            use std::io::Write;
            std::io::stderr().write_all(b"\x07").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn is_application_bundle(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::is_application_bundle(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn execute_process(
    executable: String, args: Vec<String>, timeout_ms: u64, max_buffer: usize,
) -> Result<crate::process::ProcessOutput, crate::process::ProcessError> {
    tauri::async_runtime::spawn_blocking(move || crate::process::execute(&executable, &args, timeout_ms, max_buffer))
        .await
        .map_err(|error| crate::process::ProcessError::from(std::io::Error::other(error.to_string())))?
}

#[tauri::command]
pub async fn application_path(bundle_identifier: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::system::application_path(&bundle_identifier))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn unlink_file(path: String) -> Result<(), crate::file_system::FileError> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::unlink_file(Path::new(&path)))
        .await
        .map_err(|error| crate::file_system::FileError::from(std::io::Error::other(error.to_string())))?
}

#[tauri::command]
pub fn initialize_notifications(app: tauri::AppHandle) -> Result<(), String> {
    crate::notifications::initialize(app)
}
#[tauri::command]
pub fn terminate_notifications() {
    crate::notifications::terminate();
}
#[tauri::command]
pub async fn notifications_permission() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(crate::notifications::permission).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn request_notifications_permission() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(crate::notifications::request_permission).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn submit_notification(
    id: String, title: String, body: String, user_info: serde_json::Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::notifications::show(&id, &title, &body, user_info))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn close_notification(id: String) -> Result<(), String> {
    crate::notifications::close(&id)
}

#[tauri::command]
pub fn app_architecture() -> String {
    crate::stats_context::architecture()
}
#[tauri::command]
pub async fn is_in_application_folder() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(crate::stats_context::in_applications).await.map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn get_stats_guid(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::stats_context::get_guid(&app.path().app_config_dir().map_err(|e| e.to_string())?)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn save_stats_guid(app: tauri::AppHandle, guid: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::stats_context::save_guid(&app.path().app_config_dir().map_err(|e| e.to_string())?, &guid)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<String>, crate::file_system::FileError> {
    tauri::async_runtime::spawn_blocking(move || crate::file_system::read_directory(Path::new(&path)))
        .await
        .map_err(|error| crate::file_system::FileError::from(std::io::Error::other(error.to_string())))?
}

#[tauri::command]
pub async fn open_cygwin(executable: String, path: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || crate::cygwin::launch(Path::new(&executable), Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn shell_context() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(crate::shell_env::context).await.map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn shell_find_executable(name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::shell_env::find_executable(&name))
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn printenvz_path() -> Result<std::path::PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || crate::shell_env::printenvz_path().map_err(|e| e.to_string()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn shell_capture_environment(
    options: crate::shell_env::CaptureOptions,
) -> Result<crate::process::ProcessOutput, crate::process::ProcessError> {
    tauri::async_runtime::spawn_blocking(move || crate::shell_env::capture(options))
        .await
        .map_err(|e| crate::process::ProcessError::from(std::io::Error::other(e.to_string())))?
}

#[tauri::command]
pub async fn tail_watch(
    app: tauri::AppHandle, path: String, events: tauri::ipc::Channel<serde_json::Value>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let watches = app.state::<crate::file_tail::Watches>();
        watches.watch(Path::new(&path), move |event| {
            let _ = events.send(event);
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn tail_unwatch(app: tauri::AppHandle, id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let watches = app.state::<crate::file_tail::Watches>();
        watches.unwatch(id)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn tail_read(path: String, position: u64, length: usize) -> Result<Vec<u8>, crate::file_system::FileError> {
    tauri::async_runtime::spawn_blocking(move || crate::file_tail::read(Path::new(&path), position, length))
        .await
        .map_err(|e| crate::file_system::FileError::from(std::io::Error::other(e.to_string())))?
}

#[tauri::command]
pub fn toggle_devtools(window: tauri::Webview) {
    #[cfg(debug_assertions)]
    {
        if window.is_devtools_open() { window.close_devtools() } else { window.open_devtools() }
    }
    #[cfg(not(debug_assertions))]
    let _ = window;
}
#[tauri::command]
pub async fn ensure_log_directory(app: tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let path = app.path().app_log_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn start_trampoline(
    app: tauri::AppHandle, requests: tauri::ipc::Channel<serde_json::Value>,
) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let service = app.state::<crate::trampoline::Service>();
        service.start(move |value| {
            let _ = requests.send(value);
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn respond_trampoline(app: tauri::AppHandle, id: u64, result: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let service = app.state::<crate::trampoline::Service>();
        service.respond(id, &result)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn trampoline_helpers() -> Result<crate::trampoline::Helpers, String> {
    tauri::async_runtime::spawn_blocking(move || crate::trampoline::helpers().map_err(|e| e.to_string()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn git_environment() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(crate::trampoline::environment).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_account_session(host: String) -> Result<Option<(String, String)>, String> {
    account::desktop_session(&host).await
}

#[tauri::command]
pub async fn native_account_token(host: String, token: String) -> Result<Option<String>, String> {
    oauth::resolve_token(&host, &token).await
}

#[tauri::command]
pub async fn native_renew_token(host: String, refresh_token: String) -> Result<Option<serde_json::Value>, String> {
    oauth::renew_for_desktop(&host, &refresh_token).await
}

#[tauri::command]
pub async fn rerun_check(
    host: String, owner: String, name: String, target: account::CheckRetry, mode: String, job_id: Option<u64>,
) -> Result<(), String> {
    account::rerun_check(&host, &owner, &name, target, &mode, job_id).await
}

#[tauri::command]
pub async fn pull_request_targets(
    app: tauri::AppHandle, repo: String, remote_name: String,
) -> Result<serde_json::Value, String> {
    let url = tauri::async_runtime::spawn_blocking(move || crate::remote_ops::push_url(Path::new(&repo), &remote_name))
        .await
        .map_err(|error| error.to_string())??;
    let remote = account_remote(app, &url).await.ok_or("远端不是托管平台仓库")?;
    account::pull_request_targets(&remote).await
}

#[tauri::command]
pub async fn branch_policy(
    app: tauri::AppHandle, repo: String, branch: String,
) -> Result<Option<serde_json::Value>, String> {
    let target =
        tauri::async_runtime::spawn_blocking(move || crate::remote_ops::branch_target(Path::new(&repo), &branch))
            .await
            .map_err(|error| error.to_string())??;
    let Some((url, target_branch)) = target else {
        return Ok(None);
    };
    let Some(remote) = account_remote(app, &url).await else { return Ok(None) };
    account::branch_policy(&remote, &target_branch).await.map(Some)
}

/// 解析远端并把主机规整到用户添加过的实例（SSH 远端不带 Web 端口）。
async fn account_remote(app: tauri::AppHandle, url: &str) -> Option<remote::Remote> {
    let remote = remote::parse(url)?;
    Some(remote::account_remote(&remote, &store::known_instances(&app).await))
}

#[tauri::command]
pub async fn pull_request_source(
    host: String, owner: String, name: String, number: u64,
) -> Result<serde_json::Value, String> {
    account::pull_request_source(&host, &owner, &name, number).await
}

#[tauri::command]
pub async fn available_integrations() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(system::available_integrations).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pull_request_repository(host: String, owner: String, name: String) -> Result<remote::Remote, String> {
    account::pull_request_repository(&host, &owner, &name).await
}

#[tauri::command]
pub fn parse_remote(url: String) -> Option<remote::Remote> {
    remote::parse(&url)
}

#[tauri::command]
pub async fn detect_desktop_import(app: tauri::AppHandle) -> Result<crate::desktop_import::Detection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::desktop_import::detect(store::load(&app).desktop_import_handled)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn finish_desktop_import(app: tauri::AppHandle, import: bool) -> Result<store::AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = if import {
            Some(crate::credentials::import_profile(
                &crate::desktop_import::profile_path()?,
                &store::load(&app).account_hosts,
            )?)
        } else {
            None
        };
        let mut state = store::load(&app);
        if let Some(data) = data {
            for host in &data.account_hosts {
                cache::invalidate(&app, &format!("account-{host}"));
            }
            store::merge_desktop_import(&mut state, data);
        }
        state.desktop_import_handled = true;
        store::save(&app, state.clone())?;
        Ok(state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_rerun_eligibility(
    host: String, owner: String, name: String, checks: Vec<account::CheckRun>,
) -> Result<Vec<u64>, String> {
    account::check_rerun_eligibility(&host, &owner, &name, checks).await
}
