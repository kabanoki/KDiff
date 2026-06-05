use rustc_hash::FxHasher;
use serde::Serialize;
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::hash::{Hash, Hasher};

/// One aligned side-by-side row.
/// `left` / `right` are 0-based line indices, or -1 when that side is blank.
/// `kind`: 0 equal, 1 insert(right only), 2 delete(left only), 3 modify(both).
pub struct Row {
    pub left: i32,
    pub right: i32,
    pub kind: u8,
}

/// A changed character range inside a modified line (char offsets, not bytes).
#[derive(Serialize)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

/// Hash each line to a u64 so the line-level diff compares integers, not strings.
pub fn hash_lines(lines: &[String]) -> Vec<u64> {
    lines
        .iter()
        .map(|l| {
            let mut h = FxHasher::default();
            l.hash(&mut h);
            h.finish()
        })
        .collect()
}

/// Build the aligned row list from the two line-hash sequences.
pub fn build_rows(left: &[u64], right: &[u64]) -> Vec<Row> {
    let ops = capture_diff_slices(Algorithm::Patience, left, right);
    let mut rows: Vec<Row> = Vec::new();

    for op in ops {
        match op {
            DiffOp::Equal { old_index, new_index, len } => {
                for i in 0..len {
                    rows.push(Row { left: (old_index + i) as i32, right: (new_index + i) as i32, kind: 0 });
                }
            }
            DiffOp::Delete { old_index, old_len, .. } => {
                for i in 0..old_len {
                    rows.push(Row { left: (old_index + i) as i32, right: -1, kind: 2 });
                }
            }
            DiffOp::Insert { new_index, new_len, .. } => {
                for i in 0..new_len {
                    rows.push(Row { left: -1, right: (new_index + i) as i32, kind: 1 });
                }
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                let common = old_len.min(new_len);
                for i in 0..common {
                    rows.push(Row { left: (old_index + i) as i32, right: (new_index + i) as i32, kind: 3 });
                }
                for i in common..old_len {
                    rows.push(Row { left: (old_index + i) as i32, right: -1, kind: 2 });
                }
                for i in common..new_len {
                    rows.push(Row { left: -1, right: (new_index + i) as i32, kind: 1 });
                }
            }
        }
    }
    rows
}

#[cfg(test)]
mod bench {
    use super::*;
    use std::time::Instant;

    // Temporary benchmark: run with
    //   cargo test --release bench_1m -- --nocapture --ignored
    #[test]
    #[ignore]
    fn bench_1m() {
        let t0 = Instant::now();
        let lt = std::fs::read_to_string("/tmp/kdiff-test/big_a.txt").unwrap();
        let rt = std::fs::read_to_string("/tmp/kdiff-test/big_b.txt").unwrap();
        let left: Vec<String> = lt.lines().map(|s| s.to_string()).collect();
        let right: Vec<String> = rt.lines().map(|s| s.to_string()).collect();
        println!("read+split: {:?} ({} / {} lines)", t0.elapsed(), left.len(), right.len());

        let t1 = Instant::now();
        let lh = hash_lines(&left);
        let rh = hash_lines(&right);
        println!("hash: {:?}", t1.elapsed());

        let t2 = Instant::now();
        let rows = build_rows(&lh, &rh);
        println!("diff+rows: {:?} ({} rows)", t2.elapsed(), rows.len());
        println!("TOTAL: {:?}", t0.elapsed());
    }
}

/// Character-level diff of two modified lines, returning the changed ranges on
/// each side (left = deletions, right = insertions).
pub fn inline(a: &str, b: &str) -> (Vec<Span>, Vec<Span>) {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let ops = capture_diff_slices(Algorithm::Myers, &ac, &bc);

    let mut left = Vec::new();
    let mut right = Vec::new();
    for op in ops {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete { old_index, old_len, .. } => {
                left.push(Span { start: old_index as u32, end: (old_index + old_len) as u32 });
            }
            DiffOp::Insert { new_index, new_len, .. } => {
                right.push(Span { start: new_index as u32, end: (new_index + new_len) as u32 });
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                left.push(Span { start: old_index as u32, end: (old_index + old_len) as u32 });
                right.push(Span { start: new_index as u32, end: (new_index + new_len) as u32 });
            }
        }
    }
    (left, right)
}
