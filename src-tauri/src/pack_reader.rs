//! 按 git `packfile.c` 的 `unpack_entry` + delta base cache 读包里的对象：
//! 解 delta 链时链上每一级的结果都放进按包内偏移索引的缓存，下一次读同一条链上的
//! 其他版本只需在最近的缓存基上应用剩下几级 delta。gix 只缓存最终请求的对象、
//! 不缓存链底的完整对象，按历史逐版读 blame 用到的树和 blob 时会反复解压同一个基。
//!
//! 只读 `objects/pack/*.idx` 对应的包；读不到（松散对象、跨包的 REF_DELTA、数据损坏）
//! 时返回 `None`，调用方改用 gix 读，内容一样，只是慢。

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

use gix::objs::Kind;
use gix::odb::pack;

/// 每个读取器的缓存上限（git `core.deltaBaseCacheLimit` 默认 96MiB，是整个进程一份；
/// 这里每个线程一份，取小一些）
const CACHE_LIMIT: usize = 16 * 1024 * 1024;

/// 一个仓库的全部包，多个线程共用（只读、mmap）
pub(crate) struct Packs {
    bundles: Vec<pack::Bundle>,
}

impl Packs {
    /// 本库和 `objects/info/alternates` 借用的对象库（`git clone --shared`／`--reference`）里的包。
    /// 同一个对象名在哪个包里内容都一样，读不到的照常交给 gix。
    pub(crate) fn open(repo: &gix::Repository) -> Packs {
        let hash = repo.object_hash();
        let mut bundles = Vec::new();
        for objects in object_directories(&repo.common_dir().join("objects")) {
            let Ok(entries) = std::fs::read_dir(objects.join("pack")) else { continue };
            let mut paths: Vec<_> = entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|ext| ext == "idx"))
                .collect();
            paths.sort();
            bundles.extend(paths.iter().filter_map(|path| open_bundle(path, hash)));
        }
        Packs { bundles }
    }
}

/// 对象库及其 alternates（odb.c `link_alt_odb_entries`：每行一个路径，相对路径相对于所在的对象库，
/// `#` 开头和空行跳过，最多嵌套 5 层）。带引号的行不展开，那些对象照常由 gix 读。
fn object_directories(objects: &Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![objects.to_path_buf()];
    let mut next = 0;
    let mut depth = vec![0];
    while next < out.len() {
        let (current, level) = (out[next].clone(), depth[next]);
        next += 1;
        if level >= 5 {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(current.join("info").join("alternates")) else { continue };
        for line in content.lines() {
            if line.is_empty() || line.starts_with('#') || line.starts_with('"') {
                continue;
            }
            let path = current.join(line);
            let Ok(path) = std::fs::canonicalize(path) else { continue };
            if !out.iter().any(|seen| std::fs::canonicalize(seen).is_ok_and(|seen| seen == path)) {
                out.push(path);
                depth.push(level + 1);
            }
        }
    }
    out
}

fn open_bundle(path: &Path, hash: gix::hash::Kind) -> Option<pack::Bundle> {
    pack::Bundle::at(path, hash).ok()
}

type Key = (usize, u64);

pub(crate) struct PackReader {
    packs: Arc<Packs>,
    inflate: gix::zlib::Inflate,
    cache: HashMap<Key, (Kind, Arc<Vec<u8>>, u64)>,
    /// 最近使用的序号 → 键，最小的先淘汰
    order: BTreeMap<u64, Key>,
    stamp: u64,
    used: usize,
}

impl PackReader {
    pub(crate) fn new(packs: Arc<Packs>) -> PackReader {
        PackReader {
            packs,
            inflate: gix::zlib::Inflate::default(),
            cache: HashMap::new(),
            order: BTreeMap::new(),
            stamp: 0,
            used: 0,
        }
    }

    /// 包里这个对象的类型和内容；不在包里或读不了时 `None`。
    pub(crate) fn object(&mut self, id: &gix::oid) -> Option<(Kind, Arc<Vec<u8>>)> {
        let packs = self.packs.clone();
        for (number, bundle) in packs.bundles.iter().enumerate() {
            if let Some(index) = bundle.index.lookup(id) {
                return self.at(&bundle.pack, &bundle.index, number, bundle.index.pack_offset_at_index(index));
            }
        }
        None
    }

    fn touch(&mut self, key: Key) -> Option<(Kind, Arc<Vec<u8>>)> {
        let (kind, data, stamp) = self.cache.get_mut(&key)?;
        self.order.remove(stamp);
        self.stamp += 1;
        *stamp = self.stamp;
        self.order.insert(self.stamp, key);
        Some((*kind, data.clone()))
    }

    fn put(&mut self, key: Key, kind: Kind, data: Arc<Vec<u8>>) {
        if data.len() > CACHE_LIMIT / 4 || self.cache.contains_key(&key) {
            return;
        }
        self.used += data.len();
        self.stamp += 1;
        self.order.insert(self.stamp, key);
        self.cache.insert(key, (kind, data, self.stamp));
        while self.used > CACHE_LIMIT {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            if let Some((_, data, _)) = self.cache.remove(&oldest) {
                self.used -= data.len();
            }
        }
    }

    fn decompress(&mut self, file: &pack::data::File, entry: &pack::data::Entry) -> Option<Vec<u8>> {
        let size = usize::try_from(entry.decompressed_size).ok()?;
        let mut out = vec![0; size];
        file.decompress_entry(entry, &mut self.inflate, &mut out).ok()?;
        Some(out)
    }

    fn at(
        &mut self, file: &pack::data::File, index: &pack::index::File, number: usize, offset: u64,
    ) -> Option<(Kind, Arc<Vec<u8>>)> {
        use pack::data::entry::Header;
        // 从要读的对象往下找到第一个缓存命中或完整对象
        let mut chain = Vec::new();
        let mut cursor = offset;
        let (kind, mut data) = loop {
            if let Some(hit) = self.touch((number, cursor)) {
                break hit;
            }
            let entry = file.entry(cursor).ok()?;
            match entry.header {
                Header::OfsDelta { base_distance } => {
                    let base = entry.checked_base_pack_offset(base_distance)?;
                    chain.push(entry);
                    cursor = base;
                }
                Header::RefDelta { base_id } => {
                    let base = index.pack_offset_at_index(index.lookup(base_id)?);
                    chain.push(entry);
                    cursor = base;
                }
                header => {
                    let kind = header.as_kind()?;
                    let data = Arc::new(self.decompress(file, &entry)?);
                    self.put((number, cursor), kind, data.clone());
                    break (kind, data);
                }
            }
            // 防环：链长超过包里对象数一定是坏数据
            if chain.len() > index.num_objects() as usize {
                return None;
            }
        };
        for entry in chain.iter().rev() {
            let delta = self.decompress(file, entry)?;
            let result = Arc::new(apply_delta(&data, &delta)?);
            self.put((number, entry.pack_offset()), kind, result.clone());
            data = result;
        }
        Some((kind, data))
    }
}

/// git `patch-delta.c`：两段变长整数（源长、目标长），然后是复制／插入指令。
fn apply_delta(base: &[u8], delta: &[u8]) -> Option<Vec<u8>> {
    fn varint(data: &[u8], pos: &mut usize) -> Option<usize> {
        let mut value = 0usize;
        let mut shift = 0;
        loop {
            let byte = *data.get(*pos)?;
            *pos += 1;
            value |= usize::from(byte & 0x7f).checked_shl(shift)?;
            shift += 7;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
    }
    let mut pos = 0;
    if varint(delta, &mut pos)? != base.len() {
        return None;
    }
    let size = varint(delta, &mut pos)?;
    let mut out = Vec::with_capacity(size);
    while pos < delta.len() {
        let op = delta[pos];
        pos += 1;
        if op & 0x80 != 0 {
            let mut offset = 0usize;
            let mut length = 0usize;
            for bit in 0..4 {
                if op & (1 << bit) != 0 {
                    offset |= usize::from(*delta.get(pos)?) << (8 * bit);
                    pos += 1;
                }
            }
            for bit in 0..3 {
                if op & (0x10 << bit) != 0 {
                    length |= usize::from(*delta.get(pos)?) << (8 * bit);
                    pos += 1;
                }
            }
            if length == 0 {
                length = 0x10000;
            }
            let end = offset.checked_add(length)?;
            if end > base.len() || out.len() + length > size {
                return None;
            }
            out.extend_from_slice(&base[offset..end]);
        } else if op != 0 {
            let length = usize::from(op);
            let end = pos.checked_add(length)?;
            if end > delta.len() || out.len() + length > size {
                return None;
            }
            out.extend_from_slice(&delta[pos..end]);
            pos = end;
        } else {
            return None;
        }
    }
    (out.len() == size).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        // 不受全局配置影响：别的会话可能正在改它
        let out = Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).expect("utf8")
    }

    /// 每个对象都要从包里读到，内容和 gix 读的一样。
    fn check_all(root: &Path) -> usize {
        let repo = gix::open(root).expect("open");
        let mut reader = PackReader::new(Arc::new(Packs::open(&repo)));
        let mut checked = 0;
        for line in git(root, &["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).lines() {
            let id = gix::ObjectId::from_hex(line.as_bytes()).expect("hex");
            let Some((kind, data)) = reader.object(&id) else {
                // 不在包里的只能是松散对象
                let hex = id.to_string();
                assert!(
                    repo.common_dir().join("objects").join(&hex[..2]).join(&hex[2..]).is_file(),
                    "{id} 不在包里也不是松散对象"
                );
                continue;
            };
            let object = repo.find_object(id).expect("gix");
            assert_eq!(kind, object.kind, "{id}");
            assert_eq!(data.as_slice(), &object.data[..], "{id}");
            checked += 1;
        }
        checked
    }

    #[test]
    fn 深delta链与gix读到的一致() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.name", "T"]);
        git(root, &["config", "user.email", "t@example.com"]);
        let mut content = String::new();
        for round in 0..120 {
            // 每轮加一行，偶尔删掉开头几行，让 delta 既有复制也有插入
            content.push_str(&format!("line {round} {}\n", "x".repeat(round % 7)));
            if round % 17 == 0 {
                content = content.lines().skip(3).map(|line| format!("{line}\n")).collect();
            }
            std::fs::write(root.join("a.txt"), &content).unwrap();
            std::fs::write(root.join(format!("f{}.txt", round % 5)), format!("{round}\n{content}")).unwrap();
            git(root, &["add", "-A"]);
            git(root, &["commit", "-q", "-m", &format!("r{round}")]);
        }
        git(root, &["repack", "-a", "-d", "-f", "-q", "--depth=100", "--window=250"]);
        assert!(check_all(root) > 300);
        // 再打一个增量包，对象分在两个包里
        std::fs::write(root.join("a.txt"), format!("{content}tail\n")).unwrap();
        git(root, &["commit", "-q", "-am", "tail"]);
        git(root, &["repack", "-d", "-q"]);
        assert!(check_all(root) > 300);
    }

    /// 真实仓库的全部对象（只读）：`GITCUB_BLAME_REPOS=/a:/b cargo test --release -- --ignored 真实仓库全部对象`
    #[test]
    #[ignore]
    fn 真实仓库全部对象与gix读到的一致() {
        for repo in std::env::var("GITCUB_BLAME_REPOS").unwrap_or_default().split(':').filter(|p| !p.is_empty()) {
            let checked = check_all(Path::new(repo));
            eprintln!("{repo}: {checked} objects identical");
        }
    }

    #[test]
    fn 坏的delta不读() {
        // 复制 [0, 3)
        assert_eq!(apply_delta(b"abc", &[3, 3, 0x91, 0, 3]), Some(b"abc".to_vec()));
        // 复制 [1, 3) 再插入 xyz
        let delta = [3, 5, 0x91, 1, 2, 3, b'x', b'y', b'z'];
        assert_eq!(apply_delta(b"abc", &delta), Some(b"bcxyz".to_vec()));
        // 源长不符、复制越界、0 指令、插入被截断、结果长度不符
        assert_eq!(apply_delta(b"abc", &[4, 3, 0x91, 0, 3]), None);
        assert_eq!(apply_delta(b"abc", &[3, 4, 0x91, 0, 4]), None);
        assert_eq!(apply_delta(b"abc", &[3, 1, 0]), None);
        assert_eq!(apply_delta(b"abc", &delta[..8]), None);
        assert_eq!(apply_delta(b"abc", &[3, 6, 0x91, 1, 2, 3, b'x', b'y', b'z']), None);
    }
}
