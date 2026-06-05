mod diff;

use diff::{build_rows, hash_lines, inline, Row, Span};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, State};

/// The currently loaded comparison. Kept entirely on the Rust side so the huge
/// line data never has to cross into the webview at once.
struct Doc {
    left_lines: Vec<String>,
    right_lines: Vec<String>,
    rows: Vec<Row>,
}

/// One `Doc` per window (keyed by window label) so multiple windows compare
/// independent file pairs without clobbering each other.
#[derive(Default)]
struct AppState(Mutex<HashMap<String, Doc>>);

/// A contiguous run of changed rows (for the minimap and jump navigation).
#[derive(Serialize)]
struct Block {
    start: u32,
    end: u32,
    kind: u8, // 1 add, 2 del, 3 mixed/modify
}

#[derive(Serialize)]
struct Summary {
    total: u32,
    left_path: String,
    right_path: String,
    added: u32,
    removed: u32,
    modified: u32,
    blocks: Vec<Block>,
    max_left: u32,
    max_right: u32,
}

/// One row shipped to the frontend window. Short field names keep the JSON small.
#[derive(Serialize)]
struct RowOut {
    l: i32,
    r: i32,
    k: u8,
    lt: String,
    rt: String,
    ls: Vec<Span>,
    rs: Vec<Span>,
}

fn split_lines(text: &str) -> Vec<String> {
    text.lines().map(|s| s.to_string()).collect()
}

fn max_len(lines: &[String]) -> u32 {
    lines.iter().map(|l| l.chars().count() as u32).max().unwrap_or(0)
}

/// Read both files, run the line-level diff and assemble the summary + the
/// document we keep in Rust state. CPU-bound, so this is run off the main
/// thread (see `open_files`).
fn compute(left: String, right: String) -> Result<(Summary, Doc), String> {
    let lt = std::fs::read_to_string(&left).map_err(|e| format!("左ファイルを開けません: {e}"))?;
    let rt = std::fs::read_to_string(&right).map_err(|e| format!("右ファイルを開けません: {e}"))?;

    let left_lines = split_lines(&lt);
    let right_lines = split_lines(&rt);
    let max_left = max_len(&left_lines);
    let max_right = max_len(&right_lines);

    let lh = hash_lines(&left_lines);
    let rh = hash_lines(&right_lines);
    let rows = build_rows(&lh, &rh);

    // stats
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut modified = 0u32;
    for r in &rows {
        match r.kind {
            1 => added += 1,
            2 => removed += 1,
            3 => modified += 1,
            _ => {}
        }
    }

    // merge consecutive changed rows into blocks, tagging the dominant kind
    let mut blocks: Vec<Block> = Vec::new();
    let mut run_start: Option<usize> = None;
    let mut has_add = false;
    let mut has_del = false;
    let mut has_mod = false;
    for (idx, r) in rows.iter().enumerate() {
        if r.kind != 0 {
            if run_start.is_none() {
                run_start = Some(idx);
                has_add = false;
                has_del = false;
                has_mod = false;
            }
            match r.kind {
                1 => has_add = true,
                2 => has_del = true,
                _ => has_mod = true,
            }
        } else if let Some(s) = run_start.take() {
            blocks.push(Block { start: s as u32, end: idx as u32, kind: block_kind(has_add, has_del, has_mod) });
        }
    }
    if let Some(s) = run_start.take() {
        blocks.push(Block { start: s as u32, end: rows.len() as u32, kind: block_kind(has_add, has_del, has_mod) });
    }

    let summary = Summary {
        total: rows.len() as u32,
        left_path: left,
        right_path: right,
        added,
        removed,
        modified,
        blocks,
        max_left,
        max_right,
    };

    Ok((summary, Doc { left_lines, right_lines, rows }))
}

#[tauri::command]
async fn open_files(window: tauri::Window, left: String, right: String, state: State<'_, AppState>) -> Result<Summary, String> {
    let (summary, doc) = tauri::async_runtime::spawn_blocking(move || compute(left, right))
        .await
        .map_err(|e| format!("比較処理に失敗しました: {e}"))??;
    state.0.lock().unwrap().insert(window.label().to_string(), doc);
    Ok(summary)
}

fn block_kind(add: bool, del: bool, modi: bool) -> u8 {
    if modi || (add && del) {
        3
    } else if add {
        1
    } else if del {
        2
    } else {
        3
    }
}

#[tauri::command]
fn get_rows(window: tauri::Window, start: u32, count: u32, state: State<AppState>) -> Result<Vec<RowOut>, String> {
    let guard = state.0.lock().unwrap();
    let doc = guard.get(window.label()).ok_or("ファイルが読み込まれていません")?;

    let s = start as usize;
    let e = (s + count as usize).min(doc.rows.len());
    if s >= e {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(e - s);
    for row in &doc.rows[s..e] {
        let lt = if row.left >= 0 { doc.left_lines[row.left as usize].clone() } else { String::new() };
        let rt = if row.right >= 0 { doc.right_lines[row.right as usize].clone() } else { String::new() };
        let (ls, rs) = if row.kind == 3 { inline(&lt, &rt) } else { (Vec::new(), Vec::new()) };
        out.push(RowOut { l: row.left, r: row.right, k: row.kind, lt, rt, ls, rs });
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        // Free a window's (potentially huge) Doc when it closes.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<AppState>().0.lock().unwrap().remove(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![open_files, get_rows])
        .run(tauri::generate_context!())
        .expect("error while running KDiff");
}
