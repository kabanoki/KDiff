import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

// ---- types mirrored from the Rust backend ----
type Span = { start: number; end: number };
type RowOut = { l: number; r: number; k: number; lt: string; rt: string; ls: Span[]; rs: Span[] };
type Block = { start: number; end: number; kind: number };
type Summary = {
  total: number;
  left_path: string;
  right_path: string;
  added: number;
  removed: number;
  modified: number;
  blocks: Block[];
  max_left: number;
  max_right: number;
};

const ROW_H = 20;
const BUFFER = 16;     // extra rows above/below the viewport
const CHUNK = 256;     // rows fetched per backend call
const CONTEXT = 3;     // unchanged lines kept around a change in "diff-only" mode
// WebKit cannot lay out / paint elements taller than ~2^24px, so the scroll
// runway is capped below that and scrollTop is remapped onto the true height.
const MAX_RUNWAY = 16_000_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- state ----
let leftPath = "";
let rightPath = "";
let summary: Summary | null = null;
let blocks: Block[] = [];

const cache = new Map<number, RowOut>();     // actual row index -> row data
const loaded = new Set<number>();            // chunk index -> fetched
const pending = new Set<number>();           // chunk index -> in flight

// "diff-only" view model: a compact list of entries.
//   entry >= 0  -> actual row index
//   entry <  0  -> gap, decode gid = -entry - 1
let diffOnly = false;
let viewRows: number[] | null = null;        // null => identity (full file)
let viewLen = 0;
let gaps: [number, number][] = [];           // gid -> [hiddenStart, hiddenEnd)

let charW = 7.2;                             // measured monospace char width

let virtualH = 0;                            // true pixel height (viewLen * ROW_H)
let runwayH = 0;                             // capped pixel height of the scroller

// Two panes scroll horizontally on their own; rpane carries the (single) shared
// vertical scrollbar and drives the vertical math. lpane's vertical scroll is
// kept in sync in JS.
const lpane = $("lpane");
const rpane = $("rpane");
const lcontent = $("lcontent");
const rcontent = $("rcontent");

// ---- scroll mapping (handles the runway cap) ----
// virtualScrollTop(): the true pixel offset into the full content for the
// current real scrollTop. setVirtualScrollTop(): inverse. topViewRow(): the
// first view row at the top of the viewport. All collapse to identity when the
// content fits under the cap.
function virtualScrollTop(): number {
  const maxRunway = runwayH - rpane.clientHeight;
  if (maxRunway <= 0) return 0;
  return (rpane.scrollTop / maxRunway) * (virtualH - rpane.clientHeight);
}

function setVirtualScrollTop(v: number) {
  const maxVirtual = virtualH - rpane.clientHeight;
  if (maxVirtual <= 0) { rpane.scrollTop = 0; return; }
  const clamped = Math.max(0, Math.min(v, maxVirtual));
  rpane.scrollTop = (clamped / maxVirtual) * (runwayH - rpane.clientHeight);
}

function topViewRow(): number {
  return Math.floor(virtualScrollTop() / ROW_H);
}

// ---------- helpers ----------
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function actualRow(i: number): number {
  return viewRows ? viewRows[i] : i;
}

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 4000);
}

function measureChar() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;font-family:var(--mono);font-size:12.5px;white-space:pre;";
  probe.textContent = "0".repeat(100);
  document.body.appendChild(probe);
  charW = probe.getBoundingClientRect().width / 100 || 7.2;
  probe.remove();
}

// ---------- backend fetching ----------
function fetchChunk(chunkIdx: number) {
  if (loaded.has(chunkIdx) || pending.has(chunkIdx)) return;
  pending.add(chunkIdx);
  const start = chunkIdx * CHUNK;
  invoke<RowOut[]>("get_rows", { start, count: CHUNK })
    .then((rows) => {
      rows.forEach((row, i) => cache.set(start + i, row));
      loaded.add(chunkIdx);
      pending.delete(chunkIdx);
      scheduleRender();
    })
    .catch((e) => {
      pending.delete(chunkIdx);
      toast(String(e));
    });
}

function ensureVisible(viewStart: number, viewEnd: number) {
  const need = new Set<number>();
  for (let i = viewStart; i < viewEnd; i++) {
    const r = actualRow(i);
    if (r >= 0 && !cache.has(r)) need.add(Math.floor(r / CHUNK));
  }
  need.forEach(fetchChunk);
}

// ---------- rendering ----------
// Build one row's HTML for both panes; [left half, right half].
function rowPair(viewIdx: number, y: number): [string, string] {
  const v = actualRow(viewIdx);

  if (v < 0) {
    const [s, e] = gaps[-v - 1];
    const n = e - s;
    const gap = `<div class="row gap" data-vi="${viewIdx}" style="top:${y}px;width:100%">` +
      `<div class="gaptext">⋯ ${n.toLocaleString()} 行を省略 — クリックで展開</div></div>`;
    return [gap, gap];
  }

  const row = cache.get(v);
  if (!row) {
    return [
      `<div class="row eq" style="top:${y}px"><div class="gln"></div><div class="ltxt"></div></div>`,
      `<div class="row eq" style="top:${y}px"><div class="rln"></div><div class="rtxt"></div></div>`,
    ];
  }

  const cls = row.k === 1 ? "ins" : row.k === 2 ? "del" : row.k === 3 ? "mod" : "eq";
  const lno = row.l >= 0 ? row.l + 1 : "";
  const rno = row.r >= 0 ? row.r + 1 : "";
  const ltxt = row.k === 3 ? markInline(row.lt, row.ls, "del") : esc(row.lt);
  const rtxt = row.k === 3 ? markInline(row.rt, row.rs, "ins") : esc(row.rt);

  return [
    `<div class="row ${cls}" style="top:${y}px"><div class="gln">${lno}</div><div class="ltxt">${ltxt}</div></div>`,
    `<div class="row ${cls}" style="top:${y}px"><div class="rln">${rno}</div><div class="rtxt">${rtxt}</div></div>`,
  ];
}

function markInline(text: string, spans: Span[], cls: string): string {
  if (!spans.length) return esc(text);
  const chars = Array.from(text);
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += esc(chars.slice(pos, s.start).join(""));
    out += `<span class="hi-${cls}">${esc(chars.slice(s.start, s.end).join(""))}</span>`;
    pos = s.end;
  }
  out += esc(chars.slice(pos).join(""));
  return out;
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render() {
  if (!summary) return;
  const vTop = virtualScrollTop();
  const viewH = rpane.clientHeight;

  let start = Math.floor(vTop / ROW_H) - BUFFER;
  if (start < 0) start = 0;
  let end = Math.ceil((vTop + viewH) / ROW_H) + BUFFER;
  if (end > viewLen) end = viewLen;

  ensureVisible(start, end);

  // Place rows in content space: on-screen y = i*ROW_H - vTop, and content is
  // scrolled by scrollTop, so content-space top = i*ROW_H - vTop + scrollTop.
  // Both panes share the same vertical scrollTop (kept in sync).
  const base = rpane.scrollTop - vTop;
  let lhtml = "";
  let rhtml = "";
  for (let i = start; i < end; i++) {
    const [lh, rh] = rowPair(i, i * ROW_H + base);
    lhtml += lh;
    rhtml += rh;
  }
  lcontent.innerHTML = lhtml;
  rcontent.innerHTML = rhtml;

  updateMinimapView();
}

// ---------- geometry / view model ----------
function setupGeometry() {
  if (!summary) return;
  virtualH = viewLen * ROW_H;
  runwayH = Math.min(virtualH, MAX_RUNWAY);
  lcontent.style.height = runwayH + "px";
  rcontent.style.height = runwayH + "px";
  // Each text column is at least the longest line's natural width; if shorter, it
  // grows to fill its own pane so no horizontal space is wasted. Longer lines
  // overflow and the pane gets its own horizontal scrollbar.
  const GUTTER = 56; // keep in sync with --gutter in styles.css
  const natL = Math.max(120, Math.ceil(summary.max_left * charW) + 16);
  const natR = Math.max(120, Math.ceil(summary.max_right * charW) + 16);
  const lw = Math.max(natL, lpane.clientWidth - GUTTER);
  const rw = Math.max(natR, rpane.clientWidth - GUTTER);
  lcontent.style.setProperty("--tw", lw + "px");
  rcontent.style.setProperty("--tw", rw + "px");
  lcontent.style.width = `calc(var(--gutter) + ${lw}px)`;
  rcontent.style.width = `calc(var(--gutter) + ${rw}px)`;
}

function buildView() {
  if (!summary) return;
  gaps = [];
  if (!diffOnly) {
    viewRows = null;
    viewLen = summary.total;
    return;
  }
  // Merge change blocks with CONTEXT lines, collapse everything else into gaps.
  const show: [number, number][] = [];
  for (const b of blocks) {
    const s = Math.max(0, b.start - CONTEXT);
    const e = Math.min(summary.total, b.end + CONTEXT);
    const last = show[show.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else show.push([s, e]);
  }
  const rows: number[] = [];
  let prev = 0;
  for (const [s, e] of show) {
    if (s > prev) { rows.push(-(gaps.push([prev, s])) ); }
    for (let r = s; r < e; r++) rows.push(r);
    prev = e;
  }
  if (prev < summary.total) { rows.push(-(gaps.push([prev, summary.total]))); }
  viewRows = rows;
  viewLen = rows.length;
}

// Switch between "all" and "diff-only", keeping the currently shown line in view.
function setMode(diff: boolean) {
  if (!summary) return;
  const anchor = actualRow(topViewRow());
  diffOnly = diff;
  buildView();
  setupGeometry();
  scrollToActualRow(Math.max(0, anchor));
  render();
}

function expandGap(viewIdx: number) {
  if (!viewRows) return;
  const v = viewRows[viewIdx];
  if (v >= 0) return;
  const [s, e] = gaps[-v - 1];
  const fill: number[] = [];
  for (let r = s; r < e; r++) fill.push(r);
  viewRows.splice(viewIdx, 1, ...fill);
  viewLen = viewRows.length;
  setupGeometry();
  render();
}

// ---------- minimap ----------
function renderMinimap() {
  const marks = $("mm-marks");
  if (!summary || !blocks.length) { marks.innerHTML = ""; return; }
  const total = summary.total;
  marks.innerHTML = blocks
    .map((b) => {
      const cls = b.kind === 1 ? "add" : b.kind === 2 ? "del" : "mod";
      const top = (b.start / total) * 100;
      const h = Math.max(0.15, ((b.end - b.start) / total) * 100);
      return `<div class="mk ${cls}" style="top:${top}%;height:${h}%"></div>`;
    })
    .join("");
}

function updateMinimapView() {
  if (!summary) return;
  const mm = $("mm-view");
  const total = summary.total;
  const topRow = actualRow(topViewRow());
  const top = (Math.max(0, topRow) / total) * 100;
  const frac = Math.min(1, rpane.clientHeight / (virtualH || 1));
  mm.style.top = top + "%";
  mm.style.height = Math.max(2, frac * 100) + "%";
}

// ---------- jump to change ----------
function viewIndexOfRow(target: number): number {
  if (!viewRows) return target;
  // diff-only view is small; find the exact row, else the nearest visible row
  // at or after it (the target may have been collapsed into a gap).
  let fallback = -1;
  for (let i = 0; i < viewRows.length; i++) {
    const r = viewRows[i];
    if (r === target) return i;
    if (r >= 0 && r > target && fallback === -1) fallback = i;
  }
  return fallback === -1 ? viewRows.length - 1 : fallback;
}

function scrollToActualRow(target: number) {
  const vi = viewRows ? viewIndexOfRow(target) : target;
  if (vi < 0) return;
  setVirtualScrollTop(Math.max(0, vi * ROW_H - ROW_H * 3));
}

function jump(dir: 1 | -1) {
  if (!blocks.length) return;
  const topRow = actualRow(topViewRow() + 3);
  let target: Block | null = null;
  if (dir === 1) {
    for (const b of blocks) if (b.start > topRow) { target = b; break; }
    if (!target) target = blocks[0];
  } else {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].start < topRow - 3) { target = blocks[i]; break; }
    if (!target) target = blocks[blocks.length - 1];
  }
  scrollToActualRow(target.start);
}

// ---------- open + compare ----------
function setPath(side: "left" | "right", path: string) {
  if (side === "left") leftPath = path; else rightPath = path;
  const el = $(`path-${side}`);
  el.textContent = path;
  el.classList.add("set");
}

async function compare() {
  if (!leftPath || !rightPath) return;
  cache.clear(); loaded.clear(); pending.clear();
  try {
    summary = await invoke<Summary>("open_files", { left: leftPath, right: rightPath });
  } catch (e) {
    toast(String(e));
    return;
  }
  blocks = summary.blocks;
  $("stats").hidden = false;
  $("nav").hidden = false;
  $("s-add").textContent = summary.added.toLocaleString();
  $("s-del").textContent = summary.removed.toLocaleString();
  $("s-mod").textContent = summary.modified.toLocaleString();

  $("stage").classList.add("loaded");
  buildView();
  setupGeometry();
  renderMinimap();
  lpane.scrollTop = rpane.scrollTop = 0;
  lpane.scrollLeft = rpane.scrollLeft = 0;
  render();
}

// Clear everything so a fresh pair of files can be chosen.
function resetAll() {
  leftPath = ""; rightPath = "";
  summary = null; blocks = [];
  cache.clear(); loaded.clear(); pending.clear();
  viewRows = null; viewLen = 0; gaps = []; diffOnly = false;

  $("path-left").textContent = "左ファイルをドロップ / 参照";
  $("path-right").textContent = "右ファイルをドロップ / 参照";
  $("path-left").classList.remove("set");
  $("path-right").classList.remove("set");

  $("stats").hidden = true;
  $("nav").hidden = true;
  $("stage").classList.remove("loaded");
  document.querySelectorAll(".tab").forEach((t, i) => t.classList.toggle("active", i === 0));

  lcontent.innerHTML = "";
  rcontent.innerHTML = "";
  lpane.scrollTop = rpane.scrollTop = 0;
  lpane.scrollLeft = rpane.scrollLeft = 0;
}

// Which side a drop lands on: the slot/pane actually under the pointer, else the
// half of the stage it falls in. Tauri reports the position in physical pixels.
function dropSide(physX: number, physY: number): "left" | "right" {
  const dpr = window.devicePixelRatio || 1;
  const x = physX / dpr;
  const el = document.elementFromPoint(x, physY / dpr) as HTMLElement | null;
  if (el?.closest("#slot-right, #rpane")) return "right";
  if (el?.closest("#slot-left, #lpane")) return "left";
  return x < rpane.getBoundingClientRect().left ? "left" : "right";
}

function setDragTarget(side: "left" | "right" | null) {
  $("slot-left").classList.toggle("drag", side === "left");
  $("slot-right").classList.toggle("drag", side === "right");
  lpane.classList.toggle("drag", side === "left");
  rpane.classList.toggle("drag", side === "right");
}

// Open another independent KDiff window (its own diff state, label "w-<id>").
function newWindow() {
  new WebviewWindow(`w-${Date.now()}`, {
    url: window.location.pathname,
    title: "KDiff",
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    dragDropEnabled: true,
  });
}

// ---------- wiring ----------
function init() {
  measureChar();

  $("pick-left").addEventListener("click", () => pick("left"));
  $("pick-right").addEventListener("click", () => pick("right"));
  $("swap").addEventListener("click", () => {
    [leftPath, rightPath] = [rightPath, leftPath];
    if (leftPath) setPath("left", leftPath);
    if (rightPath) setPath("right", rightPath);
    compare();
  });

  $("next").addEventListener("click", () => jump(1));
  $("prev").addEventListener("click", () => jump(-1));
  $("reset").addEventListener("click", resetAll);
  $("newwin").addEventListener("click", newWindow);

  $("tabs").addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
    if (!tab) return;
    const mode = tab.dataset.mode === "diff";
    if (mode === diffOnly) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    setMode(mode);
  });

  // Keep the two panes vertically aligned; horizontal scroll stays independent.
  const syncV = (src: HTMLElement, dst: HTMLElement) => {
    if (dst.scrollTop !== src.scrollTop) dst.scrollTop = src.scrollTop;
    scheduleRender();
  };
  lpane.addEventListener("scroll", () => syncV(lpane, rpane), { passive: true });
  rpane.addEventListener("scroll", () => syncV(rpane, lpane), { passive: true });

  window.addEventListener("resize", () => {
    if (!summary) return;
    setupGeometry();
    render();
  });

  const onGapClick = (e: Event) => {
    const gap = (e.target as HTMLElement).closest(".row.gap") as HTMLElement | null;
    if (gap) expandGap(Number(gap.dataset.vi));
  };
  lcontent.addEventListener("click", onGapClick);
  rcontent.addEventListener("click", onGapClick);

  // minimap click -> jump
  $("minimap").addEventListener("click", (e) => {
    if (!summary) return;
    const rect = $("minimap").getBoundingClientRect();
    const frac = (e.clientY - rect.top) / rect.height;
    scrollToActualRow(Math.floor(frac * summary.total));
  });

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); jump(1); }
    if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); jump(-1); }
    if (e.ctrlKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); newWindow(); }
  });

  // native drag & drop of files onto the left/right slots or panes
  getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    if (p.type === "over") {
      setDragTarget(dropSide(p.position.x, p.position.y));
    } else if (p.type === "drop") {
      setDragTarget(null);
      const path = p.paths[0];
      if (!path) return;
      setPath(dropSide(p.position.x, p.position.y), path);
      compare();
    } else {
      setDragTarget(null);
    }
  });
}

async function pick(side: "left" | "right") {
  const sel = await open({ multiple: false, directory: false });
  if (typeof sel === "string") {
    setPath(side, sel);
    compare();
  }
}

init();
