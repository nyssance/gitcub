//! git 内置 xdiff 的逐行移植，只覆盖 `git diff` 默认参数走到的那条路：
//! Myers（不带 `--minimal`）+ 缩进启发（`diff.indentHeuristic` 默认开）+ 3 行上下文、
//! 0 行合并间距 + 默认函数名（`def_ff`）。
//!
//! 来源：git v2.54.0 `xdiff/xprepare.c`（分类、首尾裁剪、`xdl_cleanup_records`）、
//! `xdiff/xdiffi.c`（`xdl_split`、`xdl_recs_cmp`、`xdl_change_compact`、`xdl_build_script`）、
//! `xdiff/xemit.c`（`xdl_get_hunk`、`def_ff`、`xdl_emit_diff`）、`xdiff/xutils.c`
//! （`xdl_bogosqrt`、`xdl_emit_diffrec`、`xdl_format_hunk_hdr`）。
//!
//! 输出必须和 git 逐字节一致（前端的 diff-parser 和行选择补丁都基于它），所以下标、
//! 循环顺序和启发阈值都照抄 C 代码，不做「等价」改写。哈希表只用来判等：xdiff 的
//! 分类在哈希碰撞时也用 memcmp 落定，类号按首次出现顺序分配，和这里的 HashMap 一致。
//! 空白忽略、patience/histogram、函数上下文（`-W`）、自定义 funcname 都不在这里，
//! 调用方遇到这些设置必须让位给 git。

use std::collections::HashMap;

const XDL_KPDIS_RUN: isize = 4;
const XDL_MAX_EQLIMIT: isize = 1024;
const XDL_SIMSCAN_WINDOW: isize = 100;
const XDL_MAX_COST_MIN: isize = 256;
const XDL_HEUR_MIN_COST: isize = 256;
const XDL_LINE_MAX: isize = isize::MAX;
const XDL_SNAKE_CNT: isize = 20;
const XDL_K_HEUR: isize = 4;
const MAX_INDENT: i32 = 200;
const MAX_BLANKS: i32 = 20;
const START_OF_FILE_PENALTY: i32 = 1;
const END_OF_FILE_PENALTY: i32 = 21;
const TOTAL_BLANK_WEIGHT: i32 = -30;
const POST_BLANK_WEIGHT: i32 = 6;
const RELATIVE_INDENT_PENALTY: i32 = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY: i32 = 10;
const RELATIVE_OUTDENT_PENALTY: i32 = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY: i32 = 17;
const RELATIVE_DEDENT_PENALTY: i32 = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY: i32 = 17;
const INDENT_WEIGHT: i32 = 60;
const INDENT_HEURISTIC_MAX_SLIDING: isize = 100;
/// `git diff` 的默认上下文行数（`diff.context`）和合并间距（`diff.interHunkContext`）
const CONTEXT: isize = 3;
const INTER_HUNK_CONTEXT: isize = 0;

const DISCARD: u8 = 0;
const KEEP: u8 = 1;
const INVESTIGATE: u8 = 2;

struct Record<'a> {
    data: &'a [u8],
    class: usize,
}

struct XdFile<'a> {
    recs: Vec<Record<'a>>,
    /// C 里是 `changed - 1` 起算的数组：下标 -1 和 nrec 是恒为 false 的哨兵
    changed: Vec<bool>,
    reference_index: Vec<isize>,
    dstart: isize,
    dend: isize,
}

impl XdFile<'_> {
    fn nrec(&self) -> isize {
        self.recs.len() as isize
    }

    fn changed(&self, i: isize) -> bool {
        self.changed[(i + 1) as usize]
    }

    fn set_changed(&mut self, i: isize, value: bool) {
        self.changed[(i + 1) as usize] = value;
    }

    fn hash(&self, index: isize) -> usize {
        self.recs[self.reference_index[index as usize] as usize].class
    }

    fn nreff(&self) -> isize {
        self.reference_index.len() as isize
    }
}

/// `xdl_hash_record` 不带空白标志时的切行：每条记录含行尾 `\n`，最后一行可以没有。
/// 行分类用的哈希：和 xdiff `xdl_hash_record` 一样只是为了快，判等仍比较整行内容，
/// 类号按首次出现分配，与哈希函数无关。SipHash 在大文件 blame 时占了一半时间。
#[derive(Default)]
struct LineHasher(u64);

impl std::hash::Hasher for LineHasher {
    fn finish(&self) -> u64 {
        // 末尾混一下，让 hashbrown 取高位作控制字节时也分散
        let h = self.0 ^ (self.0 >> 29);
        h.wrapping_mul(0xbf58_476d_1ce4_e5b9) ^ (h >> 32)
    }

    fn write(&mut self, bytes: &[u8]) {
        const K: u64 = 0x517c_c1b7_2722_0a95;
        let mut h = self.0;
        let (words, rest) = bytes.as_chunks::<8>();
        for word in words {
            h = (h.rotate_left(5) ^ u64::from_le_bytes(*word)).wrapping_mul(K);
        }
        for &b in rest {
            h = (h.rotate_left(5) ^ u64::from(b)).wrapping_mul(K);
        }
        self.0 = h;
    }
}

type LineClasses<'a> = HashMap<&'a [u8], usize, std::hash::BuildHasherDefault<LineHasher>>;

/// 按行切分：每条记录含行尾 `\n`，最后一行可以没有。按 8 字节一组找换行（SWAR：
/// `(x - 0x01…) & !x & 0x80…` 最低的置位字节就是第一个等于 `\n` 的字节）。
struct Lines<'a>(&'a [u8]);

impl<'a> Iterator for Lines<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        const ONES: u64 = 0x0101_0101_0101_0101;
        const HIGHS: u64 = 0x8080_8080_8080_8080;
        let data = self.0;
        if data.is_empty() {
            return None;
        }
        let mut end = data.len();
        let mut at = 0;
        while at + 8 <= data.len() {
            let word = u64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes")) ^ (ONES * u64::from(b'\n'));
            let found = word.wrapping_sub(ONES) & !word & HIGHS;
            if found != 0 {
                end = at + (found.trailing_zeros() / 8) as usize + 1;
                break;
            }
            at += 8;
        }
        if end == data.len()
            && let Some(i) = data[at..].iter().position(|c| *c == b'\n')
        {
            end = at + i + 1;
        }
        self.0 = &data[end..];
        Some(&data[..end])
    }
}

fn bogosqrt(mut n: isize) -> isize {
    let mut i = 1;
    while n > 0 {
        i <<= 1;
        n >>= 2;
    }
    i
}

/// git 自己的 `isspace`（ctype.c `sane_ctype`）：只有 `\t` `\n` `\r` 和空格，不含 `\v` `\f`
fn is_space(c: u8) -> bool {
    matches!(c, b'\t' | b'\n' | b'\r' | b' ')
}

/// 两份内容相同的开头有多少字节（按块比较，块内再逐字节）
fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    const BLOCK: usize = 256;
    let limit = a.len().min(b.len());
    let mut at = 0;
    while at + BLOCK <= limit && a[at..at + BLOCK] == b[at..at + BLOCK] {
        at += BLOCK;
    }
    at + a[at..limit].iter().zip(&b[at..limit]).position(|(x, y)| x != y).unwrap_or(limit - at)
}

/// 两边的记录与每个类在两边各出现几次（`len1` / `len2`）
type Classified<'a> = (Vec<Record<'a>>, Vec<Record<'a>>, Vec<[isize; 2]>);

/// `xdl_prepare_env` 的分类（`xdl_classify_record`）：相同内容的行同一类。两边逐字节相同的开头
/// （到换行为止）每行只分类一次、两边各记一次；类号仍与 git 先分类 a 的全部行、再分类 b 的顺序相同——
/// a 的开头本来就最先分类，b 的开头和它逐行相同，不会产生新类。
fn classify<'a>(a: &'a [u8], b: &'a [u8]) -> Classified<'a> {
    let mut classes = LineClasses::default();
    classes.reserve((a.len() + b.len()) / 32);
    let mut counts: Vec<[isize; 2]> = Vec::new();
    let mut class_of = |line: &'a [u8], seen: [isize; 2]| {
        let next = classes.len();
        let class = *classes.entry(line).or_insert(next);
        if class == counts.len() {
            counts.push([0, 0]);
        }
        counts[class][0] += seen[0];
        counts[class][1] += seen[1];
        class
    };
    let head = a[..common_prefix(a, b)].iter().rposition(|c| *c == b'\n').map_or(0, |i| i + 1);
    let estimate = |data: &[u8]| data.len() / 32 + 1;
    let mut recs1: Vec<Record<'a>> = Vec::with_capacity(estimate(a));
    let mut recs2: Vec<Record<'a>> = Vec::with_capacity(estimate(b));
    let mut at = 0;
    for line in Lines(&a[..head]) {
        let class = class_of(line, [1, 1]);
        recs1.push(Record { data: line, class });
        recs2.push(Record { data: &b[at..at + line.len()], class });
        at += line.len();
    }
    for (data, recs, seen) in [(a, &mut recs1, [1, 0]), (b, &mut recs2, [0, 1])] {
        for line in Lines(&data[head..]) {
            let class = class_of(line, seen);
            recs.push(Record { data: line, class });
        }
    }
    (recs1, recs2, counts)
}

/// `xdl_prepare_env`：两边一起分类，再首尾裁剪、丢掉对面没有的行。
fn prepare<'a>(a: &'a [u8], b: &'a [u8]) -> (XdFile<'a>, XdFile<'a>) {
    let (recs1, recs2, counts) = classify(a, b);
    let file = |recs: Vec<Record<'a>>| {
        let n = recs.len();
        XdFile { recs, changed: vec![false; n + 2], reference_index: Vec::new(), dstart: 0, dend: n as isize - 1 }
    };
    let (mut x1, mut x2) = (file(recs1), file(recs2));

    // xdl_trim_ends
    let lim = x1.recs.len().min(x2.recs.len());
    let mut i = 0;
    while i < lim && x1.recs[i].class == x2.recs[i].class {
        i += 1;
    }
    x1.dstart = i as isize;
    x2.dstart = i as isize;
    let lim = lim - i;
    let mut j = 0;
    while j < lim && x1.recs[x1.recs.len() - 1 - j].class == x2.recs[x2.recs.len() - 1 - j].class {
        j += 1;
    }
    x1.dend = x1.nrec() - j as isize - 1;
    x2.dend = x2.nrec() - j as isize - 1;

    // xdl_cleanup_records（不带 XDF_NEED_MINIMAL）
    let actions = |x: &XdFile, other: usize| {
        let mut action = vec![DISCARD; x.recs.len() + 1];
        let mlim = bogosqrt(x.nrec()).min(XDL_MAX_EQLIMIT);
        for i in x.dstart..=x.dend {
            let nm = counts[x.recs[i as usize].class][other];
            action[i as usize] = if nm == 0 {
                DISCARD
            } else if nm >= mlim {
                INVESTIGATE
            } else {
                KEEP
            };
        }
        action
    };
    let action1 = actions(&x1, 1);
    let action2 = actions(&x2, 0);
    for (x, action) in [(&mut x1, &action1), (&mut x2, &action2)] {
        for i in x.dstart..=x.dend {
            let a = action[i as usize];
            if a == KEEP || (a == INVESTIGATE && !clean_mmatch(action, i, x.dstart, x.dend)) {
                x.reference_index.push(i);
            } else {
                x.set_changed(i, true);
            }
        }
    }
    (x1, x2)
}

/// `xdl_clean_mmatch`
fn clean_mmatch(action: &[u8], i: isize, mut s: isize, mut e: isize) -> bool {
    if i - s > XDL_SIMSCAN_WINDOW {
        s = i - XDL_SIMSCAN_WINDOW;
    }
    if e - i > XDL_SIMSCAN_WINDOW {
        e = i + XDL_SIMSCAN_WINDOW;
    }
    let (mut rdis0, mut rpdis0) = (0, 1);
    let mut r = 1;
    while i - r >= s {
        match action[(i - r) as usize] {
            DISCARD => rdis0 += 1,
            INVESTIGATE => rpdis0 += 1,
            _ => break,
        }
        r += 1;
    }
    if rdis0 == 0 {
        return false;
    }
    let (mut rdis1, mut rpdis1) = (0, 1);
    r = 1;
    while i + r <= e {
        match action[(i + r) as usize] {
            DISCARD => rdis1 += 1,
            INVESTIGATE => rpdis1 += 1,
            _ => break,
        }
        r += 1;
    }
    if rdis1 == 0 {
        return false;
    }
    rdis1 += rdis0;
    rpdis1 += rpdis0;
    rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1
}

struct Split {
    i1: isize,
    i2: isize,
    min_lo: bool,
    min_hi: bool,
}

/// C 里 `kvdf`/`kvdb` 允许负下标，这里统一加上 `offset`
struct Kv {
    data: Vec<isize>,
    offset: isize,
}

impl std::ops::Index<isize> for Kv {
    type Output = isize;
    fn index(&self, i: isize) -> &isize {
        &self.data[(i + self.offset) as usize]
    }
}

impl std::ops::IndexMut<isize> for Kv {
    fn index_mut(&mut self, i: isize) -> &mut isize {
        &mut self.data[(i + self.offset) as usize]
    }
}

struct AlgoEnv {
    mxcost: isize,
}

/// `xdl_split`
#[allow(clippy::too_many_arguments)]
fn split(
    x1: &XdFile, off1: isize, lim1: isize, x2: &XdFile, off2: isize, lim2: isize, kvdf: &mut Kv, kvdb: &mut Kv,
    need_min: bool, env: &AlgoEnv,
) -> Split {
    let dmin = off1 - lim2;
    let dmax = lim1 - off2;
    let fmid = off1 - off2;
    let bmid = lim1 - lim2;
    let odd = (fmid - bmid) & 1 != 0;
    let (mut fmin, mut fmax) = (fmid, fmid);
    let (mut bmin, mut bmax) = (bmid, bmid);

    kvdf[fmid] = off1;
    kvdb[bmid] = lim1;

    let mut ec: isize = 1;
    loop {
        let mut got_snake = false;

        if fmin > dmin {
            fmin -= 1;
            kvdf[fmin - 1] = -1;
        } else {
            fmin += 1;
        }
        if fmax < dmax {
            fmax += 1;
            kvdf[fmax + 1] = -1;
        } else {
            fmax -= 1;
        }

        let mut d = fmax;
        while d >= fmin {
            let mut i1 = if kvdf[d - 1] >= kvdf[d + 1] { kvdf[d - 1] + 1 } else { kvdf[d + 1] };
            let prev1 = i1;
            let mut i2 = i1 - d;
            while i1 < lim1 && i2 < lim2 && x1.hash(i1) == x2.hash(i2) {
                i1 += 1;
                i2 += 1;
            }
            if i1 - prev1 > XDL_SNAKE_CNT {
                got_snake = true;
            }
            kvdf[d] = i1;
            if odd && bmin <= d && d <= bmax && kvdb[d] <= i1 {
                return Split { i1, i2, min_lo: true, min_hi: true };
            }
            d -= 2;
        }

        if bmin > dmin {
            bmin -= 1;
            kvdb[bmin - 1] = XDL_LINE_MAX;
        } else {
            bmin += 1;
        }
        if bmax < dmax {
            bmax += 1;
            kvdb[bmax + 1] = XDL_LINE_MAX;
        } else {
            bmax -= 1;
        }

        let mut d = bmax;
        while d >= bmin {
            let mut i1 = if kvdb[d - 1] < kvdb[d + 1] { kvdb[d - 1] } else { kvdb[d + 1] - 1 };
            let prev1 = i1;
            let mut i2 = i1 - d;
            while i1 > off1 && i2 > off2 && x1.hash(i1 - 1) == x2.hash(i2 - 1) {
                i1 -= 1;
                i2 -= 1;
            }
            if prev1 - i1 > XDL_SNAKE_CNT {
                got_snake = true;
            }
            kvdb[d] = i1;
            if !odd && fmin <= d && d <= fmax && i1 <= kvdf[d] {
                return Split { i1, i2, min_lo: true, min_hi: true };
            }
            d -= 2;
        }

        if need_min {
            ec += 1;
            continue;
        }

        if got_snake && ec > XDL_HEUR_MIN_COST {
            let mut best = 0;
            let mut found = (0, 0);
            let mut d = fmax;
            while d >= fmin {
                let dd = if d > fmid { d - fmid } else { fmid - d };
                let i1 = kvdf[d];
                let i2 = i1 - d;
                let v = (i1 - off1) + (i2 - off2) - dd;
                if v > XDL_K_HEUR * ec
                    && v > best
                    && off1 + XDL_SNAKE_CNT <= i1
                    && i1 < lim1
                    && off2 + XDL_SNAKE_CNT <= i2
                    && i2 < lim2
                {
                    let mut k = 1;
                    while x1.hash(i1 - k) == x2.hash(i2 - k) {
                        if k == XDL_SNAKE_CNT {
                            best = v;
                            found = (i1, i2);
                            break;
                        }
                        k += 1;
                    }
                }
                d -= 2;
            }
            if best > 0 {
                return Split { i1: found.0, i2: found.1, min_lo: true, min_hi: false };
            }

            best = 0;
            let mut d = bmax;
            while d >= bmin {
                let dd = if d > bmid { d - bmid } else { bmid - d };
                let i1 = kvdb[d];
                let i2 = i1 - d;
                let v = (lim1 - i1) + (lim2 - i2) - dd;
                if v > XDL_K_HEUR * ec
                    && v > best
                    && off1 < i1
                    && i1 <= lim1 - XDL_SNAKE_CNT
                    && off2 < i2
                    && i2 <= lim2 - XDL_SNAKE_CNT
                {
                    let mut k = 0;
                    while x1.hash(i1 + k) == x2.hash(i2 + k) {
                        if k == XDL_SNAKE_CNT - 1 {
                            best = v;
                            found = (i1, i2);
                            break;
                        }
                        k += 1;
                    }
                }
                d -= 2;
            }
            if best > 0 {
                return Split { i1: found.0, i2: found.1, min_lo: false, min_hi: true };
            }
        }

        if ec >= env.mxcost {
            let (mut fbest, mut fbest1) = (-1, -1);
            let mut d = fmax;
            while d >= fmin {
                let mut i1 = kvdf[d].min(lim1);
                let mut i2 = i1 - d;
                if lim2 < i2 {
                    i1 = lim2 + d;
                    i2 = lim2;
                }
                if fbest < i1 + i2 {
                    fbest = i1 + i2;
                    fbest1 = i1;
                }
                d -= 2;
            }
            let (mut bbest, mut bbest1) = (XDL_LINE_MAX, XDL_LINE_MAX);
            let mut d = bmax;
            while d >= bmin {
                let mut i1 = off1.max(kvdb[d]);
                let mut i2 = i1 - d;
                if i2 < off2 {
                    i1 = off2 + d;
                    i2 = off2;
                }
                if i1 + i2 < bbest {
                    bbest = i1 + i2;
                    bbest1 = i1;
                }
                d -= 2;
            }
            return if (lim1 + lim2) - bbest < fbest - (off1 + off2) {
                Split { i1: fbest1, i2: fbest - fbest1, min_lo: true, min_hi: false }
            } else {
                Split { i1: bbest1, i2: bbest - bbest1, min_lo: false, min_hi: true }
            };
        }
        ec += 1;
    }
}

/// `xdl_recs_cmp`。C 是递归；各子盒标记的行互不相交，`kvdf`/`kvdb` 每次 split 都从头初始化，
/// 所以改成显式栈不改变结果，只是避免超长文件把线程栈压爆。
fn recs_cmp(x1: &mut XdFile, x2: &mut XdFile, kvdf: &mut Kv, kvdb: &mut Kv, env: &AlgoEnv) {
    let mut stack = vec![(0, x1.nreff(), 0, x2.nreff(), false)];
    while let Some((mut off1, mut lim1, mut off2, mut lim2, need_min)) = stack.pop() {
        while off1 < lim1 && off2 < lim2 && x1.hash(off1) == x2.hash(off2) {
            off1 += 1;
            off2 += 1;
        }
        while off1 < lim1 && off2 < lim2 && x1.hash(lim1 - 1) == x2.hash(lim2 - 1) {
            lim1 -= 1;
            lim2 -= 1;
        }
        if off1 == lim1 {
            for i in off2..lim2 {
                let r = x2.reference_index[i as usize];
                x2.set_changed(r, true);
            }
        } else if off2 == lim2 {
            for i in off1..lim1 {
                let r = x1.reference_index[i as usize];
                x1.set_changed(r, true);
            }
        } else {
            let spl = split(x1, off1, lim1, x2, off2, lim2, kvdf, kvdb, need_min, env);
            stack.push((spl.i1, lim1, spl.i2, lim2, spl.min_hi));
            stack.push((off1, spl.i1, off2, spl.i2, spl.min_lo));
        }
    }
}

/// `get_indent`
fn get_indent(rec: &[u8]) -> i32 {
    let mut ret = 0;
    for &c in rec {
        if !is_space(c) {
            return ret;
        } else if c == b' ' {
            ret += 1;
        } else if c == b'\t' {
            ret += 8 - ret % 8;
        }
        if ret >= MAX_INDENT {
            return MAX_INDENT;
        }
    }
    -1
}

#[derive(Default)]
struct SplitMeasurement {
    end_of_file: bool,
    indent: i32,
    pre_blank: i32,
    pre_indent: i32,
    post_blank: i32,
    post_indent: i32,
}

#[derive(Clone, Copy, Default)]
struct SplitScore {
    effective_indent: i32,
    penalty: i32,
}

fn measure_split(x: &XdFile, split: isize) -> SplitMeasurement {
    let mut m = SplitMeasurement::default();
    if split >= x.nrec() {
        m.end_of_file = true;
        m.indent = -1;
    } else {
        m.indent = get_indent(x.recs[split as usize].data);
    }
    m.pre_indent = -1;
    let mut i = split - 1;
    while i >= 0 {
        m.pre_indent = get_indent(x.recs[i as usize].data);
        if m.pre_indent != -1 {
            break;
        }
        m.pre_blank += 1;
        if m.pre_blank == MAX_BLANKS {
            m.pre_indent = 0;
            break;
        }
        i -= 1;
    }
    m.post_indent = -1;
    let mut i = split + 1;
    while i < x.nrec() {
        m.post_indent = get_indent(x.recs[i as usize].data);
        if m.post_indent != -1 {
            break;
        }
        m.post_blank += 1;
        if m.post_blank == MAX_BLANKS {
            m.post_indent = 0;
            break;
        }
        i += 1;
    }
    m
}

fn score_add_split(m: &SplitMeasurement, s: &mut SplitScore) {
    if m.pre_indent == -1 && m.pre_blank == 0 {
        s.penalty += START_OF_FILE_PENALTY;
    }
    if m.end_of_file {
        s.penalty += END_OF_FILE_PENALTY;
    }
    let post_blank = if m.indent == -1 { 1 + m.post_blank } else { 0 };
    let total_blank = m.pre_blank + post_blank;
    s.penalty += TOTAL_BLANK_WEIGHT * total_blank;
    s.penalty += POST_BLANK_WEIGHT * post_blank;
    let indent = if m.indent != -1 { m.indent } else { m.post_indent };
    let any_blanks = total_blank != 0;
    s.effective_indent += indent;
    if indent == -1 || m.pre_indent == -1 {
    } else if indent > m.pre_indent {
        s.penalty += if any_blanks { RELATIVE_INDENT_WITH_BLANK_PENALTY } else { RELATIVE_INDENT_PENALTY };
    } else if indent == m.pre_indent {
    } else if m.post_indent != -1 && m.post_indent > indent {
        s.penalty += if any_blanks { RELATIVE_OUTDENT_WITH_BLANK_PENALTY } else { RELATIVE_OUTDENT_PENALTY };
    } else {
        s.penalty += if any_blanks { RELATIVE_DEDENT_WITH_BLANK_PENALTY } else { RELATIVE_DEDENT_PENALTY };
    }
}

fn score_cmp(s1: &SplitScore, s2: &SplitScore) -> i32 {
    let cmp_indents =
        (s1.effective_indent > s2.effective_indent) as i32 - (s1.effective_indent < s2.effective_indent) as i32;
    INDENT_WEIGHT * cmp_indents + (s1.penalty - s2.penalty)
}

#[derive(Clone, Copy)]
struct Group {
    start: isize,
    end: isize,
}

fn group_init(x: &XdFile) -> Group {
    let mut g = Group { start: 0, end: 0 };
    while x.changed(g.end) {
        g.end += 1;
    }
    g
}

fn group_next(x: &XdFile, g: &mut Group) -> bool {
    if g.end == x.nrec() {
        return false;
    }
    g.start = g.end + 1;
    g.end = g.start;
    while x.changed(g.end) {
        g.end += 1;
    }
    true
}

fn group_previous(x: &XdFile, g: &mut Group) -> bool {
    if g.start == 0 {
        return false;
    }
    g.end = g.start - 1;
    g.start = g.end;
    while x.changed(g.start - 1) {
        g.start -= 1;
    }
    true
}

fn group_slide_down(x: &mut XdFile, g: &mut Group) -> bool {
    if g.end < x.nrec() && x.recs[g.start as usize].class == x.recs[g.end as usize].class {
        x.set_changed(g.start, false);
        g.start += 1;
        x.set_changed(g.end, true);
        g.end += 1;
        while x.changed(g.end) {
            g.end += 1;
        }
        true
    } else {
        false
    }
}

fn group_slide_up(x: &mut XdFile, g: &mut Group) -> bool {
    if g.start > 0 && x.recs[(g.start - 1) as usize].class == x.recs[(g.end - 1) as usize].class {
        g.start -= 1;
        x.set_changed(g.start, true);
        g.end -= 1;
        x.set_changed(g.end, false);
        while x.changed(g.start - 1) {
            g.start -= 1;
        }
        true
    } else {
        false
    }
}

/// `xdl_change_compact`（Myers + XDF_INDENT_HEURISTIC；histogram 才有的重新比较不会走到）。
/// C 里组同步失败是 BUG()，这里同样当不变量处理。
fn change_compact(x: &mut XdFile, xo: &XdFile) {
    let mut g = group_init(x);
    let mut go = group_init(xo);
    loop {
        if g.end != g.start {
            let mut groupsize;
            let mut earliest_end;
            let mut end_matching_other;
            loop {
                groupsize = g.end - g.start;
                end_matching_other = -1;
                while group_slide_up(x, &mut g) {
                    assert!(group_previous(xo, &mut go), "group sync broken sliding up");
                }
                earliest_end = g.end;
                if go.end > go.start {
                    end_matching_other = g.end;
                }
                loop {
                    if !group_slide_down(x, &mut g) {
                        break;
                    }
                    assert!(group_next(xo, &mut go), "group sync broken sliding down");
                    if go.end > go.start {
                        end_matching_other = g.end;
                    }
                }
                if groupsize == g.end - g.start {
                    break;
                }
            }

            if g.end == earliest_end {
            } else if end_matching_other != -1 {
                while go.end == go.start {
                    assert!(group_slide_up(x, &mut g), "match disappeared");
                    assert!(group_previous(xo, &mut go), "group sync broken sliding to match");
                }
            } else {
                let mut shift = earliest_end;
                if g.end - groupsize - 1 > shift {
                    shift = g.end - groupsize - 1;
                }
                if g.end - INDENT_HEURISTIC_MAX_SLIDING > shift {
                    shift = g.end - INDENT_HEURISTIC_MAX_SLIDING;
                }
                let mut best_shift = -1;
                let mut best_score = SplitScore::default();
                while shift <= g.end {
                    let mut score = SplitScore::default();
                    score_add_split(&measure_split(x, shift), &mut score);
                    score_add_split(&measure_split(x, shift - groupsize), &mut score);
                    if best_shift == -1 || score_cmp(&score, &best_score) <= 0 {
                        best_score = score;
                        best_shift = shift;
                    }
                    shift += 1;
                }
                while g.end > best_shift {
                    assert!(group_slide_up(x, &mut g), "best shift unreached");
                    assert!(group_previous(xo, &mut go), "group sync broken sliding to blank line");
                }
            }
        }
        if !group_next(x, &mut g) {
            break;
        }
        assert!(group_next(xo, &mut go), "group sync broken moving to next group");
    }
    assert!(!group_next(xo, &mut go), "group sync broken at end of file");
}

#[derive(Clone, Copy)]
struct Change {
    i1: isize,
    i2: isize,
    chg1: isize,
    chg2: isize,
}

/// `xdl_build_script`：从尾到头收集，头插，所以结果是升序。
fn build_script(x1: &XdFile, x2: &XdFile) -> Vec<Change> {
    let mut out = Vec::new();
    let (mut i1, mut i2) = (x1.nrec(), x2.nrec());
    while i1 >= 0 || i2 >= 0 {
        if x1.changed(i1 - 1) || x2.changed(i2 - 1) {
            let l1 = i1;
            while x1.changed(i1 - 1) {
                i1 -= 1;
            }
            let l2 = i2;
            while x2.changed(i2 - 1) {
                i2 -= 1;
            }
            out.push(Change { i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
        }
        i1 -= 1;
        i2 -= 1;
    }
    out.reverse();
    out
}

/// `xdl_get_hunk`，没有可忽略的改动（`ignore` 恒为 0）：返回本块最后一个改动的下标。
fn get_hunk(changes: &[Change], start: usize) -> usize {
    let max_common = CONTEXT + CONTEXT + INTER_HUNK_CONTEXT;
    let mut last = start;
    let mut prev = start;
    for next in start + 1..changes.len() {
        let distance = changes[next].i1 - (changes[prev].i1 + changes[prev].chg1);
        if distance > max_common {
            break;
        }
        // 没有可忽略的改动时，C 里距离不超过 max_common 的几条分支都落到 `lxch = xch`
        last = next;
        prev = next;
    }
    last
}

/// `def_ff`：以字母、`_` 或 `$` 开头的行就是「函数行」，最多取 80 字节再去掉尾部空白。
fn def_ff(rec: &[u8]) -> Option<&[u8]> {
    let first = *rec.first()?;
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b'$') {
        return None;
    }
    let mut len = rec.len().min(80);
    while len > 0 && is_space(rec[len - 1]) {
        len -= 1;
    }
    Some(&rec[..len])
}

fn emit_record(out: &mut Vec<u8>, prefix: u8, rec: &[u8]) {
    out.push(prefix);
    out.extend_from_slice(rec);
    if rec.last().is_some_and(|&b| b != b'\n') {
        out.extend_from_slice(b"\n\\ No newline at end of file\n");
    }
}

fn push_number(buf: &mut Vec<u8>, value: isize) {
    buf.extend_from_slice(value.to_string().as_bytes());
}

/// `xdl_format_hunk_hdr`（128 字节缓冲区里放不下的函数名截掉），再经 diff.c 的
/// `sane_truncate_line`：从第一个 git 认为不合法的 UTF-8 处截断，`emit_hunk_header`
/// 不带颜色时原样输出并补上行尾。
fn hunk_header(out: &mut Vec<u8>, s1: isize, c1: isize, s2: isize, c2: isize, func: &[u8]) {
    let mut buf = Vec::with_capacity(128);
    buf.extend_from_slice(b"@@ -");
    push_number(&mut buf, if c1 != 0 { s1 } else { s1 - 1 });
    if c1 != 1 {
        buf.push(b',');
        push_number(&mut buf, c1);
    }
    buf.extend_from_slice(b" +");
    push_number(&mut buf, if c2 != 0 { s2 } else { s2 - 1 });
    if c2 != 1 {
        buf.push(b',');
        push_number(&mut buf, c2);
    }
    buf.extend_from_slice(b" @@");
    if !func.is_empty() {
        buf.push(b' ');
        let room = 128 - buf.len() - 1;
        buf.extend_from_slice(&func[..func.len().min(room)]);
    }
    buf.push(b'\n');
    let valid = git_utf8_prefix(&buf);
    out.extend_from_slice(&buf[..valid]);
    if out.last() != Some(&b'\n') {
        out.push(b'\n');
    }
}

/// utf8.c `pick_one_utf8_char` 逐字符扫描，返回合法前缀的长度。和 Rust 的 UTF-8 校验不同，
/// git 还拒绝 U+FFFE、U+FFFF。
pub fn git_utf8_prefix(s: &[u8]) -> usize {
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let b0 = rest[0];
        let cont = |k: usize| rest.get(k).is_some_and(|&b| b & 0xc0 == 0x80);
        let incr = if b0 < 0x80 {
            1
        } else if b0 & 0xe0 == 0xc0 {
            if rest.len() < 2 || !cont(1) || b0 & 0xfe == 0xc0 {
                break;
            }
            2
        } else if b0 & 0xf0 == 0xe0 {
            if rest.len() < 3
                || !cont(1)
                || !cont(2)
                || (b0 == 0xe0 && rest[1] & 0xe0 == 0x80)
                || (b0 == 0xed && rest[1] & 0xe0 == 0xa0)
                || (b0 == 0xef && rest[1] == 0xbf && rest[2] & 0xfe == 0xbe)
            {
                break;
            }
            3
        } else if b0 & 0xf8 == 0xf0 {
            if rest.len() < 4
                || !cont(1)
                || !cont(2)
                || !cont(3)
                || (b0 == 0xf0 && rest[1] & 0xf0 == 0x80)
                || (b0 == 0xf4 && rest[1] > 0x8f)
                || b0 > 0xf4
            {
                break;
            }
            4
        } else {
            break;
        };
        i += incr;
    }
    i
}

/// `xdl_diff` + `xdl_emit_diff`（XDL_EMIT_FUNCNAMES）：返回从第一个 `@@` 开始的补丁正文，
/// 两边相同时为空。
pub fn unified_diff(a: &[u8], b: &[u8]) -> Vec<u8> {
    let (mut x1, mut x2) = prepare(a, b);
    let ndiags = x1.nreff() + x2.nreff() + 3;
    let offset = x2.nreff() + 1;
    let mut kvdf = Kv { data: vec![0; ndiags as usize], offset };
    let mut kvdb = Kv { data: vec![0; ndiags as usize], offset };
    let env = AlgoEnv { mxcost: bogosqrt(ndiags).max(XDL_MAX_COST_MIN) };
    recs_cmp(&mut x1, &mut x2, &mut kvdf, &mut kvdb, &env);
    change_compact(&mut x1, &x2);
    change_compact(&mut x2, &x1);
    let changes = build_script(&x1, &x2);

    let mut out = Vec::new();
    let mut func_line: &[u8] = &[];
    let mut funclineprev: isize = -1;
    let mut index = 0;
    while index < changes.len() {
        let last = get_hunk(&changes, index);
        let (xch, xche) = (changes[index], changes[last]);
        let mut s1 = (xch.i1 - CONTEXT).max(0);
        let mut s2 = (xch.i2 - CONTEXT).max(0);
        let lctx = CONTEXT.min(x1.nrec() - (xche.i1 + xche.chg1)).min(x2.nrec() - (xche.i2 + xche.chg2));
        let e1 = xche.i1 + xche.chg1 + lctx;
        let e2 = xche.i2 + xche.chg2 + lctx;

        // get_func_line(s1 - 1 → funclineprev)：找不到时沿用上一块的函数名
        let start = s1 - 1;
        let step = if start > funclineprev { -1 } else { 1 };
        let mut l = start;
        while l != funclineprev && 0 <= l && l < x1.nrec() {
            if let Some(func) = def_ff(x1.recs[l as usize].data) {
                func_line = func;
                break;
            }
            l += step;
        }
        funclineprev = s1 - 1;

        hunk_header(&mut out, s1 + 1, e1 - s1, s2 + 1, e2 - s2, func_line);

        while s2 < xch.i2 {
            emit_record(&mut out, b' ', x2.recs[s2 as usize].data);
            s2 += 1;
        }
        s1 = xch.i1;
        s2 = xch.i2;
        for change in &changes[index..=last] {
            while s1 < change.i1 && s2 < change.i2 {
                emit_record(&mut out, b' ', x2.recs[s2 as usize].data);
                s1 += 1;
                s2 += 1;
            }
            for i in change.i1..change.i1 + change.chg1 {
                emit_record(&mut out, b'-', x1.recs[i as usize].data);
            }
            for i in change.i2..change.i2 + change.chg2 {
                emit_record(&mut out, b'+', x2.recs[i as usize].data);
            }
            s1 = change.i1 + change.chg1;
            s2 = change.i2 + change.chg2;
        }
        for i in xche.i2 + xche.chg2..e2 {
            emit_record(&mut out, b' ', x2.recs[i as usize].data);
        }
        index = last + 1;
    }
    out
}

/// xdiff-interface.c `trim_common_tail`：零上下文时 `xdi_diff` 先按 1 KB 块裁掉两边相同的尾部，
/// 再把裁掉部分里第一个换行（含）之前的字节还回去，两边剩下的部分都结束在行边界上。
/// 返回两边各自裁掉的字节数（两边相同）。
fn trim_common_tail(a: &[u8], b: &[u8]) -> usize {
    const BLK: usize = 1024;
    let smaller = a.len().min(b.len());
    let mut trimmed = 0;
    while BLK + trimmed <= smaller
        && a[a.len() - trimmed - BLK..a.len() - trimmed] == b[b.len() - trimmed - BLK..b.len() - trimmed]
    {
        trimmed += BLK;
    }
    let ap = a.len() - trimmed;
    let mut recovered = 0;
    while recovered < trimmed {
        let byte = a[ap + recovered];
        recovered += 1;
        if byte == b'\n' {
            break;
        }
    }
    trimmed - recovered
}

/// blame.c `diff_hunks`：`xdi_diff`（零上下文，先 `trim_common_tail`）加 `xdl_diff` 的
/// `xdl_call_hunk_func`。上下文为 0 时 `xdl_get_hunk` 不合并任何两个改动（改动之间至少隔着一行
/// 相同的），每个改动就是一块：`[start_a, count_a, start_b, count_b]`，行号从 0 数。
/// 选项与 `git blame` 默认相同：Myers（不带 `--minimal`）+ 缩进启发。
pub fn blame_hunks(a: &[u8], b: &[u8]) -> Vec<[usize; 4]> {
    let trimmed = trim_common_tail(a, b);
    let (a, b) = (&a[..a.len() - trimmed], &b[..b.len() - trimmed]);
    let (mut x1, mut x2) = prepare(a, b);
    let ndiags = x1.nreff() + x2.nreff() + 3;
    let offset = x2.nreff() + 1;
    let mut kvdf = Kv { data: vec![0; ndiags as usize], offset };
    let mut kvdb = Kv { data: vec![0; ndiags as usize], offset };
    let env = AlgoEnv { mxcost: bogosqrt(ndiags).max(XDL_MAX_COST_MIN) };
    recs_cmp(&mut x1, &mut x2, &mut kvdf, &mut kvdb, &env);
    change_compact(&mut x1, &x2);
    change_compact(&mut x2, &x1);
    build_script(&x1, &x2)
        .into_iter()
        .map(|change| [change.i1 as usize, change.chg1 as usize, change.i2 as usize, change.chg2 as usize])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// 改动前的写法：逐行 memchr 切分，先 a 后 b 各自完整分类（`xdl_prepare_env` 的原样顺序）
    type Side = Vec<(Vec<u8>, usize)>;

    fn reference(a: &[u8], b: &[u8]) -> (Side, Side, Vec<[isize; 2]>) {
        let mut classes: std::collections::HashMap<Vec<u8>, usize> = std::collections::HashMap::new();
        let mut counts: Vec<[isize; 2]> = Vec::new();
        let mut sides = [Vec::new(), Vec::new()];
        for (pass, data) in [a, b].into_iter().enumerate() {
            let mut rest = data;
            while !rest.is_empty() {
                let end = gix::bstr::ByteSlice::find_byte(rest, b'\n').map_or(rest.len(), |i| i + 1);
                let line = rest[..end].to_vec();
                rest = &rest[end..];
                let next = classes.len();
                let class = *classes.entry(line.clone()).or_insert(next);
                if class == counts.len() {
                    counts.push([0, 0]);
                }
                counts[class][pass] += 1;
                sides[pass].push((line, class));
            }
        }
        let [one, two] = sides;
        (one, two, counts)
    }

    fn random_text(rng: &mut Rng) -> Vec<u8> {
        const LINES: [&[u8]; 8] = [b"", b"}", b"    let x = 1;", b"fn main() {", b"a", b"0123456", b"01234567", b"\r"];
        let mut out = Vec::new();
        for _ in 0..rng.below(40) {
            out.extend_from_slice(LINES[rng.below(LINES.len())]);
            if rng.below(6) == 0 {
                out.extend(std::iter::repeat_n(b'x', rng.below(20)));
            }
            out.push(b'\n');
        }
        if !out.is_empty() && rng.below(3) == 0 {
            out.pop();
        }
        out
    }

    /// 在 a 的基础上改一处，留下长短不一的相同开头（包括半行相同、一边是另一边的开头）
    fn edit(rng: &mut Rng, a: &[u8]) -> Vec<u8> {
        let mut b = a.to_vec();
        match rng.below(5) {
            0 => b.truncate(rng.below(b.len() + 1)),
            1 => b.extend_from_slice(&random_text(rng)),
            _ => {
                let at = rng.below(b.len() + 1);
                let end = (at + rng.below(30)).min(b.len());
                let insert = random_text(rng);
                let take = rng.below(50);
                b.splice(at..end, insert.into_iter().take(take));
            }
        }
        b
    }

    #[test]
    fn 切行与逐字节查换行一致() {
        let mut rng = Rng(0x2545_f491_4f6c_dd1d);
        for _ in 0..5000 {
            let len = rng.below(70);
            let data: Vec<u8> = (0..len).map(|_| if rng.below(9) == 0 { b'\n' } else { rng.next() as u8 }).collect();
            let ours: Vec<&[u8]> = Lines(&data).collect();
            let expected: Vec<&[u8]> = data.split_inclusive(|c| *c == b'\n').collect();
            assert_eq!(ours, expected, "{data:?}");
        }
    }

    #[test]
    fn 相同开头的长度() {
        let mut rng = Rng(7);
        for _ in 0..3000 {
            let a: Vec<u8> = (0..rng.below(1200)).map(|_| b'a' + rng.below(2) as u8).collect();
            let mut b = a.clone();
            if !b.is_empty() && rng.below(4) != 0 {
                let at = rng.below(b.len());
                b[at] ^= 1;
            }
            b.truncate(rng.below(b.len() + 2).min(b.len()));
            let expected = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
            assert_eq!(common_prefix(&a, &b), expected);
        }
    }

    #[test]
    fn 共同开头只分类一次与两边完整分类相同() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let mut shared_heads = 0;
        for round in 0..5000 {
            let a = random_text(&mut rng);
            let b = if round % 4 == 0 { a.clone() } else { edit(&mut rng, &a) };
            let (a, b) = if round % 2 == 0 { (a, b) } else { (b, a) };
            let (recs1, recs2, counts) = classify(&a, &b);
            let (one, two, expected_counts) = reference(&a, &b);
            let flat = |recs: &[Record]| recs.iter().map(|r| (r.data.to_vec(), r.class)).collect::<Vec<_>>();
            assert_eq!(flat(&recs1), one, "{a:?} {b:?}");
            assert_eq!(flat(&recs2), two, "{a:?} {b:?}");
            assert_eq!(counts, expected_counts, "{a:?} {b:?}");
            // 每条记录指向自己那一边的内容（输出 diff 时按它取行）
            for (recs, data) in [(&recs1, &a), (&recs2, &b)] {
                let range = data.as_ptr_range();
                assert!(recs.iter().all(|r| range.contains(&r.data.as_ptr())));
            }
            shared_heads += usize::from(!a.is_empty() && a.first() == b.first());
        }
        assert!(shared_heads > 2500, "{shared_heads}");
    }
}
