//! crate docs
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Point<'a, T: Copy> { x: T, name: &'a str }

/// doc comment
impl<'a, T: Copy + std::fmt::Debug> Point<'a, T> {
    pub fn new(x: T, name: &'a str) -> Self { Self { x, name } }
    fn show(&self) -> String { format!("{:?} {}", self.x, self.name) }
}

fn main() {
    let mut m: HashMap<u32, f64> = HashMap::new();
    m.insert(1_000, 2.5e-3);
    let s = r#"raw "string""#;
    let c = 'x'; let b = b'y';
    match m.get(&1000) { Some(v) if *v > 0.0 => println!("{s} {c} {b}"), _ => unreachable!() }
    /* block
       comment */
    loop { break; }
}
