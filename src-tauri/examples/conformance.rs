//! 仅测试构建的 JSON 桥：原版 TypeScript 测试调用 Rust 生产模块。
// 导入完整生产模块，桥只暴露测试所需入口；未调用入口的 dead_code 与应用构建无关。
#![allow(dead_code)]
#[path = "../src/blame_model.rs"]
mod blame_model;
#[path = "../src/branch.rs"]
mod branch;
#[path = "../src/credential_protocol.rs"]
mod credential_protocol;
#[path = "../src/cygwin.rs"]
mod cygwin;
#[path = "../src/desktop_import.rs"]
mod desktop_import;
#[path = "../src/desktop_log.rs"]
mod desktop_log;
#[path = "../src/file_history.rs"]
mod file_history;
#[path = "../src/file_system.rs"]
mod file_system;
#[path = "../src/git.rs"]
mod git;
#[path = "../src/git_config.rs"]
mod git_config;
#[path = "../src/gitignore.rs"]
mod gitignore;
#[path = "../src/graph.rs"]
mod graph;
#[path = "../src/history.rs"]
mod history;
#[path = "../src/hooks.rs"]
mod hooks;
#[path = "../src/host_url.rs"]
mod host_url;
#[path = "../src/image.rs"]
mod image;
#[path = "../src/index_parser.rs"]
mod index_parser;
#[path = "../src/interactive.rs"]
mod interactive;
#[path = "../src/lfs.rs"]
mod lfs;
#[path = "../src/net.rs"]
mod net;
#[path = "../src/notifications.rs"]
mod notifications;
#[path = "../src/ops.rs"]
mod ops;
#[path = "../src/porcelain.rs"]
mod porcelain;
#[path = "../src/process.rs"]
mod process;
#[path = "../src/progress.rs"]
mod progress;
#[path = "../src/raw_diff.rs"]
mod raw_diff;
#[path = "../src/remote.rs"]
mod remote;
#[path = "../src/remote_ops.rs"]
mod remote_ops;
#[path = "../src/rename.rs"]
mod rename;
#[path = "../src/repository.rs"]
mod repository;
#[path = "../src/search_query.rs"]
mod search_query;
#[path = "../src/shell_env.rs"]
mod shell_env;
#[path = "../src/ssh.rs"]
mod ssh;
#[path = "../src/stage.rs"]
mod stage;
#[path = "../src/stats_context.rs"]
mod stats_context;
#[path = "../src/status.rs"]
mod status;
#[path = "../src/system.rs"]
mod system;
#[path = "../src/terminal.rs"]
mod terminal;
#[cfg(test)]
#[path = "../src/test_repo.rs"]
mod test_repo;
#[path = "../src/trampoline.rs"]
mod trampoline;
#[path = "../src/watch.rs"]
mod watch;
#[path = "../src/windows_integrations.rs"]
mod windows_integrations;
#[path = "../src/xdiff.rs"]
mod xdiff;
use serde_json::{Value, json};
use std::io::{self, Read};
use std::path::Path;

fn execute(request: &Value) -> Result<Value, String> {
    let repo = Path::new(request["repo"].as_str().unwrap_or(""));
    let strings = |key: &str| -> Result<Vec<String>, String> {
        serde_json::from_value(request[key].clone()).map_err(|error| error.to_string())
    };
    Ok(match request["operation"].as_str().unwrap_or("") {
        "desktop/import" => {
            json!(desktop_import::read_profile(Path::new(request["profile"].as_str().ok_or("Missing profile")?))?)
        }
        "notifications/show" => {
            notifications::show(
                request["id"].as_str().unwrap(),
                request["title"].as_str().unwrap(),
                request["body"].as_str().unwrap(),
                request["userInfo"].clone(),
            )?;
            Value::Null
        }
        "log/broken-pipe" => json!(desktop_log::is_broken_pipe(if request["code"] == "EPIPE" {
            io::ErrorKind::BrokenPipe
        } else {
            io::ErrorKind::Other
        })),
        "log/write" => {
            let mut transport = desktop_log::DesktopFileTransport::new(
                Path::new(request["directory"].as_str().unwrap()).to_path_buf(),
                "development",
            );
            transport
                .write(request["timestamp"].as_i64().unwrap(), request["message"].as_str().unwrap())
                .map_err(|e| e.to_string())?;
            transport.close().map_err(|e| e.to_string())?;
            Value::Null
        }
        "stats/architecture" => json!(stats_context::architecture()),
        "stats/in-applications" => json!(stats_context::in_applications()),
        "stats/guid" => json!(stats_context::get_guid(Path::new(request["directory"].as_str().unwrap()))?),
        "file/read-directory" => match file_system::read_directory(Path::new(request["path"].as_str().unwrap())) {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"failure":error}),
        },
        "trampoline/environment" => trampoline::environment(),
        "trampoline/build-paths" => {
            json!({"askpass":env!("GITCUB_ASKPASS_PATH"),"credentialHelper":env!("GITCUB_CREDENTIAL_HELPER_PATH"),"sshWrapper":env!("GITCUB_SSH_WRAPPER_PATH")})
        }
        "trampoline/helpers" => json!(trampoline::helpers().map_err(|e| e.to_string())?),
        "shell/context" => shell_env::context(),
        "shell/which" => json!(shell_env::find_executable(request["name"].as_str().unwrap())),
        "shell/printenvz" => json!(shell_env::printenvz_path().map_err(|e| e.to_string())?),
        "shell/capture" => {
            match shell_env::capture(serde_json::from_value(request["options"].clone()).map_err(|e| e.to_string())?) {
                Ok(value) => json!({"value":value}),
                Err(failure) => json!({"failure":failure}),
            }
        }
        "shell/cygwin-plan" => {
            json!(cygwin::plan(request["executable"].as_str().unwrap(), request["path"].as_str().unwrap()))
        }
        "status/parse" => json!(porcelain::parse(
            &serde_json::from_value::<Vec<u8>>(request["data"].clone()).map_err(|e| e.to_string())?
        )?),
        "status/parse-gitlens" => json!(porcelain::parse_gitlens(
            request["data"].as_str().unwrap_or(""),
            request["porcelainVersion"].as_u64().unwrap_or(2) as u32
        )?),
        "status/fold-ignored" => {
            json!(porcelain::fold_matching_ignored(strings("records")?.iter().map(String::as_str)))
        }
        "repository/description" => json!(repository::description(repo)),
        "reflog/recent" => json!(ops::recent_branches(repo, request["limit"].as_u64().unwrap() as usize)?),
        "reflog/checkouts" => json!(ops::branch_checkouts(repo, request["after"].as_str().unwrap())?),
        "branch/rename" => {
            ops::rename_branch(repo, request["from"].as_str().unwrap(), request["to"].as_str().unwrap())?;
            Value::Null
        }
        "submodules/list" => json!(ops::list_submodules(repo)?),
        "submodules/reset" => {
            ops::reset_submodules(repo, &strings("paths")?)?;
            Value::Null
        }
        "format/patch" => {
            json!(ops::format_patch(repo, request["base"].as_str().unwrap(), request["head"].as_str().unwrap())?)
        }
        "branch/fast-forward" => {
            branch::fast_forward_branches(
                repo,
                &serde_json::from_value::<Vec<branch::TrackingBranch>>(request["branches"].clone())
                    .map_err(|e| e.to_string())?,
            )?;
            Value::Null
        }
        "lfs/using" => json!(ops::using_lfs(repo)?),
        "lfs/tracked" => json!(ops::tracked_by_lfs(repo, request["file"].as_str().unwrap())?),
        "lfs/untracked" => json!(ops::files_not_tracked_by_lfs(repo, &strings("paths")?)?),
        "stash/list" => json!(ops::stashes(repo)?),
        "stash/push" => {
            ops::stash_push(repo, request["branch"].as_str().unwrap())?;
            Value::Null
        }
        "cherry-pick/stream" => {
            ops::cherry_pick_stream(repo, &strings("shas")?, |_| {})?;
            Value::Null
        }
        "stash/message" => json!(ops::stash_message(request["branch"].as_str().unwrap())),
        "stash/create" => json!(ops::create_stash(repo, request["branch"].as_str().unwrap(), &strings("paths")?)?),
        "stash/last" => json!(ops::last_branch_stash(repo, request["branch"].as_str().unwrap())?),
        "stash/drop" => {
            ops::drop_stash_sha(repo, request["sha"].as_str().unwrap())?;
            Value::Null
        }
        "stash/pop" => {
            ops::pop_stash_sha(repo, request["sha"].as_str().unwrap())?;
            Value::Null
        }
        "remote/fetch" => {
            net::fetch(repo, request["remote"].as_str().unwrap(), None, None)?;
            Value::Null
        }
        "remote/pull" => {
            net::pull(repo, request["remote"].as_str().unwrap(), None, None)?;
            Value::Null
        }
        "revision/symmetric" => {
            json!(ops::symmetric_difference(request["ours"].as_str().unwrap(), request["theirs"].as_str().unwrap()))
        }
        "revision/ahead-behind" => json!(ops::ahead_behind_range(repo, request["range"].as_str().unwrap())?),
        "history/merge-base-files" => json!(history::merge_base_changes(
            repo,
            request["from"].as_str().unwrap(),
            request["to"].as_str().unwrap(),
            request["latest"].as_str().unwrap()
        )?),
        "history/range" => json!(history::commits_in_range(repo, request["range"].as_str().unwrap())?),
        "history/merges" => json!(history::has_merges_after(repo, request["revision"].as_str())?),
        "blob" => json!(raw_diff::blob_contents(
            repo,
            request["revision"].as_str().unwrap(),
            request["file"].as_str().unwrap()
        )?),
        "blob/partial" => json!(raw_diff::partial_blob_contents(
            repo,
            request["revision"].as_str().unwrap(),
            request["file"].as_str().unwrap(),
            request["length"].as_u64().unwrap() as usize
        )?),
        "diff/merge-base" => json!(raw_diff::merge_base_diff(
            repo,
            request["from"].as_str().unwrap(),
            request["to"].as_str().unwrap(),
            request["file"].as_str().unwrap(),
            request["oldPath"].as_str(),
            request["hideWhitespace"].as_bool().unwrap_or(false)
        )?),
        "image/diff" => json!(image::image_diff(repo, request["file"].as_str().unwrap(), request["sha"].as_str())?),
        "image/working" => json!(image::working_image(repo, request["file"].as_str().unwrap())?),
        "image/blob" => {
            json!(image::blob_image(repo, request["file"].as_str().unwrap(), request["revision"].as_str().unwrap())?)
        }
        "submodule/info" => json!(system::submodule_info(repo, request["file"].as_str().unwrap())?),
        "diff/binary-paths" => {
            json!(status::binary_paths(repo, request["revision"].as_str().unwrap(), &strings("paths")?)?)
        }
        "cherry-pick/start" => json!(ops::cherry_pick_commits(
            repo,
            &serde_json::from_value::<Vec<history::CommitOneLine>>(request["commits"].clone())
                .map_err(|e| e.to_string())?
        )?),
        "cherry-pick/continue" => json!(ops::continue_cherry_pick(
            repo,
            &strings("paths")?,
            &serde_json::from_value::<Vec<(String, ops::Resolution)>>(request["resolutions"].clone())
                .map_err(|e| e.to_string())?
        )?),
        "cherry-pick/snapshot" => json!(ops::cherry_pick_snapshot(repo)?),
        "cherry-pick/abort" => {
            ops::abort_operation(repo, ops::Operation::CherryPick)?;
            Value::Null
        }
        "clone" => {
            let output = branch::clone_output(
                request["url"].as_str().unwrap(),
                Path::new(request["path"].as_str().unwrap()),
                None,
                &serde_json::from_value::<branch::CloneOptions>(request["options"].clone())
                    .map_err(|e| e.to_string())?,
            )?;
            json!({ "exitCode": output.status.code(), "stdout": String::from_utf8_lossy(&output.stdout), "stderr": String::from_utf8_lossy(&output.stderr), "progress": progress::clone_progress(&output.stderr) })
        }
        "git-attributes/write" => {
            repository::write_git_attributes(repo)?;
            Value::Null
        }
        "progress/new" => json!(if request["clone"].as_bool().unwrap_or(false) {
            progress::Parser::clone_parser()
        } else {
            progress::Parser::new(serde_json::from_value(request["steps"].clone()).map_err(|e| e.to_string())?)?
        }),
        "progress/parse" => json!(progress::parse(request["line"].as_str().unwrap())),
        "progress/next" => {
            let mut parser: progress::Parser =
                serde_json::from_value(request["parser"].clone()).map_err(|e| e.to_string())?;
            let result = parser.parse(request["line"].as_str().unwrap());
            json!({ "parser": parser, "result": result })
        }
        "progress/lfs" => {
            let mut parser: progress::LfsParser = if request["parser"].is_null() {
                progress::LfsParser::default()
            } else {
                serde_json::from_value(request["parser"].clone()).map_err(|e| e.to_string())?
            };
            let result = parser.parse(request["line"].as_str().unwrap());
            json!({ "parser": parser, "result": result })
        }
        "commit/format" => json!(net::format_commit_message(
            repo,
            request["summary"].as_str().unwrap(),
            request["description"].as_str(),
            &serde_json::from_value::<Vec<net::Trailer>>(request["trailers"].clone()).map_err(|e| e.to_string())?
        )?),
        "readme/write" => {
            repository::write_default_readme(repo, request["name"].as_str().unwrap(), request["description"].as_str())?;
            Value::Null
        }
        "terminal/tail" => {
            let mut tail = terminal::Tail::default();
            let capacity = request["capacity"].as_u64().ok_or("Invalid capacity")? as usize;
            if capacity == 0 {
                return Err("The capacity argument must be greater than 0".into());
            }
            for chunk in serde_json::from_value::<Vec<Vec<u8>>>(request["chunks"].clone()).map_err(|e| e.to_string())? {
                tail.push(capacity, &chunk);
            }
            json!(tail.bytes())
        }
        "format/rebase" => json!(ops::format_rebase_value(
            request["value"].as_str().unwrap().parse().map_err(|e: std::num::ParseFloatError| e.to_string())?
        )),
        "http/absolute-url" => {
            json!(host_url::absolute_url(request["endpoint"].as_str().unwrap(), request["path"].as_str().unwrap())?)
        }
        "http/dotcom" => json!(host_url::DOT_COM_API_ENDPOINT),
        "ssh/prompt" => json!(ssh::parse_host_prompt(request["prompt"].as_str().unwrap())),
        "credential/parse" => json!(credential_protocol::parse(request["value"].as_str().unwrap())),
        "credential/format" => json!(credential_protocol::format(
            &serde_json::from_value::<Vec<(String, String)>>(request["entries"].clone()).map_err(|e| e.to_string())?
        )?),
        "file/temp" => json!(file_system::temporary_file_path(request["name"].as_str().unwrap())?),
        "file/partial" => json!(file_system::read_partial_file(
            repo,
            request["start"].as_u64().unwrap(),
            request["end"].as_u64().unwrap()
        )?),
        "process/execute" => match process::execute(
            request["executable"].as_str().unwrap(),
            &strings("args")?,
            request["timeoutMs"].as_u64().unwrap(),
            request["maxBuffer"].as_u64().unwrap() as usize,
        ) {
            Ok(value) => json!({"value":value}),
            Err(failure) => json!({"failure":failure}),
        },
        "file/hash" => match file_system::file_hash(repo, request["algorithm"].as_str().unwrap()) {
            Ok(value) => json!({ "value": value }),
            Err(failure) => json!({ "failure": failure }),
        },
        "file/resolve" => json!(file_system::resolve_within(repo, &strings("segments")?)?),
        "file/url" => json!(file_system::encode_path_url(&strings("segments")?)?),
        "file/bundle" => json!(file_system::is_application_bundle_metadata(request["metadata"].as_str().unwrap())?),
        "remote/fetch-output" => json!(net::fetch_output(
            repo,
            request["remote"].as_str().unwrap(),
            serde_json::from_value(request["options"].clone()).map_err(|e| e.to_string())?,
            None,
            None
        )?),
        "remote/pull-output" => json!(net::pull_output(
            repo,
            request["remote"].as_str().unwrap(),
            serde_json::from_value(request["options"].clone()).map_err(|e| e.to_string())?,
            None,
            None
        )?),
        "remote/fetch-refspec" => {
            net::fetch_refspec(repo, request["remote"].as_str().unwrap(), request["refspec"].as_str().unwrap(), None)?;
            Value::Null
        }
        "worktree/add" => {
            ops::add_worktree_at(
                repo,
                Path::new(request["path"].as_str().unwrap()),
                request["createBranch"].as_str(),
                request["commitish"].as_str(),
            )?;
            Value::Null
        }
        "rebase/start" => {
            json!(ops::rebase_branch(repo, request["base"].as_str().unwrap(), request["target"].as_str())?)
        }
        "rebase/abort" => {
            ops::abort_operation(repo, ops::Operation::Rebase)?;
            Value::Null
        }
        "rebase/snapshot" => json!(ops::rebase_snapshot(repo)?),
        "rebase/continue-detailed" => json!(ops::continue_rebase_with_resolutions(
            repo,
            &strings("paths")?,
            &serde_json::from_value::<Vec<(String, ops::Resolution)>>(request["resolutions"].clone())
                .map_err(|e| e.to_string())?,
            request["editor"].as_str()
        )?),
        "tags/list" => json!(ops::all_tags(repo)?),
        "tags/create" => {
            ops::create_tag(repo, request["name"].as_str().unwrap(), request["sha"].as_str().unwrap())?;
            Value::Null
        }
        "tags/delete" => {
            ops::delete_tag(repo, request["name"].as_str().unwrap())?;
            Value::Null
        }
        "tags/unpushed" => json!(ops::tags_to_push(
            repo,
            request["remote"].as_str().unwrap(),
            request["branch"].as_str().unwrap(),
            None
        )?),
        "tags/push" => {
            net::push_with_tags(
                repo,
                request["remote"].as_str().unwrap(),
                request["branch"].as_str().unwrap(),
                &strings("tags")?,
                serde_json::from_value(request["options"].clone()).map_err(|e| e.to_string())?,
                None,
                None,
            )?;
            Value::Null
        }
        "reset" => {
            ops::reset(
                repo,
                serde_json::from_value(request["mode"].clone()).map_err(|e| e.to_string())?,
                request["target"].as_str().unwrap(),
            )?;
            json!(true)
        }
        "reset/paths" => {
            ops::reset_paths(
                repo,
                serde_json::from_value(request["mode"].clone()).map_err(|e| e.to_string())?,
                request["target"].as_str().unwrap(),
                &strings("paths")?,
            )?;
            Value::Null
        }
        "conflict/add" => {
            ops::add_conflicted_file(repo, request["file"].as_str().unwrap())?;
            Value::Null
        }
        "diff/discard" => {
            raw_diff::apply_patch_to_worktree(repo, request["patch"].as_str().unwrap())?;
            Value::Null
        }
        "diff/resolution" => json!(raw_diff::resolution_diff(
            repo,
            request["file"].as_str().unwrap(),
            serde_json::from_value(request["target"].clone()).map_err(|e| e.to_string())?,
            request["hideWhitespace"].as_bool().unwrap_or(false)
        )?),
        "remote/push-url" => json!(remote_ops::push_url(repo, request["name"].as_str().unwrap())?),
        "remote/parse" => json!(remote::parse(request["url"].as_str().unwrap())),
        "commit" => json!(net::commit_output(
            repo,
            request["message"].as_str().unwrap(),
            "",
            serde_json::from_value(request["options"].clone()).map_err(|e| e.to_string())?
        )?),
        "commit/merge" => json!(ops::finish_merge(
            repo,
            &strings("paths")?,
            &serde_json::from_value::<Vec<(String, ops::Resolution)>>(request["resolutions"].clone())
                .map_err(|e| e.to_string())?
        )?),
        "branch/local-ref" => json!(branch::local_ref(request["name"].as_str().unwrap())),
        "branch/symbolic" => json!(branch::symbolic_ref(repo, request["name"].as_str().unwrap())?),
        "branch/differing" => json!(branch::differing_from_upstream(repo)?),
        "branch/list" => json!(branch::list(repo, request["pattern"].as_str())?),
        "branch/tip" => json!(branch::tip(repo)?),
        "branch/pointed" => json!(branch::pointed_at(repo, request["revision"].as_str().unwrap())?),
        "branch/create" => {
            branch::create(
                repo,
                request["name"].as_str().unwrap(),
                request["start"].as_str(),
                request["noTrack"].as_bool().unwrap_or(false),
            )?;
            json!(true)
        }
        "branch/delete" => {
            branch::delete_local(repo, request["name"].as_str().unwrap())?;
            json!(true)
        }
        "branch/delete-remote" => {
            branch::delete_remote(repo, request["remote"].as_str().unwrap(), request["name"].as_str().unwrap(), None)?;
            json!(true)
        }
        "branch/checkout" => {
            branch::checkout(
                repo,
                request["name"].as_str().unwrap(),
                request["remoteRef"].as_str(),
                request["allowFileProtocol"].as_bool().unwrap_or(false),
            )?;
            json!(true)
        }
        "checkout" => {
            net::checkout(repo, request["branch"].as_str().unwrap())?;
            json!(true)
        }
        "merge" => json!(ops::merge_with_options(
            repo,
            request["branch"].as_str().unwrap(),
            request["squash"].as_bool().unwrap_or(false),
            request["noVerify"].as_bool().unwrap_or(false)
        )?),
        "merge/base" => {
            json!(ops::merge_base(repo, request["first"].as_str().unwrap(), request["second"].as_str().unwrap())?)
        }
        "merge/abort" => {
            ops::abort_operation(repo, ops::Operation::Merge)?;
            Value::Null
        }
        "conflict/markers" => json!(status::conflict_markers(repo)?),
        "index/staged" => json!(index_parser::staged(request["data"].as_str())),
        "index/conflicts" => {
            json!(index_parser::conflicts(request["data"].as_str(), request["repo"].as_str().unwrap_or("")))
        }
        "squash" => rebase_result(
            repo,
            interactive::squash(
                repo,
                &strings("shas")?,
                request["onto"].as_str().unwrap(),
                request["base"].as_str(),
                request["message"].as_str().unwrap_or(""),
            ),
        ),
        "reorder" => rebase_result(
            repo,
            interactive::reorder(repo, &strings("shas")?, request["before"].as_str(), request["base"].as_str()),
        ),
        "rebase/continue" => {
            rebase_result(repo, ops::continue_rebase(repo, &strings("paths")?, request["editor"].as_str()))
        }
        "rebase/state" => json!(ops::rebase_state(repo)),
        "history/files" => json!(history::commit_files(repo, request["sha"].as_str().unwrap())?),
        "repository/type" => json!(repository::repository_type(repo)?),
        "config/safe" => {
            git_config::add_safe_directory(repo)?;
            Value::Null
        }
        "config/get" => json!(git_config::get(
            request["repo"].as_str().map(Path::new),
            request["key"].as_str().unwrap(),
            request["local"].as_bool().unwrap_or(false),
            request["boolean"].as_bool().unwrap_or(false)
        )?),
        "config/set" => {
            git_config::set(
                request["repo"].as_str().map(Path::new),
                request["key"].as_str().unwrap(),
                request["value"].as_str().unwrap(),
            )?;
            Value::Null
        }
        "config/path" => json!(git_config::global_path()?),
        "git/config-lock-path" => json!(git::config_lock_path(repo, request["stderr"].as_str().unwrap())),
        "git" | "git/execute" | "git/stream" => {
            let mut command = git::Git::new(Some(repo)).args(strings("args")?);
            if let Some(env) = request["env"].as_object() {
                for (key, value) in env {
                    command = command.env(key, value.as_str().unwrap());
                }
            }
            if let Some(input) = request["stdin"].as_str() {
                command = command.stdin(input);
            }
            if request["operation"] == "git/stream" {
                let codes: Vec<i32> =
                    serde_json::from_value(request["successExitCodes"].clone()).map_err(|e| e.to_string())?;
                let out = command.output_stream(|bytes| {
                    println!("{}", json!({"terminal": bytes}));
                })?;
                json!(git::checked_result(repo, out, &codes, &strings("expectedErrors")?)?)
            } else if request["operation"] == "git/execute" {
                let codes: Vec<i32> =
                    serde_json::from_value(request["successExitCodes"].clone()).map_err(|e| e.to_string())?;
                json!(command.execute(repo, &codes, &strings("expectedErrors")?)?)
            } else {
                let out = command.output()?;
                json!({"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"exitCode":out.status.code()})
            }
        }
        "revert" => {
            ops::revert(repo, request["sha"].as_str().unwrap(), request["merge"].as_bool().unwrap_or(false))?;
            Value::Null
        }
        "file/metadata" => json!(file_system::metadata(Path::new(request["path"].as_str().unwrap()))?),
        "file/unlink" => match file_system::unlink_file(Path::new(request["path"].as_str().unwrap())) {
            Ok(()) => json!({"value":null}),
            Err(failure) => json!({"failure":failure}),
        },
        "file/remove" => {
            file_system::remove_file(Path::new(request["path"].as_str().unwrap()))?;
            json!(null)
        }
        "file/exists" => json!(file_system::path_exists(Path::new(request["path"].as_str().unwrap()))?),
        "remote/head" => json!(remote_ops::head(repo, request["remote"].as_str().unwrap())?),
        "git/metadata-exists" => {
            let name = request["name"].as_str().unwrap();
            if !["SQUASH_MSG", "MERGE_HEAD", "CHERRY_PICK_HEAD"].contains(&name) {
                return Err("Unknown Git metadata".into());
            }
            let value = git::Git::new(Some(repo)).args(["rev-parse", "--git-path", name]).stdout()?;
            let path = Path::new(value.trim());
            json!(file_system::path_exists(&if path.is_absolute() { path.to_path_buf() } else { repo.join(path) })?)
        }
        "file/size" => json!(file_system::file_size(Path::new(request["path"].as_str().unwrap()))?),
        "file/conflict-text" => json!(file_system::read_conflict_text(Path::new(request["path"].as_str().unwrap()))?),
        "history/details" => json!(history::query_details(
            repo,
            request["revision"].as_str(),
            request["limit"].as_u64().map(|n| n as usize),
            request["skip"].as_u64().map(|n| n as usize),
            &strings("additional")?
        )?),
        "history/query" => json!(history::query(
            repo,
            request["revision"].as_str().unwrap_or("HEAD"),
            request["limit"].as_u64().map(|n| n as usize),
            request["skip"].as_u64().map(|n| n as usize),
            &strings("additional")?
        )?),
        "history" => json!(history::log(repo, request["limit"].as_u64().unwrap_or(100) as usize, 0)?),
        "blame" => {
            let user = request
                .get("user")
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| error.to_string())?;
            json!(blame_model::parse(
                repo.to_str().unwrap_or(""),
                request["data"].as_str(),
                user.as_ref(),
                request["modifiedTime"].as_i64()
            ))
        }
        "gitignore/read" => json!(gitignore::read(repo)?),
        "gitignore/save" => {
            gitignore::save(repo, request["text"].as_str().unwrap())?;
            Value::Null
        }
        "gitignore/escape" => json!(gitignore::escape(request["text"].as_str().unwrap())),
        "gitignore/append-rules" => {
            gitignore::append_rules(repo, &strings("patterns")?)?;
            Value::Null
        }
        "gitignore/append-files" => {
            gitignore::append_files(repo, &strings("paths")?)?;
            Value::Null
        }
        "remote/list" => json!(remote_ops::list(repo)?),
        "remote/get-url" => json!(remote_ops::get_url(repo, request["name"].as_str().unwrap())?),
        "remote/update-head" => {
            remote_ops::update_head(repo, request["name"].as_str().unwrap(), None, None)?;
            Value::Null
        }
        "remote/add" => {
            system::add_remote(repo, request["name"].as_str().unwrap(), request["url"].as_str().unwrap())?;
            json!({"name":request["name"],"url":request["url"]})
        }
        "remote/set-url" => {
            system::set_remote_url(repo, request["name"].as_str().unwrap(), request["url"].as_str().unwrap())?;
            json!(true)
        }
        "remote/remove" => {
            system::remove_remote(repo, request["name"].as_str().unwrap())?;
            Value::Null
        }
        "init" => {
            system::init_repo(repo, request["branch"].as_str().unwrap_or("main"))?;
            Value::Null
        }
        "diff" => json!(raw_diff::working_directory_diff(
            repo,
            request["file"].as_str().unwrap(),
            serde_json::from_value(request["kind"].clone()).map_err(|error| error.to_string())?,
            request["hideWhitespace"].as_bool().unwrap_or(false)
        )?),
        "status" => json!(status::status(repo)?),
        "selection" => {
            stage::apply_selection(
                repo,
                &serde_json::from_value::<Vec<stage::StageFile>>(request["files"].clone())
                    .map_err(|error| error.to_string())?,
            )?;
            Value::Null
        }
        "worktree/list" => json!(ops::worktrees(repo)?),
        "worktree/move" => {
            ops::move_worktree(repo, request["oldPath"].as_str().unwrap(), request["newPath"].as_str().unwrap())?;
            Value::Null
        }
        "worktree/move-command" => {
            let (cwd, args) = ops::move_worktree_command(
                repo,
                request["oldPath"].as_str().unwrap(),
                request["newPath"].as_str().unwrap(),
            )?;
            json!({ "cwd": cwd, "args": args })
        }
        "worktree/git-dir" => json!(ops::worktrees_from_git_dir(Path::new(request["gitDir"].as_str().unwrap()))?),
        "worktree/main-path" => json!(ops::main_worktree_path(
            repo,
            request["mainPath"].as_str().map(Path::new),
            request["gitDir"].as_str().map(Path::new)
        )?),
        "worktree/parse" => json!(ops::parse_worktrees(request["data"].as_str().unwrap_or(""))),
        "search/parse" => json!(search_query::parse_search_query(
            &serde_json::from_value(request["search"].clone()).map_err(|error| error.to_string())?,
            request["validate"].as_bool().unwrap_or(false)
        )),
        "search/git-command" => {
            let user: Option<search_query::GitUser> =
                serde_json::from_value(request["currentUser"].clone()).map_err(|error| error.to_string())?;
            json!(search_query::parse_search_query_git_command(
                &serde_json::from_value(request["search"].clone()).map_err(|error| error.to_string())?,
                user.as_ref()
            ))
        }
        "search/rebuild" => json!(search_query::rebuild_search_query_from_parsed(
            &serde_json::from_value(request["parsed"].clone()).map_err(|error| error.to_string())?
        )),
        "search/comparison-key" => json!(search_query::get_search_query_comparison_key(
            &serde_json::from_value(request["search"].clone()).map_err(|error| error.to_string())?
        )),
        "search/equal" => {
            let a: Option<search_query::SearchQuery> =
                serde_json::from_value(request["a"].clone()).map_err(|error| error.to_string())?;
            let b: Option<search_query::SearchQuery> =
                serde_json::from_value(request["b"].clone()).map_err(|error| error.to_string())?;
            json!(search_query::are_search_queries_equal(a.as_ref(), b.as_ref()))
        }
        "search" => json!(history::search(
            repo,
            &serde_json::from_value(request["search"].clone()).map_err(|error| error.to_string())?,
            request["limit"].as_u64().unwrap_or(100) as usize,
            request["skip"].as_u64().unwrap_or(0) as usize
        )?),
        // GitLens revision.utils / fileStatus.utils / remote / branch.utils 与 revision、revParseGitDir、
        // gitIgnoreFilter 集成套件：只调用生产函数。JS 的 undefined 按空串传入（原版 isMatch 与
        // `!rev` 对空串同样判否）；git check-ignore 末尾 `/` 表示目录，对应 `is_dir`。
        "gitlens/is-sha" => json!(search_query::is_sha(request["rev"].as_str().unwrap_or(""))),
        "gitlens/is-sha-with-optional-revision-suffix" => {
            json!(search_query::SHA_WITH_OPTIONAL_REVISION_SUFFIX.is_match(request["rev"].as_str().unwrap_or("")))
        }
        "gitlens/is-uncommitted" => json!(search_query::is_uncommitted(request["rev"].as_str().unwrap_or(""))),
        "gitlens/is-uncommitted-staged" => {
            json!(search_query::is_uncommitted_staged(request["rev"].as_str().unwrap_or("")))
        }
        "gitlens/shorten-revision" => json!(search_query::shorten_revision(request["rev"].as_str().unwrap_or(""))),
        "gitlens/is-revision-range" => json!(search_query::RANGE.is_match(request["rev"].as_str().unwrap_or(""))),
        "gitlens/file-diff-pathspecs" => {
            json!(raw_diff::file_diff_pathspecs(request["path"].as_str().unwrap(), request["originalPath"].as_str()))
        }
        "gitlens/split-remote-branch-name" => {
            let remotes = strings("remotes")?;
            let remotes: Vec<&str> = remotes.iter().map(String::as_str).collect();
            json!(branch::split_remote_branch_name(request["name"].as_str().unwrap(), &remotes))
        }
        "gitlens/resolve-shas" => json!(history::resolve_shas(repo, &strings("shas")?)?),
        "gitlens/ignored" => {
            let path = request["path"].as_str().unwrap();
            json!(match path.strip_suffix('/') {
                Some(directory) => watch::excluded(repo, Path::new(directory), true),
                None => watch::ignored_by_git(repo, Path::new(path)),
            })
        }
        // GitLens integration provider shim (tests/conformance/gitlens-integration.ts).
        "revision/resolve" => json!(history::resolve_revision(repo, request["revision"].as_str().unwrap())?),
        "worktree/remove" => {
            ops::remove_worktree(repo, request["path"].as_str().unwrap())?;
            Value::Null
        }
        // GitLens integration pausedOperations suite (gitlens-integration.ts pausedOps).
        "operation/continue" => {
            ops::continue_operation(
                repo,
                serde_json::from_value(request["pausedOperation"].clone()).map_err(|error| error.to_string())?,
            )?;
            Value::Null
        }
        // GitLens operations/graph integration suites: the Tauri commands commit / amend_commit / merge_branch /
        // graph, each calling the same production function.
        "commit/create" => {
            net::commit(
                repo,
                request["summary"].as_str().unwrap(),
                request["description"].as_str().unwrap_or(""),
                serde_json::from_value(request["options"].clone()).map_err(|e| e.to_string())?,
            )?;
            Value::Null
        }
        "commit/amend" => {
            ops::amend(repo, request["summary"].as_str().unwrap(), request["description"].as_str().unwrap_or(""))?;
            Value::Null
        }
        "merge/branch" => {
            ops::merge(repo, request["branch"].as_str().unwrap(), request["squash"].as_bool().unwrap_or(false))?;
            Value::Null
        }
        "graph" => json!(graph::graph(
            repo,
            request["limit"].as_u64().unwrap() as usize,
            request["skip"].as_u64().unwrap_or(0) as usize,
            serde_json::from_value(request["cursor"].clone()).map_err(|e| e.to_string())?
        )?),
        operation => return Err(format!("Unsupported conformance operation: {operation}")),
    })
}
// Result/operation 状态映射到 Desktop 的枚举；不代替被测变基操作。
fn rebase_result(repo: &Path, result: Result<(), String>) -> Value {
    json!(match result {
        Ok(()) => "CompletedWithoutError",
        Err(_)
            if status::status(repo)
                .is_ok_and(|s| s.changes.iter().any(|f| f.change == status::ChangeType::Conflicted)) =>
            "ConflictsEncountered",
        Err(_) => "Error",
    })
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--trampoline-relay") {
        use std::io::BufRead;
        let service = trampoline::Service::default();
        let port = service.start(|value| println!("{}", value)).expect("start trampoline relay");
        println!("{}", json!({"port":port}));
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                let _ = service.respond(frame["id"].as_u64().unwrap(), frame["result"].as_str().unwrap_or(""));
            }
        }
        return;
    }

    if std::env::args().nth(1).as_deref() == Some("--terminal-stream") {
        use std::io::Write;
        let mut terminal = terminal::Terminal::default();
        let mut bytes = [0; 8192];
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        loop {
            let count = input.read(&mut bytes).unwrap();
            if count == 0 {
                break;
            }
            output.write_all(&terminal.push(&bytes[..count])).unwrap();
            output.flush().unwrap();
        }
        output.write_all(&terminal.finish()).unwrap();
        return;
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let request: Value = serde_json::from_str(&input).unwrap();
    let response = execute(&request).unwrap_or_else(|error| json!({ "error": error }));
    println!("{response}");
}
