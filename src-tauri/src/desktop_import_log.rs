//! Strict LevelDB log framing for migration. Forensic readers deliberately skip
//! damaged records; a migration must fail instead of resurrecting stale values.
//! Format: google/leveldb doc/log_format.md and db/version_edit.cc.
use std::collections::BTreeSet;
use std::path::Path;

pub fn records(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut output = Vec::new();
    let mut fragment: Option<Vec<u8>> = None;
    for block in bytes.chunks(32768) {
        let mut offset = 0;
        while offset < block.len() {
            let remaining = &block[offset..];
            if remaining.len() < 7 || remaining.iter().all(|b| *b == 0) {
                if remaining.iter().any(|b| *b != 0) {
                    return Err("Truncated Desktop storage log".into());
                }
                break;
            }
            let checksum = u32::from_le_bytes(remaining[..4].try_into().map_err(|_| "Invalid checksum")?);
            let length = u16::from_le_bytes([remaining[4], remaining[5]]) as usize;
            let kind = remaining[6];
            let data = remaining.get(7..7 + length).ok_or("Truncated Desktop storage record")?;
            let actual = crc32c::crc32c_append(crc32c::crc32c(&[kind]), data).rotate_left(17).wrapping_add(0xa282_ead8);
            if checksum != actual {
                return Err("Desktop storage checksum mismatch".into());
            }
            match kind {
                1 if fragment.is_none() => output.push(data.to_vec()),
                2 if fragment.is_none() => fragment = Some(data.to_vec()),
                3 if fragment.is_some() => fragment.as_mut().ok_or("Missing fragment")?.extend_from_slice(data),
                4 => {
                    let mut value = fragment.take().ok_or("Missing Desktop log fragment")?;
                    value.extend_from_slice(data);
                    output.push(value);
                }
                _ => return Err("Invalid Desktop log fragment order".into()),
            }
            offset += 7 + length;
        }
    }
    if fragment.is_some() {
        return Err("Incomplete Desktop storage transaction".into());
    }
    Ok(output)
}

struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
    fn number(&mut self) -> Result<u64, String> {
        let mut number = 0u64;
        for shift in (0..70).step_by(7) {
            let (&byte, rest) = self.0.split_first().ok_or("Truncated Desktop varint")?;
            self.0 = rest;
            if shift == 63 && byte > 1 {
                return Err("Desktop varint overflow".into());
            }
            number |= u64::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(number);
            }
        }
        Err("Desktop varint overflow".into())
    }
    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let length = usize::try_from(self.number()?).map_err(|_| "Desktop value too large")?;
        let value = self.0.get(..length).ok_or("Truncated Desktop value")?;
        self.0 = &self.0[length..];
        Ok(value)
    }
}

pub fn validate_batches(bytes: &[u8]) -> Result<(), String> {
    for batch in records(bytes)? {
        let header = batch.get(..12).ok_or("Truncated Desktop write batch")?;
        let count = u32::from_le_bytes(header[8..12].try_into().map_err(|_| "Invalid batch")?);
        let mut cursor = Cursor(&batch[12..]);
        for _ in 0..count {
            let (&kind, rest) = cursor.0.split_first().ok_or("Incomplete Desktop write batch")?;
            cursor.0 = rest;
            cursor.bytes()?;
            if kind == 1 {
                cursor.bytes()?;
            } else if kind != 0 {
                return Err("Unknown Desktop batch operation".into());
            }
        }
        if !cursor.0.is_empty() {
            return Err("Invalid Desktop write batch length".into());
        }
    }
    Ok(())
}

pub struct ActiveFiles {
    pub tables: BTreeSet<u64>,
    pub log: u64,
    pub previous_log: u64,
}
impl ActiveFiles {
    pub fn contains(&self, path: &Path) -> bool {
        let Some(number) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u64>().ok()) else {
            return false;
        };
        match path.extension().and_then(|s| s.to_str()) {
            Some("log") => number >= self.log || (self.previous_log != 0 && number == self.previous_log),
            Some("ldb" | "sst") => self.tables.contains(&number),
            _ => false,
        }
    }
}

pub fn manifest(bytes: &[u8]) -> Result<ActiveFiles, String> {
    let mut result = ActiveFiles { tables: BTreeSet::new(), log: 0, previous_log: 0 };
    for edit in records(bytes)? {
        let mut cursor = Cursor(&edit);
        while !cursor.0.is_empty() {
            match cursor.number()? {
                1 => {
                    cursor.bytes()?;
                }
                2 => result.log = cursor.number()?,
                3 | 4 => {
                    cursor.number()?;
                }
                5 => {
                    cursor.number()?;
                    cursor.bytes()?;
                }
                6 => {
                    cursor.number()?;
                    result.tables.remove(&cursor.number()?);
                }
                7 => {
                    cursor.number()?;
                    result.tables.insert(cursor.number()?);
                    cursor.number()?;
                    cursor.bytes()?;
                    cursor.bytes()?;
                }
                9 => result.previous_log = cursor.number()?,
                _ => return Err("Unsupported Desktop LevelDB manifest version".into()),
            }
        }
    }
    Ok(result)
}
