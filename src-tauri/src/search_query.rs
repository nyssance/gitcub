//! GitLens 提交搜索查询语法。
//!
//! 一比一移植 Vendor/vscode-gitlens c1f6e5f3c 的 `packages/git/src/utils/search.utils.ts`
//! （含 `models/search.ts` 的操作符表与 `revision.utils.ts` 的 `isSha` / `shortenRevision`）。
//! `parseSearchQueryGitHubCommand` 面向 GitHub 搜索 API，本项目用托管平台网页，不移植。
//!
//! 位置语义沿用 JavaScript：`operatorRanges` 以 UTF-16 码元计数，空白按 `\s` 判定，
//! 值的截断只认空格（原版 `indexOf(' ')`），`Map` / `Set` 以插入顺序的去重列表表示，
//! 序列化后桥接层只需还原类型，不必重算。

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// `searchOperators`：遍历顺序即匹配优先级，空串被跳过。
pub const SEARCH_OPERATORS: [&str; 23] = [
    "",
    "=:",
    "message:",
    "-message:",
    "@:",
    "author:",
    "committer:",
    "#:",
    "commit:",
    "?:",
    "file:",
    "~:",
    "change:",
    "is:",
    "type:",
    ">:",
    "after:",
    "since:",
    "<:",
    "before:",
    "until:",
    "^:",
    "ref:",
];

/// `searchOperatorsToLongFormMap`
pub fn long_form(operator: &str) -> Option<&'static str> {
    Some(match operator {
        "" | "=:" | "message:" => "message:",
        "-message:" => "-message:",
        "@:" | "author:" => "author:",
        "committer:" => "committer:",
        "#:" | "commit:" => "commit:",
        "?:" | "file:" => "file:",
        "~:" | "change:" => "change:",
        "is:" | "type:" => "type:",
        ">:" | "after:" | "since:" => "after:",
        "<:" | "before:" | "until:" => "before:",
        "^:" | "ref:" => "ref:",
        _ => return None,
    })
}

/// `SearchQuery`。`naturalLanguage` 原版是 `boolean | object`，这里只关心真值。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_language: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_all: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_case: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_regex: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_whole_word: Option<bool>,
}

impl SearchQuery {
    fn match_all(&self) -> bool {
        self.match_all.unwrap_or(false)
    }
    fn match_case(&self) -> bool {
        self.match_case.unwrap_or(false)
    }
    fn match_regex(&self) -> bool {
        self.match_regex.unwrap_or(false)
    }
    fn match_whole_word(&self) -> bool {
        self.match_whole_word.unwrap_or(false)
    }
    /// JavaScript 真值：`Boolean(naturalLanguage)`。
    fn natural_language(&self) -> bool {
        match &self.natural_language {
            None | Some(serde_json::Value::Null) => false,
            Some(serde_json::Value::Bool(flag)) => *flag,
            Some(serde_json::Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
            Some(serde_json::Value::String(text)) => !text.is_empty(),
            Some(serde_json::Value::Array(_) | serde_json::Value::Object(_)) => true,
        }
    }
}

/// `GitUser`：`parseSearchQueryGitCommand` 只读 `name`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GitUser {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// `Map<SearchOperatorsLongForm, Set<string>>`：按首次出现顺序的（长格式操作符，去重后的值）条目。
pub type Operations = Vec<(String, Vec<String>)>;

/// `operations.get(op)`
pub fn operation_values<'a>(operations: &'a Operations, operator: &str) -> Option<&'a Vec<String>> {
    operations.iter().find(|(key, _)| key == operator).map(|(_, values)| values)
}

fn add_operation(operations: &mut Operations, operator: &str, value: &str) {
    match operations.iter_mut().find(|(key, _)| key == operator) {
        Some((_, values)) => {
            if !values.iter().any(|existing| existing == value) {
                values.push(value.to_string());
            }
        }
        None => operations.push((operator.to_string(), vec![value.to_string()])),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorRange {
    pub start: usize,
    pub end: usize,
    /// `HighlightableOperator`：匹配到的短／长操作符，或 `@me`。
    pub operator: String,
}

/// `ParsedSearchQuery`。`errors` / `operatorRanges` 为空时与原版一样不出现。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSearchQuery {
    pub operations: Operations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_ranges: Option<Vec<OperatorRange>>,
}

/// `SearchQueryFilters`
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchQueryFilters {
    pub files: bool,
    /// 只支持 `stash` / `tip` / `wip` / `merge`；多值 `type:` 以最后解析到的为准。
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub refs: bool,
}

/// `SearchQueryGitCommand`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchQueryGitCommand {
    pub args: Vec<String>,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shas: Option<Vec<String>>,
    pub filters: SearchQueryFilters,
    pub operations: Operations,
}

/// JavaScript `\s`（与 `String.prototype.trim` 同一集合）。
fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x9..=0xD | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// `query.trim()` 后的 UTF-16 码元。
fn js_trim(text: &str) -> Vec<u16> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = units.iter().position(|unit| !is_js_whitespace(*unit)).unwrap_or(units.len());
    let end = units.iter().rposition(|unit| !is_js_whitespace(*unit)).map_or(start, |index| index + 1);
    units[start..end].to_vec()
}

fn starts_with_at(units: &[u16], pos: usize, needle: &str) -> bool {
    let needle: Vec<u16> = needle.encode_utf16().collect();
    units.len() >= pos + needle.len() && units[pos..pos + needle.len()] == needle[..]
}

/// 原版从 `pos` 取一个值：带引号取到配对引号（未闭合则到结尾），否则取到下一个空格。
fn take_value(units: &[u16], pos: &mut usize) -> String {
    const QUOTE: u16 = b'"' as u16;
    const SPACE: u16 = b' ' as u16;
    let value;
    if units.get(*pos) == Some(&QUOTE) {
        match units[*pos + 1..].iter().position(|unit| *unit == QUOTE) {
            Some(offset) => {
                let end_quote_pos = *pos + 1 + offset;
                value = String::from_utf16_lossy(&units[*pos..=end_quote_pos]);
                *pos = end_quote_pos + 1;
            }
            None => {
                value = String::from_utf16_lossy(&units[*pos..]);
                *pos = units.len();
            }
        }
    } else {
        let value_end_pos = units[*pos..].iter().position(|unit| *unit == SPACE).map_or(units.len(), |o| *pos + o);
        value = String::from_utf16_lossy(&units[*pos..value_end_pos]);
        *pos = value_end_pos;
    }
    value
}

/// `revision.utils.ts` 的 `isSha(rev)`（不允许短 SHA）。
pub fn is_sha(rev: &str) -> bool {
    let bytes = rev.as_bytes();
    (bytes.len() == 40 && bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        || (bytes.len() == 41 && bytes[..40].iter().all(|b| *b == b'0') && matches!(bytes[40], b':' | b'-'))
}

/// `parseSearchQuery(search, validate)`
pub fn parse_search_query(search: &SearchQuery, validate: bool) -> ParsedSearchQuery {
    let mut operations = Operations::new();
    let query = js_trim(&search.query);

    let mut errors: Option<Vec<String>> = None;
    let mut operator_ranges: Option<Vec<OperatorRange>> = None;
    let mut pos = 0;

    while pos < query.len() {
        // Skip whitespace
        if is_js_whitespace(query[pos]) {
            pos += 1;
            continue;
        }

        // Try to match an operator
        let mut matched_operator = false;
        let mut op: Option<&str> = None;
        let mut value: Option<String> = None;

        // Check for operators (starting with longer ones first to avoid partial matches)
        for operator in SEARCH_OPERATORS {
            if operator.is_empty() {
                continue;
            }

            if starts_with_at(&query, pos, operator) {
                op = Some(operator);
                let operator_start = pos;
                let start_pos = pos + operator.encode_utf16().count();
                pos = start_pos;

                // Track operator position
                operator_ranges.get_or_insert_with(Vec::new).push(OperatorRange {
                    start: operator_start,
                    end: start_pos,
                    operator: operator.to_string(),
                });

                // Skip optional space after operator
                if query.get(pos) == Some(&(b' ' as u16)) {
                    pos += 1;
                }

                // Extract the value and check if it is quoted
                value = Some(take_value(&query, &mut pos));

                matched_operator = true;
                break;
            }
        }

        if !matched_operator {
            // No operator found, parse as text
            let text_start = pos;
            let text = take_value(&query, &mut pos);

            // Handle special text tokens (@me, SHA)
            if text == "@me" {
                op = Some("author:");
                // Track @me position for highlighting
                operator_ranges.get_or_insert_with(Vec::new).push(OperatorRange {
                    start: text_start,
                    end: text_start + text.len(),
                    operator: "@me".to_string(),
                });
            } else {
                op = Some(if is_sha(&text) { "commit:" } else { "message:" });
            }
            value = Some(text);
        }

        // Validate operator has a value
        if let Some(op) = op
            && value.as_deref().is_none_or(str::is_empty)
        {
            if !validate {
                continue;
            }

            errors.get_or_insert_with(Vec::new).push(format!("'{op}' requires a value"));
        }

        // Add the discovered operation to our map
        if let (Some(op), Some(value)) = (op, value.as_deref())
            && !value.is_empty()
            && let Some(long_form_op) = long_form(op)
        {
            add_operation(&mut operations, long_form_op, value);
        }
    }

    if validate
        && operation_values(&operations, "message:").is_some_and(|values| !values.is_empty())
        && operation_values(&operations, "-message:").is_some_and(|values| !values.is_empty())
    {
        errors
            .get_or_insert_with(Vec::new)
            .push("Cannot combine 'message:' and '-message:' in the same query".to_string());
    }

    ParsedSearchQuery {
        operations,
        errors: errors.filter(|errors| !errors.is_empty()),
        operator_ranges: operator_ranges.filter(|ranges| !ranges.is_empty()),
    }
}

/// 原版每个分支开头的 `if (!value) continue; if (quoted) { value = value.slice(1, -1); if (!value) continue; }`。
fn unquote(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if value.starts_with('"') && value.ends_with('"') {
        let inner = if value.len() >= 2 { &value[1..value.len() - 1] } else { "" };
        if inner.is_empty() {
            return None;
        }
        return Some(inner.to_string());
    }
    Some(value.to_string())
}

/// 插入有序、去重的 `Set<string>`。
#[derive(Default)]
struct OrderedSet(Vec<String>);

impl OrderedSet {
    fn add(&mut self, value: impl Into<String>) {
        let value = value.into();
        if !self.0.contains(&value) {
            self.0.push(value);
        }
    }
    fn delete(&mut self, value: &str) {
        self.0.retain(|existing| existing != value);
    }
}

/// `file:` 未加引号时判断是否已含路径／通配符字符：`/[./\\*?|![\]{}]/`。
fn has_pathspec_characters(value: &str) -> bool {
    value.chars().any(|c| matches!(c, '.' | '/' | '\\' | '*' | '?' | '|' | '!' | '[' | ']' | '{' | '}'))
}

/// `parseSearchQueryGitCommand(search, currentUser)`
pub fn parse_search_query_git_command(search: &SearchQuery, current_user: Option<&GitUser>) -> SearchQueryGitCommand {
    let ParsedSearchQuery { operations, .. } = parse_search_query(search, false);

    let mut search_args = OrderedSet::default();
    let mut files: Vec<String> = Vec::new();
    let mut shas = None;
    let mut filters = SearchQueryFilters { files: false, kind: None, refs: false };

    if let Some(values) = operation_values(&operations, "commit:") {
        for value in values {
            let Some(value) = unquote(value) else { continue };
            search_args.add(value);
        }
        shas = Some(search_args.0.clone());
    } else {
        search_args.add("--all");

        for (op, values) in &operations {
            match op.as_str() {
                "message:" => {
                    if search.match_all() {
                        search_args.add("--all-match");
                    }
                    for value in values {
                        let Some(mut value) = unquote(value) else { continue };

                        if search.match_whole_word() && search.match_regex() {
                            value = format!("\\b{value}\\b");
                        }

                        search_args.add(format!("--grep={value}"));
                    }
                }

                "-message:" => {
                    // --invert-grep flips ALL --grep patterns in the command, so a query mixing positive
                    // message: terms with negative -message: terms can't be represented in one git invocation.
                    // parseSearchQuery's validate path rejects that combination up front; this is a defensive
                    // fallback for callers that skip validation -- drop the excluded terms rather than
                    // silently inverting the positive matches.
                    if operation_values(&operations, "message:").is_some_and(|values| !values.is_empty()) {
                        continue;
                    }

                    let mut has_value = false;
                    for value in values {
                        let Some(mut value) = unquote(value) else { continue };

                        if search.match_whole_word() && search.match_regex() {
                            value = format!("\\b{value}\\b");
                        }

                        search_args.add(format!("--grep={value}"));
                        has_value = true;
                    }

                    if has_value {
                        search_args.add("--invert-grep");
                    }
                }

                "author:" | "committer:" => {
                    let flag = if op == "author:" { "--author" } else { "--committer" };
                    for value in values {
                        let Some(mut value) = unquote(value) else { continue };

                        if value == "@me" {
                            let Some(name) =
                                current_user.and_then(|user| user.name.as_deref()).filter(|n| !n.is_empty())
                            else {
                                continue;
                            };

                            value = name.to_string();
                        }

                        if let Some(rest) = value.strip_prefix('@') {
                            value = rest.to_string();
                        }

                        if search.match_whole_word() && search.match_regex() {
                            value = format!("\\b{value}\\b");
                        }

                        search_args.add(format!("{flag}={value}"));
                    }
                }

                "type:" => {
                    for value in values {
                        let Some(value) = unquote(value) else { continue };

                        if value == "stash" {
                            filters.kind = Some("stash".to_string());
                            search_args.add("--no-walk");
                        } else if value == "tip" {
                            filters.kind = Some("tip".to_string());
                        } else if value == "wip" {
                            filters.kind = Some("wip".to_string());
                        } else if value == "merge" {
                            filters.kind = Some("merge".to_string());
                            search_args.add("--merges");
                        }
                    }
                }

                "file:" => {
                    for value in values {
                        if value.is_empty() {
                            continue;
                        }

                        if value.starts_with('"') && value.ends_with('"') {
                            let Some(value) = unquote(value) else { continue };

                            filters.files = true;
                            files.push(value);
                        } else {
                            filters.files = true;

                            let prefix = if search.match_case() { "" } else { ":(icase)" };
                            if value.contains("**") {
                                files.push(format!("{prefix}:(glob){value}"));
                            } else if has_pathspec_characters(value) {
                                files.push(format!("{prefix}{value}"));
                            } else {
                                files.push(format!("{prefix}*{value}*"));
                            }
                        }
                    }
                }

                "change:" => {
                    for value in values {
                        let Some(value) = unquote(value) else { continue };

                        filters.files = true;
                        search_args.add(if search.match_regex() { format!("-G{value}") } else { format!("-S{value}") });
                    }
                }

                "after:" | "before:" => {
                    let flag = if op == "after:" { "--since" } else { "--until" };
                    for value in values {
                        let Some(value) = unquote(value) else { continue };

                        search_args.add(format!("{flag}={value}"));
                    }
                }

                "ref:" => {
                    for value in values {
                        let Some(value) = unquote(value) else { continue };

                        // A value starting with `-` would be consumed by git as an option rather than a ref
                        // (e.g. `ref:--author=x` injecting a flag), so drop it instead of passing it through
                        if value.starts_with('-') {
                            continue;
                        }

                        filters.refs = true;
                        // Replace --all with the specific ref or ref range
                        search_args.delete("--all");
                        search_args.add(value);
                    }
                }

                _ => {}
            }
        }

        // Add regex/string matching flags if we have (--grep, --author, --committer) patterns
        if search_args
            .0
            .iter()
            .any(|arg| arg.starts_with("--grep=") || arg.starts_with("--author=") || arg.starts_with("--committer="))
        {
            search_args.add(if search.match_regex() { "--extended-regexp" } else { "--fixed-strings" });
            if search.match_regex() && !search.match_case() {
                search_args.add("--regexp-ignore-case");
            }
        }
    }

    SearchQueryGitCommand { args: search_args.0, files, shas, filters, operations }
}

/// `rebuildSearchQueryFromParsed(parsed)`
#[allow(dead_code)] // Upstream entry point exercised by the GitLens conformance bridge; the app only runs searches.
pub fn rebuild_search_query_from_parsed(parsed: &ParsedSearchQuery) -> String {
    let mut parts: Vec<String> = Vec::new();

    for (operator, values) in &parsed.operations {
        for value in values {
            parts.push(format!("{operator}{value}"));
        }
    }

    parts.join(" ")
}

/// `getSearchQueryComparisonKey(search)`
#[allow(dead_code)] // Upstream entry point exercised by the GitLens conformance bridge; the app only runs searches.
pub fn get_search_query_comparison_key(search: &SearchQuery) -> String {
    format!(
        "{}|{}{}{}{}{}",
        search.query,
        if search.match_all() { "A" } else { "" },
        if search.match_case() { "C" } else { "" },
        if search.match_regex() { "R" } else { "" },
        if search.match_whole_word() { "W" } else { "" },
        if search.natural_language() { "NL" } else { "" }
    )
}

/// `areSearchQueriesEqual(a, b)`：`undefined` 与 `false` 的标志位不相等，沿用原版的 `===`。
#[allow(dead_code)] // Upstream entry point exercised by the GitLens conformance bridge; the app only runs searches.
pub fn are_search_queries_equal(a: Option<&SearchQuery>, b: Option<&SearchQuery>) -> bool {
    match (a, b) {
        (None, None) => true,
        (None, Some(_)) | (Some(_), None) => false,
        (Some(a), Some(b)) => {
            a.query == b.query
                && a.filter == b.filter
                && a.match_all == b.match_all
                && a.match_case == b.match_case
                && a.match_regex == b.match_regex
                && a.match_whole_word == b.match_whole_word
                && a.natural_language() == b.natural_language()
        }
    }
}

/// `createSearchQueryForCommit(ref)`。原版另有接受 `GitRevisionReference` 的重载，用其 `name`；
/// 这里只接受字符串引用。
#[allow(dead_code)] // Upstream entry point kept with the port; the app only runs searches.
pub fn create_search_query_for_commit(reference: &str) -> String {
    format!("#:{}", shorten_revision(reference))
}

/// `createSearchQueryForCommits(refs)`
#[allow(dead_code)] // Upstream entry point kept with the port; the app only runs searches.
pub fn create_search_query_for_commits(references: &[String]) -> String {
    references.iter().map(|r| format!("#:{}", shorten_revision(r))).collect::<Vec<_>>().join(" ")
}

const DELETED_OR_MISSING: &str = "0000000000000000000000000000000000000000-";
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";
const UNCOMMITTED_STAGED: &str = "0000000000000000000000000000000000000000:";
/// 原版的 `getAbbreviatedShaLength()` 默认值。
const ABBREVIATED_SHA_LENGTH: usize = 7;

/// JavaScript `\S`（`\s` 的补集，见 [`is_js_whitespace`]）。
const JS_NON_SPACE: &str =
    r"[^\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// `revision.utils.ts` 的 `rangeRegex`（`isRevisionRange(rev)` 的默认 `'any'` 分支）。
pub(crate) static RANGE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"^([0-9A-Za-z_\-/]+(?:\.[0-9A-Za-z_\-/]+)*)?(\.\.\.?)([0-9A-Za-z_\-/]+(?:\.[0-9A-Za-z_\-/]+)*)?$",
    )
    .expect("range regex")
});
/// `revision.utils.ts` 的 `shaWithOptionalRevisionSuffixRegex`（`isShaWithOptionalRevisionSuffix`）。
pub(crate) static SHA_WITH_OPTIONAL_REVISION_SUFFIX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(&format!(r"(^[0-9a-f]{{40}}([\^@~:]{JS_NON_SPACE}*)?$)|(^[0]{{40}}(:|-)$)")).expect("sha regex")
});
static UNCOMMITTED_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(&format!(r"^[0]{{40}}(?:[\^@~:]{JS_NON_SPACE}*)?:?$")).expect("uncommitted regex")
});
static UNCOMMITTED_STAGED_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(&format!(r"^[0]{{40}}([\^@~]{JS_NON_SPACE}*)?:$")).expect("uncommitted staged regex")
});

/// `revision.utils.ts` 的 `isUncommitted(rev)`（不带 `exact`）。
pub(crate) fn is_uncommitted(rev: &str) -> bool {
    rev == UNCOMMITTED || rev == UNCOMMITTED_STAGED || UNCOMMITTED_REGEX.is_match(rev)
}

/// `revision.utils.ts` 的 `isUncommittedStaged(rev)`（不带 `exact`）。
pub(crate) fn is_uncommitted_staged(rev: &str) -> bool {
    rev == UNCOMMITTED_STAGED || UNCOMMITTED_STAGED_REGEX.is_match(rev)
}

/// `revision.utils.ts` 的 `shortenRevision(rev)`（不带 `options`）。
pub fn shorten_revision(rev: &str) -> String {
    if rev == DELETED_OR_MISSING {
        return "(deleted)".to_string();
    }
    if rev.is_empty() {
        return String::new();
    }
    if is_uncommitted(rev) {
        return if is_uncommitted_staged(rev) { "Index" } else { "Working Tree" }.to_string();
    }
    if RANGE.is_match(rev) || !SHA_WITH_OPTIONAL_REVISION_SUFFIX.is_match(rev) {
        return rev.to_string();
    }

    // Don't allow shas to be shortened to less than 5 characters
    let len = ABBREVIATED_SHA_LENGTH.max(5);

    // If we have a suffix, append it (`/^(.*?)([\^@~:].*)?$/`)
    match rev.find(['^', '@', '~', ':']) {
        Some(index) => {
            let (rev, suffix) = rev.split_at(index);
            format!("{}{suffix}", rev.chars().take(len).collect::<String>())
        }
        None => rev.chars().take(len).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(query: &str) -> SearchQuery {
        SearchQuery { query: query.to_string(), ..Default::default() }
    }

    #[test]
    fn 操作符位置按_utf16_码元计数() {
        let parsed = parse_search_query(&q("😀 @:alice"), false);
        let ranges = parsed.operator_ranges.unwrap();
        assert_eq!((ranges[0].start, ranges[0].end), (3, 5), "表情占两个码元");
        assert_eq!(operation_values(&parsed.operations, "message:").unwrap(), &["😀".to_string()]);
    }

    #[test]
    fn 空白用_js_的集合判定而值只在空格处截断() {
        let parsed = parse_search_query(&q("\u{3000}a\tb"), false);
        assert_eq!(operation_values(&parsed.operations, "message:").unwrap(), &["a\tb".to_string()]);
    }

    #[test]
    fn 引号只有一个时视为空值() {
        let command = parse_search_query_git_command(&q("author:\""), None);
        assert!(!command.args.iter().any(|arg| arg.starts_with("--author=")));
        assert!(command.args.contains(&"--all".to_string()));
    }

    #[test]
    fn 缩短修订与原版一致() {
        assert_eq!(shorten_revision(&"a".repeat(40)), "aaaaaaa");
        assert_eq!(shorten_revision(&format!("{}^2", "b".repeat(40))), "bbbbbbb^2");
        assert_eq!(shorten_revision("main"), "main");
        assert_eq!(shorten_revision("main..dev"), "main..dev");
        assert_eq!(shorten_revision(UNCOMMITTED), "Working Tree");
        assert_eq!(shorten_revision(UNCOMMITTED_STAGED), "Index");
        assert_eq!(shorten_revision(DELETED_OR_MISSING), "(deleted)");
        assert_eq!(create_search_query_for_commits(&["c".repeat(40), "HEAD".into()]), "#:ccccccc #:HEAD");
    }
}
