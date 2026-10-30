//! GitLens git-cli/indexParser.ts 的 NUL 分隔索引解析；用于真实冲突解析与解决。
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct Revision {
    pub mode: String,
    pub oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<&'static str>,
}
#[derive(Debug, Clone, Serialize)]
pub struct IndexFile {
    #[serde(flatten)]
    pub revision: Revision,
    pub path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub repo_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Revision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<Revision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incoming: Option<Revision>,
    pub status: &'static str,
    pub conflict_status: &'static str,
}
fn version(stage: Option<i32>) -> Option<&'static str> {
    match stage {
        Some(0) => Some("normal"),
        Some(1) => Some("base"),
        Some(2) => Some("current"),
        Some(3) => Some("incoming"),
        _ => None,
    }
}
fn records(data: Option<&str>) -> impl Iterator<Item = (&str, &str, Option<i32>, &str)> {
    data.unwrap_or("").split('\0').filter_map(|line| {
        let (metadata, path) = line.split_once('\t')?;
        let (mode, rest) = metadata.split_once(' ')?;
        let (oid, stage) = rest.split_once(' ')?;
        // JavaScript parseInt 接受前导空白、符号和后面的非数字尾缀。
        let stage = stage.trim_start();
        let end = stage
            .char_indices()
            .find(|(i, c)| !c.is_ascii_digit() && !(*i == 0 && (*c == '+' || *c == '-')))
            .map_or(stage.len(), |(i, _)| i);
        let parsed = match stage[..end].parse::<i32>() {
            Ok(value) => Some(value),
            Err(error)
                if matches!(
                    error.kind(),
                    std::num::IntErrorKind::PosOverflow | std::num::IntErrorKind::NegOverflow
                ) =>
            {
                Some(4)
            }
            Err(_) => None,
        };
        Some((mode, oid, parsed, path))
    })
}
pub fn staged(data: Option<&str>) -> Vec<IndexFile> {
    records(data)
        .map(|(mode, oid, stage, path)| IndexFile {
            path: path.into(),
            revision: Revision { mode: mode.into(), oid: oid.into(), version: version(stage.or(Some(0))) },
        })
        .collect()
}
pub fn conflicts(data: Option<&str>, repo: &str) -> Vec<ConflictFile> {
    let mut files: Vec<ConflictFile> = Vec::new();
    let mut positions = HashMap::new();
    for (mode, oid, stage, path) in records(data) {
        let index = *positions.entry(path).or_insert_with(|| {
            files.push(ConflictFile {
                path: path.into(),
                repo_path: repo.into(),
                base: None,
                current: None,
                incoming: None,
                status: "DD",
                conflict_status: "DD",
            });
            files.len() - 1
        });
        let file = &mut files[index];
        let revision = Some(Revision { mode: mode.into(), oid: oid.into(), version: version(stage) });
        match stage {
            Some(1) => file.base = revision,
            Some(2) => file.current = revision,
            Some(3) => file.incoming = revision,
            _ => {}
        }
    }
    for file in &mut files {
        let pattern = (u8::from(file.base.is_some()) << 2)
            | (u8::from(file.current.is_some()) << 1)
            | u8::from(file.incoming.is_some());
        file.status = match pattern {
            1 => "UA",
            2 => "AU",
            3 => "AA",
            5 => "DU",
            6 => "UD",
            7 => "UU",
            _ => "DD",
        };
        file.conflict_status = file.status;
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 无效阶段与超大数值阶段保持不同语义() {
        for (stage, expected) in [
            ("bad", Some("normal")),
            ("+", Some("normal")),
            ("  +2tail", Some("current")),
            ("999999999999999999999", None),
            ("-99999999999999999999", None),
        ] {
            let input = format!("100644 abc {stage}\twith\nnewline\0");
            let parsed = staged(Some(&input));
            assert_eq!(parsed[0].revision.version, expected);
            assert_eq!(parsed[0].path, "with\nnewline");
        }
    }
}
