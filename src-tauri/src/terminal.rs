//! Byte-preserving Desktop terminal transform and bounded tail buffer.
#[derive(Default)]
pub struct Terminal {
    buffer: Vec<u8>,
    length: usize,
    position: usize,
}
impl Terminal {
    fn reset(&mut self) {
        self.buffer = vec![0; 1024];
        self.length = 0;
        self.position = 0;
    }
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.buffer.is_empty() {
            self.reset();
        }
        let mut output = Vec::new();
        let mut index = 0;
        while index < chunk.len() {
            let cr = chunk[index..].iter().position(|b| *b == b'\r').map(|n| n + index);
            let lf = if cr.is_none() {
                chunk[index..].iter().rposition(|b| *b == b'\n')
            } else {
                chunk[index..].iter().position(|b| *b == b'\n')
            }
            .map(|n| n + index);
            let next = cr.unwrap_or(chunk.len() - 1).min(lf.unwrap_or(chunk.len() - 1));
            let mut start = index;
            let end = next + 1;
            while start < end {
                let size = end - start;
                if self.position + size > self.buffer.len() {
                    if self.position > 0 {
                        output.extend_from_slice(&self.buffer[..self.position]);
                    }
                    let remaining = self.buffer.len() - self.position;
                    output.extend_from_slice(&chunk[start..start + remaining]);
                    start += remaining;
                    self.reset();
                } else {
                    self.buffer[self.position..self.position + size].copy_from_slice(&chunk[start..end]);
                    self.position += size;
                    self.length = self.length.max(self.position);
                    break;
                }
            }
            if chunk[next] == b'\n' && self.length > 0 {
                output.extend_from_slice(&self.buffer[..self.length]);
                self.reset();
            } else if chunk[next] == b'\r' {
                self.position = 0;
            }
            index = next + 1;
        }
        output
    }
    pub fn finish(&mut self) -> Vec<u8> {
        let result = self.buffer[..self.length].to_vec();
        self.reset();
        result
    }
}
#[derive(Default)]
pub struct Tail {
    chunks: std::collections::VecDeque<Vec<u8>>,
    length: usize,
}
impl Tail {
    pub fn push(&mut self, capacity: usize, chunk: &[u8]) {
        self.length += chunk.len();
        self.chunks.push_back(chunk.to_vec());
        while self.length > capacity {
            let first = self.chunks.pop_front().expect("Nonempty tail");
            let overrun = self.length - capacity;
            if overrun >= first.len() {
                self.length -= first.len();
            } else {
                self.chunks.push_front(first[overrun..].to_vec());
                self.length -= overrun;
            }
        }
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.chunks.iter().flatten().copied().collect()
    }
}
