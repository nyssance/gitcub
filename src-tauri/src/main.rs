// 发布版不弹控制台窗口（仅 Windows 有效）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod account;
mod blame;
#[cfg(unix)]
mod blame_engine;
mod blame_model;
mod branch;
mod cache;
#[cfg(unix)]
mod changed_paths;
mod commands;
mod credential_protocol;
mod credentials;
mod cygwin;
mod desktop_import;
mod desktop_log;
#[cfg(test)]
mod desktop_tests;
mod file_history;
mod file_system;
mod file_tail;
mod git;
mod git_config;
mod gitignore;
mod graph;
mod history;
mod host_api;
mod host_url;
mod image;
mod index_parser;
mod interactive;
mod lfs;
#[cfg(test)]
mod macos_tests;
mod menu;
mod named_store;
mod net;
mod notifications;
mod oauth;
mod ops;
#[cfg(unix)]
mod pack_reader;
// Desktop 形状的 porcelain v2 解析只作一致性基准（应用状态含子模块走 gix）；GitLens 形状由 system::submodule_info 复用。
#[allow(dead_code)]
mod porcelain;
mod process;
mod progress;
mod raw_diff;
mod remote;
mod remote_ops;
mod rename;
mod repository;
mod search_query;
mod settings;
mod shell_env;
mod ssh;
mod stage;
mod stats_context;
mod status;
mod store;
mod system;
mod terminal;
#[cfg(test)]
mod test_repo;
mod token_store;
mod trampoline;
mod trending_webview;
mod updater;
mod watch;
mod window_effects;
mod windows_integrations;
mod xdiff;

fn main() {
    // git 需要凭据时会以 GIT_ASKPASS 的身份重新拉起本程序，提示串作为 argv[1]，
    // 答案写 stdout。必须在初始化 Tauri 之前短路掉，否则会弹出一个空窗口。
    if let Some(answer) = net::askpass_if_invoked() {
        println!("{answer}");
        return;
    }

    let builder = tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        // 没有它的话，各模块里的 log::warn! 全是空调用——出了问题只能靠猜
        // 当前正在监听哪个仓库。切仓库时旧的直接丢掉
        .manage(watch::Watching::default())
        .manage(file_tail::Watches::default())
        .manage(trampoline::Service::default())
        .manage(updater::UpdateState::default())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().0.as_str()))
        .setup(|app| {
            let dispatch = desktop_log::dispatch(app.path().app_log_dir()?)?;
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .clear_targets()
                    .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Dispatch(dispatch)))
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            if let Err(error) = notifications::initialize(app.handle().clone()) {
                eprintln!("Notifications unavailable: {error}");
            }
            atlas_tauri::install(app.handle())?;
            named_store::init(app.handle())?;
            // 把资源目录告诉 git 模块，好让它优先用打包进来的 git
            if let Ok(dir) = app.path().resource_dir() {
                git::set_resource_dir(&dir);
            }
            if let Some(w) = app.get_webview_window("main") {
                window_effects::apply(&w);
            }
            Ok(())
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build());

    #[cfg(feature = "hasgard-testing")]
    let builder = builder.plugin(tauri_plugin_hasgard::init());

    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(feature = "hasgard-testing")]
    if let Ok(directory) = std::env::var("GITCUB_TEST_DATA_DIR") {
        context.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(directory.into()));
        context.config_mut().identifier = "day.dreamer.gitcub.conformance".into();
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
            // 先隐藏：hasgard 按 TAURI_HASGARD_DISPLAY 把窗口挪到测试显示器后再显示，主屏上不闪一下。
            window.visible = false;
        }
    }
    builder
        .invoke_handler(tauri::generate_handler![
            updater::updater_check,
            updater::updater_endpoint,
            updater::request_quit,
            updater::cancel_quit,
            updater::install_update,
            commands::app_architecture,
            commands::is_in_application_folder,
            commands::get_stats_guid,
            commands::save_stats_guid,
            commands::initialize_notifications,
            commands::terminate_notifications,
            commands::notifications_permission,
            commands::request_notifications_permission,
            commands::submit_notification,
            commands::close_notification,
            commands::desktop_dialog_did_open,
            commands::repo_remote,
            commands::account_info,
            commands::repo_meta,
            commands::set_token,
            commands::set_account_ignored,
            commands::oauth_default_clients,
            commands::desktop_account_session,
            commands::oauth_device_start,
            commands::oauth_device_poll,
            commands::oauth_device_cancel,
            commands::native_account_token,
            commands::native_renew_token,
            trending_webview::sync_trending_webview,
            trending_webview::control_trending_webview,
            atlas_tauri::availability::has_trackpad,
            commands::my_repos,
            commands::my_stars,
            commands::git_identity,
            commands::set_git_identity,
            commands::load_state,
            named_store::store_entries,
            named_store::store_set,
            named_store::store_delete,
            named_store::store_clear,
            named_store::store_reload,
            commands::read_desktop_import,
            commands::detect_desktop_import,
            commands::finish_desktop_import,
            commands::repository_type,
            commands::index_entries,
            commands::repository_root,
            commands::add_safe_directory,
            commands::global_git_config_path,
            commands::save_state,
            commands::repo_status,
            commands::repo_summary,
            commands::watch_repo,
            commands::branches,
            commands::branch_details,
            commands::branches_differing_from_upstream,
            commands::repository_tip,
            commands::branches_pointed_at,
            commands::merge_base,
            commands::checkout,
            commands::create_branch,
            commands::delete_branch,
            commands::delete_remote_branch,
            commands::discard_changes,
            commands::clone_repo,
            commands::clone_repo_output,
            commands::parse_lfs_progress,
            commands::write_git_attributes,
            commands::parse_ssh_host_prompt,
            commands::config_lock_file_path,
            commands::git_execute,
            commands::terminal_tail,
            commands::commit_details,
            commands::file_size,
            commands::file_metadata,
            commands::execute_process,
            commands::start_trampoline,
            commands::respond_trampoline,
            commands::trampoline_helpers,
            commands::git_environment,
            commands::toggle_devtools,
            commands::ensure_log_directory,
            commands::tail_watch,
            commands::tail_unwatch,
            commands::tail_read,
            commands::shell_context,
            commands::shell_find_executable,
            commands::shell_capture_environment,
            commands::printenvz_path,
            commands::open_cygwin,
            commands::application_path,
            commands::is_application_bundle,
            commands::remove_file,
            commands::unlink_file,
            commands::read_directory,
            commands::path_exists,
            commands::trash_path,
            commands::global_config_value,
            commands::set_global_config_value,
            commands::rebase_internal_state,
            commands::git_metadata_exists,
            commands::get_remote_head,
            commands::update_remote_head,
            commands::desktop_beep,
            commands::read_conflict_text,
            commands::working_directory,
            commands::token_store_get,
            commands::token_store_set,
            commands::token_store_delete,
            commands::get_boolean_config_value,
            commands::get_config_value,
            commands::file_hash,
            commands::temporary_file_path,
            commands::read_partial_file,
            commands::resolve_within,
            commands::encode_path_url,
            commands::is_application_bundle_metadata,
            commands::write_default_readme,
            commands::format_commit_message,
            commands::log,
            commands::graph,
            commands::pull_requests,
            commands::involved_prs,
            commands::check_runs,
            commands::check_rerun_eligibility,
            commands::rerun_failed_jobs,
            commands::rerun_check,
            commands::issues_for_completion,
            commands::mentionables,
            commands::fork_repo,
            commands::upstream_of,
            commands::sync_upstream,
            commands::create_pull_request,
            commands::pull_request_targets,
            commands::pull_request_source,
            commands::pull_request_repository,
            commands::parse_remote,
            commands::branch_policy,
            commands::create_remote_repo,
            commands::blame,
            commands::file_history,
            commands::search_commits,
            commands::commit_files,
            commands::commit_file_diff_raw,
            commands::working_directory_diff,
            commands::resolution_diff,
            commands::apply_patch_to_index,
            commands::discard_lines,
            commands::file_at_commit,
            commands::oversized_files,
            commands::pr_template,
            commands::lfs_state,
            commands::lfs_install,
            commands::image_diff,
            commands::submodule_info,
            commands::file_contents,
            commands::apply_selection,
            commands::push,
            commands::fetch,
            commands::fetch_output,
            commands::pull_output,
            commands::fetch_refspec,
            commands::add_worktree_at,
            commands::pull,
            commands::commit,
            commands::merge_preview,
            commands::merge_branch,
            commands::rebase_branch,
            commands::continue_operation,
            commands::abort_operation,
            commands::rename_branch,
            commands::ahead_behind_range,
            commands::compare_branches,
            commands::compare_commits,
            commands::stashes,
            commands::stash_push,
            commands::stash_pop,
            commands::stash_drop,
            commands::undo_commit,
            commands::amend_commit,
            commands::reset_to,
            commands::revert_commit,
            commands::squash_commits,
            commands::reorder_commits,
            commands::cherry_pick,
            commands::cherry_pick_snapshot,
            commands::cherry_pick_with_progress,
            commands::continue_cherry_pick,
            commands::tags,
            commands::tag_targets,
            commands::tags_to_push,
            commands::push_with_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::repository_description,
            commands::recent_branches,
            commands::branch_checkouts,
            commands::list_submodules,
            commands::reset_submodules,
            commands::format_patch,
            commands::using_lfs,
            commands::tracked_by_lfs,
            commands::files_not_tracked_by_lfs,
            commands::fast_forward_branches,
            commands::last_branch_stash,
            commands::drop_stash_sha,
            commands::pop_stash_sha,
            commands::merge_base_files,
            commands::merge_base_diff,
            commands::partial_blob_contents,
            commands::commits_in_range,
            commands::has_merges_after,
            commands::working_image,
            commands::blob_image,
            commands::rebase_snapshot,
            commands::rebase_with_progress,
            commands::continue_rebase_with_resolutions,
            commands::worktrees,
            commands::worktrees_from_git_dir,
            commands::main_worktree_path,
            commands::add_worktree,
            commands::remove_worktree,
            commands::move_worktree,
            commands::resolve_conflict,
            commands::reveal_in_file_manager,
            commands::open_in_terminal,
            commands::open_in_editor,
            commands::available_integrations,
            commands::init_repo,
            commands::add_remote,
            commands::remotes,
            commands::remote_push_url,
            commands::set_remote_url,
            commands::remove_remote,
            commands::read_gitignore,
            commands::write_gitignore,
            commands::append_ignore_rules,
            commands::append_ignore_files,
        ])
        .build(context)
        .expect("GitCub 启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && updater::should_delay_exit(app)
            {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
#[path = "../tests/support/perf.rs"]
mod perf;
