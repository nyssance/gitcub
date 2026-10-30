//! 把仓库交给系统上的其他工具：文件管理器、终端、编辑器。
//!
//! 原版有一整套「探测你装了哪些编辑器」的逻辑（app/src/lib/editors），
//! 那是为了在设置里列出可选项。我们先做最常用的一条路：
//! 按优先级试几个常见 CLI，都没有就交给系统默认程序打开目录。

use std::path::Path;
use std::process::Command;

/// 在文件管理器里显示。
pub fn reveal(path: &Path) -> Result<(), String> {
    let (bin, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![])
    } else if cfg!(target_os = "windows") {
        ("explorer", vec![])
    } else {
        ("xdg-open", vec![])
    };
    spawn(bin, &args, path)
}

/// 在终端里打开。
pub fn open_terminal(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return spawn("open", &["-a", "Terminal"], path);
    }
    if cfg!(target_os = "windows") {
        // Windows Terminal 装了就用它；没装退回 cmd。
        // cmd 那条不能把路径当参数递过去（`start cmd <路径>` 会被 cmd 当成
        // 要执行的命令），靠 spawn 设好工作目录就行
        return spawn("wt", &["-d"], path).or_else(|_| spawn_in("cmd", &["/c", "start", "cmd"], path));
    }
    // Linux 各发行版默认终端不一样，按常见程度试
    for bin in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if spawn(bin, &[], path).is_ok() {
            return Ok(());
        }
    }
    Err("没找到可用的终端程序".into())
}

/// 在编辑器里打开。挨个试常见 CLI；都没有就交给系统默认程序。
pub fn open_editor(path: &Path) -> Result<(), String> {
    // 先尊重用户的 $EDITOR / $VISUAL——配了就是想用它
    for var in ["VISUAL", "EDITOR"] {
        if let Ok(bin) = std::env::var(var)
            && !bin.trim().is_empty()
            && spawn(&bin, &[], path).is_ok()
        {
            return Ok(());
        }
    }
    for bin in ["code", "cursor", "zed", "subl", "idea", "webstorm"] {
        if spawn(bin, &[], path).is_ok() {
            return Ok(());
        }
    }
    reveal(path)
}

fn spawn(bin: &str, args: &[&str], path: &Path) -> Result<(), String> {
    Command::new(bin).args(args).arg(path).spawn().map(|_| ()).map_err(|e| format!("启动 {bin} 失败: {e}"))
}

/// 和 [`spawn`] 一样，但路径是作为**工作目录**而不是参数给出去的。
fn spawn_in(bin: &str, args: &[&str], path: &Path) -> Result<(), String> {
    Command::new(bin).args(args).current_dir(path).spawn().map(|_| ()).map_err(|e| format!("启动 {bin} 失败: {e}"))
}

/// 新建仓库。默认分支由前端按 Desktop 的 getDefaultBranch 传入（全局 init.defaultBranch，没配就是 main）。
pub fn init_repo(path: &Path, default_branch: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("创建目录失败: {e}"))?;
    crate::git::Git::new(None).args(["-c", &format!("init.defaultBranch={default_branch}")]).arg("init").arg(path).run()
}

/// 给已有仓库配远端。发布到远端＝配 origin + 首推（带 --set-upstream）。
pub fn add_remote(repo: &Path, name: &str, url: &str) -> Result<(), String> {
    crate::git::Git::new(Some(repo)).args(["remote", "add", "--", name, url]).run()
}

/// 远端列表：名字 → URL。
pub fn remotes(repo: &Path) -> Result<Vec<(String, String)>, String> {
    crate::remote_ops::list(repo)
}

pub fn set_remote_url(repo: &Path, name: &str, url: &str) -> Result<(), String> {
    crate::git::Git::new(Some(repo)).args(["remote", "set-url", "--", name, url]).run()
}

pub fn remove_remote(repo: &Path, name: &str) -> Result<(), String> {
    // Desktop remote.ts/removeRemote：缺失远端允许 2/128，参数按字面量传递。
    let out = crate::git::Git::new(Some(repo)).args(["remote", "remove", "--", name]).output()?;
    match out.status.code() {
        Some(0 | 2 | 128) => Ok(()),
        _ => Err(crate::git::stderr_of(&out)),
    }
}

/// 读 .gitignore。没有这个文件不是错误——大量仓库就是没有。
pub fn read_gitignore(repo: &Path) -> Result<String, String> {
    crate::gitignore::read(repo).map(Option::unwrap_or_default)
}

pub fn write_gitignore(repo: &Path, content: &str) -> Result<(), String> {
    crate::gitignore::save(repo, content)
}

// Bundle IDs and launch arguments follow Desktop lib/editors/darwin.ts and lib/shells/darwin.ts.
pub fn available_integrations() -> Result<Vec<serde_json::Value>, String> {
    if cfg!(windows) {
        return Ok(crate::windows_integrations::available());
    }
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }
    let catalog: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("desktop-integrations.json")).map_err(|e| e.to_string())?;
    let query = catalog
        .iter()
        .filter_map(|item| item["bundleId"].as_str())
        .map(|id| format!("kMDItemCFBundleIdentifier == '{id}'"))
        .collect::<Vec<_>>()
        .join(" || ");
    let output = Command::new("mdfind").arg(query).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let mut result = Vec::new();
    for path in String::from_utf8_lossy(&output.stdout).lines().filter(|path| path.ends_with(".app")) {
        let plist = Path::new(path).join("Contents/Info.plist");
        let output = Command::new("plutil")
            .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
            .arg(plist)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            continue;
        }
        let id = String::from_utf8_lossy(&output.stdout);
        if let Some(item) = catalog.iter().find(|item| item["bundleId"].as_str() == Some(id.trim())) {
            let mut item = item.clone();
            item["path"] = path.into();
            if !result.iter().any(|found: &serde_json::Value| found["bundleId"] == item["bundleId"]) {
                result.push(item);
            }
        }
    }
    Ok(result)
}

pub fn open_integration(bundle_id: &str, path: &Path) -> Result<(), String> {
    if cfg!(windows) {
        return crate::windows_integrations::open(bundle_id, path);
    }
    let apps = available_integrations()?;
    let app = apps
        .iter()
        .find(|app| app["bundleId"].as_str() == Some(bundle_id))
        .ok_or("所选应用已不可用，请重新选择编辑器或终端")?;
    let root = app["path"].as_str().ok_or("应用路径缺失")?;
    let specialized = match app["name"].as_str().unwrap_or("") {
        "Kitty" => Some(("kitty", vec!["--single-instance", "--directory"])),
        "Alacritty" => Some(("alacritty", vec!["--working-directory"])),
        "Tabby" => Some(("Tabby", vec!["open"])),
        "WezTerm" => Some(("wezterm", vec!["start", "--cwd"])),
        _ => None,
    };
    if let Some((exe, args)) = specialized {
        let exe = Path::new(root).join("Contents/MacOS").join(exe);
        Command::new(exe).args(args).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        spawn("open", &["-b", bundle_id], path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 新建的仓库默认分支是指定的那个() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("新仓库");
        init_repo(&p, "main").unwrap();

        let head = std::fs::read_to_string(p.join(".git").join("HEAD")).unwrap();
        assert_eq!(head.trim(), "ref: refs/heads/main");
    }

    #[test]
    fn 远端列表与改地址() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r");
        init_repo(&p, "main").unwrap();
        add_remote(&p, "origin", "https://example.com/a/b.git").unwrap();

        assert_eq!(remotes(&p).unwrap(), vec![("origin".into(), "https://example.com/a/b.git".into())]);

        set_remote_url(&p, "origin", "https://example.com/c/d.git").unwrap();
        assert_eq!(remotes(&p).unwrap()[0].1, "https://example.com/c/d.git");

        remove_remote(&p, "origin").unwrap();
        assert!(remotes(&p).unwrap().is_empty());
    }

    #[test]
    fn gitignore_写入时补末尾换行() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r");
        init_repo(&p, "main").unwrap();

        assert_eq!(read_gitignore(&p).unwrap(), "", "没有这个文件不该报错");
        write_gitignore(&p, "target\nnode_modules").unwrap();
        assert_eq!(read_gitignore(&p).unwrap(), "target\nnode_modules\n");
    }

    #[test]
    fn 配远端后能读回来() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r");
        init_repo(&p, "main").unwrap();
        add_remote(&p, "origin", "https://example.com/a/b.git").unwrap();

        let url = crate::git::Git::new(Some(&p)).args(["remote", "get-url", "origin"]).stdout().unwrap();
        assert_eq!(url.trim(), "https://example.com/a/b.git");
    }
}

/// 子模块的细节，给 diff 面板用。
///
/// 子模块在父仓库眼里只是一个「指向某个提交」的条目，拿它去做文本 diff 没有
/// 意义（原版专门画了一块 SubmoduleDiff）。界面要的是三件事：它是哪个仓库、
/// 记录的提交和实际的提交差在哪、里面还有没有没提交的东西。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub full_path: String,
    /// .gitmodules 里写的地址
    pub url: Option<String>,
    /// 父仓库记录的提交（HEAD 里那一版）
    pub recorded: Option<String>,
    /// 子模块实际检出的提交
    pub actual: Option<String>,
    /// 子模块内部未提交的改动条数（`git status --porcelain` 经 `porcelain::parse_gitlens` 解析出的条目数）
    pub dirty: u32,
}

pub fn submodule_info(repo: &Path, rel: &str) -> Result<SubmoduleInfo, String> {
    let g = || crate::git::Git::new(Some(repo));
    // `.gitmodules` 里的名字不一定等于路径，用 --get-regexp 反查
    let url = g()
        .args(["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"])
        .stdout_or_empty()
        .lines()
        .find(|l| l.split_once(' ').is_some_and(|(_, p)| p == rel))
        .and_then(|l| l.split_once(' ').map(|(k, _)| k.to_string()))
        .map(|key| key.trim_end_matches(".path").to_string() + ".url")
        .map(|key| g().args(["config", "-f", ".gitmodules", "--get", &key]).stdout_or_empty())
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    let recorded = g().args(["rev-parse", &format!("HEAD:{rel}")]).stdout_or_empty().trim().to_string();
    let full = repo.join(rel);
    let actual = crate::git::Git::new(Some(&full)).args(["rev-parse", "HEAD"]).stdout_or_empty().trim().to_string();
    let porcelain = crate::git::Git::new(Some(&full)).args(["status", "--porcelain"]).stdout_or_empty();
    let dirty =
        crate::porcelain::parse_gitlens(&porcelain, 1).ok().flatten().map_or(0, |status| status.files.len() as u32);

    Ok(SubmoduleInfo {
        full_path: full.to_string_lossy().into_owned(),
        url,
        recorded: (!recorded.is_empty()).then_some(recorded),
        actual: (!actual.is_empty()).then_some(actual),
        dirty,
    })
}

#[cfg(test)]
mod lfs_tests {
    use super::*;

    /// 造一个 100MiB+ 的稀疏文件：只占元数据，不真写 100MB 进磁盘
    fn big_file(path: &Path, bytes: u64) {
        let f = std::fs::File::create(path).unwrap();
        f.set_len(bytes).unwrap();
    }

    fn git(r: &Path, args: &[&str]) {
        std::process::Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
    }

    #[test]
    fn 超大又没走_lfs_的文件会被挑出来() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        // 一个大的、没被 LFS 接管
        big_file(&r.join("大文件.bin"), 101 * 1024 * 1024);
        // 一个大的、但 .gitattributes 说它走 lfs
        big_file(&r.join("走lfs.bin"), 101 * 1024 * 1024);
        std::fs::write(r.join(".gitattributes"), "走lfs.bin filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        // 一个小的
        std::fs::write(r.join("小文件.txt"), "x\n").unwrap();

        let paths = vec!["大文件.bin".to_string(), "走lfs.bin".to_string(), "小文件.txt".to_string()];
        let out = oversized_files(&r, &paths);
        assert_eq!(out, vec!["大文件.bin".to_string()], "实际: {out:?}");
    }

    #[test]
    fn 没有超大文件时不起_git_进程() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        std::fs::write(r.join("a.txt"), "x\n").unwrap();
        assert!(oversized_files(&r, &["a.txt".to_string()]).is_empty());
    }
}

#[cfg(test)]
mod submodule_tests {
    use super::*;

    #[test]
    fn 读得出子模块的地址和两个提交() {
        let (_d, outer) = crate::test_repo::with_submodule();
        let info = submodule_info(&outer, "mod").unwrap();
        assert_eq!(info.url.as_deref(), Some("../inner"));
        assert!(info.recorded.is_some() && info.actual.is_some());
        assert_ne!(info.recorded, info.actual, "夹具把子模块切到了上一个提交");
        assert_eq!(info.dirty, 2, "子模块里一个改动 + 一个未跟踪");
    }
}

/// GitHub 单个文件的硬上限。超过这个大小又没走 LFS 的文件，推上去会被拒。
const GITHUB_FILE_LIMIT: u64 = 100 * 1024 * 1024;

/// 这些文件里，哪些又大又没被 LFS 接管。
///
/// 照原版的做法（getLargeFilePaths + filesNotTrackedByLFS）：先按体积筛，
/// 再问 `git check-attr filter` 看有没有被 lfs 过滤器接管。
///
/// 为什么值得专门做一步：这事不检查的话，用户是在**推送被拒之后**才知道的——
/// 而那时提交已经在历史里了，得回去改历史才能救。提交前问一句便宜得多。
pub fn oversized_files(repo: &Path, paths: &[String]) -> Vec<String> {
    let big: Vec<String> = paths
        .iter()
        .filter(|p| std::fs::metadata(repo.join(p)).is_ok_and(|m| m.len() > GITHUB_FILE_LIMIT))
        .cloned()
        .collect();
    if big.is_empty() {
        return big;
    }

    crate::ops::files_not_tracked_by_lfs(repo, &big).unwrap_or(big)
}

/// 仓库里的 PR 模板（`.github/PULL_REQUEST_TEMPLATE.md` 那一套）。
///
/// 在网页上开 PR 时是 GitHub 自己把模板填进正文的，**走 API 建 PR 不会**。
/// 我们是走 API 的，不读这份模板的话，从 GitCub 开出来的 PR 就少了维护者
/// 指望看到的那几栏。
///
/// 查找位置照 GitHub 的约定：根目录 / `.github/` / `docs/`，
/// 文件名大小写两种、带不带 `.md` 两种。
pub fn pr_template(repo: &Path) -> Option<String> {
    const DIRS: [&str; 3] = ["", ".github", "docs"];
    const NAMES: [&str; 4] =
        ["PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "PULL_REQUEST_TEMPLATE", "pull_request_template"];
    for dir in DIRS {
        for name in NAMES {
            let p = if dir.is_empty() { repo.join(name) } else { repo.join(dir).join(name) };
            if let Ok(text) = std::fs::read_to_string(&p)
                && !text.trim().is_empty()
            {
                return Some(text);
            }
        }
    }
    None
}

#[cfg(test)]
mod pr_template_tests {
    use super::*;

    #[test]
    fn 三个位置都找得到() {
        for dir in ["", ".github", "docs"] {
            let d = tempfile::tempdir().unwrap();
            let r = d.path();
            let target = if dir.is_empty() { r.to_path_buf() } else { r.join(dir) };
            std::fs::create_dir_all(&target).unwrap();
            std::fs::write(target.join("PULL_REQUEST_TEMPLATE.md"), "## 改了什么\n").unwrap();
            assert_eq!(pr_template(r).as_deref(), Some("## 改了什么\n"), "位置: {dir:?}");
        }
    }

    #[test]
    fn 小写文件名也认() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".github")).unwrap();
        std::fs::write(d.path().join(".github/pull_request_template.md"), "正文\n").unwrap();
        assert_eq!(pr_template(d.path()).as_deref(), Some("正文\n"));
    }

    #[test]
    fn 没有模板时是_none() {
        let d = tempfile::tempdir().unwrap();
        assert!(pr_template(d.path()).is_none());
    }

    #[test]
    fn 空模板当作没有() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("PULL_REQUEST_TEMPLATE.md"), "\n  \n").unwrap();
        assert!(pr_template(d.path()).is_none());
    }
}

/// Resolve a bundle identifier through Launch Services without launching it.
pub fn application_path(bundle_identifier: &str) -> Result<Option<String>, String> {
    if bundle_identifier != "com.github.githubapp" {
        return Err("Unsupported bundle identifier".into());
    }
    #[cfg(target_os = "macos")]
    {
        let result = Command::new("/usr/bin/osascript")
            .args(["-e", "POSIX path of (path to application id \"com.github.githubapp\")"])
            .output()
            .map_err(|e| e.to_string())?;
        if result.status.success() {
            return Ok(Some(String::from_utf8_lossy(&result.stdout).trim_end().into()));
        }
    }
    Ok(None)
}
