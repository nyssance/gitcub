//! Native architecture, installation and persistent anonymous identifier boundary.
use std::io::Write;
use std::path::Path;
pub fn architecture() -> String {
    #[cfg(target_os = "macos")]
    let translated = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-in", "sysctl.proc_translated"])
        .output()
        .is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"1"));
    #[cfg(target_os = "windows")]
    let translated = std::env::var("PROCESSOR_ARCHITEW6432").is_ok_and(|v| v.eq_ignore_ascii_case("ARM64"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let translated = false;
    if translated {
        "x64-emulated"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
    .into()
}
pub fn in_applications() -> bool {
    std::env::current_exe().is_ok_and(|path| {
        path.starts_with("/Applications")
            || std::env::var_os("HOME").is_some_and(|home| path.starts_with(Path::new(&home).join("Applications")))
    })
}
pub fn save_guid(directory: &Path, guid: &str) -> Result<(), String> {
    if guid.is_empty() || guid.len() > 128 || guid.chars().any(char::is_control) {
        return Err("Invalid anonymous identifier".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    file.write_all(guid.as_bytes()).map_err(|e| e.to_string())?;
    file.persist(directory.join("stats-guid")).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn get_guid(directory: &Path) -> Result<String, String> {
    let path = directory.join("stats-guid");
    match std::fs::read_to_string(&path) {
        Ok(value) => return Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let guid = format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]);
    save_guid(directory, &guid)?;
    Ok(guid)
}
