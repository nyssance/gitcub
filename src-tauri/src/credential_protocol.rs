//! Desktop credential helper protocol: preserve insertion order and repeated array keys.
pub fn parse(value: &str) -> Vec<(String, String)> {
    let mut credentials: Vec<(String, String)> = Vec::new();
    for line in value.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = if let Some(base) = key.strip_suffix("[]") {
            let mut index = 0;
            loop {
                let candidate = format!("{base}[{index}]");
                if !credentials.iter().any(|(key, _)| key == &candidate) {
                    break candidate;
                }
                index += 1;
            }
        } else {
            key.to_string()
        };
        if let Some((_, previous)) = credentials.iter_mut().find(|(existing, _)| existing == &key) {
            *previous = value.to_string();
        } else {
            credentials.push((key, value.to_string()));
        }
    }
    credentials
}
pub fn format(credentials: &[(String, String)]) -> Result<String, String> {
    let mut result = String::new();
    for (key, value) in credentials {
        if value.contains(['\n', '\0']) {
            return Err(format!("forbidden characters in credential value: {key}"));
        }
        let key = if let Some((base, index)) = key.strip_suffix(']').and_then(|key| key.rsplit_once('[')) {
            if !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()) {
                format!("{base}[]")
            } else {
                key.clone()
            }
        } else {
            key.clone()
        };
        result.push_str(&format!("{key}={value}\n"));
    }
    Ok(result)
}
