//! Desktop progress/git.ts, clone.ts and lfs.ts contracts for native operations.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
pub struct Step {
    pub title: String,
    pub weight: f64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parser {
    steps: Vec<Step>,
    step_index: usize,
    last_percent: f64,
}
#[derive(Serialize)]
pub struct Info {
    pub title: String,
    pub value: u64,
    pub total: Option<u64>,
    pub percent: Option<u64>,
    pub done: bool,
    pub text: String,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Progress {
    Progress { percent: f64, details: Info },
    Context { percent: f64, text: String },
}

pub fn parse(line: &str) -> Option<Info> {
    let (title, text) = line.rsplit_once(": ")?;
    if title.is_empty() {
        return None;
    }
    let mut parts = text.trim().split(", ");
    let numbers = parts.next()?;
    let (value, total, percent) = if numbers.bytes().all(|byte| byte.is_ascii_digit()) {
        (numbers.parse().ok()?, None, None)
    } else {
        let (percent, ratio) = numbers.split_once("% (")?;
        if percent.is_empty() || percent.len() > 3 || !percent.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let (value, total) = ratio.strip_suffix(')')?.split_once('/')?;
        if !value.bytes().chain(total.bytes()).all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        (value.parse().ok()?, Some(total.parse().ok()?), Some(percent.parse().ok()?))
    };
    Some(Info {
        title: title.into(),
        value,
        total,
        percent,
        done: parts.any(|part| part == "done."),
        text: line.into(),
    })
}

fn strip_controls(line: &str) -> String {
    let mut output = String::new();
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' || (ch == '\x1b' && chars.next() == Some('\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else {
            output.push(ch);
        }
    }
    output
}

impl Parser {
    pub fn new(steps: Vec<Step>) -> Result<Self, String> {
        if steps.is_empty() {
            return Err("must specify at least one step".into());
        }
        let total: f64 = steps.iter().map(|step| step.weight).sum();
        Ok(Self {
            steps: steps.into_iter().map(|step| Step { title: step.title, weight: step.weight / total }).collect(),
            step_index: 0,
            last_percent: 0.0,
        })
    }
    fn with_steps(steps: &[(&str, f64)]) -> Self {
        Self::new(steps.iter().map(|(title, weight)| Step { title: (*title).into(), weight: *weight }).collect())
            .expect("progress steps are nonempty")
    }
    /// Desktop progress/clone.ts
    pub fn clone_parser() -> Self {
        Self::with_steps(&[
            ("remote: Compressing objects", 0.1),
            ("Receiving objects", 0.6),
            ("Resolving deltas", 0.1),
            ("Checking out files", 0.2),
        ])
    }
    /// Desktop progress/push.ts
    pub fn push_parser() -> Self {
        Self::with_steps(&[("Compressing objects", 0.2), ("Writing objects", 0.7), ("remote: Resolving deltas", 0.1)])
    }
    /// Desktop progress/fetch.ts
    pub fn fetch_parser() -> Self {
        Self::with_steps(&[("remote: Compressing objects", 0.1), ("Receiving objects", 0.7), ("Resolving deltas", 0.2)])
    }
    /// Desktop progress/pull.ts
    pub fn pull_parser() -> Self {
        Self::with_steps(&[
            ("remote: Compressing objects", 0.1),
            ("Receiving objects", 0.7),
            ("Resolving deltas", 0.15),
            ("Checking out files", 0.15),
        ])
    }
    pub fn parse(&mut self, line: &str) -> Progress {
        let text = strip_controls(line);
        if let Some(details) = parse(&text) {
            let mut percent = 0.0;
            for (index, step) in self.steps.iter().enumerate() {
                if index >= self.step_index && details.title == step.title {
                    if let Some(total) = details.total.filter(|total| *total != 0) {
                        percent += step.weight * (details.value as f64 / total as f64);
                    }
                    self.step_index = index;
                    self.last_percent = percent;
                    return Progress::Progress { percent, details };
                }
                percent += step.weight;
            }
        }
        Progress::Context { percent: self.last_percent, text }
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct LfsParser {
    files: BTreeMap<String, (u64, u64)>,
}
impl LfsParser {
    pub fn parse(&mut self, line: &str) -> Progress {
        let parsed = (|| {
            let mut parts = line.splitn(4, char::is_whitespace);
            let direction = parts.next()?;
            let (current, files) = parts.next()?.split_once('/')?;
            let _ = current.parse::<u64>().ok()?;
            let count = files.parse::<u64>().ok()?;
            let (transferred, total) = parts.next()?.split_once('/')?;
            let transferred = transferred.parse::<u64>().ok()?;
            let size = total.parse::<u64>().ok()?;
            let name = parts.next()?;
            if name.is_empty() {
                return None;
            }
            Some((direction, count, transferred, size, name))
        })();
        let Some((direction, count, transferred, size, name)) = parsed else {
            return Progress::Context { percent: 0.0, text: line.into() };
        };
        self.files.insert(name.into(), (transferred, size));
        let total_transferred: u64 = self.files.values().map(|file| file.0).sum();
        let total_size: u64 = self.files.values().map(|file| file.1).sum();
        let finished = self.files.values().filter(|file| file.0 == file.1).count();
        let count = count.max(self.files.len() as u64);
        let verb = match direction {
            "upload" => "Uploading",
            "checkout" => "Checking out",
            _ => "Downloading",
        };
        Progress::Progress {
            percent: 0.0,
            details: Info {
                title: format!("{verb} \"{name}\""),
                value: total_transferred,
                total: Some(total_size),
                percent: Some(0),
                done: false,
                text: format!(
                    "{verb} {name} ({finished} out of an estimated {count} completed, {} / {})",
                    bytes(total_transferred),
                    bytes(total_size)
                ),
            },
        }
    }
}
fn bytes(value: u64) -> String {
    const UNITS: [&str; 7] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
    let index =
        if value < 1024 { 0 } else { ((value as f64).ln() / 1024f64.ln()).floor() as usize }.min(UNITS.len() - 1);
    let number = (value as f64 / 1024f64.powi(index as i32) * 10.0).round() / 10.0;
    format!("{number} {}", UNITS[index])
}

#[allow(dead_code)] // Non-streaming entry point used by the upstream conformance bridge.
pub fn clone_progress(stderr: &[u8]) -> Vec<Progress> {
    let mut parser = Parser::clone_parser();
    String::from_utf8_lossy(stderr)
        .split(['\r', '\n'])
        .filter(|line| !line.is_empty())
        .map(|line| parser.parse(line))
        .collect()
}

/// Decode complete CR/LF progress records without losing split UTF-8 chunks.
/// Desktop from-process.ts createProgressProcessCallback：把 stderr 按 \r / \n 切成行交给解析器
pub struct ProgressStream<F: FnMut(Progress)> {
    parser: Parser,
    pending: Vec<u8>,
    emit: F,
}
impl<F: FnMut(Progress)> ProgressStream<F> {
    pub fn new(parser: Parser, emit: F) -> Self {
        Self { parser, pending: Vec::new(), emit }
    }
    pub fn push(&mut self, chunk: crate::git::TerminalChunk) {
        if !matches!(chunk.stream, crate::git::TerminalStream::Stderr) {
            return;
        }
        for byte in chunk.bytes {
            if matches!(byte, b'\r' | b'\n') {
                self.finish();
            } else {
                self.pending.push(byte);
                if self.pending.len() >= 65536 {
                    self.finish();
                }
            }
        }
    }
    pub fn finish(&mut self) {
        if !self.pending.is_empty() {
            (self.emit)(self.parser.parse(&String::from_utf8_lossy(&self.pending)));
            self.pending.clear();
        }
    }
}
