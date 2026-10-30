//! git v2.54.0 diffcore-rename 的逐行移植（`diffcore-rename.c`、`diffcore-delta.c`），
//! 供提交文件列表（Desktop `getChangedFiles` 的 `git log -C -M -m -1 --first-parent --raw --numstat -z`）
//! 和历史里选中重命名文件的 diff 在进程内作答。
//!
//! 只移植 `-C -M` 实际走到的那条路径：diff.c 里 `-M` 在 `-C` 之后解析，把 `detect_rename` 改回
//! `DIFF_DETECT_RENAME`，所以 Desktop 这条命令只做重命名、不做复制（`C` 状态不会出现）；没有 `-B`、
//! 没有 `relevant_sources` / `dirs_removed`（`idx_possible_rename` 总是 -1）。保留的步骤：
//!
//! 1. 目标是新增、来源是删除（`rename_empty` 默认开，空文件也参加）；
//! 2. `find_exact_renames`：按对象 id 精确配对，候选按 git 哈希表的链表顺序遍历（插入逆序、扩容时反转），
//!    同名优先、最多看 100 个；
//! 3. `find_basename_matches`：来源和目标里各自唯一的文件名两两比较，门槛
//!    `minimum_score + 0.5 × (MAX_SCORE − minimum_score)`；
//! 4. `too_many_rename_candidates`：剩下的目标数 × 来源数超过 `rename_limit²`（默认 1000）时 git 会放弃
//!    模糊检测并警告——这里让位；
//! 5. 相似度矩阵：每个目标保留 4 个最好的候选（`record_if_better`），全部稳定排序后贪心配对。
//!
//! 相似度照 `estimate_similarity`：只比普通文件，大小差太多直接 0 分，否则用 `hash_chars` 的 spanhash
//! （按换行或 64 字节切块、文本里 CRLF 的 CR 不算）数出来源被复制到目标的字节数。
//! 文本与否取决于 `diff` 属性和 `buffer_is_binary`，所以要算 spanhash 的路径都先做属性检查，
//! 带 `diff`/`binary` 等属性就让位。

use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

/// diffcore.h
pub(crate) const MAX_SCORE: u64 = 60000;
pub(crate) const DEFAULT_RENAME_SCORE: u64 = 30000;
/// diff.c `diff_rename_limit_default`
const DEFAULT_RENAME_LIMIT: u64 = 1000;
/// diffcore-delta.c
const HASHBASE: u32 = 107927;
/// diffcore-rename.c
const NUM_CANDIDATE_PER_DST: usize = 4;
/// 需要读内容时，超过这个大小交给 git（和 raw_diff 的快速路径相同）
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
/// diff.c `buffer_is_binary`
const FIRST_FEW_BYTES: usize = 8000;

type Fallback = String;

/// 对一个路径检查会改变转换、二进制判定或驱动的属性（见 `raw_diff::in_process::attribute_checker`）
pub(crate) type AttributeCheck<'r> = Box<dyn FnMut(&BStr) -> Result<(), Fallback> + 'r>;

/// 树里的一侧：规范化后的模式和对象 id
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Side {
    pub mode: u32,
    pub id: ObjectId,
}

/// 递归树差异里的一条（diff_queue 里的 filepair）：`one` 缺省是新增，`two` 缺省是删除
#[derive(Clone, Debug)]
pub(crate) struct Change {
    pub path: BString,
    pub one: Option<Side>,
    pub two: Option<Side>,
}

/// diffcore 处理后的一条输出
#[derive(Clone, Debug)]
pub(crate) struct Pair {
    /// 重命名时是来源路径，否则与 `path` 相同
    pub one_path: BString,
    pub path: BString,
    pub one: Option<Side>,
    pub two: Option<Side>,
    /// 只有重命名带分数（`p->score`）
    pub score: u64,
    pub status: u8,
}

fn is_reg(mode: u32) -> bool {
    mode & 0o170000 == 0o100000
}

/// diff.c `similarity_index`
pub(crate) fn similarity_index(score: u64) -> u64 {
    score * 100 / MAX_SCORE
}

pub(crate) fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(FIRST_FEW_BYTES)].contains(&0)
}

/// diffcore-delta.c `hash_chars`：按 hashval 升序、同值合并的 (hashval, 字节数)
pub(crate) fn spanhash(data: &[u8], is_text: bool) -> Vec<(u32, u32)> {
    let mut spans: Vec<(u32, u32)> = Vec::new();
    let (mut n, mut accum1, mut accum2) = (0u32, 0u32, 0u32);
    let mut i = 0;
    while i < data.len() {
        let c = data[i] as u32;
        i += 1;
        let old_1 = accum1;
        // Ignore CR in CRLF sequence if text
        if is_text && c == b'\r' as u32 && i < data.len() && data[i] == b'\n' {
            continue;
        }
        accum1 = (accum1 << 7) ^ (accum2 >> 25);
        accum2 = (accum2 << 7) ^ (old_1 >> 25);
        accum1 = accum1.wrapping_add(c);
        n += 1;
        if n < 64 && c != b'\n' as u32 {
            continue;
        }
        spans.push((accum1.wrapping_add(accum2.wrapping_mul(0x61)) % HASHBASE, n));
        n = 0;
        accum1 = 0;
        accum2 = 0;
    }
    if n > 0 {
        spans.push((accum1.wrapping_add(accum2.wrapping_mul(0x61)) % HASHBASE, n));
    }
    spans.sort_unstable_by_key(|(hash, _)| *hash);
    let mut merged: Vec<(u32, u32)> = Vec::with_capacity(spans.len());
    for (hash, cnt) in spans {
        match merged.last_mut() {
            Some(last) if last.0 == hash => last.1 += cnt,
            _ => merged.push((hash, cnt)),
        }
    }
    merged
}

/// diffcore-delta.c `diffcore_count_changes` 的 `src_copied`
pub(crate) fn src_copied(src: &[(u32, u32)], dst: &[(u32, u32)]) -> u64 {
    let (mut sc, mut d) = (0u64, 0usize);
    for &(hash, src_cnt) in src {
        while d < dst.len() && dst[d].0 < hash {
            d += 1;
        }
        let mut dst_cnt = 0;
        if d < dst.len() && dst[d].0 == hash {
            dst_cnt = dst[d].1;
            d += 1;
        }
        sc += u64::from(src_cnt.min(dst_cnt));
    }
    sc
}

/// 相似度计算要的 blob 信息：大小只读对象头，spanhash 按对象缓存（文本与否只看内容，路径的属性先检查过）
pub(crate) trait Blobs {
    fn size(&mut self, id: &ObjectId) -> Result<u64, Fallback>;
    fn spans(&mut self, path: &BStr, id: &ObjectId) -> Result<Rc<Vec<(u32, u32)>>, Fallback>;
}

/// diffcore-rename.c `estimate_similarity`
fn estimate_similarity(
    blobs: &mut impl Blobs, src_path: &BStr, src: Side, dst_path: &BStr, dst: Side, minimum_score: u64,
) -> Result<u64, Fallback> {
    if !is_reg(src.mode) || !is_reg(dst.mode) {
        return Ok(0);
    }
    let (src_size, dst_size) = (blobs.size(&src.id)?, blobs.size(&dst.id)?);
    let max_size = src_size.max(dst_size);
    let base_size = src_size.min(dst_size);
    let delta_size = max_size - base_size;
    if max_size * (MAX_SCORE - minimum_score) < delta_size * MAX_SCORE {
        return Ok(0);
    }
    let src_count = blobs.spans(src_path, &src.id)?;
    let dst_count = blobs.spans(dst_path, &dst.id)?;
    let copied = src_copied(&src_count, &dst_count);
    if dst_size == 0 {
        return Ok(0);
    }
    Ok(copied * MAX_SCORE / max_size)
}

/// `estimate_similarity` 用于两个内容已在内存里、都是非二进制普通文件的情形（`commit_file_diff` 的一对一）
pub(crate) fn text_similarity(src: &[u8], dst: &[u8], minimum_score: u64) -> u64 {
    let (src_size, dst_size) = (src.len() as u64, dst.len() as u64);
    let max_size = src_size.max(dst_size);
    let delta_size = max_size - src_size.min(dst_size);
    if max_size * (MAX_SCORE - minimum_score) < delta_size * MAX_SCORE || dst_size == 0 {
        return 0;
    }
    src_copied(&spanhash(src, !is_binary(src)), &spanhash(dst, !is_binary(dst))) * MAX_SCORE / max_size
}

/// diffcore-rename.c `basename_same`
fn basename_same(src: &[u8], dst: &[u8]) -> bool {
    let (mut src_len, mut dst_len) = (src.len(), dst.len());
    while src_len > 0 && dst_len > 0 {
        src_len -= 1;
        dst_len -= 1;
        let (c1, c2) = (src[src_len], dst[dst_len]);
        if c1 != c2 {
            return false;
        }
        if c1 == b'/' {
            return true;
        }
    }
    (src_len == 0 || src[src_len - 1] == b'/') && (dst_len == 0 || dst[dst_len - 1] == b'/')
}

fn get_basename(path: &[u8]) -> &[u8] {
    match path.iter().rposition(|b| *b == b'/') {
        Some(slash) => &path[slash + 1..],
        None => path,
    }
}

#[derive(Clone, Copy)]
struct DiffScore {
    src: usize,
    /// -1 表示空位
    dst: isize,
    score: u64,
    name_score: i64,
}

/// diffcore-rename.c `score_compare`（qsort 比较函数，>0 表示 a 排在后面）
fn score_compare(a: &DiffScore, b: &DiffScore) -> i64 {
    if a.dst < 0 {
        return (0 <= b.dst) as i64;
    } else if b.dst < 0 {
        return -1;
    }
    if a.score == b.score {
        return b.name_score - a.name_score;
    }
    b.score as i64 - a.score as i64
}

/// diffcore-rename.c `record_if_better`
fn record_if_better(m: &mut [DiffScore], o: DiffScore) {
    let mut worst = 0;
    for i in 1..NUM_CANDIDATE_PER_DST {
        if score_compare(&m[i], &m[worst]) > 0 {
            worst = i;
        }
    }
    if score_compare(&m[worst], &o) > 0 {
        m[worst] = o;
    }
}

/// `find_exact_renames` 的来源表：git `hashmap` 的桶链表里，同一对象的来源按什么顺序被遍历。
/// 插入按来源下标逆序、每次插在链表头；`private_size > grow_at` 时扩容 4 倍，`rehash` 逐条头插会把
/// 同一个桶里已有的链表反转（同一对象的条目总在同一个桶里）。
fn exact_candidates(sources: &[(usize, Side)]) -> HashMap<ObjectId, std::collections::VecDeque<usize>> {
    // hashmap.c：HASHMAP_INITIAL_SIZE 64、HASHMAP_RESIZE_BITS 2、HASHMAP_LOAD_FACTOR 80
    let initial = ((sources.len() as u64) * 100 / 80) as u32 as u64;
    let mut size: u64 = 64;
    while initial > size {
        size <<= 2;
    }
    let mut grow_at = (size as u32 as u64) * 80 / 100;
    let mut table: HashMap<ObjectId, std::collections::VecDeque<usize>> = HashMap::new();
    let mut count = 0u64;
    for (index, (_, side)) in sources.iter().enumerate().rev() {
        table.entry(side.id).or_default().push_front(index);
        count += 1;
        if count > grow_at {
            size <<= 2;
            grow_at = (size as u32 as u64) * 80 / 100;
            for chain in table.values_mut() {
                chain.make_contiguous().reverse();
            }
        }
    }
    table
}

/// `diffcore_rename`（`DIFF_DETECT_RENAME`，`rename_score` 默认）：返回每条 `queue` 记录配上的来源下标与分数
/// （只有新增记录会有）。`rename_limit` 是 `diff.renameLimit`，超限时让位。
pub(crate) fn detect_renames(
    queue: &[Change], blobs: &mut impl Blobs, rename_limit: u64,
) -> Result<Vec<Option<(usize, u64)>>, Fallback> {
    let minimum_score = DEFAULT_RENAME_SCORE;
    let mut result: Vec<Option<(usize, u64)>> = vec![None; queue.len()];
    // rename_dst / rename_src：队列下标与那一侧
    let dsts: Vec<(usize, Side)> = queue
        .iter()
        .enumerate()
        .filter_map(|(i, c)| (c.one.is_none()).then_some(()).and(c.two.map(|s| (i, s))))
        .collect();
    let mut srcs: Vec<(usize, Side)> = queue
        .iter()
        .enumerate()
        .filter_map(|(i, c)| (c.two.is_none()).then_some(()).and(c.one.map(|s| (i, s))))
        .collect();
    if dsts.is_empty() || srcs.is_empty() {
        return Ok(result);
    }
    let path = |queue_index: usize| queue[queue_index].path.as_bstr();
    // rename_used 按队列下标记（每个来源一个 filespec）
    let mut used = vec![false; queue.len()];
    // rename_dst[i].is_rename
    let mut matched = vec![false; dsts.len()];
    let record = |result: &mut Vec<Option<(usize, u64)>>,
                  used: &mut Vec<bool>,
                  matched: &mut Vec<bool>,
                  dst: usize,
                  src_queue: usize,
                  score: u64| {
        used[src_queue] = true;
        matched[dst] = true;
        result[dsts[dst].0] = Some((src_queue, score));
    };

    // find_exact_renames
    let table = exact_candidates(&srcs);
    for (dst_index, &(dst_queue, target)) in dsts.iter().enumerate() {
        let Some(chain) = table.get(&target.id) else { continue };
        let (mut best, mut best_score, mut budget) = (None, -1i32, 100);
        for &src_index in chain {
            let (src_queue, source) = srcs[src_index];
            if (!is_reg(source.mode) || !is_reg(target.mode)) && source.mode != target.mode {
                continue;
            }
            if used[src_queue] {
                continue;
            }
            let score = 1 + basename_same(path(src_queue), path(dst_queue)) as i32;
            if score > best_score {
                best = Some(src_queue);
                best_score = score;
                if score == 2 {
                    break;
                }
            }
            budget -= 1;
            if budget == 0 {
                break;
            }
        }
        if let Some(src_queue) = best {
            record(&mut result, &mut used, &mut matched, dst_index, src_queue, MAX_SCORE);
        }
    }

    // remove_unneeded_paths_from_src
    srcs.retain(|(queue_index, _)| !used[*queue_index]);

    // find_basename_matches（GIT_BASENAME_FACTOR 由调用方让位）
    let min_basename_score = minimum_score + (0.5 * (MAX_SCORE - minimum_score) as f64) as u64;
    let mut sources: HashMap<&[u8], isize> = HashMap::new();
    for (i, (queue_index, _)) in srcs.iter().enumerate() {
        let base = get_basename(&queue[*queue_index].path);
        let value = if sources.contains_key(base) { -1 } else { i as isize };
        sources.insert(base, value);
    }
    let mut dests: HashMap<&[u8], isize> = HashMap::new();
    for (i, (queue_index, _)) in dsts.iter().enumerate() {
        if matched[i] {
            continue;
        }
        let base = get_basename(&queue[*queue_index].path);
        let value = if dests.contains_key(base) { -1 } else { i as isize };
        dests.insert(base, value);
    }
    for (i, &(src_queue, one)) in srcs.iter().enumerate() {
        let base = get_basename(&queue[src_queue].path);
        let src_index = sources[base];
        debug_assert!(src_index == -1 || src_index == i as isize);
        let Some(&dst_index) = dests.get(base) else { continue };
        // idx_possible_rename 在没有 dirs_removed / relevant_sources 时总是 -1
        if src_index == -1 || dst_index == -1 {
            continue;
        }
        let dst_index = dst_index as usize;
        if matched[dst_index] {
            continue;
        }
        let (dst_queue, two) = dsts[dst_index];
        let score = estimate_similarity(blobs, path(src_queue), one, path(dst_queue), two, min_basename_score)?;
        if score < min_basename_score {
            continue;
        }
        record(&mut result, &mut used, &mut matched, dst_index, src_queue, score);
    }
    srcs.retain(|(queue_index, _)| !used[*queue_index]);

    let num_destinations = matched.iter().filter(|m| !**m).count() as u64;
    let num_sources = srcs.len() as u64;
    if num_destinations == 0 || num_sources == 0 {
        return Ok(result);
    }
    // too_many_rename_candidates：git 放弃模糊检测并在 stderr 警告
    if rename_limit > 0 && num_destinations * num_sources > rename_limit * rename_limit {
        return Err(format!("重命名候选 {num_destinations}×{num_sources} 超过 diff.renameLimit"));
    }

    let mut mx: Vec<DiffScore> = Vec::with_capacity(num_destinations as usize * NUM_CANDIDATE_PER_DST);
    for (i, &(dst_queue, two)) in dsts.iter().enumerate() {
        if matched[i] {
            continue;
        }
        let start = mx.len();
        mx.extend([DiffScore { src: 0, dst: -1, score: 0, name_score: 0 }; NUM_CANDIDATE_PER_DST]);
        for (j, &(src_queue, one)) in srcs.iter().enumerate() {
            let score = estimate_similarity(blobs, path(src_queue), one, path(dst_queue), two, minimum_score)?;
            let name_score = basename_same(path(src_queue), path(dst_queue)) as i64;
            record_if_better(&mut mx[start..], DiffScore { src: j, dst: i as isize, score, name_score });
        }
    }
    // STABLE_QSORT
    mx.sort_by(|a, b| score_compare(a, b).cmp(&0));
    // find_renames(copies = 0)
    for m in &mx {
        if m.dst < 0 || m.score < minimum_score {
            break;
        }
        let dst_index = m.dst as usize;
        if matched[dst_index] {
            continue;
        }
        let src_queue = srcs[m.src].0;
        if used[src_queue] {
            continue;
        }
        record(&mut result, &mut used, &mut matched, dst_index, src_queue, m.score);
    }
    Ok(result)
}

/// diffcore_rename 的写回（`cleanup:` 段）加 `diff_resolve_rename_copy`：配上的删除记录去掉，
/// 新增记录变成重命名，留在新增的位置。单个来源只用一次，状态总是 `R`。
pub(crate) fn resolve(queue: Vec<Change>, renames: &[Option<(usize, u64)>]) -> Vec<Pair> {
    let used: std::collections::HashSet<usize> = renames.iter().flatten().map(|(src, _)| *src).collect();
    let mut out = Vec::with_capacity(queue.len());
    for (i, change) in queue.iter().enumerate() {
        if change.two.is_none() && used.contains(&i) {
            continue;
        }
        if let Some((src, score)) = renames[i] {
            out.push(Pair {
                one_path: queue[src].path.clone(),
                path: change.path.clone(),
                one: queue[src].one,
                two: change.two,
                score,
                status: b'R',
            });
            continue;
        }
        let status = match (change.one, change.two) {
            (None, _) => b'A',
            (_, None) => b'D',
            (Some(one), Some(two)) if one.mode & 0o170000 != two.mode & 0o170000 => b'T',
            _ => b'M',
        };
        out.push(Pair {
            one_path: change.path.clone(),
            path: change.path.clone(),
            one: change.one,
            two: change.two,
            score: 0,
            status,
        });
    }
    out
}

/// 从对象库读大小和内容；要算 spanhash 的路径先过属性检查
pub(crate) struct RepoBlobs<'r> {
    repo: &'r gix::Repository,
    attributes: Option<AttributeCheck<'r>>,
    sizes: HashMap<ObjectId, u64>,
    spans: HashMap<ObjectId, Rc<Vec<(u32, u32)>>>,
}

impl<'r> RepoBlobs<'r> {
    pub(crate) fn new(repo: &'r gix::Repository) -> Self {
        Self { repo, attributes: None, sizes: HashMap::new(), spans: HashMap::new() }
    }

    /// 用调用方给的属性检查代替默认的那份（默认的对行尾等属性也让位，只读 blob 时不需要）
    pub(crate) fn with_attributes(repo: &'r gix::Repository, attributes: AttributeCheck<'r>) -> Self {
        Self { repo, attributes: Some(attributes), sizes: HashMap::new(), spans: HashMap::new() }
    }
}

impl Blobs for RepoBlobs<'_> {
    fn size(&mut self, id: &ObjectId) -> Result<u64, Fallback> {
        if let Some(size) = self.sizes.get(id) {
            return Ok(*size);
        }
        // 部分克隆缺对象时 git 会去懒加载；这里报错让位
        let size = self.repo.find_header(*id).map_err(|e| e.to_string())?.size();
        self.sizes.insert(*id, size);
        Ok(size)
    }

    fn spans(&mut self, path: &BStr, id: &ObjectId) -> Result<Rc<Vec<(u32, u32)>>, Fallback> {
        if self.attributes.is_none() {
            self.attributes = Some(attribute_checker(self.repo)?);
        }
        (self.attributes.as_mut().expect("刚建好"))(path)?;
        if let Some(spans) = self.spans.get(id) {
            return Ok(spans.clone());
        }
        if self.size(id)? > MAX_FILE_SIZE {
            return Err("文件太大".into());
        }
        let data = self.repo.find_object(*id).map_err(|e| e.to_string())?.detach().data;
        let spans = Rc::new(spanhash(&data, !is_binary(&data)));
        self.spans.insert(*id, spans.clone());
        Ok(spans)
    }
}

#[cfg(unix)]
fn attribute_checker<'r>(repo: &'r gix::Repository) -> Result<AttributeCheck<'r>, Fallback> {
    crate::raw_diff::in_process::attribute_checker(repo)
}

#[cfg(not(unix))]
fn attribute_checker<'r>(_: &'r gix::Repository) -> Result<AttributeCheck<'r>, Fallback> {
    Err("属性检查只在 unix 上实现".into())
}

/// 这些设置出现时让位：`diff.renameLimit` 改变超限判断，`GIT_BASENAME_FACTOR` 改变文件名配对门槛，
/// 其余是 git 会读、可能借 `-c` 改配置的环境变量
#[cfg(unix)]
pub(crate) fn check_rename_settings(repo: &gix::Repository) -> Result<u64, Fallback> {
    crate::raw_diff::in_process::check_rename_settings(repo).map(|()| DEFAULT_RENAME_LIMIT)
}

#[cfg(not(unix))]
pub(crate) fn check_rename_settings(_: &gix::Repository) -> Result<u64, Fallback> {
    Err("重命名检测只在 unix 上实现".into())
}

/// 规范化的模式（git `canon_mode`）
fn canon_mode(mode: gix::object::tree::EntryMode) -> u32 {
    use gix::object::tree::EntryKind;
    match mode.kind() {
        EntryKind::Tree => 0o040000,
        EntryKind::Blob => 0o100644,
        EntryKind::BlobExecutable => 0o100755,
        EntryKind::Link => 0o120000,
        EntryKind::Commit => 0o160000,
    }
}

/// `git log -C -M -m -1 --first-parent <sha>` 的 diff 队列：第一父（根提交为空树）对提交树的递归差异，
/// 按路径排序（等于 git 树遍历的顺序），再做重命名检测。
///
/// 文件与目录互换时 gix 和 git 一样报成一删（文件）一增（目录里的文件），树序里 `x` 排在 `x/…` 前，
/// 照常参与重命名检测。子模块条目以及 `commit_trees_in_process` 让位的情形（浅克隆、移植、替换对象、
/// `log.showRoot=false` 的根提交、`log.diffMerges`）交给 git；需要检测重命名（既有新增又有删除）时，
/// 另外让位 `check_rename_settings` 的设置、超过 rename limit、缺对象、超过 16 MiB 和带属性的路径。
pub(crate) fn commit_pairs(root: &Path, sha: &str) -> Result<(gix::Repository, Vec<Pair>), Fallback> {
    let (repo, old_tree, new_tree) = crate::history::commit_trees_in_process(root, sha, true)?;
    let queue = tree_queue(&repo, old_tree, new_tree, false)?;
    let has_dst = queue.iter().any(|change| change.one.is_none());
    let has_src = queue.iter().any(|change| change.two.is_none());
    let renames = if has_dst && has_src {
        let limit = check_rename_settings(&repo)?;
        detect_renames(&queue, &mut RepoBlobs::new(&repo), limit)?
    } else {
        vec![None; queue.len()]
    };
    let pairs = resolve(queue, &renames);
    Ok((repo, pairs))
}

/// 两棵树（`None` 是空树）的递归差异，按路径排序，即 diffcore 收到的 diff 队列。
///
/// `keep_gitlinks` 为假时任何子模块条目都让位；为真时删除的子模块留在队列里（模式 160000，
/// 重命名检测里它们是来源，只参与文件名唯一性的判断，`estimate_similarity` 给 0 分），
/// 新增与修改的子模块丢掉——它们既不是来源，也不会是普通文件的目标。
pub(crate) fn tree_queue(
    repo: &gix::Repository, old_tree: Option<ObjectId>, new_tree: ObjectId, keep_gitlinks: bool,
) -> Result<Vec<Change>, Fallback> {
    let old_tree = match old_tree {
        Some(id) => repo.find_tree(id).map_err(|e| e.to_string())?,
        None => repo.empty_tree(),
    };
    let new_tree = repo.find_tree(new_tree).map_err(|e| e.to_string())?;
    let mut recorder = gix::diff::tree::Recorder::default();
    gix::diff::tree(
        gix::objs::TreeRefIter::from_bytes(&old_tree.data, repo.object_hash()),
        gix::objs::TreeRefIter::from_bytes(&new_tree.data, repo.object_hash()),
        gix::diff::tree::State::default(),
        &repo.objects,
        &mut recorder,
    )
    .map_err(|e| e.to_string())?;
    drop((old_tree, new_tree));
    use gix::diff::tree::recorder::Change as Record;
    let mut queue = Vec::with_capacity(recorder.records.len());
    for record in recorder.records {
        let (path, one, two) = match record {
            Record::Addition { path, entry_mode, oid, .. } => (path, None, Some((entry_mode, oid))),
            Record::Deletion { path, entry_mode, oid, .. } => (path, Some((entry_mode, oid)), None),
            Record::Modification { path, previous_entry_mode, previous_oid, entry_mode, oid } => {
                (path, Some((previous_entry_mode, previous_oid)), Some((entry_mode, oid)))
            }
        };
        let modes = [one, two].map(|side| side.map(|(mode, _)| mode));
        // 递归差异里的目录条目本身不进 raw 输出；若被报成一条修改则让位
        match modes.map(|mode| mode.map(|mode| mode.is_tree())) {
            [Some(true), Some(true)] | [None, Some(true)] | [Some(true), None] => continue,
            [Some(true), Some(false)] | [Some(false), Some(true)] => return Err("tree and blob swapped".into()),
            _ => {}
        }
        if modes.iter().flatten().any(|mode| mode.is_commit()) {
            if !keep_gitlinks {
                return Err("submodule".into());
            }
            if two.is_some() {
                continue;
            }
        }
        let side = |side: Option<(gix::object::tree::EntryMode, ObjectId)>| {
            side.map(|(mode, id)| Side { mode: canon_mode(mode), id })
        };
        let (one, two) = (side(one), side(two));
        // git 读树时规范化模式（100664 → 100644），规范化后相同就不是改动
        if one.is_some() && one == two {
            continue;
        }
        queue.push(Change { path, one, two });
    }
    queue.sort_by(|a, b| a.path.cmp(&b.path));
    if queue.windows(2).any(|pair| pair[0].path == pair[1].path) {
        return Err("同一路径出现两次".into());
    }
    Ok(queue)
}

/// `--raw -z` 一条记录（diff.c `diff_flush_raw`）；`abbrev` 给出对象名的写法
pub(crate) fn write_raw(
    out: &mut Vec<u8>, pair: &Pair, abbrev: &mut impl FnMut(&ObjectId) -> Result<String, Fallback>,
) -> Result<(), Fallback> {
    let null = |side: &Option<Side>, other: &Option<Side>| {
        let kind = side.or(*other).expect("至少一侧存在").id.kind();
        ObjectId::null(kind)
    };
    let (mode_one, id_one) = pair.one.map_or((0, null(&pair.one, &pair.two)), |s| (s.mode, s.id));
    let (mode_two, id_two) = pair.two.map_or((0, null(&pair.two, &pair.one)), |s| (s.mode, s.id));
    out.extend_from_slice(
        format!(":{mode_one:06o} {mode_two:06o} {} {} ", abbrev(&id_one)?, abbrev(&id_two)?).as_bytes(),
    );
    out.push(pair.status);
    if pair.score > 0 {
        out.extend_from_slice(format!("{:03}", similarity_index(pair.score)).as_bytes());
    }
    out.push(0);
    if pair.status == b'R' {
        out.extend_from_slice(&pair.one_path);
        out.push(0);
    }
    out.extend_from_slice(&pair.path);
    out.push(0);
    Ok(())
}

/// `--numstat -z` 一条记录（diff.c `builtin_diffstat` + `show_numstat`）：任一侧二进制是 `-\t-\t`，
/// 对象相同是 0/0，否则数 xdiff 的增删行。修改记录增删都是 0 且模式不变时 git 不输出（只有忽略空白时才会发生）。
pub(crate) fn write_numstat(out: &mut Vec<u8>, repo: &gix::Repository, pair: &Pair) -> Result<(), Fallback> {
    let load = |side: Option<Side>| -> Result<Vec<u8>, Fallback> {
        let Some(side) = side else { return Ok(Vec::new()) };
        let header = repo.find_header(side.id).map_err(|e| e.to_string())?;
        if header.size() > MAX_FILE_SIZE {
            return Err("文件太大".into());
        }
        Ok(repo.find_object(side.id).map_err(|e| e.to_string())?.detach().data)
    };
    let (one, two) = (load(pair.one)?, load(pair.two)?);
    let may_differ = !matches!((pair.one, pair.two), (Some(a), Some(b)) if a.id == b.id);
    if is_binary(&one) || is_binary(&two) {
        out.extend_from_slice(b"-\t-\t");
    } else {
        let (mut added, mut deleted) = (0u64, 0u64);
        if may_differ {
            for line in crate::xdiff::unified_diff(&one, &two).split(|b| *b == b'\n') {
                match line.first() {
                    Some(b'+') => added += 1,
                    Some(b'-') => deleted += 1,
                    _ => {}
                }
            }
            if pair.status == b'M' && added == 0 && deleted == 0 && pair.one.map(|s| s.mode) == pair.two.map(|s| s.mode)
            {
                return Ok(());
            }
        }
        out.extend_from_slice(format!("{added}\t{deleted}\t").as_bytes());
    }
    if pair.one_path != pair.path {
        out.push(0);
        out.extend_from_slice(&pair.one_path);
        out.push(0);
    }
    out.extend_from_slice(&pair.path);
    out.push(0);
    Ok(())
}

/// Desktop `getChangedFiles` 那条命令的完整标准输出（raw 段 + numstat 段）。`abbreviate` 为真时对象名照
/// `core.abbrev` 缩写，用来逐字节对照 git；生产路径（`history::commit_files_in_process`）写完整对象名，
/// 解析时用不到。numstat 要读每个文件的内容，所以所有路径都过属性检查；xdiff 设置与 `diff.orderFile`
/// 会改变数字或顺序，出现时让位。属性检查只在 unix 上实现，其它平台整体交给 git。
#[cfg(unix)]
pub(crate) fn commit_log_bytes(root: &Path, sha: &str, abbreviate: bool) -> Result<Vec<u8>, Fallback> {
    let (repo, pairs) = commit_pairs(root, sha)?;
    crate::raw_diff::in_process::check_numstat_settings(&repo)?;
    let min_len = if abbreviate { Some(crate::history::abbreviation_length(&repo)?) } else { None };
    let mut attributes = attribute_checker(&repo)?;
    let mut out = Vec::with_capacity(pairs.len() * 160);
    for pair in &pairs {
        attributes(pair.one_path.as_bstr())?;
        attributes(pair.path.as_bstr())?;
        write_raw(&mut out, pair, &mut |id| match min_len {
            Some(min_len) => crate::raw_diff::in_process::abbrev(&repo, id, min_len),
            None => Ok(id.to_hex().to_string()),
        })?;
    }
    for pair in &pairs {
        write_numstat(&mut out, &repo, pair)?;
    }
    Ok(out)
}

#[cfg(not(unix))]
pub(crate) fn commit_log_bytes(_: &Path, _: &str, _: bool) -> Result<Vec<u8>, Fallback> {
    Err("属性检查只在 unix 上实现".into())
}

/// 对象名按 `core.abbrev` 缩写的完整输出，逐字节对照 git（测试与基准用）。
#[cfg(unix)]
#[allow(dead_code)] // Byte-for-byte comparison in tests and the benchmark.
pub(crate) fn commit_log_output(root: &Path, sha: &str) -> Result<Vec<u8>, Fallback> {
    commit_log_bytes(root, sha, true)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn basename_same_照搬_git() {
        assert!(basename_same(b"a/b.txt", b"c/b.txt"));
        assert!(basename_same(b"b.txt", b"c/b.txt"));
        assert!(basename_same(b"b.txt", b"b.txt"));
        assert!(!basename_same(b"a/xb.txt", b"c/b.txt"));
        assert!(!basename_same(b"a/b.txt", b"c/b.md"));
    }

    #[test]
    fn spanhash_按行与_64_字节切块且忽略_crlf_的_cr() {
        let lf = spanhash(b"a\nb\n", true);
        assert_eq!(lf, spanhash(b"a\r\nb\r\n", true));
        assert_ne!(lf, spanhash(b"a\r\nb\r\n", false));
        let long = vec![b'x'; 130];
        let spans = spanhash(&long, true);
        assert_eq!(spans.iter().map(|(_, n)| n).sum::<u32>(), 130);
        // 两个 64 字节块内容相同，合并成一项
        assert_eq!(spans.len(), 2);
        assert!(spans.iter().any(|(_, n)| *n == 128));
    }

    fn git(r: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    /// Desktop `getChangedFiles` 的完整命令；部分克隆缺对象时不去网络上取，失败返回 `None`
    pub(crate) fn git_log_output(r: &Path, sha: &str) -> Option<Vec<u8>> {
        let out = Command::new("git")
            .arg("-C")
            .arg(r)
            .args([
                "log",
                "-C",
                "-M",
                "-m",
                "-1",
                "--no-show-signature",
                "--first-parent",
                "--raw",
                "--format=format:",
                "--numstat",
                "-z",
                "--end-of-options",
                sha,
                "--",
            ])
            .env("GIT_NO_LAZY_FETCH", "1")
            .output()
            .unwrap();
        out.status.success().then_some(out.stdout)
    }

    fn show(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).replace('\0', "\\0\n")
    }

    /// 对照一个提交：快速路径作答时完整输出与 git 逐字节相同、解析结果与 `commit_files_via_git` 相同。
    /// `Err` 是让位的原因。
    pub(crate) fn check(r: &Path, sha: &str) -> Result<(), String> {
        let Some(expected) = git_log_output(r, sha) else { return Err("git 读不到对象".into()) };
        let fast = commit_log_output(r, sha);
        let files = crate::history::commit_files_in_process(r, sha);
        if let Ok(fast) = &fast {
            assert!(*fast == expected, "{sha}: 与 git 不同\n--- 进程内\n{}\n--- git\n{}", show(fast), show(&expected));
            assert!(files.is_ok(), "{sha}: 完整输出能作答但文件列表让位");
        }
        if let Ok(files) = files {
            // 同一条命令的输出（`commit_files_via_git` 会让部分克隆去远端懒加载缺的 blob，这里不用它）
            let via_git = crate::history::parse_raw_with_numstat(&expected);
            assert_eq!(
                serde_json::to_value(files).unwrap(),
                serde_json::to_value(via_git).unwrap(),
                "{sha}\n{}",
                show(&expected)
            );
        }
        fast.map(|_| ())
    }

    struct Repo {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
    }

    impl Repo {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().to_path_buf();
            git(&root, &["init", "-q", "-b", "main", "."]);
            git(&root, &["config", "user.email", "t@t.t"]);
            git(&root, &["config", "user.name", "t"]);
            // 后台自动打包会在 gix 扫描对象库时挪走松散对象（gix 不重扫，只会让位），对照里关掉
            git(&root, &["config", "gc.auto", "0"]);
            git(&root, &["config", "maintenance.auto", "false"]);
            Repo { _dir: dir, root }
        }

        fn write(&self, path: &str, data: impl AsRef<[u8]>) {
            let path = self.root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let _ = std::fs::remove_file(&path);
            std::fs::write(path, data).unwrap();
        }

        fn remove(&self, path: &str) {
            std::fs::remove_file(self.root.join(path)).unwrap();
        }

        fn mv(&self, from: &str, to: &str) {
            let to_path = self.root.join(to);
            std::fs::create_dir_all(to_path.parent().unwrap()).unwrap();
            std::fs::rename(self.root.join(from), to_path).unwrap();
        }

        fn commit(&self, message: &str) -> String {
            git(&self.root, &["add", "-A"]);
            git(&self.root, &["commit", "-qm", message, "--allow-empty", "--no-verify"]);
            String::from_utf8(git(&self.root, &["rev-parse", "HEAD"])).unwrap().trim().to_string()
        }

        /// 提交并对照；`fast` 是快速路径是否应作答。返回 git 的 raw 段（便于断言形状）
        fn expect(&self, message: &str, fast: bool) -> String {
            let sha = self.commit(message);
            let result = check(&self.root, &sha);
            assert_eq!(result.is_ok(), fast, "{message}: {result:?}");
            let raw = git_log_output(&self.root, &sha).unwrap();
            show(&raw)
        }
    }

    fn lines(range: std::ops::Range<usize>, tag: &str) -> String {
        range.map(|i| format!("{tag} line number {i}\n")).collect()
    }

    /// 前 `keep` 行不变、后面换成新内容，总行数 `total`
    fn edited(total: usize, keep: usize, tag: &str) -> String {
        lines(0..keep, "base") + &lines(keep..total, tag)
    }

    #[test]
    fn 重命名形状_与_git_逐字节一致() {
        let repo = Repo::new();
        let body = lines(0..40, "base");
        repo.write("a.txt", &body);
        repo.write("dir/b.txt", lines(0..20, "b"));
        repo.write("same1.txt", "dup\ncontent\n");
        repo.write("same2.txt", "dup\ncontent\n");
        repo.write("empty.txt", "");
        repo.write("x.sh", "#!/bin/sh\necho hi\n");
        repo.write("bin.dat", b"\0\x01\x02binary\n".repeat(50));
        repo.write("crlf.txt", lines(0..30, "crlf"));
        repo.write("long.txt", "x".repeat(300) + "\n" + &"y".repeat(200));
        std::os::unix::fs::symlink("a.txt", repo.root.join("link")).unwrap();
        repo.expect("root", true);

        repo.mv("a.txt", "a-renamed.txt");
        let out = repo.expect("精确重命名", true);
        assert!(out.contains("R100"), "{out}");

        repo.mv("dir/b.txt", "other/b.txt");
        repo.expect("目录间精确重命名（同名）", true);

        // 两个相同内容的来源、一个目标：同名的那个优先
        repo.remove("same1.txt");
        repo.remove("same2.txt");
        repo.write("sub/same2.txt", "dup\ncontent\n");
        let out = repo.expect("多个精确来源，同名优先", true);
        assert!(out.contains("same2.txt\\0\nsub/same2.txt"), "{out}");

        // 两个相同来源、两个目标，都不同名：按来源顺序
        repo.write("p.txt", "pair\n");
        repo.write("q.txt", "pair\n");
        repo.commit("准备");
        repo.remove("p.txt");
        repo.remove("q.txt");
        repo.write("m/one.txt", "pair\n");
        repo.write("n/two.txt", "pair\n");
        repo.expect("多个精确来源，多个目标", true);

        // 相似重命名加修改
        repo.mv("a-renamed.txt", "a2.txt");
        repo.write("a2.txt", edited(40, 34, "edit"));
        let out = repo.expect("重命名加修改", true);
        assert!(out.contains(":100644 100644") && out.contains(" R0"), "{out}");

        // 空文件：rename_empty 默认开，空文件之间按对象 id 精确配对
        repo.mv("empty.txt", "empty-moved.txt");
        repo.expect("空文件重命名", true);

        // 模式变化的精确重命名、符号链接精确重命名
        repo.mv("x.sh", "y.sh");
        std::fs::set_permissions(repo.root.join("y.sh"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        repo.mv("link", "link2");
        repo.expect("模式变化与符号链接", true);

        // 二进制：精确与相似
        repo.mv("bin.dat", "bin2.dat");
        repo.expect("二进制精确重命名", true);
        let mut bin = b"\0\x01\x02binary\n".repeat(50);
        bin.extend_from_slice(b"\0tail\n");
        repo.remove("bin2.dat");
        repo.write("bin3.dat", &bin);
        repo.expect("二进制相似重命名", true);

        // CRLF：文本里 CRLF 的 CR 不参与 spanhash
        let crlf = lines(0..30, "crlf").replace('\n', "\r\n");
        repo.remove("crlf.txt");
        repo.write("crlf2.txt", &crlf);
        repo.expect("LF 改 CRLF 的重命名", true);

        // 超过 64 字节的行按 64 字节切块
        repo.remove("long.txt");
        repo.write("long2.txt", "x".repeat(300) + "\n" + &"z".repeat(200));
        repo.expect("长行", true);

        // 目录整体移动
        for i in 0..12 {
            repo.write(&format!("pkg/m{i}.rs"), lines(0..10 + i, &format!("m{i}")));
        }
        repo.commit("准备目录");
        for i in 0..12 {
            repo.mv(&format!("pkg/m{i}.rs"), &format!("lib/pkg/m{i}.rs"));
            if i % 3 == 0 {
                repo.write(&format!("lib/pkg/m{i}.rs"), lines(0..10 + i, &format!("m{i}")) + "extra\n");
            }
        }
        repo.expect("目录移动，部分文件有修改", true);

        // 排序边界：a.txt、a/b、a-b、a0
        for path in ["s/a.txt", "s/a/b", "s/a-b", "s/a0", "s/a"] {
            if path != "s/a" {
                repo.write(path, format!("{path}\n"));
            }
        }
        repo.commit("准备排序");
        repo.remove("s/a/b");
        repo.write("s/a.txt", "changed\n");
        repo.write("s/a-c", "s/a/b\n");
        repo.write("s/a1", "fresh\n");
        repo.expect("树序与路径字节序", true);

        // 类型变化（普通文件变符号链接）与新增删除同时出现
        repo.remove("y.sh");
        std::os::unix::fs::symlink("a2.txt", repo.root.join("y.sh")).unwrap();
        repo.write("new-file.txt", "brand new\n");
        repo.remove("s/a0");
        repo.expect("类型变化加新增删除", true);

        // 文件变目录、目录变文件：git 报一删一增（树序里文件 `x` 排在 `x/…` 前面），可以配成重命名
        repo.remove("new-file.txt");
        repo.write("new-file.txt/inner.txt", "brand new\n");
        let out = repo.expect("文件变目录", true);
        assert!(out.contains("R100"), "{out}");
        let m1 = std::fs::read(repo.root.join("lib/pkg/m1.rs")).unwrap();
        std::fs::remove_dir_all(repo.root.join("lib/pkg")).unwrap();
        repo.write("lib/pkg", [m1, b"tail\n".to_vec()].concat());
        repo.expect("目录变文件", true);
    }

    #[test]
    fn 文件名启发与打分并列规则_与_git_一致() {
        let repo = Repo::new();
        let base = lines(0..50, "base");
        // 同名来源 88% 相似，另一个不同名来源 96% 相似：文件名阶段先配上同名的，矩阵本会选另一个
        repo.write("old/x.txt", &base);
        repo.write("else/y.txt", edited(50, 44, "bee"));
        repo.commit("准备 1");
        repo.remove("old/x.txt");
        repo.remove("else/y.txt");
        repo.write("new/x.txt", lines(0..44, "base") + &lines(44..48, "bee") + &lines(48..50, "dst"));
        let out = repo.expect("文件名阶段：同名先配", true);
        assert!(out.contains("old/x.txt\\0\nnew/x.txt"), "{out}");

        // 同名但相似度只有 60%（低于文件名阶段的 75%）：留给矩阵，矩阵选最相似的
        repo.write("u/z.txt", &base);
        repo.write("v/w.txt", &base);
        repo.commit("准备 2");
        repo.remove("u/z.txt");
        repo.remove("v/w.txt");
        repo.write("t/z.txt", edited(50, 30, "sixty"));
        repo.write("t/k.txt", edited(50, 45, "ninety"));
        repo.expect("同名低于文件名门槛，交给矩阵", true);

        // 同名不唯一：文件名阶段跳过
        repo.write("a1/same.txt", &base);
        repo.write("a2/same.txt", edited(50, 45, "s2"));
        repo.commit("准备 3");
        repo.remove("a1/same.txt");
        repo.remove("a2/same.txt");
        repo.write("b1/same.txt", edited(50, 44, "t1"));
        repo.expect("同名不唯一", true);

        // 打分并列：两个来源对同一目标同分，同名的优先；都不同名时按矩阵里的位置（稳定排序）
        repo.write("c1/tie.txt", &base);
        repo.write("c2/tie2.txt", &base);
        repo.write("c3/tie3.txt", &base);
        repo.commit("准备 4");
        for path in ["c1/tie.txt", "c2/tie2.txt", "c3/tie3.txt"] {
            repo.remove(path);
        }
        repo.write("d/tie.txt", edited(50, 40, "tie"));
        repo.write("d/other.txt", edited(50, 40, "tie"));
        repo.expect("并列分数", true);

        // 每个目标只留 4 个候选：5 个来源竞争 2 个目标
        for i in 0..5 {
            repo.write(&format!("e/src{i}.txt"), edited(50, 30 + i * 3, &format!("src{i}")));
        }
        repo.commit("准备 5");
        for i in 0..5 {
            repo.remove(&format!("e/src{i}.txt"));
        }
        repo.write("f/dst-a.txt", edited(50, 44, "dst-a"));
        repo.write("f/dst-b.txt", edited(50, 41, "dst-b"));
        repo.expect("候选上限", true);
    }

    /// 相同内容的来源很多时，git 哈希表链表的遍历顺序决定选谁：205 个来源恰好在最后一次插入时扩容，
    /// 链表反转，选中的是最后一个；204 个不扩容，选第一个；超过 100 个候选后不再找同名的
    #[test]
    fn 精确重命名的候选顺序与上限() {
        for (count, same_name_at) in [(204, None), (205, None), (120, Some(110)), (120, Some(50)), (52, Some(51))] {
            let repo = Repo::new();
            for i in 0..count {
                repo.write(&format!("src/f{i:03}.txt"), "same content\n");
            }
            repo.commit("准备");
            for i in 0..count {
                repo.remove(&format!("src/f{i:03}.txt"));
            }
            let name = match same_name_at {
                Some(i) => format!("dst/f{i:03}.txt"),
                None => "dst/other.txt".into(),
            };
            repo.write(&name, "same content\n");
            let out = repo.expect(&format!("{count} 个相同来源"), true);
            let expected_source = match (count, same_name_at) {
                (205, None) => "src/f204.txt".to_string(),
                (_, None) => "src/f000.txt".to_string(),
                (_, Some(i)) if i < 100 => format!("src/f{i:03}.txt"),
                _ => "src/f000.txt".to_string(),
            };
            assert!(out.contains(&format!("R100\\0\n{expected_source}\\0\n{name}")), "{count}: {out}");
        }
    }

    /// 每个形状都让一处细节决定配对结果（变异测试据此确认）：文件名阶段门槛、矩阵里同分时同名优先、
    /// 每个目标只留 4 个候选且同分不替换、正好 50% 的分数、rename limit 的边界
    #[test]
    fn 打分边界与_git_一致() {
        // 等长的行，相似度按行数精确控制
        let block = |range: std::ops::Range<usize>, tag: &str| lines(range, tag);

        // 同名来源 72%（低于文件名阶段的 75%）、另一来源 90%：git 交给矩阵，选 90% 的
        let repo = Repo::new();
        repo.write("p/q.txt", block(0..36, "base") + &block(36..50, "src1"));
        repo.write("p/other.txt", block(0..36, "base") + &block(36..45, "dst1") + &block(45..50, "oth2"));
        repo.commit("准备");
        repo.remove("p/q.txt");
        repo.remove("p/other.txt");
        repo.write("r/q.txt", block(0..36, "base") + &block(36..50, "dst1"));
        let out = repo.expect("文件名门槛之下交给矩阵", true);
        assert!(out.contains("p/other.txt\\0\nr/q.txt"), "{out}");

        // 矩阵里同分：同名的来源优先（文件名阶段因为 60% 低于门槛没配上）
        let repo = Repo::new();
        repo.write("a/one.txt", block(0..30, "base") + &block(30..50, "aaaa"));
        repo.write("b/tie.txt", block(0..30, "base") + &block(30..50, "bbbb"));
        repo.commit("准备");
        repo.remove("a/one.txt");
        repo.remove("b/tie.txt");
        repo.write("c/tie.txt", block(0..30, "base") + &block(30..50, "cccc"));
        let out = repo.expect("同分同名优先", true);
        assert!(out.contains("b/tie.txt\\0\nc/tie.txt"), "{out}");

        // 5 个同分来源竞争：D 的 4 个候选位被前 4 个占住（同分不替换），它们又被各自 98% 的目标拿走，
        // D 最后什么也配不上；第 5 个来源保持删除
        let repo = Repo::new();
        for i in 1..=5 {
            repo.write(&format!("s/src{i}.txt"), block(0..30, "base") + &block(30..50, &format!("sr{i:02}")));
        }
        repo.commit("准备");
        for i in 1..=5 {
            repo.remove(&format!("s/src{i}.txt"));
        }
        for i in 1..=4 {
            repo.write(
                &format!("t/near{i}.txt"),
                block(0..30, "base") + &block(30..49, &format!("sr{i:02}")) + &block(49..50, "xxxx"),
            );
        }
        repo.write("t/d.txt", block(0..30, "base") + &block(30..50, "dddd"));
        let out = repo.expect("每个目标 4 个候选", true);
        assert!(out.contains("A\\0\nt/d.txt") && out.contains("D\\0\ns/src5.txt"), "{out}");

        // 正好 50%：目标是来源加上等长的一段，src_copied × 60000 / max_size = 30000，仍算重命名
        let repo = Repo::new();
        repo.write("half.txt", "0123456789abcdefghi\n");
        repo.commit("准备");
        repo.remove("half.txt");
        repo.write("half2.txt", "0123456789abcdefghi\nzyxwvutsrqponmlkjih\n");
        let out = repo.expect("正好 50%", true);
        assert!(out.contains("R050"), "{out}");
    }

    /// 1000×1000 正好不超过默认 rename limit（`num_destinations * num_sources > limit²` 才放弃）
    #[test]
    fn 正好等于_rename_limit_仍在进程内检测() {
        let repo = Repo::new();
        for i in 0..1000 {
            repo.write(&format!("old/o{i}.txt"), format!("old {i}\n"));
        }
        repo.commit("准备");
        for i in 0..1000 {
            repo.remove(&format!("old/o{i}.txt"));
            repo.write(&format!("new/n{i}.txt"), format!("new {i}\n"));
        }
        repo.expect("1000×1000", true);
    }

    #[test]
    fn 相似度阈值_50_附近_与_git_一致() {
        let repo = Repo::new();
        let mut paths = Vec::new();
        for keep in 0..=40 {
            let path = format!("t{keep:02}/f{keep}.txt");
            repo.write(&path, lines(0..40, &format!("base{keep:02}")));
            paths.push((path, keep));
        }
        repo.commit("准备");
        let mut renamed = 0;
        for (path, keep) in &paths {
            repo.remove(path);
            // 前 keep 行保留，其余换掉：相似度从 0% 到 100%
            let data = lines(0..*keep, &format!("base{keep:02}")) + &lines(*keep..40, &format!("new{keep:02}"));
            repo.write(&format!("moved{keep:02}/g{keep}.txt"), data);
        }
        let out = repo.expect("41 个相似度梯度", true);
        renamed += out.matches(" R0").count();
        assert!(renamed > 10 && renamed < 35, "梯度应跨过 50% 门槛: {renamed}\n{out}");
    }

    #[test]
    fn 无法证明一致的情形交给_git() {
        let repo = Repo::new();
        let base = lines(0..30, "base");
        repo.write("a.dat", &base);
        repo.write(".gitattributes", "*.dat diff\n");
        repo.commit("root");
        repo.remove("a.dat");
        repo.write("b.dat", edited(30, 25, "x"));
        repo.expect("带 diff 属性的相似重命名", false);
        // 精确重命名不读内容，属性不影响状态；但文件列表带 numstat，算 numstat 要读内容，整体让位
        repo.mv("b.dat", "c.dat");
        let sha = repo.commit("带属性的精确重命名");
        assert!(commit_log_output(&repo.root, &sha).is_err());
        assert!(crate::history::commit_files_in_process(&repo.root, &sha).is_err());
        let files = crate::history::commit_files(&repo.root, &sha).unwrap();
        let via_git = crate::history::commit_files_via_git(&repo.root, &sha).unwrap();
        assert_eq!(serde_json::to_value(files).unwrap(), serde_json::to_value(via_git).unwrap());

        repo.write("plain.txt", &base);
        repo.commit("准备");
        repo.remove("plain.txt");
        repo.write("plain2.txt", edited(30, 25, "y"));
        let sha = repo.commit("diff.renameLimit");
        git(&repo.root, &["config", "diff.renameLimit", "5"]);
        assert!(check(&repo.root, &sha).is_err());
        git(&repo.root, &["config", "--unset", "diff.renameLimit"]);
        assert!(check(&repo.root, &sha).is_ok());
        // 只有新增或只有删除时不做重命名检测，配置不影响
        git(&repo.root, &["config", "diff.renameLimit", "5"]);
        repo.write("only-new.txt", "n\n");
        repo.expect("只有新增", true);
        git(&repo.root, &["config", "--unset", "diff.renameLimit"]);
        // diff.algorithm 改变 numstat 的数字：完整对照和文件列表一起让位给 git
        git(&repo.root, &["config", "diff.algorithm", "patience"]);
        assert!(commit_log_output(&repo.root, &sha).is_err());
        assert!(crate::history::commit_files_in_process(&repo.root, &sha).is_err());
        assert!(crate::history::commit_files(&repo.root, &sha).is_ok());
        git(&repo.root, &["config", "--unset", "diff.algorithm"]);
    }

    #[test]
    fn 超过默认_rename_limit_交给_git() {
        let repo = Repo::new();
        for i in 0..1001 {
            repo.write(&format!("old/o{i}.txt"), format!("old {i}\n"));
        }
        repo.commit("准备");
        for i in 0..1001 {
            repo.remove(&format!("old/o{i}.txt"));
            repo.write(&format!("new/n{i}.txt"), format!("new {i}\n"));
        }
        let sha = repo.commit("1001×1001");
        let result = crate::history::commit_files_in_process(&repo.root, &sha);
        assert!(result.is_err(), "超过 1000² 的矩阵应让位");
    }

    /// 随机仓库：从共享的行池里生成文件，每个提交随机重命名（带或不带修改）、复制、删除、新增、修改
    #[test]
    fn 随机重命名与_git_逐字节一致() {
        let repo = Repo::new();
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n.max(1) as u64) as usize
        };
        let pool: Vec<String> = (0..60).map(|i| format!("shared line {i} {}\n", "w".repeat(i % 7 * 9))).collect();
        let dirs = ["", "a/", "b/", "a/c/", "d/"];
        let names = ["x.txt", "y.txt", "z.rs", "readme", "mod.rs", "data.bin"];
        let mut files: std::collections::BTreeMap<String, Vec<u8>> = Default::default();
        let gen_file = |next: &mut dyn FnMut(usize) -> usize| -> Vec<u8> {
            let mut out = Vec::new();
            for _ in 0..next(30) {
                out.extend_from_slice(pool[next(pool.len())].as_bytes());
            }
            match next(10) {
                0 => out.extend_from_slice(b"\0binary tail"),
                1 => out = String::from_utf8_lossy(&out).replace('\n', "\r\n").into_bytes(),
                2 => out.extend_from_slice(b"no newline"),
                _ => {}
            }
            out
        };
        let mutate = |data: &[u8], next: &mut dyn FnMut(usize) -> usize| -> Vec<u8> {
            let mut lines: Vec<Vec<u8>> = data.split_inclusive(|b| *b == b'\n').map(<[u8]>::to_vec).collect();
            for _ in 0..next(6) {
                match next(3) {
                    0 if !lines.is_empty() => {
                        let i = next(lines.len());
                        lines.remove(i);
                    }
                    1 => {
                        let i = next(lines.len() + 1);
                        lines.insert(i, format!("inserted {}\n", next(1000)).into_bytes());
                    }
                    _ if !lines.is_empty() => {
                        let i = next(lines.len());
                        lines[i] = format!("replaced {}\n", next(1000)).into_bytes();
                    }
                    _ => {}
                }
            }
            lines.concat()
        };
        let name = |next: &mut dyn FnMut(usize) -> usize, step: usize| {
            format!(
                "{}{}{}",
                dirs[next(dirs.len())],
                if next(3) == 0 { format!("s{step}-") } else { String::new() },
                names[next(names.len())]
            )
        };
        let (mut fast, mut total, mut renames, mut modified_renames) = (0, 0, 0, 0);
        for step in 0..200 {
            for _ in 0..1 + next(5) {
                let keys: Vec<String> = files.keys().cloned().collect();
                match next(6) {
                    0 | 1 if !keys.is_empty() => {
                        // 重命名，可能带修改
                        let from = &keys[next(keys.len())];
                        let to = name(&mut next, step);
                        if files.contains_key(&to) || to.starts_with(&format!("{from}/")) {
                            continue;
                        }
                        let mut data = files.remove(from).unwrap();
                        if next(2) == 0 {
                            data = mutate(&data, &mut next);
                        }
                        files.insert(to, data);
                    }
                    2 if !keys.is_empty() => {
                        // 复制（-C -M 只做重命名，复制显示为新增）
                        let from = &keys[next(keys.len())];
                        let to = name(&mut next, step);
                        if !files.contains_key(&to) {
                            let data = mutate(&files[from], &mut next);
                            files.insert(to, data);
                        }
                    }
                    3 if keys.len() > 2 => {
                        files.remove(&keys[next(keys.len())]);
                    }
                    4 if !keys.is_empty() => {
                        let key = &keys[next(keys.len())];
                        let data = mutate(&files[key], &mut next);
                        files.insert(key.clone(), data);
                    }
                    _ => {
                        let to = name(&mut next, step);
                        let data = gen_file(&mut next);
                        files.insert(to, data);
                    }
                }
            }
            // 路径与目录冲突（x.txt 既是文件又是目录前缀）不会出现：名字都以文件名结尾、目录固定
            for entry in std::fs::read_dir(&repo.root).unwrap() {
                let entry = entry.unwrap();
                if entry.file_name() != ".git" {
                    let path = entry.path();
                    if path.is_dir() {
                        std::fs::remove_dir_all(path).unwrap()
                    } else {
                        std::fs::remove_file(path).unwrap()
                    }
                }
            }
            for (path, data) in &files {
                repo.write(path, data);
            }
            let sha = repo.commit(&format!("step {step}"));
            total += 1;
            match check(&repo.root, &sha) {
                Ok(()) => fast += 1,
                Err(reason) => eprintln!("step {step} 让位：{reason}"),
            }
            let files = crate::history::commit_files_via_git(&repo.root, &sha).unwrap();
            renames += files.iter().filter(|f| f.kind == crate::history::CommitFileKind::Renamed).count();
            modified_renames += files.iter().filter(|f| f.rename_includes_modifications).count();
        }
        eprintln!(
            "随机对照：{fast}/{total} 个提交由快速路径作答，git 报告重命名 {renames} 个（带修改 {modified_renames} 个）"
        );
        assert!(renames >= 100 && modified_renames >= 40, "随机形状里的重命名太少");
        assert!(fast * 100 >= total * 95, "快速路径只作答了 {fast}/{total}");
    }

    /// 真实仓库最近的提交逐个对照：`GITCUB_RENAME_REPOS` 是冒号分隔的仓库列表，`GITCUB_RENAME_COUNT` 是每个仓库的提交数。
    /// `cargo test --bins rename::tests::真实仓库 -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn 真实仓库最近提交与_git_逐字节一致() {
        let home = std::env::var("HOME").unwrap();
        let repos = std::env::var("GITCUB_RENAME_REPOS")
            .unwrap_or_else(|_| format!("{home}/Projects/nyssance/Vendor/desktop:/opt/homebrew"));
        let count = std::env::var("GITCUB_RENAME_COUNT").unwrap_or_else(|_| "500".into());
        for repo in repos.split(':') {
            let root = Path::new(repo);
            let list = git(root, &["rev-list", &format!("--max-count={count}"), "HEAD"]);
            let shas: Vec<&str> = std::str::from_utf8(&list).unwrap().lines().collect();
            let (mut fast, mut renamed, mut unreadable, mut raw_checked, mut raw_fast) = (0, 0, 0, 0, 0);
            let mut reasons: std::collections::BTreeMap<String, usize> = Default::default();
            for sha in &shas {
                match check(root, sha) {
                    Ok(()) => {
                        fast += 1;
                        if crate::history::commit_files_in_process(root, sha)
                            .unwrap()
                            .iter()
                            .any(|f| f.kind == crate::history::CommitFileKind::Renamed)
                        {
                            renamed += 1;
                        }
                    }
                    Err(reason) if reason == "git 读不到对象" => {
                        // 部分克隆缺历史 blob，numstat 读不了；不带 numstat 的 raw 段只在模糊重命名时读 blob，
                        // 能读出来就对照解析结果
                        unreadable += 1;
                        let out = Command::new("git")
                            .arg("-C")
                            .arg(root)
                            .args(["log", "-C", "-M", "-m", "-1", "--no-show-signature", "--first-parent", "--raw"])
                            .args(["--format=format:", "-z", "--end-of-options", sha, "--"])
                            .env("GIT_NO_LAZY_FETCH", "1")
                            .output()
                            .unwrap();
                        if !out.status.success() {
                            continue;
                        }
                        raw_checked += 1;
                        if let Ok(files) = crate::history::commit_files_in_process(root, sha) {
                            let expected = crate::history::parse_raw_with_numstat(&out.stdout);
                            assert_eq!(
                                serde_json::to_value(files).unwrap(),
                                serde_json::to_value(expected).unwrap(),
                                "{sha}"
                            );
                            raw_fast += 1;
                        }
                    }
                    Err(reason) => *reasons.entry(reason).or_default() += 1,
                }
            }
            eprintln!(
                "{repo}: {} 个提交，完整输出逐字节一致 {fast} 个（含重命名 {renamed} 个），git 自己缺对象 {unreadable} 个\
                 （其中 raw 段可读 {raw_checked} 个，文件列表进程内作答且一致 {raw_fast} 个），让位 {reasons:?}",
                shas.len()
            );
        }
    }
}
