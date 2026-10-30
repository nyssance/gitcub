//! 图片的 diff —— 拿两版图片本身给界面，而不是一句「二进制文件」。
//!
//! 改图标、改设计稿、改截图的人天天要看这个。原版专门做了一块
//! （ModifiedImageDiff：并排 / 滑动 / 洋葱皮 / 差值 四种看法），
//! 这里把两侧的字节给出去，怎么摆由界面决定。

use base64::Engine as _;
use serde::Serialize;
use std::path::Path;

/// 超过这个大小就不往 webview 里塞了。base64 还会再撑大三分之一，
/// 几十兆的图塞进去只会把界面卡死——那种情况老老实实说「二进制文件」。
const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// 认得出的图片扩展名 → media type。照原版 imageFileExtensions 那张表。
fn media_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    Some(match ext.as_str() {
        "png" | "apng" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "dds" => "image/vnd-ms.dds",
        _ => return None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSide {
    /// base64 的文件内容，界面拼成 data: URL 直接喂给 <img>
    pub data: String,
    pub media_type: String,
    /// 原始字节数（界面上要显示「大了多少」）
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDiff {
    /// 改动前那一版。新增的文件没有
    pub previous: Option<ImageSide>,
    /// 改动后那一版。删掉的文件没有
    pub current: Option<ImageSide>,
}

fn encode(bytes: Vec<u8>, media: &str) -> Option<ImageSide> {
    let len = bytes.len() as u64;
    if len == 0 || len > MAX_BYTES {
        return None;
    }
    Some(ImageSide {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        media_type: media.to_string(),
        bytes: len,
    })
}

/// 某个 rev 下这个文件的原始字节。文件在那一版不存在就返回 None。
///
/// 必须走 `cat-file blob` 拿原始字节：`git show` 那条路我们封装成了 String，
/// 图片一过 UTF-8 有损转换就全毁了。
fn at_rev(repo: &Path, rev: &str, file: &str) -> Option<Vec<u8>> {
    crate::raw_diff::blob_contents(repo, rev, file).ok()
}

pub fn working_image(repo: &Path, file: &str) -> Result<Option<ImageSide>, String> {
    let media = media_type(file).ok_or("这个扩展名不是图片")?;
    Ok(std::fs::read(repo.join(file)).ok().and_then(|data| encode(data, media)))
}

pub fn blob_image(repo: &Path, file: &str, revision: &str) -> Result<Option<ImageSide>, String> {
    let media = media_type(file).ok_or("这个扩展名不是图片")?;
    Ok(at_rev(repo, revision, file).and_then(|data| encode(data, media)))
}

/// 两版图片。`sha` 给了就是看某次提交（和它的父比），
/// 没给就是看工作区（和 HEAD 比）。
pub fn image_diff(repo: &Path, file: &str, sha: Option<&str>) -> Result<ImageDiff, String> {
    let (previous, current) = match sha {
        Some(sha) => (blob_image(repo, file, &format!("{sha}^"))?, blob_image(repo, file, sha)?),
        None => (blob_image(repo, file, "HEAD")?, working_image(repo, file)?),
    };
    Ok(ImageDiff { previous, current })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_repo::git;

    /// 最小的合法 PNG（1x1，透明）
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D,
        0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        (d, r)
    }

    #[test]
    fn 认扩展名() {
        assert_eq!(media_type("a/b/图标.PNG"), Some("image/png"));
        assert_eq!(media_type("x.jpeg"), Some("image/jpeg"));
        assert_eq!(media_type("x.svg"), Some("image/svg+xml"));
        assert_eq!(media_type("x.txt"), None);
        assert_eq!(media_type("没有扩展名"), None);
    }

    #[test]
    fn 改了的图片两版都拿得到() {
        let (_d, r) = repo();
        std::fs::write(r.join("i.png"), PNG).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "加图"]);
        // 改一版：同样是 PNG，多几个字节
        let mut bigger = PNG.to_vec();
        bigger.extend_from_slice(&[0, 0, 0, 0]);
        std::fs::write(r.join("i.png"), &bigger).unwrap();

        let d = image_diff(&r, "i.png", None).unwrap();
        let p = d.previous.expect("改动前那一版");
        let c = d.current.expect("改动后那一版");
        assert_eq!(p.bytes, PNG.len() as u64);
        assert_eq!(c.bytes, bigger.len() as u64);
        assert_eq!(p.media_type, "image/png");
        assert_ne!(p.data, c.data, "两版内容应该不一样");
    }

    #[test]
    fn 新增的图片没有前一版() {
        let (_d, r) = repo();
        std::fs::write(r.join("x.txt"), "先有个提交\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "init"]);
        std::fs::write(r.join("新.png"), PNG).unwrap();

        let d = image_diff(&r, "新.png", None).unwrap();
        assert!(d.previous.is_none(), "新增的不该有前一版");
        assert!(d.current.is_some());
    }

    #[test]
    fn 删掉的图片没有后一版() {
        let (_d, r) = repo();
        std::fs::write(r.join("i.png"), PNG).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "加图"]);
        std::fs::remove_file(r.join("i.png")).unwrap();

        let d = image_diff(&r, "i.png", None).unwrap();
        assert!(d.previous.is_some());
        assert!(d.current.is_none(), "删了就不该有后一版");
    }

    #[test]
    fn 看某次提交时和它的父比() {
        let (_d, r) = repo();
        std::fs::write(r.join("i.png"), PNG).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "加图"]);
        let mut bigger = PNG.to_vec();
        bigger.push(0);
        std::fs::write(r.join("i.png"), &bigger).unwrap();
        git(&r, &["commit", "-qam", "改图"]);
        let sha = git(&r, &["rev-parse", "HEAD"]).trim().to_string();

        let d = image_diff(&r, "i.png", Some(&sha)).unwrap();
        assert_eq!(d.previous.unwrap().bytes, PNG.len() as u64);
        assert_eq!(d.current.unwrap().bytes, bigger.len() as u64);
    }
}
