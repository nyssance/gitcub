//! Windows external editors and shells, ported from Desktop `app/src/lib/editors/win32.ts`,
//! `app/src/lib/editors/launch.ts` and `app/src/lib/shells/win32.ts` (2970f9ae1).
//!
//! Only executables found through the registry entries and well-known locations Desktop checks are
//! offered; imported shell commands are never executed. Differences from Desktop:
//! - WSL is not offered: Desktop gates it behind `enableWSLDetection()`, which is beta only.
//! - Custom integrations (`launchCustomShell`, `launchCustomExternalEditor`) are not ported.
//! - The `cmd.exe` that Node's `shell: true` puts in front of a shell is started without a console
//!   window, so opening a terminal never flashes an extra one.
#![cfg_attr(not(windows), allow(dead_code, reason = "只在 Windows 上调用；其它平台靠单元测试覆盖其中的查找与拼装"))]

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Hive {
    CurrentUser,
    LocalMachine,
    ClassesRoot,
}

/// registry-js `RegistryValue`, reduced to the types Desktop looks at.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Data {
    Sz(String),
    ExpandSz(String),
    Other,
}

#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub name: String,
    pub data: Data,
}

/// registry-js `enumerateValues` / `enumerateKeys`: a missing key is an empty list.
pub(crate) trait Registry {
    fn values(&self, hive: Hive, sub_key: &str) -> Vec<Entry>;
    fn keys(&self, hive: Hive, sub_key: &str) -> Vec<String>;
}

#[cfg(windows)]
struct SystemRegistry;

#[cfg(windows)]
impl SystemRegistry {
    fn open(hive: Hive, sub_key: &str) -> Option<winreg::RegKey> {
        use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        let root = match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
            Hive::ClassesRoot => HKEY_CLASSES_ROOT,
        };
        winreg::RegKey::predef(root).open_subkey(sub_key).ok()
    }
}

#[cfg(windows)]
impl Registry for SystemRegistry {
    fn values(&self, hive: Hive, sub_key: &str) -> Vec<Entry> {
        use winreg::enums::RegType;
        use winreg::types::FromRegValue;
        let Some(key) = Self::open(hive, sub_key) else { return Vec::new() };
        key.enum_values()
            .filter_map(Result::ok)
            .map(|(name, value)| {
                let text = || String::from_reg_value(&value).ok();
                let data = match value.vtype {
                    RegType::REG_SZ => text().map_or(Data::Other, Data::Sz),
                    RegType::REG_EXPAND_SZ => text().map_or(Data::Other, Data::ExpandSz),
                    _ => Data::Other,
                };
                Entry { name, data }
            })
            .collect()
    }

    fn keys(&self, hive: Hive, sub_key: &str) -> Vec<String> {
        Self::open(hive, sub_key).map(|key| key.enum_keys().filter_map(Result::ok).collect()).unwrap_or_default()
    }
}

/// Everything the lookup reads from the machine, so tests can describe an installation.
pub(crate) struct Host<'a> {
    pub registry: &'a dyn Registry,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// `new Date().getFullYear()`.
    pub year: i32,
    /// `findGitOnPath()`.
    pub git: Option<String>,
}

// ── editors/win32.ts ────────────────────────────────────────────────────────

type RegistryKey = (Hive, String);

/// `WindowsExternalEditorPathInfo`.
enum Location {
    /// `InstallLocation` joined with each executable shim path.
    Install(Vec<Vec<String>>),
    /// `UninstallString` joined with each executable shim path.
    Uninstall(Vec<Vec<String>>),
    /// `DisplayIcon` is the executable itself.
    DisplayIcon,
}

/// `WindowsExternalEditor`.
struct Editor {
    name: String,
    registry_keys: Vec<RegistryKey>,
    display_name_prefixes: Vec<String>,
    publishers: Vec<String>,
    location: Location,
}

const UNINSTALL_SUB_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const WOW64_UNINSTALL_SUB_KEY: &str = "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

fn cu(sub_key: &str) -> RegistryKey {
    (Hive::CurrentUser, format!("{UNINSTALL_SUB_KEY}\\{sub_key}"))
}

fn lm(sub_key: &str) -> RegistryKey {
    (Hive::LocalMachine, format!("{UNINSTALL_SUB_KEY}\\{sub_key}"))
}

fn wow(sub_key: &str) -> RegistryKey {
    (Hive::LocalMachine, format!("{WOW64_UNINSTALL_SUB_KEY}\\{sub_key}"))
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn shims(paths: &[&[&str]]) -> Vec<Vec<String>> {
    paths.iter().map(|path| strings(path)).collect()
}

/// `registryKeysForJetBrainsIDE`: the last two years plus this one, at most five major and five
/// minor releases a year, newest first.
fn jetbrains_keys(product: &str, last_year: i32) -> Vec<RegistryKey> {
    let mut result = Vec::new();
    for year in last_year - 2..=last_year {
        for major in 1..=5 {
            for minor in 0..=5 {
                let mut key = format!("{product} {year}.{major}");
                if minor > 0 {
                    key = format!("{key}.{minor}");
                }
                result.push(wow(&key));
                result.push(cu(&key));
            }
        }
    }
    result.reverse();
    result
}

/// `executableShimPathsForJetBrainsIDE`.
fn jetbrains_shims(base_name: &str) -> Vec<Vec<String>> {
    vec![vec!["bin".into(), format!("{base_name}64.exe")], vec!["bin".into(), format!("{base_name}.exe")]]
}

fn install(
    name: &str, keys: Vec<RegistryKey>, shim_paths: &[&[&str]], prefixes: &[&str], publishers: &[&str],
) -> Editor {
    Editor {
        name: name.into(),
        registry_keys: keys,
        display_name_prefixes: strings(prefixes),
        publishers: strings(publishers),
        location: Location::Install(shims(shim_paths)),
    }
}

fn display_icon(name: &str, keys: Vec<RegistryKey>, prefixes: &[&str], publishers: &[&str]) -> Editor {
    Editor {
        name: name.into(),
        registry_keys: keys,
        display_name_prefixes: strings(prefixes),
        publishers: strings(publishers),
        location: Location::DisplayIcon,
    }
}

fn jetbrains(name: &str, product: &str, base_name: &str, prefix: &str, year: i32) -> Editor {
    Editor {
        name: name.into(),
        registry_keys: jetbrains_keys(product, year),
        display_name_prefixes: vec![prefix.into()],
        publishers: vec!["JetBrains s.r.o.".into()],
        location: Location::Install(jetbrains_shims(base_name)),
    }
}

/// `editors`, in Desktop's order.
fn editors(year: i32) -> Vec<Editor> {
    vec![
        install(
            "Visual Studio Code",
            vec![
                cu("{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1"),
                cu("{D628A17A-9713-46BF-8D57-E671B46A741E}_is1"),
                cu("{D9E514E7-1A56-452D-9337-2990C0DC4310}_is1"),
                lm("{EA457B21-F73E-494C-ACAB-524FDE069978}_is1"),
                wow("{F8A2A208-72B3-4D61-95FC-8A65D340689B}_is1"),
                lm("{A5270FC5-65AD-483E-AC30-2C276B63D0AC}_is1"),
            ],
            &[&["code.exe"]],
            &["Microsoft Visual Studio Code"],
            &["Microsoft Corporation"],
        ),
        install(
            "Visual Studio Code (Insiders)",
            vec![
                cu("{217B4C08-948D-4276-BFBB-BEE930AE5A2C}_is1"),
                cu("{26F4A15E-E392-4887-8C09-7BC55712FD5B}_is1"),
                cu("{69BD8F7B-65EB-4C6F-A14E-44CFA83712C0}_is1"),
                lm("{1287CAD5-7C8D-410D-88B9-0D1EE4A83FF2}_is1"),
                wow("{C26E74D1-022E-4238-8B9D-1E7564A36CC9}_is1"),
                lm("{0AEDB616-9614-463B-97D7-119DD86CCA64}_is1"),
            ],
            &[&["Code - Insiders.exe"]],
            &["Microsoft Visual Studio Code Insiders"],
            &["Microsoft Corporation"],
        ),
        install(
            "VSCodium",
            vec![
                cu("{2E1F05D1-C245-4562-81EE-28188DB6FD17}_is1"),
                cu("{0FD05EB4-651E-4E78-A062-515204B47A3A}_is1"),
                cu("{57FD70A5-1B8D-4875-9F40-C5553F094828}_is1"),
                lm("{88DA3577-054F-4CA1-8122-7D820494CFFB}_is1"),
                wow("{763CBF88-25C6-4B10-952F-326AE657F16B}_is1"),
                lm("{67DEE444-3D04-4258-B92A-BC1F0FF2CAE4}_is1"),
                cu("{C6065F05-9603-4FC4-8101-B9781A25D88E}}_is1"),
                cu("{3AEBF0C8-F733-4AD4-BADE-FDB816D53D7B}_is1"),
                lm("{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}_is1"),
                wow("{E34003BB-9E10-4501-8C11-BE3FAA83F23F}_is1"),
                lm("{D1ACE434-89C5-48D1-88D3-E2991DF85475}_is1"),
            ],
            &[&["VSCodium.exe"]],
            &["VSCodium"],
            &["VSCodium", "Microsoft Corporation"],
        ),
        install(
            "VSCodium (Insiders)",
            vec![
                cu("{20F79D0D-A9AC-4220-9A81-CE675FFB6B41}_is1"),
                cu("{ED2E5618-3E7E-4888-BF3C-A6CCC84F586F}_is1"),
                cu("{2E362F92-14EA-455A-9ABD-3E656BBBFE71}_is1"),
                lm("{B2E0DDB2-120E-4D34-9F7E-8C688FF839A2}_is1"),
                wow("{EF35BB36-FA7E-4BB9-B7DA-D1E09F2DA9C9}_is1"),
                lm("{44721278-64C6-4513-BC45-D48E07830599}_is1"),
            ],
            &[&["VSCodium - Insiders.exe"]],
            &["VSCodium Insiders", "VSCodium (Insiders)"],
            &["VSCodium"],
        ),
        install(
            "Sublime Text",
            vec![lm("Sublime Text_is1"), lm("Sublime Text 3_is1")],
            &[&["subl.exe"]],
            &["Sublime Text"],
            &["Sublime HQ Pty Ltd"],
        ),
        install(
            "Brackets",
            vec![wow("{4F3B6E8C-401B-4EDE-A423-6481C239D6FF}")],
            &[&["Brackets.exe"]],
            &["Brackets"],
            &["brackets.io"],
        ),
        install(
            "ColdFusion Builder",
            vec![lm("Adobe ColdFusion Builder 3_is1"), lm("Adobe ColdFusion Builder 2016")],
            &[&["CFBuilder.exe"]],
            &["Adobe ColdFusion Builder"],
            &["Adobe Systems Incorporated"],
        ),
        install(
            "Typora",
            vec![lm("{37771A20-7167-44C0-B322-FD3E54C56156}_is1"), wow("{37771A20-7167-44C0-B322-FD3E54C56156}_is1")],
            &[&["typora.exe"]],
            &["Typora"],
            &["typora.io"],
        ),
        install(
            "SlickEdit",
            vec![
                lm("{18406187-F49E-4822-CAF2-1D25C0C83BA2}"),
                wow("{18006187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{18606187-F49E-4822-CAF2-1D25C0C83BA2}"),
                wow("{18206187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{15406187-F49E-4822-CAF2-1D25C0C83BA2}"),
                wow("{15006187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{10C06187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{10406187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{0DC06187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{0D406187-F49E-4822-CAF2-1D25C0C83BA2}"),
                lm("{7CC0E567-ACD6-41E8-95DA-154CEEDB0A18}"),
            ],
            &[&["win", "vs.exe"]],
            &["SlickEdit"],
            &["SlickEdit Inc."],
        ),
        install(
            "Aptana Studio 3",
            vec![wow("{2D6C1116-78C6-469C-9923-3E549218773F}")],
            &[&["AptanaStudio3.exe"]],
            &["Aptana Studio"],
            &["Appcelerator"],
        ),
        jetbrains("JetBrains Webstorm", "WebStorm", "webstorm", "WebStorm", year),
        jetbrains("JetBrains PhpStorm", "PhpStorm", "phpstorm", "PhpStorm", year),
        Editor {
            name: "Android Studio".into(),
            registry_keys: vec![lm("Android Studio")],
            display_name_prefixes: strings(&["Android Studio"]),
            publishers: strings(&["Google LLC"]),
            location: Location::Uninstall(shims(&[&["..", "bin", "studio64.exe"], &["..", "bin", "studio.exe"]])),
        },
        display_icon("Notepad++", vec![lm("Notepad++"), wow("Notepad++")], &["Notepad++"], &["Notepad++ Team"]),
        jetbrains("JetBrains Rider", "JetBrains Rider", "rider", "JetBrains Rider", year),
        display_icon(
            "RStudio",
            vec![cu("RStudio"), lm("RStudio"), wow("RStudio")],
            &["RStudio"],
            &["RStudio", "Posit Software"],
        ),
        jetbrains("JetBrains IntelliJ Idea", "IntelliJ IDEA", "idea", "IntelliJ IDEA ", year),
        jetbrains(
            "JetBrains IntelliJ Idea Community Edition",
            "IntelliJ IDEA Community Edition",
            "idea",
            "IntelliJ IDEA Community Edition ",
            year,
        ),
        jetbrains("JetBrains PyCharm", "PyCharm", "pycharm", "PyCharm ", year),
        jetbrains(
            "JetBrains PyCharm Community Edition",
            "PyCharm Community Edition",
            "pycharm",
            "PyCharm Community Edition",
            year,
        ),
        jetbrains("JetBrains CLion", "CLion", "clion", "CLion ", year),
        jetbrains("JetBrains RubyMine", "RubyMine", "rubymine", "RubyMine ", year),
        jetbrains("JetBrains GoLand", "GoLand", "goland", "GoLand ", year),
        display_icon("JetBrains Fleet", vec![lm("Fleet")], &["Fleet "], &["JetBrains s.r.o."]),
        jetbrains("JetBrains DataSpell", "DataSpell", "dataspell", "DataSpell ", year),
        jetbrains("JetBrains RustRover", "RustRover", "rustrover", "RustRover ", year),
        install(
            "Pulsar",
            vec![cu("0949b555-c22c-56b7-873a-a960bdefa81f"), lm("0949b555-c22c-56b7-873a-a960bdefa81f")],
            &[&["..", "pulsar", "Pulsar.exe"]],
            &["Pulsar"],
            &["Pulsar-Edit"],
        ),
        display_icon(
            "Cursor",
            vec![
                cu("62625861-8486-5be9-9e46-1da50df5f8ff"),
                cu("{DADADADA-ADAD-ADAD-ADAD-ADADADADADAD}}_is1"),
                cu("{DBDBDBDB-BDBD-BDBD-BDBD-BDBDBDBDBDBD}}_is1"),
            ],
            &["Cursor", "Cursor (User)"],
            &["Cursor AI, Inc.", "Anysphere"],
        ),
        display_icon(
            "Windsurf",
            vec![cu("{5A8B7D94-9B5F-4D1F-93FC-5609F7159349}_is1")],
            &["Windsurf", "Windsurf (User)"],
            &["Codeium"],
        ),
        display_icon("Zed", vec![cu("{2DB0DA96-CA55-49BB-AF4F-64AF36A86712}_is1")], &["Zed"], &["Zed Industries"]),
    ]
}

/// `getKeyOrEmpty`: only REG_SZ counts.
fn key_or_empty(values: &[Entry], name: &str) -> String {
    match values.iter().find(|entry| entry.name == name) {
        Some(Entry { data: Data::Sz(data), .. }) => data.clone(),
        _ => String::new(),
    }
}

/// `getCleanInstallLocationFromDisplayIcon`: drops the icon index and the quotes.
fn clean_display_icon(value: &str) -> String {
    value.split(',').next().unwrap_or_default().replace('"', "")
}

/// `Path.join(base, ...parts)`, resolving `..` the way Node's normalisation does.
fn join(base: &str, parts: &[String]) -> PathBuf {
    let mut path = PathBuf::from(base);
    for part in parts {
        if part == ".." {
            path.pop();
        } else {
            path.push(part);
        }
    }
    path
}

/// `findApplication`.
fn find_application(editor: &Editor, registry: &dyn Registry) -> Option<PathBuf> {
    for (hive, sub_key) in &editor.registry_keys {
        let values = registry.values(*hive, sub_key);
        if values.is_empty() {
            continue;
        }
        let display_name = key_or_empty(&values, "DisplayName");
        let publisher = key_or_empty(&values, "Publisher");
        let install_location = key_or_empty(
            &values,
            match editor.location {
                Location::Install(_) => "InstallLocation",
                Location::Uninstall(_) => "UninstallString",
                Location::DisplayIcon => "DisplayIcon",
            },
        );
        if !editor.display_name_prefixes.iter().any(|prefix| display_name.starts_with(prefix.as_str()))
            || !editor.publishers.contains(&publisher)
        {
            log::debug!("Unexpected registry entries for {}", editor.name);
            continue;
        }
        let candidates = match &editor.location {
            Location::DisplayIcon => vec![PathBuf::from(clean_display_icon(&install_location))],
            Location::Install(paths) | Location::Uninstall(paths) => {
                paths.iter().map(|path| join(&install_location, path)).collect()
            }
        };
        for path in candidates {
            if path.exists() {
                return Some(path);
            }
            log::debug!("Executable for {} not found at '{}'", editor.name, path.display());
        }
    }
    None
}

/// The leading `JetBrains Toolbox (...)` of a key name: `/^JetBrains Toolbox \(.*\)/`.
fn toolbox_name(key: &str) -> Option<&str> {
    const PREFIX: &str = "JetBrains Toolbox (";
    let rest = key.strip_prefix(PREFIX)?;
    let end = rest.rfind(')')?;
    Some(&key[..PREFIX.len() + end + 1])
}

/// `getJetBrainsToolboxEditors`.
fn jetbrains_toolbox_editors(registry: &dyn Registry) -> Vec<Editor> {
    let mut result = Vec::new();
    for parent in [UNINSTALL_SUB_KEY, WOW64_UNINSTALL_SUB_KEY] {
        for key in registry.keys(Hive::CurrentUser, parent) {
            let Some(name) = toolbox_name(&key) else { continue };
            let sub_key = format!("{parent}\\{key}");
            let display_name = key_or_empty(&registry.values(Hive::CurrentUser, &sub_key), "DisplayName");
            if display_name.is_empty() {
                log::debug!("Missing DisplayName for registry key {sub_key}");
                continue;
            }
            result.push(Editor {
                name: name.into(),
                registry_keys: vec![(Hive::CurrentUser, sub_key)],
                display_name_prefixes: vec![display_name],
                publishers: vec!["JetBrains s.r.o.".into()],
                location: Location::DisplayIcon,
            });
        }
    }
    result
}

/// `getAvailableEditors`.
fn available_editors(host: &Host) -> Vec<Found> {
    editors(host.year)
        .into_iter()
        .chain(jetbrains_toolbox_editors(host.registry))
        .filter_map(|editor| {
            let path = find_application(&editor, host.registry)?;
            Some(Found {
                name: editor.name,
                kind: "editor",
                path: path.to_string_lossy().into_owned(),
                extra_args: Vec::new(),
            })
        })
        .collect()
}

// ── shells/win32.ts ─────────────────────────────────────────────────────────

const CMD: &str = "Command Prompt";
const POWERSHELL: &str = "PowerShell";
const POWERSHELL_CORE: &str = "PowerShell Core";
const HYPER: &str = "Hyper";
const GIT_BASH: &str = "Git Bash";
const CYGWIN: &str = "Cygwin";
const WINDOWS_TERMINAL: &str = "Windows Terminal";
const FLUENT_TERMINAL: &str = "Fluent Terminal";
const ALACRITTY: &str = "Alacritty";
const WARP: &str = "Warp";

fn existing(path: String) -> Option<String> {
    Path::new(&path).exists().then_some(path)
}

/// `Path.join` of a base and a backslash-separated tail.
fn win_join(base: &str, rest: &str) -> String {
    let mut path = PathBuf::from(base);
    path.extend(rest.split('\\'));
    path.to_string_lossy().into_owned()
}

fn named<'a>(values: &'a [Entry], name: &str) -> Option<&'a Entry> {
    values.iter().find(|entry| entry.name == name)
}

/// `findPowerShell`.
fn find_powershell(host: &Host) -> Option<String> {
    let values = host
        .registry
        .values(Hive::LocalMachine, "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PowerShell.exe");
    // Windows 7 stores these as REG_SZ with an unexpanded %SystemRoot%; Desktop expands it for both.
    let (Data::Sz(data) | Data::ExpandSz(data)) = &values.first()?.data else { return None };
    const VARIABLE: &str = "%SystemRoot%";
    let path = match data.get(..VARIABLE.len()) {
        Some(prefix) if prefix.eq_ignore_ascii_case(VARIABLE) => {
            format!("{}{}", (host.env)("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()), &data[VARIABLE.len()..])
        }
        _ => data.clone(),
    };
    existing(path)
}

/// `findPowerShellCore`.
fn find_powershell_core(host: &Host) -> Option<String> {
    let values =
        host.registry.values(Hive::LocalMachine, "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe");
    let Data::Sz(path) = &values.first()?.data else { return None };
    existing(path.clone())
}

/// The first quoted run in a command: `/(["'])(.*?)\1/`.
fn first_quoted(command: &str) -> Option<&str> {
    command.char_indices().filter(|(_, c)| matches!(c, '"' | '\'')).find_map(|(start, quote)| {
        let rest = &command[start + 1..];
        rest.find(quote).map(|end| &rest[..end])
    })
}

/// `findHyper`: the context-menu command is `"{install}\app-x.x.x\Hyper.exe" "%V"`.
fn find_hyper(host: &Host) -> Option<String> {
    let values =
        host.registry.values(Hive::CurrentUser, "Software\\Classes\\Directory\\Background\\shell\\Hyper\\command");
    let Data::Sz(command) = &values.first()?.data else { return None };
    let path = match first_quoted(command) {
        Some(path) => path.to_owned(),
        // Fall back to the launcher in the install root.
        None => win_join(&(host.env)("LocalAppData")?, "hyper\\Hyper.exe"),
    };
    existing(path)
}

/// `findGitBash`.
fn find_git_bash(host: &Host) -> Option<String> {
    let values = host.registry.values(Hive::LocalMachine, "SOFTWARE\\GitForWindows");
    let Data::Sz(install_path) = &named(&values, "InstallPath")?.data else { return None };
    existing(win_join(install_path, "git-bash.exe"))
}

/// `findCygwin`: the 32-bit root is only consulted when the 64-bit one is registered.
fn find_cygwin(host: &Host) -> Option<String> {
    let root = |sub_key: &str| match named(&host.registry.values(Hive::LocalMachine, sub_key), "rootdir") {
        Some(Entry { data: Data::Sz(root), .. }) => Some(root.clone()),
        _ => None,
    };
    let root64 = root("SOFTWARE\\Cygwin\\setup")?;
    existing(win_join(&root64, "bin\\mintty.exe")).or_else(|| {
        let root32 = root("SOFTWARE\\WOW6432Node\\Cygwin\\setup")?;
        existing(win_join(&root32, "bin\\mintty.exe"))
    })
}

/// `findOldWarp`.
fn find_old_warp(host: &Host) -> Option<String> {
    let variable = |name: &str| (host.env)(name).filter(|value| !value.is_empty());
    [
        variable("LocalAppData").map(|root| win_join(&root, "warp\\Warp\\warp.exe")),
        variable("ProgramFiles").map(|root| win_join(&root, "Warp\\warp.exe")),
        variable("ProgramFiles(x86)").map(|root| win_join(&root, "Warp\\warp.exe")),
    ]
    .into_iter()
    .flatten()
    .find_map(existing)
}

/// `findWarp`.
fn find_warp(host: &Host) -> Option<String> {
    let values = host.registry.values(Hive::CurrentUser, "Software\\Warp.dev\\Warp");
    if values.is_empty() {
        return None;
    }
    if let Some(Entry { data: Data::Sz(path), .. }) = named(&values, "InstallationPath")
        && let Some(path) = existing(path.clone())
    {
        return Some(path);
    }
    find_old_warp(host)
}

/// `findAlacritty`.
fn find_alacritty(host: &Host) -> Option<String> {
    let values = host.registry.values(Hive::ClassesRoot, "Directory\\Background\\shell\\Open Alacritty here");
    let Data::Sz(path) = &named(&values, "Icon")?.data else { return None };
    existing(path.clone())
}

/// `findWindowsTerminal` / `findFluentTerminal`: app execution aliases under WindowsApps.
fn find_app_alias(host: &Host, executable: &str) -> Option<String> {
    existing(win_join(&(host.env)("LocalAppData")?, &format!("Microsoft\\WindowsApps\\{executable}")))
}

/// `getAvailableShells`, in Desktop's order. Command Prompt is always offered.
fn available_shells(host: &Host) -> Vec<Found> {
    let root_dir = (host.env)("WINDIR").filter(|value| !value.is_empty()).unwrap_or_else(|| "C:\\Windows".into());
    let cmd_args = host.git.as_ref().map_or_else(Vec::new, |git| {
        vec!["/K".to_owned(), format!("\"{root_dir}\\system32\\doskey.exe git=^\"{git}^\" $*\"")]
    });
    let mut shells = vec![Found {
        name: CMD.into(),
        kind: "terminal",
        path: (host.env)("comspec")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "C:\\Windows\\System32\\cmd.exe".into()),
        extra_args: cmd_args,
    }];
    let found = [
        (POWERSHELL, find_powershell(host)),
        (POWERSHELL_CORE, find_powershell_core(host)),
        (HYPER, find_hyper(host)),
        (GIT_BASH, find_git_bash(host)),
        (CYGWIN, find_cygwin(host)),
        (WARP, find_warp(host)),
        (ALACRITTY, find_alacritty(host)),
        (WINDOWS_TERMINAL, find_app_alias(host, "wt.exe")),
        (FLUENT_TERMINAL, find_app_alias(host, "flute.exe")),
    ];
    shells.extend(found.into_iter().filter_map(|(name, path)| {
        Some(Found { name: name.into(), kind: "terminal", path: path?, extra_args: Vec::new() })
    }));
    shells
}

/// What `launch` hands to `child_process.spawn`.
#[derive(PartialEq, Eq, Debug)]
enum Launch {
    /// `shell: true`: Node joins the command and its arguments with spaces and runs
    /// `%comspec% /d /s /c "<line>"`.
    CommandLine(String),
    /// No shell: program, arguments and extra environment.
    Direct { program: String, args: Vec<String>, env: Vec<(&'static str, String)> },
}

/// `launch`.
fn shell_launch(shell: &Found, path: &str) -> Result<Launch, String> {
    let executable = &shell.path;
    Ok(Launch::CommandLine(match shell.name.as_str() {
        POWERSHELL => format!("START \"PowerShell\" \"{executable}\""),
        POWERSHELL_CORE => format!("START \"PowerShell Core\" \"{executable}\" -WorkingDirectory \"{path}\""),
        HYPER => format!("\"{executable}\" \"{path}\""),
        ALACRITTY => format!("\"{executable}\" --working-directory \"{path}\""),
        GIT_BASH => format!("\"{executable}\" --cd=\"{path}\""),
        CYGWIN => {
            // The path travels through the environment so shell metacharacters in directory names
            // stay literal instead of becoming part of the script.
            return Ok(Launch::Direct {
                program: executable.clone(),
                args: strings(&["/bin/sh", "-lc", "cd -- \"$(cygpath -- \"$GITCUB_CYGWIN_OPEN_PATH\")\" && exec bash"]),
                env: vec![("GITCUB_CYGWIN_OPEN_PATH", path.to_owned())],
            });
        }
        WARP => format!("\"{executable}\" warp://action/new_tab?path=\"{path}\""),
        CMD => {
            let mut parts = vec!["START".to_owned(), "\"Command Prompt\"".to_owned(), format!("\"{executable}\"")];
            parts.extend(shell.extra_args.iter().cloned());
            parts.join(" ")
        }
        WINDOWS_TERMINAL => format!("\"{executable}\" -d ."),
        FLUENT_TERMINAL => format!("\"{executable}\" new"),
        other => return Err(format!("Unknown shell: {other}")),
    }))
}

// ── GitCub boundary ─────────────────────────────────────────────────────────

struct Found {
    name: String,
    kind: &'static str,
    path: String,
    extra_args: Vec<String>,
}

/// Preference identifier for an integration. Identifiers stored by earlier versions are kept.
fn identifier(name: &str) -> String {
    let legacy = match name {
        "Visual Studio Code" => Some("vscode"),
        "Visual Studio Code (Insiders)" => Some("vscode-insiders"),
        "Cursor" => Some("cursor"),
        CMD => Some("cmd"),
        POWERSHELL => Some("powershell"),
        POWERSHELL_CORE => Some("pwsh"),
        WINDOWS_TERMINAL => Some("terminal"),
        GIT_BASH => Some("git-bash"),
        _ => None,
    };
    if let Some(id) = legacy {
        return format!("windows:{id}");
    }
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_alphanumeric() {
            slug.extend(c.to_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    format!("windows:{}", slug.trim_end_matches('-'))
}

fn discover(host: &Host) -> Vec<Found> {
    let mut found = available_editors(host);
    found.extend(available_shells(host));
    let mut seen = std::collections::HashSet::new();
    found.retain(|app| seen.insert(identifier(&app.name)));
    found
}

#[cfg(windows)]
fn installed() -> Vec<Found> {
    use chrono::Datelike;
    discover(&Host {
        registry: &SystemRegistry,
        env: &|name| std::env::var(name).ok(),
        year: chrono::Local::now().year(),
        git: crate::shell_env::find_executable("git"),
    })
}

#[cfg(not(windows))]
fn installed() -> Vec<Found> {
    Vec::new()
}

pub fn available() -> Vec<Value> {
    installed()
        .iter()
        .map(|app| json!({"name": app.name, "kind": app.kind, "bundleId": identifier(&app.name), "path": app.path}))
        .collect()
}

pub fn open(id: &str, path: &Path) -> Result<(), String> {
    let apps = installed();
    let app =
        apps.iter().find(|app| identifier(&app.name) == id).ok_or("Selected Windows application is unavailable")?;
    if app.kind == "editor" {
        return spawn_editor(&app.path, path);
    }
    spawn_shell(shell_launch(app, &path.to_string_lossy())?, path)
}

/// `launchEditor`: detached, so editors such as Notepad++ outlive the app.
#[cfg(windows)]
fn spawn_editor(executable: &str, path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    Command::new(executable)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn spawn_shell(launch: Launch, directory: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = match launch {
        Launch::CommandLine(line) => {
            let shell = std::env::var("comspec").ok().filter(|value| !value.is_empty());
            let mut command = Command::new(shell.as_deref().unwrap_or("cmd.exe"));
            // Node passes these verbatim (`windowsVerbatimArguments`).
            command.raw_arg("/d /s /c").raw_arg(format!("\"{line}\"")).creation_flags(CREATE_NO_WINDOW);
            command
        }
        Launch::Direct { program, args, env } => {
            let mut command = Command::new(program);
            command.args(args).envs(env);
            command
        }
    };
    command.current_dir(directory).spawn().map(|_| ()).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn spawn_editor(_executable: &str, _path: &Path) -> Result<(), String> {
    Err("Unsupported Windows integration".into())
}

#[cfg(not(windows))]
fn spawn_shell(_launch: Launch, _directory: &Path) -> Result<(), String> {
    Err("Unsupported Windows integration".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeRegistry {
        values: HashMap<(Hive, String), Vec<Entry>>,
        /// Sub keys as registered: key names keep their case when enumerated.
        sub_keys: Vec<RegistryKey>,
    }

    impl FakeRegistry {
        fn set(&mut self, (hive, sub_key): RegistryKey, values: &[(&str, Data)]) {
            let values = values.iter().map(|(name, data)| Entry { name: (*name).into(), data: data.clone() }).collect();
            self.values.insert((hive, sub_key.to_lowercase()), values);
            self.sub_keys.push((hive, sub_key));
        }
    }

    impl Registry for FakeRegistry {
        fn values(&self, hive: Hive, sub_key: &str) -> Vec<Entry> {
            self.values.get(&(hive, sub_key.to_lowercase())).cloned().unwrap_or_default()
        }

        fn keys(&self, hive: Hive, sub_key: &str) -> Vec<String> {
            let prefix = format!("{}\\", sub_key.to_lowercase());
            let mut keys: Vec<String> = self
                .sub_keys
                .iter()
                .filter(|(key_hive, key)| *key_hive == hive && key.to_lowercase().starts_with(&prefix))
                .map(|(_, key)| key[prefix.len()..].to_owned())
                .filter(|key| !key.contains('\\'))
                .collect();
            keys.sort();
            keys
        }
    }

    fn sz(value: impl Into<String>) -> Data {
        Data::Sz(value.into())
    }

    fn touch(path: &Path) -> String {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, []).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn host<'a>(registry: &'a FakeRegistry, env: &'a dyn Fn(&str) -> Option<String>) -> Host<'a> {
        Host { registry, env, year: 2026, git: None }
    }

    fn names(found: &[Found]) -> Vec<&str> {
        found.iter().map(|app| app.name.as_str()).collect()
    }

    #[test]
    fn editor_needs_matching_display_name_publisher_and_an_existing_shim() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user");
        let system = temp.path().join("system");
        touch(&system.join("code.exe"));
        let mut registry = FakeRegistry::default();
        // The user-scope key names another publisher, so the system-scope key is used.
        registry.set(
            cu("{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1"),
            &[
                ("DisplayName", sz("Microsoft Visual Studio Code (User)")),
                ("Publisher", sz("Someone Else")),
                ("InstallLocation", sz(touch(&user.join("code.exe")).replace("code.exe", ""))),
            ],
        );
        registry.set(
            lm("{EA457B21-F73E-494C-ACAB-524FDE069978}_is1"),
            &[
                ("DisplayName", sz("Microsoft Visual Studio Code")),
                ("Publisher", sz("Microsoft Corporation")),
                ("InstallLocation", sz(system.to_string_lossy())),
            ],
        );
        // Insiders is registered but its executable is gone.
        registry.set(
            cu("{217B4C08-948D-4276-BFBB-BEE930AE5A2C}_is1"),
            &[
                ("DisplayName", sz("Microsoft Visual Studio Code Insiders")),
                ("Publisher", sz("Microsoft Corporation")),
                ("InstallLocation", sz(temp.path().join("missing").to_string_lossy())),
            ],
        );
        // A REG_EXPAND_SZ display name does not count (getKeyOrEmpty).
        registry.set(
            lm("Sublime Text_is1"),
            &[
                ("DisplayName", Data::ExpandSz("Sublime Text".into())),
                ("Publisher", sz("Sublime HQ Pty Ltd")),
                ("InstallLocation", sz(touch(&temp.path().join("subl/subl.exe")).replace("subl.exe", ""))),
            ],
        );
        let found = available_editors(&host(&registry, &no_env));
        assert_eq!(names(&found), ["Visual Studio Code"]);
        assert_eq!(PathBuf::from(&found[0].path), system.join("code.exe"));
    }

    #[test]
    fn display_icon_and_uninstall_string_locations() {
        let temp = tempfile::tempdir().unwrap();
        let notepad = touch(&temp.path().join("npp/notepad++.exe"));
        let studio = temp.path().join("studio");
        touch(&studio.join("bin/studio.exe"));
        let pulsar = temp.path().join("programs");
        touch(&pulsar.join("pulsar/Pulsar.exe"));
        let mut registry = FakeRegistry::default();
        registry.set(
            wow("Notepad++"),
            &[
                ("DisplayName", sz("Notepad++ (32-bit x86)")),
                ("Publisher", sz("Notepad++ Team")),
                ("DisplayIcon", sz(format!("\"{notepad}\",0"))),
            ],
        );
        registry.set(
            lm("Android Studio"),
            &[
                ("DisplayName", sz("Android Studio")),
                ("Publisher", sz("Google LLC")),
                ("UninstallString", sz(studio.join("uninstall.exe").to_string_lossy())),
            ],
        );
        registry.set(
            cu("0949b555-c22c-56b7-873a-a960bdefa81f"),
            &[
                ("DisplayName", sz("Pulsar 1.2")),
                ("Publisher", sz("Pulsar-Edit")),
                ("InstallLocation", sz(pulsar.join("Pulsar-updater").to_string_lossy())),
            ],
        );
        let found = available_editors(&host(&registry, &no_env));
        assert_eq!(names(&found), ["Android Studio", "Notepad++", "Pulsar"]);
        assert_eq!(PathBuf::from(&found[0].path), studio.join("bin/studio.exe"));
        assert_eq!(found[1].path, notepad);
        assert_eq!(PathBuf::from(&found[2].path), pulsar.join("pulsar/Pulsar.exe"));
    }

    #[test]
    fn jetbrains_keys_cover_three_years_newest_first() {
        let keys = jetbrains_keys("WebStorm", 2026);
        assert_eq!(keys.len(), 3 * 5 * 6 * 2);
        assert_eq!(keys[0], cu("WebStorm 2026.5.5"));
        assert_eq!(keys[1], wow("WebStorm 2026.5.5"));
        assert_eq!(keys[keys.len() - 1], wow("WebStorm 2024.1"));

        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("2025");
        let new = temp.path().join("2026");
        touch(&old.join("bin/webstorm64.exe"));
        touch(&new.join("bin/webstorm.exe"));
        let mut registry = FakeRegistry::default();
        for (key, root) in [("WebStorm 2025.3", &old), ("WebStorm 2026.1.2", &new)] {
            registry.set(
                wow(key),
                &[
                    ("DisplayName", sz(key)),
                    ("Publisher", sz("JetBrains s.r.o.")),
                    ("InstallLocation", sz(root.to_string_lossy())),
                ],
            );
        }
        let found = available_editors(&host(&registry, &no_env));
        assert_eq!(names(&found), ["JetBrains Webstorm"]);
        assert_eq!(PathBuf::from(&found[0].path), new.join("bin/webstorm.exe"));
    }

    #[test]
    fn jetbrains_toolbox_products_are_discovered_from_the_user_hive() {
        let temp = tempfile::tempdir().unwrap();
        let rider = touch(&temp.path().join("rider/bin/rider64.exe"));
        let mut registry = FakeRegistry::default();
        registry.set(
            cu("JetBrains Toolbox (Rider) 4f2a"),
            &[
                ("DisplayName", sz("JetBrains Rider 2026.2")),
                ("Publisher", sz("JetBrains s.r.o.")),
                ("DisplayIcon", sz(rider.clone())),
            ],
        );
        // No DisplayName: skipped.
        registry.set(cu("JetBrains Toolbox (GoLand)"), &[("Publisher", sz("JetBrains s.r.o."))]);
        registry.set(cu("JetBrains Toolbox"), &[("DisplayName", sz("JetBrains Toolbox"))]);
        let found = available_editors(&host(&registry, &no_env));
        assert_eq!(names(&found), ["JetBrains Toolbox (Rider)"]);
        assert_eq!(found[0].path, rider);
        assert_eq!(identifier(&found[0].name), "windows:jetbrains-toolbox-rider");
        assert_eq!(toolbox_name("JetBrains Toolbox (a) (b) c"), Some("JetBrains Toolbox (a) (b)"));
    }

    #[test]
    fn shells_follow_desktop_lookup_and_order() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let system_root = root.join("Windows").to_string_lossy().into_owned();
        let local = root.join("Local").to_string_lossy().into_owned();
        touch(&root.join("Windows/System32/WindowsPowerShell/v1.0/powershell.exe"));
        let pwsh = touch(&root.join("pwsh/pwsh.exe"));
        let hyper = touch(&root.join("Local/hyper/app-3.4.1/Hyper.exe"));
        touch(&root.join("Git/git-bash.exe"));
        touch(&root.join("cygwin32/bin/mintty.exe"));
        touch(&root.join("Local/warp/Warp/warp.exe"));
        let alacritty = touch(&root.join("alacritty/alacritty.exe"));
        touch(&root.join("Local/Microsoft/WindowsApps/wt.exe"));
        touch(&root.join("Local/Microsoft/WindowsApps/flute.exe"));
        let app_paths = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths";
        let mut registry = FakeRegistry::default();
        registry.set(
            (Hive::LocalMachine, format!("{app_paths}\\PowerShell.exe")),
            &[(
                "",
                Data::ExpandSz(
                    "%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                        .replace('\\', std::path::MAIN_SEPARATOR_STR),
                ),
            )],
        );
        registry.set((Hive::LocalMachine, format!("{app_paths}\\pwsh.exe")), &[("", sz(pwsh.clone()))]);
        registry.set(
            (Hive::CurrentUser, "Software\\Classes\\Directory\\Background\\shell\\Hyper\\command".into()),
            &[("", sz(format!("\"{hyper}\" \"%V\"")))],
        );
        registry.set(
            (Hive::LocalMachine, "SOFTWARE\\GitForWindows".into()),
            &[("InstallPath", sz(root.join("Git").to_string_lossy()))],
        );
        // The 64-bit root has no mintty, so the 32-bit root is used.
        registry.set(
            (Hive::LocalMachine, "SOFTWARE\\Cygwin\\setup".into()),
            &[("rootdir", sz(root.join("cygwin64").to_string_lossy()))],
        );
        registry.set(
            (Hive::LocalMachine, "SOFTWARE\\WOW6432Node\\Cygwin\\setup".into()),
            &[("rootdir", sz(root.join("cygwin32").to_string_lossy()))],
        );
        // The registered Warp path is gone, so the old per-user location is used.
        registry.set(
            (Hive::CurrentUser, "Software\\Warp.dev\\Warp".into()),
            &[("InstallationPath", sz(root.join("gone/warp.exe").to_string_lossy()))],
        );
        registry.set(
            (Hive::ClassesRoot, "Directory\\Background\\shell\\Open Alacritty here".into()),
            &[("Icon", sz(alacritty.clone()))],
        );
        let env = |name: &str| match name {
            "SystemRoot" | "WINDIR" => Some(system_root.clone()),
            "LocalAppData" => Some(local.clone()),
            "comspec" => Some("C:\\Windows\\System32\\cmd.exe".into()),
            _ => None,
        };
        let host = Host { registry: &registry, env: &env, year: 2026, git: Some("C:\\Git\\cmd\\git.exe".into()) };
        let shells = available_shells(&host);
        assert_eq!(
            names(&shells),
            [
                CMD,
                POWERSHELL,
                POWERSHELL_CORE,
                HYPER,
                GIT_BASH,
                CYGWIN,
                WARP,
                ALACRITTY,
                WINDOWS_TERMINAL,
                FLUENT_TERMINAL
            ]
        );
        assert_eq!(shells[0].path, "C:\\Windows\\System32\\cmd.exe");
        assert_eq!(
            shells[0].extra_args,
            ["/K".to_owned(), format!("\"{system_root}\\system32\\doskey.exe git=^\"C:\\Git\\cmd\\git.exe^\" $*\"")]
        );
        assert_eq!(shells[2].path, pwsh);
        assert_eq!(shells[3].path, hyper);
        assert!(shells[5].path.contains("cygwin32"));
        assert_eq!(shells[7].path, alacritty);
    }

    #[test]
    fn only_command_prompt_without_registrations() {
        let registry = FakeRegistry::default();
        let shells = available_shells(&host(&registry, &no_env));
        assert_eq!(names(&shells), [CMD]);
        assert_eq!(shells[0].path, "C:\\Windows\\System32\\cmd.exe");
        assert!(shells[0].extra_args.is_empty());
        assert!(available_editors(&host(&registry, &no_env)).is_empty());
    }

    #[test]
    fn hyper_command_parsing() {
        assert_eq!(first_quoted("\"C:\\a b\\Hyper.exe\" \"%V\""), Some("C:\\a b\\Hyper.exe"));
        assert_eq!(first_quoted("'C:\\Hyper.exe' \"%V\""), Some("C:\\Hyper.exe"));
        assert_eq!(first_quoted("it's \"C:\\Hyper.exe\""), Some("C:\\Hyper.exe"));
        assert_eq!(first_quoted("C:\\Hyper.exe %V"), None);
        assert_eq!(clean_display_icon("\"C:\\Path\\app.exe\",0"), "C:\\Path\\app.exe");
    }

    #[test]
    fn launch_command_lines_match_desktop() {
        let shell = |name: &str, extra_args: &[&str]| Found {
            name: name.into(),
            kind: "terminal",
            path: "C:\\Apps\\shell.exe".into(),
            extra_args: strings(extra_args),
        };
        let line =
            |name: &str, extra_args: &[&str]| match shell_launch(&shell(name, extra_args), "C:\\my repo").unwrap() {
                Launch::CommandLine(line) => line,
                Launch::Direct { .. } => panic!("{name} runs through the shell"),
            };
        assert_eq!(line(POWERSHELL, &[]), "START \"PowerShell\" \"C:\\Apps\\shell.exe\"");
        assert_eq!(
            line(POWERSHELL_CORE, &[]),
            "START \"PowerShell Core\" \"C:\\Apps\\shell.exe\" -WorkingDirectory \"C:\\my repo\""
        );
        assert_eq!(line(HYPER, &[]), "\"C:\\Apps\\shell.exe\" \"C:\\my repo\"");
        assert_eq!(line(ALACRITTY, &[]), "\"C:\\Apps\\shell.exe\" --working-directory \"C:\\my repo\"");
        assert_eq!(line(GIT_BASH, &[]), "\"C:\\Apps\\shell.exe\" --cd=\"C:\\my repo\"");
        assert_eq!(line(WARP, &[]), "\"C:\\Apps\\shell.exe\" warp://action/new_tab?path=\"C:\\my repo\"");
        assert_eq!(line(CMD, &[]), "START \"Command Prompt\" \"C:\\Apps\\shell.exe\"");
        assert_eq!(line(CMD, &["/K", "\"doskey\""]), "START \"Command Prompt\" \"C:\\Apps\\shell.exe\" /K \"doskey\"");
        assert_eq!(line(WINDOWS_TERMINAL, &[]), "\"C:\\Apps\\shell.exe\" -d .");
        assert_eq!(line(FLUENT_TERMINAL, &[]), "\"C:\\Apps\\shell.exe\" new");
        assert_eq!(
            shell_launch(&shell(CYGWIN, &[]), "C:\\my repo").unwrap(),
            Launch::Direct {
                program: "C:\\Apps\\shell.exe".into(),
                args: strings(&["/bin/sh", "-lc", "cd -- \"$(cygpath -- \"$GITCUB_CYGWIN_OPEN_PATH\")\" && exec bash"]),
                env: vec![("GITCUB_CYGWIN_OPEN_PATH", "C:\\my repo".into())],
            }
        );
        assert!(shell_launch(&shell("WSL", &[]), "C:\\my repo").is_err());
    }

    #[test]
    fn identifiers_keep_stored_preferences_and_are_unique() {
        for (name, id) in [
            ("Visual Studio Code", "windows:vscode"),
            ("Visual Studio Code (Insiders)", "windows:vscode-insiders"),
            ("Cursor", "windows:cursor"),
            (CMD, "windows:cmd"),
            (POWERSHELL, "windows:powershell"),
            (POWERSHELL_CORE, "windows:pwsh"),
            (WINDOWS_TERMINAL, "windows:terminal"),
            (GIT_BASH, "windows:git-bash"),
            ("Notepad++", "windows:notepad"),
            ("JetBrains IntelliJ Idea Community Edition", "windows:jetbrains-intellij-idea-community-edition"),
        ] {
            assert_eq!(identifier(name), id);
        }
        let mut ids: Vec<String> = editors(2026).iter().map(|editor| identifier(&editor.name)).collect();
        ids.extend(
            [
                CMD,
                POWERSHELL,
                POWERSHELL_CORE,
                HYPER,
                GIT_BASH,
                CYGWIN,
                WARP,
                ALACRITTY,
                WINDOWS_TERMINAL,
                FLUENT_TERMINAL,
            ]
            .map(identifier),
        );
        assert_eq!(editors(2026).len(), 30);
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
    }

    /// The command line reaches `cmd.exe` verbatim, quotes and spaces included.
    #[cfg(windows)]
    #[test]
    fn shell_command_line_runs_through_cmd_verbatim() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("my repo");
        std::fs::create_dir_all(&directory).unwrap();
        let cmd = std::env::var("comspec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
        spawn_shell(Launch::CommandLine(format!("START \"t\" /B \"{cmd}\" /c \"cd> \"out file.txt\"\"")), &directory)
            .unwrap();
        let output = directory.join("out file.txt");
        for _ in 0..100 {
            if std::fs::read_to_string(&output).is_ok_and(|text| text.trim_end().ends_with("my repo")) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the started command did not run in {}", directory.display());
    }

    /// The registry on this machine is readable and every offered executable exists.
    #[cfg(windows)]
    #[test]
    fn installed_integrations_exist_on_this_machine() {
        let apps = installed();
        assert!(apps.iter().any(|app| app.name == CMD));
        for app in &apps {
            println!("{} [{}] {}", app.name, identifier(&app.name), app.path);
            assert!(Path::new(&app.path).exists(), "{} at {}", app.name, app.path);
        }
    }
}
