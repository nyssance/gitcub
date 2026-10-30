//! commit-graph 里的 changed-path Bloom 过滤器（`BIDX`/`BDAT` 两个 chunk），照 git v2.54.0
//! `commit-graph.c`（加载、分层、校验）与 `bloom.c`（murmur3 键、`get_bloom_filter`、`bloom_filter_contains`）。
//!
//! blame 用它实现 `maybe_changed_path`：子提交和第一父提交比较同一路径之前，先问这个提交的过滤器；
//! 所有键都「肯定不在」时 git 直接当作没变，不做树比较。过滤器没有假阴性时这只省时间；
//! 但 git 照样信任来自别的实现或别的平台的过滤器（版本 1 的哈希按平台 `char` 的符号扩展，
//! 带高位字节的路径在 `char` 无符号的平台上写出的过滤器在这里可能假阴性），所以这里一比一照
//! git 的读取规则：同样的文件、同样的层、同样的版本判断、同样的哈希，得到同样的「跳过」。
//!
//! `Err` 表示「交给 git」：git 会报错或走到这里没实现的分支（文件损坏、分层链不完整、
//! 只在 alternates 里有 commit-graph、`GIT_TEST_COMMIT_GRAPH` 之类）。

use gix::ObjectId;
use std::path::Path;

type Fallback = String;

const SIGNATURE: &[u8; 4] = b"CGPH";
const HEADER_SIZE: usize = 8;
const TOC_ENTRY_SIZE: usize = 12;
const FANOUT_SIZE: usize = 256 * 4;
const BLOOM_HEADER_SIZE: usize = 12;
const OVERFLOW: u32 = 1 << 31;

/// 一个 commit-graph 文件（单文件或分层链里的一层）
struct Layer {
    data: Vec<u8>,
    /// `BASE` chunk 里基础层的个数
    bases: u32,
    oid_lookup: usize,
    commit_data: usize,
    /// `GDA2`；分层链里有一层没有时全部不读（`validate_mixed_generation_chain`）
    generation_data: Option<usize>,
    /// `GDO2` 的起点与长度
    generation_overflow: Option<(usize, usize)>,
    bloom: Option<LayerBloom>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct BloomSettings {
    hash_version: u32,
    num_hashes: u32,
    bits_per_entry: u32,
}

#[derive(Clone, Copy)]
struct LayerBloom {
    indexes: usize,
    data: usize,
    data_size: usize,
    settings: BloomSettings,
}

/// 一个路径的 `bloom_key`：`num_hashes` 个位置的哈希
pub(crate) struct Key(Vec<u32>);

/// 仓库的 commit-graph 与 blame 用的过滤器设置（`get_bloom_filter_settings`）
pub(crate) struct ChangedPaths {
    /// 最上层在前（git 的 `g->base_graph` 顺序）
    layers: Vec<Layer>,
    settings: BloomSettings,
    /// `commitGraph.changedPathsVersion`（-1 表示认文件里的版本）
    version: i64,
    hash_len: usize,
}

fn be32(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(data[at..at + 4].try_into().expect("4 bytes"))
}

fn be64(data: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(data[at..at + 8].try_into().expect("8 bytes"))
}

/// git `git_config_int` 能接受的十进制整数（不带单位后缀；带后缀或写错的交给 git）
fn config_int(config: &crate::raw_diff::in_process::Config, key: &str) -> Result<Option<i64>, Fallback> {
    let Some(value) = config.string(key) else { return Ok(None) };
    let text = std::str::from_utf8(value.as_ref()).map_err(|_| format!("{key} 不是整数"))?;
    text.trim().parse::<i32>().map(|v| Some(i64::from(v))).map_err(|_| format!("{key} 不是简单整数"))
}

impl ChangedPaths {
    /// `prepare_commit_graph` + `get_bloom_filter_settings`：没有可用的过滤器时 `Ok(None)`。
    /// 浅克隆、移植、替换对象在调用前已经让位（`commit_graph_compatible`）。
    pub(crate) fn load(
        repo: &gix::Repository, config: &crate::raw_diff::in_process::Config,
    ) -> Result<Option<ChangedPaths>, Fallback> {
        for key in ["GIT_TEST_COMMIT_GRAPH", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] {
            if std::env::var_os(key).is_some() {
                return Err(key.into());
            }
        }
        // repo-settings.c
        if !config.boolean("core.commitGraph")?.unwrap_or(true) {
            return Ok(None);
        }
        let generation_version = config_int(config, "commitGraph.generationVersion")?.unwrap_or(2);
        let read_changed_paths = config.boolean("commitGraph.readChangedPaths")?.unwrap_or(true);
        let version =
            config_int(config, "commitGraph.changedPathsVersion")?.unwrap_or(if read_changed_paths { -1 } else { 0 });
        let hash_len = repo.object_hash().len_in_bytes();
        let hash_version = match repo.object_hash() {
            gix::hash::Kind::Sha1 => 1,
            #[allow(unreachable_patterns)]
            _ => return Err("非 SHA-1 仓库".into()),
        };
        let info = repo.common_dir().join("objects").join("info");
        let mut layers = match std::fs::read(info.join("commit-graph")) {
            Ok(data) => vec![parse(data, hash_len, hash_version, generation_version, version)?],
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                load_chain(&info.join("commit-graphs"), hash_len, hash_version, generation_version, version)?
            }
            Err(error) => return Err(error.to_string()),
        };
        if layers.is_empty() {
            // 第一个有 commit-graph 的对象库生效：本库没有时 git 会去 alternates 里找
            match std::fs::read(info.join("alternates")) {
                Ok(content) if content.iter().any(|b| !b.is_ascii_whitespace()) => {
                    return Err("commit-graph 可能在 alternates 里".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            return Ok(None);
        }
        if layers.len() == 1 && layers[0].bases != 0 {
            return Err("单文件 commit-graph 带基础层".into());
        }
        // validate_mixed_generation_chain
        if layers.iter().any(|layer| layer.generation_data.is_none()) {
            for layer in &mut layers {
                layer.generation_data = None;
            }
        }
        // validate_mixed_bloom_settings：从最上层往下，和第一个带过滤器的层设置不同的层停用
        let mut settings = None;
        for layer in &mut layers {
            let Some(bloom) = layer.bloom else { continue };
            match settings {
                None => settings = Some(bloom.settings),
                Some(first) if first != bloom.settings => layer.bloom = None,
                Some(_) => {}
            }
        }
        let Some(settings) = settings else { return Ok(None) };
        if settings.num_hashes > 64 {
            return Err("过滤器哈希个数异常".into());
        }
        Ok(Some(ChangedPaths { layers, settings, version, hash_len }))
    }

    /// `bloom_key_fill`，用 `get_bloom_filter_settings` 的设置
    pub(crate) fn key(&self, path: &[u8]) -> Key {
        const SEED0: u32 = 0x293a_e76f;
        const SEED1: u32 = 0x7e64_6e2c;
        let v2 = self.settings.hash_version == 2;
        let hash0 = murmur3_seeded(SEED0, path, v2);
        let hash1 = murmur3_seeded(SEED1, path, v2);
        Key((0..self.settings.num_hashes).map(|i| hash0.wrapping_add(i.wrapping_mul(hash1))).collect())
    }

    /// 这个提交在哪一层、层内第几个（`search_commit_pos_in_graph`：从最上层往下找）
    fn position(&self, id: &gix::oid) -> Option<(usize, u32)> {
        let raw = id.as_bytes();
        for (index, layer) in self.layers.iter().enumerate() {
            let fanout = |byte: usize| be32(&layer.data, layer.oid_lookup - FANOUT_SIZE + 4 * byte);
            let first = usize::from(raw[0]);
            let (mut lo, mut hi) = (if first == 0 { 0 } else { fanout(first - 1) }, fanout(first));
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                let at = layer.oid_lookup + mid as usize * self.hash_len;
                match layer.data[at..at + self.hash_len].cmp(raw) {
                    std::cmp::Ordering::Equal => return Some((index, mid)),
                    std::cmp::Ordering::Less => lo = mid + 1,
                    std::cmp::Ordering::Greater => hi = mid,
                }
            }
        }
        None
    }

    /// `commit_graph_generation(c) != GENERATION_NUMBER_INFINITY`（`fill_commit_graph_info` 填的值不为 0）
    fn has_generation(&self, layer: &Layer, lex: u32) -> Result<bool, Fallback> {
        let at = layer.commit_data + lex as usize * (self.hash_len + 16) + self.hash_len + 8;
        let word = be32(&layer.data, at);
        let Some(generation_data) = layer.generation_data else { return Ok(word >> 2 != 0) };
        let date = (u64::from(word & 0x3) << 32) | u64::from(be32(&layer.data, at + 4));
        let offset = be32(&layer.data, generation_data + 4 * lex as usize);
        if offset & OVERFLOW == 0 {
            return Ok(date + u64::from(offset) != 0);
        }
        // git 在这两种情况下 die
        let (start, size) = layer.generation_overflow.ok_or("缺 GDO2")?;
        let index = (offset ^ OVERFLOW) as usize;
        if size / 8 <= index {
            return Err("GDO2 太短".into());
        }
        Ok(date.wrapping_add(be64(&layer.data, start + 8 * index)) != 0)
    }

    /// blame.c `maybe_changed_path`：`false` 表示过滤器说这些路径在这个提交（对第一父提交）里都没变。
    pub(crate) fn maybe_changed(&self, commit: &gix::oid, keys: &[Key]) -> Result<bool, Fallback> {
        let Some((index, lex)) = self.position(commit) else { return Ok(true) };
        let layer = &self.layers[index];
        if !self.has_generation(layer, lex)? {
            return Ok(true);
        }
        // load_bloom_filter_from_graph
        let Some(bloom) = layer.bloom else { return Ok(true) };
        let lex = lex as usize;
        let end = be32(&layer.data, bloom.indexes + 4 * lex) as usize;
        let start = if lex > 0 { be32(&layer.data, bloom.indexes + 4 * (lex - 1)) as usize } else { 0 };
        let limit = bloom.data_size - BLOOM_HEADER_SIZE;
        if end > limit || start > limit || end < start {
            return Ok(true);
        }
        // get_or_compute_bloom_filter 不认长度 0；get_bloom_filter 只认配置的版本
        if end == start || !(self.version == -1 || self.version == i64::from(bloom.settings.hash_version)) {
            return Ok(true);
        }
        let filter = &layer.data[bloom.data + BLOOM_HEADER_SIZE + start..bloom.data + BLOOM_HEADER_SIZE + end];
        let bits = filter.len() as u64 * 8;
        Ok(keys.iter().any(|key| {
            key.0.iter().all(|hash| {
                let bit = u64::from(*hash) % bits;
                filter[(bit / 8) as usize] & (1 << (bit % 8)) != 0
            })
        }))
    }
}

/// `murmur3_seeded_v1` / `_v2`：版本 1 把字节当平台的 `char`（有符号时高位字节符号扩展）
fn murmur3_seeded(mut seed: u32, data: &[u8], v2: bool) -> u32 {
    const C1: u32 = 0xcc9e_2d51;
    const C2: u32 = 0x1b87_3593;
    let byte = |b: u8| if v2 { u32::from(b) } else { b as std::ffi::c_char as u32 };
    let (chunks, tail) = data.as_chunks::<4>();
    for chunk in chunks {
        let mut k = byte(chunk[0]) | byte(chunk[1]) << 8 | byte(chunk[2]) << 16 | byte(chunk[3]) << 24;
        k = k.wrapping_mul(C1).rotate_left(15).wrapping_mul(C2);
        seed ^= k;
        seed = seed.rotate_left(13).wrapping_mul(5).wrapping_add(0xe654_6b64);
    }
    if !tail.is_empty() {
        let mut k1 = 0u32;
        if tail.len() == 3 {
            k1 ^= byte(tail[2]) << 16;
        }
        if tail.len() >= 2 {
            k1 ^= byte(tail[1]) << 8;
        }
        k1 ^= byte(tail[0]);
        k1 = k1.wrapping_mul(C1).rotate_left(15).wrapping_mul(C2);
        seed ^= k1;
    }
    seed ^= data.len() as u32;
    seed ^= seed >> 16;
    seed = seed.wrapping_mul(0x85eb_ca6b);
    seed ^= seed >> 13;
    seed = seed.wrapping_mul(0xc2b2_ae35);
    seed ^= seed >> 16;
    seed
}

/// `load_commit_graph_chain_fd_st`：链文件每行一层（最底层在前），每层文件的 `BASE` 必须与前面各层对上；
/// 对不上、缺文件时 git 只用前面那几层并警告，这里交给 git。返回最上层在前。
fn load_chain(
    dir: &Path, hash_len: usize, hash_version: u8, generation_version: i64, version: i64,
) -> Result<Vec<Layer>, Fallback> {
    let chain = match std::fs::read(dir.join("commit-graph-chain")) {
        Ok(chain) => chain,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let hex_len = hash_len * 2;
    if chain.is_empty() || chain.len() % (hex_len + 1) != 0 {
        return Err("commit-graph-chain 长度不对".into());
    }
    let mut ids: Vec<ObjectId> = Vec::new();
    let mut layers: Vec<Layer> = Vec::new();
    for line in chain.chunks(hex_len + 1) {
        if line[hex_len] != b'\n' {
            return Err("commit-graph-chain 格式不对".into());
        }
        let id = ObjectId::from_hex(&line[..hex_len]).map_err(|_| "commit-graph-chain 不是对象名")?;
        let name = format!("graph-{id}.graph");
        let data = std::fs::read(dir.join(name)).map_err(|e| format!("commit-graph 层: {e}"))?;
        let layer = parse(data, hash_len, hash_version, generation_version, version)?;
        // add_graph_to_chain
        if layer.bases as usize != ids.len() {
            return Err("commit-graph 层的 BASE 不对".into());
        }
        let bases = layer.base_ids(hash_len);
        if bases.len() < ids.len() || bases.iter().zip(&ids).any(|(base, id)| *base != id.as_bytes()) {
            return Err("commit-graph 链对不上".into());
        }
        // 层内 id 由文件末尾的校验和给出
        let trailer = &layer.data[layer.data.len() - hash_len..];
        if trailer != id.as_bytes() {
            return Err("commit-graph 层名与校验和不符".into());
        }
        ids.push(id);
        layers.push(layer);
    }
    layers.reverse();
    Ok(layers)
}

impl Layer {
    /// `BASE` chunk 里的对象名
    fn base_ids(&self, hash_len: usize) -> Vec<&[u8]> {
        match find_chunk(&self.data, *b"BASE", hash_len) {
            Some((start, size)) => self.data[start..start + size / hash_len * hash_len].chunks(hash_len).collect(),
            None => Vec::new(),
        }
    }
}

/// 读目录表：(id, 起点, 长度)。照 chunk-format.c `read_table_of_contents` 的校验，不合规就交给 git。
fn chunks(data: &[u8], hash_len: usize) -> Result<Vec<([u8; 4], usize, usize)>, Fallback> {
    let count = usize::from(data[6]);
    if data.len() < HEADER_SIZE + (count + 1) * TOC_ENTRY_SIZE + FANOUT_SIZE + hash_len {
        return Err("commit-graph 太小".into());
    }
    let mut out: Vec<([u8; 4], usize, usize)> = Vec::with_capacity(count);
    for i in 0..count {
        let at = HEADER_SIZE + i * TOC_ENTRY_SIZE;
        let id: [u8; 4] = data[at..at + 4].try_into().expect("4 bytes");
        let offset = be64(data, at + 4);
        let next = be64(data, at + TOC_ENTRY_SIZE + 4);
        if id == [0; 4] || next < offset || next > (data.len() - hash_len) as u64 {
            return Err("commit-graph 目录表损坏".into());
        }
        if out.iter().any(|(seen, _, _)| *seen == id) {
            return Err("commit-graph chunk 重复".into());
        }
        out.push((id, offset as usize, (next - offset) as usize));
    }
    let end = HEADER_SIZE + count * TOC_ENTRY_SIZE;
    if data[end..end + 4] != [0; 4] {
        return Err("commit-graph 目录表没有结束项".into());
    }
    Ok(out)
}

fn find_chunk(data: &[u8], id: [u8; 4], hash_len: usize) -> Option<(usize, usize)> {
    chunks(data, hash_len).ok()?.into_iter().find(|(seen, _, _)| *seen == id).map(|(_, start, size)| (start, size))
}

/// `parse_commit_graph`
fn parse(
    data: Vec<u8>, hash_len: usize, hash_version: u8, generation_version: i64, version: i64,
) -> Result<Layer, Fallback> {
    if data.len() < HEADER_SIZE + 4 * TOC_ENTRY_SIZE + FANOUT_SIZE + hash_len {
        return Err("commit-graph 太小".into());
    }
    if &data[..4] != SIGNATURE || data[4] != 1 || data[5] != hash_version {
        return Err("commit-graph 头部不对".into());
    }
    let table = chunks(&data, hash_len)?;
    let chunk = |id: &[u8; 4]| table.iter().find(|(seen, _, _)| seen == id).map(|&(_, start, size)| (start, size));
    let (fanout, fanout_size) = chunk(b"OIDF").ok_or("缺 OIDF")?;
    if fanout_size != FANOUT_SIZE {
        return Err("OIDF 长度不对".into());
    }
    let num_commits = be32(&data, fanout + FANOUT_SIZE - 4);
    if (0..255).any(|i| be32(&data, fanout + 4 * i) > be32(&data, fanout + 4 * (i + 1))) {
        return Err("OIDF 不是递增".into());
    }
    let (oid_lookup, lookup_size) = chunk(b"OIDL").ok_or("缺 OIDL")?;
    if lookup_size / hash_len != num_commits as usize {
        return Err("OIDL 长度不对".into());
    }
    // position() 按 OIDL 前面紧挨着 OIDF 读扇出表
    if fanout + FANOUT_SIZE != oid_lookup {
        return Err("OIDF 与 OIDL 不相邻".into());
    }
    let (commit_data, commit_size) = chunk(b"CDAT").ok_or("缺 CDAT")?;
    if commit_size / (hash_len + 16) != num_commits as usize {
        return Err("CDAT 长度不对".into());
    }
    let mut generation_data = None;
    let mut generation_overflow = None;
    if generation_version >= 2 {
        if let Some((start, size)) = chunk(b"GDA2")
            && size / 4 == num_commits as usize
        {
            generation_data = Some(start);
        }
        generation_overflow = chunk(b"GDO2");
    }
    let mut bloom = None;
    if version != 0
        && let (Some((indexes, index_size)), Some((bloom_data, data_size))) = (chunk(b"BIDX"), chunk(b"BDAT"))
        && index_size / 4 == num_commits as usize
        && data_size >= BLOOM_HEADER_SIZE
    {
        bloom = Some(LayerBloom {
            indexes,
            data: bloom_data,
            data_size,
            settings: BloomSettings {
                hash_version: be32(&data, bloom_data),
                num_hashes: be32(&data, bloom_data + 4),
                bits_per_entry: be32(&data, bloom_data + 8),
            },
        });
    }
    let bases = match chunk(b"BASE") {
        Some((_, size)) => (size / hash_len) as u32,
        None => 0,
    };
    Ok(Layer { data, bases, oid_lookup, commit_data, generation_data, generation_overflow, bloom })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(hash_version: u32) -> ChangedPaths {
        ChangedPaths {
            layers: Vec::new(),
            settings: BloomSettings { hash_version, num_hashes: 7, bits_per_entry: 10 },
            version: -1,
            hash_len: 20,
        }
    }

    /// 一个键放进 `(bits_per_entry + 7) / 8` 字节的过滤器（test-bloom.c `generate_filter`）
    fn filter(key: &Key) -> Vec<u8> {
        let mut data = vec![0u8; 2];
        for hash in &key.0 {
            let bit = u64::from(*hash) % 16;
            data[(bit / 8) as usize] |= 1 << (bit % 8);
        }
        data
    }

    /// t0095-bloom.sh 的期望值
    #[test]
    fn murmur3_与键与_git_的测试向量一致() {
        assert_eq!(murmur3_seeded(0, b"", true), 0x0000_0000);
        assert_eq!(murmur3_seeded(0, b"Hello world!", true), 0x627b_0c2c);
        assert_eq!(murmur3_seeded(0, b"The quick brown fox jumps over the lazy dog", true), 0x2e4f_f723);
        assert_eq!(murmur3_seeded(0, b"\x99\xaa\xbb\xcc\xdd\xee\xff", true), 0xa183_ccfd);
        let v1 = settings(1);
        let key = v1.key(b"");
        assert_eq!(key.0, [0x5615800c, 0x5b966560, 0x61174ab4, 0x66983008, 0x6c19155c, 0x7199fab0, 0x771ae004]);
        assert_eq!(filter(&key), [0x11, 0x11]);
        assert_eq!(filter(&v1.key(b" ")), [0x51, 0x55]);
        assert_eq!(v1.key(b"Hello world!").0[0], 0xb270de9b);
        assert_eq!(filter(&v1.key(b"Hello world!")), [0x92, 0x6c]);
        assert_eq!(filter(&v1.key(b"file.txt")), [0xa5, 0x4a]);
    }

    /// t4216-log-bloom.sh：只改了「¢」的根提交，版本 1 的过滤器是 52a9（`char` 有符号的平台）、版本 2 是 c01f
    #[test]
    fn 高位字节路径的两个版本() {
        let cent = "¢".as_bytes();
        assert_eq!(filter(&settings(2).key(cent)), [0xc0, 0x1f]);
        let v1 = filter(&settings(1).key(cent));
        if std::ffi::c_char::MIN != 0 {
            assert_eq!(v1, [0x52, 0xa9])
        } else {
            assert_eq!(v1, [0xc0, 0x1f])
        }
        // 没有高位字节时两个版本相同
        assert_eq!(murmur3_seeded(7, b"Hello world!", false), murmur3_seeded(7, b"Hello world!", true));
    }
}
