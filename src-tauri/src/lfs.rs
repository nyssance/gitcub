//! Git LFS 的状态检查与安装。
//!
//! 不做 LFS 本身的事（那是 git-lfs 的活），只管一件会把人坑惨的：**仓库用了
//! LFS，但这台机器上的过滤器没装**。那种情况下检出来的大文件全是几行指针
//! （`version https://git-lfs...`），看着像文件坏了，而且直接提交回去会把
//! 指针当内容覆盖掉。原版是在仓库加进来时弹窗问要不要装，我们挂一条提示条。

use crate::git::Git;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsState {
    /// 这个仓库有 LFS 规则
    pub used: bool,
    /// 这台机器上有 git-lfs
    pub available: bool,
    /// 这个仓库已经装过过滤器了
    pub installed: bool,
}

/// 仓库里有没有 LFS 规则。
///
/// 直接读 `.gitattributes` 而不是跑 `git lfs track`：后者要求 git-lfs 已经装了，
/// 而我们恰恰要在**没装**的时候也能判断出「这个仓库需要它」。
/// 规则也可能写在子目录的 .gitattributes 里，但根目录那份覆盖了绝大多数情况。
fn uses_lfs(repo: &Path) -> bool {
    let files = [repo.join(".gitattributes"), repo.join(".git").join("info").join("attributes")];
    files.iter().any(|p| {
        std::fs::read_to_string(p)
            .is_ok_and(|s| s.lines().filter(|l| !l.trim_start().starts_with('#')).any(|l| l.contains("filter=lfs")))
    })
}

/// LFS 过滤器对这个仓库生效没有。
///
/// 判据是 `filter.lfs.smudge` 这条配置——`git lfs install` 干的就是写它。
/// 注意问的是**生效的**配置（全局的也算）：`git lfs install` 默认写的就是
/// 全局配置，装过一次之后所有仓库都被覆盖，这是大多数人的状态。
/// 真正会出事的是「机器上有 git-lfs 但从没 install 过」——那时检出来
/// 全是指针文件。
fn installed(repo: &Path) -> bool {
    !Git::new(Some(repo)).args(["config", "--get", "filter.lfs.smudge"]).stdout_or_empty().trim().is_empty()
}

/// 机器上有没有 git-lfs。装上之后不会在应用运行期间消失，所以只缓存「有」；
/// 「没有」每次重查，用户中途装上后无需重启。
fn available() -> bool {
    static FOUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if FOUND.load(std::sync::atomic::Ordering::Relaxed) {
        return true;
    }
    let found = Git::new(None).args(["lfs", "version"]).stdout().is_ok();
    FOUND.store(found, std::sync::atomic::Ordering::Relaxed);
    found
}

/// `git var GIT_ATTR_SYSTEM`：系统级属性文件的位置取决于 git 的编译前缀，只问一次。
pub(crate) fn system_attributes() -> Option<std::path::PathBuf> {
    static PATH: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        Git::new(None).args(["var", "GIT_ATTR_SYSTEM"]).stdout().ok().map(|path| path.trim_end().into())
    })
    .clone()
}

/// `git lfs track --json` 能报告的规则只可能来自这些文件：工作区里已跟踪和未忽略的
/// `.gitattributes`（git-lfs 用 `ls-files --cached --others --exclude-standard` 找它们并读工作区内容）、
/// `info/attributes`、全局和系统属性文件。它们都不含 `lfs` 时 git-lfs 一定报告「没有」，
/// 不必起 git-lfs 和它内部的十来个 git 进程。返回 `true` 只表示「需要问 git-lfs」。
fn may_use_lfs(repo: &Path) -> Result<bool, String> {
    let repo = gix::open(repo).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("bare repository")?.to_path_buf();
    let index = repo.index_or_empty().map_err(|e| e.to_string())?;
    if index.is_sparse() {
        return Err("sparse index".into());
    }
    let is_attributes = |path: &[u8]| path == b".gitattributes" || path.ends_with(b"/.gitattributes");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in index.entries() {
        let path = entry.path(&index);
        if is_attributes(path) {
            files.push(workdir.join(gix::path::from_bstr(path).map_err(|e| e.to_string())?));
        }
    }
    let options = repo
        .dirwalk_options()
        .map_err(|e| e.to_string())?
        .emit_untracked(gix::dir::walk::EmissionMode::Matching)
        .emit_ignored(None)
        .emit_tracked(false);
    let mut collect = gix::dir::walk::delegate::Collect::default();
    let interrupt = std::sync::atomic::AtomicBool::new(false);
    // 非 glob 的 pathspec 里 `*` 可以跨目录，等于「任何以 .gitattributes 结尾的路径」。
    repo.dirwalk(&index, ["*.gitattributes"], &interrupt, options, &mut collect).map_err(|e| e.to_string())?;
    for (entry, _) in collect.unorded_entries {
        if is_attributes(&entry.rela_path) {
            files.push(workdir.join(gix::path::from_bstr(&entry.rela_path).map_err(|e| e.to_string())?));
        }
    }
    files.push(repo.common_dir().join("info").join("attributes"));
    let config = repo.config_snapshot();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    if let Some(path) = config.string("core.attributesFile") {
        let path = gix::path::from_bstr(path.as_ref() as &gix::bstr::BStr).map_err(|e| e.to_string())?.into_owned();
        match (path.strip_prefix("~"), &home) {
            (Ok(rest), Some(home)) => files.push(home.join(rest)),
            _ => files.push(path),
        }
    }
    match std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        Some(xdg) => files.push(std::path::PathBuf::from(xdg).join("git").join("attributes")),
        None => files.extend(home.map(|home| home.join(".config").join("git").join("attributes"))),
    }
    files.push(system_attributes().ok_or("git var GIT_ATTR_SYSTEM failed")?);
    for file in files {
        match std::fs::read(&file) {
            Ok(content) if content.windows(3).any(|window| window.eq_ignore_ascii_case(b"lfs")) => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", file.display())),
        }
    }
    Ok(false)
}

pub fn state(repo: &Path) -> LfsState {
    if matches!(may_use_lfs(repo), Ok(false)) {
        return LfsState { used: false, available: false, installed: false };
    }
    let available = available();
    let used = if available { crate::ops::using_lfs(repo).unwrap_or_else(|_| uses_lfs(repo)) } else { uses_lfs(repo) };
    LfsState {
        used,
        // 没用 LFS 的仓库不必为了填这两个字段去起进程
        available: used && available,
        installed: used && installed(repo),
    }
}

/// 给这个仓库装上 LFS 过滤器。
///
/// 先按常规来：`git lfs install` 会把过滤器写进**全局**配置、钩子写进本仓库，
/// 一次解决所有仓库（原版也是这条）。但仓库自己的配置能盖住全局的，真遇到
/// 这种（比如别人给的仓库里把 filter.lfs.smudge 显式置空了），再补一次
/// `--local` 写进本仓库——那份谁也盖不住。
pub fn install(repo: &Path) -> Result<(), String> {
    Git::new(Some(repo)).args(["lfs", "install"]).run()?;
    if installed(repo) {
        return Ok(());
    }
    Git::new(Some(repo)).args(["lfs", "install", "--local"]).run()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_repo::git;

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        (d, r)
    }

    /// 预检查给出「没有」时，git-lfs 也必须说没有；每种布局都和 `git lfs track --json` 对照。
    #[test]
    fn 预检查与_git_lfs_track_一致() {
        if !available() {
            return;
        }
        let (_d, r) = repo();
        let write = |path: &str, content: &str| {
            let path = r.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        };
        let check = |label: &str| {
            let truth = crate::ops::using_lfs(&r).unwrap();
            let may = may_use_lfs(&r).unwrap();
            assert!(may || !truth, "{label}: pre-check said no but git-lfs tracks patterns");
            assert_eq!(state(&r).used, truth, "{label}");
            may
        };
        assert!(!check("empty repository"));
        write("a.txt", "1\n");
        write(".gitattributes", "*.txt text\n");
        git(&r, &["add", "."]);
        assert!(!check("attributes without lfs"));
        write("assets/.gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n");
        assert!(check("untracked nested attributes"));
        git(&r, &["add", "."]);
        assert!(check("tracked nested attributes"));
        std::fs::remove_file(r.join("assets/.gitattributes")).unwrap();
        check("tracked attributes deleted from the worktree");
        git(&r, &["add", "-A"]);
        write(".gitignore", "build/\n");
        write("build/.gitattributes", "*.bin filter=lfs -text\n");
        assert!(!check("attributes inside an ignored directory"));
        write(".git/info/attributes", "*.zip filter=lfs\n");
        assert!(check("info/attributes"));
        std::fs::remove_file(r.join(".git/info/attributes")).unwrap();
        write("docs/.gitattributes", "# lfs is not used here\n");
        assert!(check("lfs only in a comment"));
        assert!(!state(&r).used);
    }

    #[test]
    fn 普通仓库不认为用了_lfs() {
        let (_d, r) = repo();
        assert!(!state(&r).used);
        std::fs::write(r.join(".gitattributes"), "*.txt text\n").unwrap();
        assert!(!state(&r).used, "普通的 attributes 不算");
    }

    #[test]
    fn 有_lfs_规则时认得出来() {
        let (_d, r) = repo();
        std::fs::write(
            r.join(".gitattributes"),
            "# 注释里提 filter=lfs 不算\n*.psd filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        assert!(state(&r).used);
    }

    #[test]
    fn 注释里的规则不算数() {
        let (_d, r) = repo();
        std::fs::write(r.join(".gitattributes"), "# *.psd filter=lfs diff=lfs\n").unwrap();
        assert!(!state(&r).used);
    }

    /// 装完之后过滤器要对这个仓库生效。
    ///
    /// 不断言「装之前一定没生效」：`git lfs install` 默认写全局配置，
    /// 开发机上多半早就装过了，那条断言只会在别人机器上随机失败。
    #[test]
    fn 装过之后过滤器生效() {
        if !available() {
            return; // 这台机器没有 git-lfs，跳过
        }
        let (_d, r) = repo();
        std::fs::write(r.join(".gitattributes"), "*.psd filter=lfs\n").unwrap();
        install(&r).unwrap();
        assert!(state(&r).installed);
    }

    /// 仓库自己的配置把全局那份盖住了（filter.lfs.smudge 被显式置空）。
    /// 这时只写全局是没用的，得补一次 --local。
    #[test]
    fn 本仓库配置盖住全局时也能装上() {
        if !available() {
            return;
        }
        let (_d, r) = repo();
        std::fs::write(r.join(".gitattributes"), "*.psd filter=lfs\n").unwrap();
        git(&r, &["config", "--local", "filter.lfs.smudge", ""]);
        assert!(!state(&r).installed, "置空之后应当算没生效");

        install(&r).unwrap();
        assert!(state(&r).installed, "补了 --local 之后该生效");
    }

    /// 没有 LFS 规则的仓库不该为了填字段去起 git 进程
    #[test]
    fn 不用_lfs_时其余字段都是假() {
        let (_d, r) = repo();
        let s = state(&r);
        assert!(!s.used && !s.available && !s.installed);
    }
}
