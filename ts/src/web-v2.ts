// v2 editor page. Owns: textarea source, parse/run loop, display-module
// dispatch, error/status panel. Choice resolutions are appended directly to
// the source textarea as `= V… (…)` shared bindings + `^ is L R` rows; no
// side-channel buffer.

import { parse } from "./v2/parse.js";
import { runFixpoint } from "./v2/fixpoint.js";
import { renderTerm, renderTermShallow, compressRefs } from "./v2/print.js";
import { refTagOf } from "./hashcons.js";
import { renderTimeline } from "./v2/timeline.js";
import type { Atom, Term } from "./types.js";
import type { Store } from "./v2/store.js";
import { lessThan } from "./v2/store.js";
import type { ComponentOptions, Rule, RuleAtom } from "./v2/types.js";

// A click intent is an unresolved component plus the chosen option tuple.
// `activeTerms[i]` should bind to `optionTuple[i]`. `handleClick` reifies
// this into source via `compressRefs` and inserts at the textarea cursor.
interface ClickIntent {
  activeTerms: Term[];
  optionTuple: Term[];
}

interface DisplayCallContext {
  components: ComponentOptions[];
}

interface DisplayApi {
  addStyles(css: string): void;
  // One-level peek for Refs; mirrors the v1 helper.
  peek(term: Term, store: Store): Atom | null;
  renderTerm: (store: Store, t: Term) => string;
}

interface DisplayModule {
  render(
    store: Store,
    ctx: DisplayCallContext,
  ): { element: HTMLElement; clicks: Map<HTMLElement, ClickIntent> } | null;
}

const sourceEl = document.getElementById("source") as HTMLTextAreaElement;
const sourceCursorLineEl = document.getElementById("source-cursor-line") as HTMLSpanElement;
const displayEl = document.getElementById("display") as HTMLDivElement;
const dbEl = document.getElementById("db") as HTMLDivElement;
const infoEl = document.getElementById("info") as HTMLDivElement;
const statusEl = document.getElementById("status-line") as HTMLSpanElement;
const fileNameEl = document.getElementById("file-name") as HTMLSpanElement;
const hideInternalEl = document.getElementById("hide-internal") as HTMLInputElement;
const dbTemporalEl = document.getElementById("db-temporal") as HTMLInputElement;
const editorTabEl = document.getElementById("editor-tab") as HTMLDivElement;
const timelineTabEl = document.getElementById("timeline-tab") as HTMLDivElement;
const timelineMainEl = document.getElementById("timeline-main") as HTMLDivElement;
const timelineSidebarEl = document.getElementById("timeline-sidebar-host") as HTMLDivElement;
const tabBtnEditor = document.getElementById("tab-editor") as HTMLButtonElement;
const tabBtnTimeline = document.getElementById("tab-timeline") as HTMLButtonElement;
const orientHEl = document.getElementById("timeline-orient-h") as HTMLButtonElement;
const orientVEl = document.getElementById("timeline-orient-v") as HTMLButtonElement;

const GAS = 100;
const TUPLE_GAS = 3000;

let currentDisplayName: string | null = null;
let currentDisplayModule: DisplayModule | null = null;
const injectedStyles = new Set<string>();

// Last fixpoint store; used by `handleClick` to compress option intents
// into source-form text. `null` until the first `run()` completes.
let lastStore: Store | null = null;

// Per-render lookup of click intents for option-list `<span class="opt">`
// nodes. Cleared at the start of each `run()`; entries' lifetime matches
// the DOM nodes they're keyed against.
const clickIntents = new Map<string, ClickIntent>();
let clickIdCounter = 0;

// Server-sync state. `loadedFile` is non-null after `bootstrap` successfully
// fetches a file from the server; subsequent edits are written back to it
// via a debounced PUT. Failure to PUT just shows in the status line — we
// don't gate further edits on it.
let loadedFile: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveStatus: "idle" | "pending" | "saving" | "error" = "idle";

// Playground mode: when the page is loaded at /v2/playground, the source is
// read from / written to the `?code=` URL param (URL-safe base64). No server
// PUTs happen; the textarea state lives entirely in the URL so it's shareable.
const playgroundMode = window.location.pathname === "/v2/playground";

const SAVE_DEBOUNCE_MS = 400;

function b64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function updatePlaygroundUrl(): void {
  if (!playgroundMode) return;
  const code = b64UrlEncode(sourceEl.value);
  const url = new URL(window.location.href);
  url.searchParams.set("code", code);
  window.history.replaceState(null, "", url.toString());
}

function schedulePut(): void {
  if (loadedFile === null) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveStatus = "pending";
  refreshFileName();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void putCurrentFile();
  }, SAVE_DEBOUNCE_MS);
}

async function putCurrentFile(): Promise<void> {
  if (loadedFile === null) return;
  const file = loadedFile;
  const content = sourceEl.value;
  saveStatus = "saving";
  refreshFileName();
  try {
    const res = await fetch(`/api/v2-file/${encodeURIComponent(file)}`, {
      method: "PUT",
      body: content,
    });
    saveStatus = res.ok ? "idle" : "error";
  } catch {
    saveStatus = "error";
  }
  refreshFileName();
}

function refreshFileName(): void {
  // Re-derive display directive from current source so updates from PUT
  // completion don't drop the "display: ..." suffix.
  updateFileNameDisplay(parseDisplayDirective(sourceEl.value));
}

function addStyles(css: string): void {
  if (injectedStyles.has(css)) return;
  injectedStyles.add(css);
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}

function peek(term: Term, store: Store): Atom | null {
  if (term.tag === "Ref") return store.hash.refToAtom.get(term.id) ?? null;
  if (term.tag === "Atom" || term.tag === "Id") return term.atom;
  return null;
}

const displayApi: DisplayApi = { addStyles, peek, renderTerm };

// `-- display: <file>` from the leading `--`-only block, mirroring v1's
// `/ display: <file>` frontmatter convention.
function parseDisplayDirective(source: string): string | null {
  const lines = source.split("\n");
  for (const line of lines) {
    const t = line.trimStart();
    if (t === "") continue;
    if (!t.startsWith("--")) break;
    const m = line.match(/^\s*--\s*display:\s*(\S+)\s*$/);
    if (m) return m[1] ?? null;
  }
  return null;
}

async function loadDisplay(name: string | null): Promise<DisplayModule | null> {
  if (!name) {
    currentDisplayModule = null;
    currentDisplayName = null;
    return null;
  }
  if (name === currentDisplayName && currentDisplayModule) return currentDisplayModule;
  try {
    const mod = await import(`/data/v2/${name}`);
    currentDisplayModule = mod.create(displayApi) as DisplayModule;
    currentDisplayName = name;
    return currentDisplayModule;
  } catch (e) {
    console.warn(`Failed to load display module: ${name}`, e);
    currentDisplayModule = null;
    currentDisplayName = null;
    return null;
  }
}

function setStatus(text: string, isError: boolean): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function saveMarker(): string {
  switch (saveStatus) {
    case "idle":    return "·";
    case "pending": return "~";
    case "saving":  return "↑";
    case "error":   return "✗";
  }
}

function updateFileNameDisplay(displayName: string | null): void {
  const parts: string[] = [];
  if (playgroundMode) parts.push("(playground)");
  else if (loadedFile !== null) parts.push(`${loadedFile} ${saveMarker()}`);
  else parts.push("(detached)");
  if (displayName) parts.push(`display: ${displayName}`);
  fileNameEl.textContent = parts.join("  ");
}

function setInfo(html: string): void {
  infoEl.innerHTML = html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Term rendering for the DB pane: unfold `Atom`-backed Refs through the
// hashcons so users see actual data structure, but stop at `Id` boundaries
// (per notes/v2-design.md — printers must not unfold ids). Id-backed Refs
// and Id literals render as opaque `*<token>` handles.
function renderTermDb(store: Store, term: Term): string {
  switch (term.tag) {
    case "Symbol":   return `<span class="sym">${escapeHtml(term.name)}</span>`;
    case "Variable": return `<span class="var">?${escapeHtml(term.name)}</span>`;
    case "Wildcard": return `<span class="sym">_</span>`;
    case "Ref": {
      if (refTagOf(store.hash, term.id) === "Id") {
        return `<span class="ref">*${term.id}</span>`;
      }
      const stored = store.hash.refToAtom.get(term.id);
      if (stored === undefined) return `<span class="ref">*${term.id}</span>`;
      return `(${stored.terms.map((t) => renderTermDb(store, t)).join(" ")})`;
    }
    case "Id":   return `<span class="ref">*${term.atom.terms[0]?.tag === "Symbol" ? term.atom.terms[0].name : "id"}</span>`;
    case "Atom": return `(${term.atom.terms.map((t) => renderTermDb(store, t)).join(" ")})`;
  }
}

function renderEndpoint(store: Store, term: Term): string {
  if (term.tag === "Ref") return `*${term.id}`;
  return renderTermShallow(store, term);
}

function renderTupleRow(store: Store, i: number): { atom: string; interval: string; line: number | undefined } {
  const t = store.tuples[i]!;
  const head = t.atom.terms[0];
  const headStr = head !== undefined && head.tag === "Symbol"
    ? `<span class="pred">${escapeHtml(head.name)}</span>`
    : renderTermDb(store, head!);
  // slice(1, -1): skip the head AND the trailing universal id slot.
  const args = t.atom.terms.slice(1, -1).map((x) => renderTermDb(store, x)).join(" ");
  const atomStr = args === "" ? headStr : `${headStr} ${args}`;
  const intervalStr = `[${renderEndpoint(store, t.l)}, ${renderEndpoint(store, t.r)}]`;
  return { atom: atomStr, interval: intervalStr, line: store.tupleSource[i]?.line };
}

function emitRows(
  lines: string[],
  rendered: { atom: string; interval: string; line: number | undefined }[],
): void {
  let maxAtomLen = 0;
  for (const r of rendered) {
    const plain = r.atom.replace(/<[^>]+>/g, "");
    if (plain.length > maxAtomLen) maxAtomLen = plain.length;
  }
  const pad = Math.min(maxAtomLen, 48);
  for (const r of rendered) {
    const plainLen = r.atom.replace(/<[^>]+>/g, "").length;
    const gap = " ".repeat(Math.max(2, pad - plainLen + 2));
    const attr = r.line !== undefined ? ` data-source-line="${r.line}"` : "";
    lines.push(`  <span class="row"${attr}>${r.atom}${gap}<span class="interval">${escapeHtml(r.interval)}</span></span>`);
  }
}

// Topological sort of tuple indices by temporal precedence: a precedes b iff
// a.r < b.l. Incomparable tuples may appear in any order; we tie-break by
// store insertion order so the result is deterministic.
function temporalOrder(store: Store, idxs: number[]): number[] {
  const n = idxs.length;
  // depth[k] = longest chain of strict predecessors ending at idxs[k].
  const depth = new Array<number>(n).fill(0);
  // Successors per element so we can relax in topo order using a simple
  // iterative longest-path computation; since we don't have the DAG up front,
  // do an O(n^2) pass: for each pair (i, j) determine precedence via lessThan
  // on endpoints, then propagate via repeated relaxation. n^2 is acceptable
  // for a UI-side database view.
  const preds: number[][] = [];
  for (let k = 0; k < n; k++) preds.push([]);
  for (let i = 0; i < n; i++) {
    const ti = store.tuples[idxs[i]!]!;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const tj = store.tuples[idxs[j]!]!;
      // ti precedes tj iff ti.r < tj.l.
      if (lessThan(store, ti.r, tj.l)) preds[j]!.push(i);
    }
  }
  // Iterate until stable (DAG, so converges in <= n rounds).
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < n; k++) {
      let d = 0;
      for (const p of preds[k]!) {
        if (depth[p]! + 1 > d) d = depth[p]! + 1;
      }
      if (d !== depth[k]) { depth[k] = d; changed = true; }
    }
  }
  const order = idxs.map((_, k) => k);
  order.sort((a, b) => depth[a]! - depth[b]! || idxs[a]! - idxs[b]!);
  return order.map((k) => idxs[k]!);
}

function renderDatabase(store: Store): void {
  const hide = hideInternalEl.checked;
  const temporal = dbTemporalEl.checked;

  // Select visible tuple indices.
  const visible: number[] = [];
  for (let i = 0; i < store.tuples.length; i++) {
    const head = store.tuples[i]!.atom.terms[0];
    const name = head !== undefined && head.tag === "Symbol" ? head.name : "(other)";
    if (hide && name.startsWith("_")) continue;
    visible.push(i);
  }

  if (visible.length === 0) {
    dbEl.innerHTML = `<span style="color:#666">(empty)</span>`;
    return;
  }

  const lines: string[] = [];
  if (temporal) {
    const ordered = temporalOrder(store, visible);
    const rendered = ordered.map((i) => renderTupleRow(store, i));
    emitRows(lines, rendered);
  } else {
    // Group tuples by head sym name. Tuples without a Symbol head fall under
    // "(other)".
    const groups = new Map<string, number[]>();
    for (const i of visible) {
      const head = store.tuples[i]!.atom.terms[0];
      const name = head !== undefined && head.tag === "Symbol" ? head.name : "(other)";
      let bucket = groups.get(name);
      if (bucket === undefined) { bucket = []; groups.set(name, bucket); }
      bucket.push(i);
    }
    const userKeys: string[] = [];
    const internalKeys: string[] = [];
    for (const k of groups.keys()) {
      if (k.startsWith("_")) internalKeys.push(k);
      else userKeys.push(k);
    }
    userKeys.sort();
    internalKeys.sort();
    const orderedKeys = [...userKeys, ...internalKeys];
    for (const key of orderedKeys) {
      const idxs = groups.get(key)!;
      lines.push(`<span class="group-heading">${escapeHtml(key)} (${idxs.length})</span>`);
      const rendered = idxs.map((i) => renderTupleRow(store, i));
      emitRows(lines, rendered);
    }
  }
  dbEl.innerHTML = lines.join("\n");
}

const ORIENT_KEY = "v2-timeline-orientation";
let timelineOrient: "horizontal" | "vertical" = "horizontal";
try {
  const v = sessionStorage.getItem(ORIENT_KEY);
  if (v === "vertical" || v === "horizontal") timelineOrient = v;
} catch { /* ignore */ }

function refreshOrientButtons(): void {
  orientHEl.classList.toggle("active", timelineOrient === "horizontal");
  orientVEl.classList.toggle("active", timelineOrient === "vertical");
}
refreshOrientButtons();

function renderTimelineTab(store: Store): void {
  const out = renderTimeline(store, {
    hideInternal: hideInternalEl.checked,
    orientation: timelineOrient,
  });
  timelineMainEl.replaceChildren(out.main);
  timelineSidebarEl.replaceChildren(out.sidebar);
}

function setOrient(o: "horizontal" | "vertical"): void {
  if (timelineOrient === o) return;
  timelineOrient = o;
  refreshOrientButtons();
  try { sessionStorage.setItem(ORIENT_KEY, o); } catch { /* ignore */ }
  if (lastStore !== null) renderTimelineTab(lastStore);
  timelineMainEl.scrollLeft = 0;
  timelineMainEl.scrollTop = 0;
}
orientHEl.addEventListener("click", () => setOrient("horizontal"));
orientVEl.addEventListener("click", () => setOrient("vertical"));

const TAB_KEY = "v2-active-tab";
function setActiveTab(name: "editor" | "timeline"): void {
  const isEditor = name === "editor";
  editorTabEl.classList.toggle("hidden", !isEditor);
  timelineTabEl.classList.toggle("hidden", isEditor);
  tabBtnEditor.classList.toggle("active", isEditor);
  tabBtnTimeline.classList.toggle("active", !isEditor);
  try { sessionStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }
}
tabBtnEditor.addEventListener("click", () => setActiveTab("editor"));
tabBtnTimeline.addEventListener("click", () => setActiveTab("timeline"));

// Translate vertical wheel scroll to horizontal in the timeline pane. Only
// active in horizontal orientation; vertical orientation uses default vertical
// scroll. Shift-wheel and horizontal trackpad gestures pass through.
timelineMainEl.addEventListener("wheel", (e) => {
  if (timelineOrient !== "horizontal") return;
  if (e.shiftKey) return;
  if (e.deltaX !== 0) return;
  if (e.deltaY === 0) return;
  e.preventDefault();
  timelineMainEl.scrollLeft += e.deltaY;
}, { passive: false });

function handleClick(intent: ClickIntent): void {
  if (lastStore === null) return;
  const N = intent.activeTerms.length;
  if (N !== intent.optionTuple.length) {
    console.warn("handleClick: activeTerms / optionTuple length mismatch");
    return;
  }
  const roots = [...intent.activeTerms, ...intent.optionTuple];
  const { bindings, results } = compressRefs(roots, lastStore);
  const isLines: string[] = [];
  for (let i = 0; i < N; i++) isLines.push(`^ is ${results[i]} ${results[i + N]}`);
  const lines = [...bindings, ...isLines];
  const text = "\n\n" + lines.join("\n");
  // Append to the textarea via execCommand so the existing "input" listener
  // fires and triggers the debounced run + PUT.
  sourceEl.focus();
  sourceEl.setSelectionRange(sourceEl.value.length, sourceEl.value.length);
  document.execCommand("insertText", false, text);
}

async function run(): Promise<void> {
  const userSource = sourceEl.value;
  clickIntents.clear();
  clickIdCounter = 0;

  const parsed = parse(userSource);
  if ("message" in parsed) {
    setStatus(`parse error line ${parsed.line}: ${parsed.message}`, true);
    displayEl.innerHTML = "";
    setInfo("");
    positiveLines = new Set();
    return;
  }

  positiveLines = collectPositiveLines(parsed.rules);

  const result = runFixpoint(parsed, GAS, TUPLE_GAS);
  const { store, status, iterations } = result;
  lastStore = store;

  renderDatabase(store);
  renderTimelineTab(store);
  highlightDbFromSource();

  // Status line.
  switch (status.kind) {
    case "done":
      setStatus(`done — ${iterations} iter${iterations === 1 ? "" : "s"}, ${store.tuples.length} tuples`, false);
      break;
    case "gas":
      setStatus(`gas — exceeded ${GAS} iterations`, true);
      break;
    case "active-choices":
      setStatus(`active-choices(${status.choices.length}) — ${iterations} iter${iterations === 1 ? "" : "s"}`, false);
      break;
    case "empty-fringe-error":
      setStatus(`empty-fringe-error: active term ${renderTermShallow(store, status.activeTerm)} has no constraint row`, true);
      break;
  }

  // Info panel: list components/options + status detail.
  const infoLines: string[] = [];
  if (status.kind === "active-choices") {
    for (let i = 0; i < status.components.length; i++) {
      const comp = status.components[i]!;
      infoLines.push(`<b>component ${i + 1}</b> active: ${comp.activeTerms.map((t) => escapeHtml(renderTermShallow(store, t))).join(", ")}`);
      for (const opt of comp.options) {
        const rendered = opt.map((t) => renderTermShallow(store, t)).join(" ");
        const id = `c${clickIdCounter++}`;
        clickIntents.set(id, { activeTerms: comp.activeTerms, optionTuple: opt });
        infoLines.push(`  <span class="opt" data-click-id="${id}">${escapeHtml(rendered)}</span>`);
      }
    }
  } else if (status.kind === "empty-fringe-error") {
    infoLines.push(`<span class="err">empty-fringe-error: ${escapeHtml(renderTermShallow(store, status.activeTerm))}</span>`);
  }
  setInfo(infoLines.join("\n"));
  infoEl.querySelectorAll(".opt").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-click-id");
      if (!id) return;
      const intent = clickIntents.get(id);
      if (intent) handleClick(intent);
    });
  });

  // Display module + file/save indicator.
  const displayName = parseDisplayDirective(userSource);
  updateFileNameDisplay(displayName);
  const display = await loadDisplay(displayName);
  displayEl.innerHTML = "";
  if (display && status.kind !== "empty-fringe-error") {
    const ctx: DisplayCallContext = {
      components: status.kind === "active-choices" ? status.components : [],
    };
    try {
      const out = display.render(store, ctx);
      if (out) {
        displayEl.appendChild(out.element);
        for (const [el, intent] of out.clicks) {
          el.addEventListener("click", () => handleClick(intent));
        }
      }
    } catch (e) {
      const err = document.createElement("div");
      err.style.color = "#f87171";
      err.textContent = `display error: ${e}`;
      displayEl.appendChild(err);
    }
  }
}

// Debounced input handler.
let runTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRun(): void {
  if (runTimer !== null) clearTimeout(runTimer);
  runTimer = setTimeout(() => {
    runTimer = null;
    void run();
  }, 150);
}

sourceEl.addEventListener("input", () => {
  scheduleRun();
  if (playgroundMode) updatePlaygroundUrl();
  else schedulePut();
  updateCursorLine();
});

function updateCursorLine(): void {
  const pos = sourceEl.selectionStart;
  const before = sourceEl.value.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - (before.lastIndexOf("\n") + 1) + 1;
  sourceCursorLineEl.textContent = `L${line}:${col}`;
  currentLine = line;
  highlightDbFromSource();
  updateSymbolHighlights();
}

// --- Source ↔ output linking ---
//
// Forward: when the textarea caret enters a line that has a positive (assert/
// ask/constrain) atom, every db row emitted from that atom gets a highlight.
// Reverse: hovering a db row highlights its source line (via overlay) and any
// sibling rows from the same line. Clicking a db row focuses the textarea
// with the caret at the end of that line.
let currentLine: number | null = null;
// Lines that contain at least one positive atom; rebuilt on every `run()`.
let positiveLines: Set<number> = new Set();

const sourceLineHighlightEl = document.createElement("div");
sourceLineHighlightEl.className = "source-line-highlight";
sourceEl.parentElement!.insertBefore(sourceLineHighlightEl, sourceEl);

const symbolOverlayEl = document.createElement("div");
symbolOverlayEl.className = "source-symbol-overlay";
sourceEl.parentElement!.insertBefore(symbolOverlayEl, sourceEl);

// Split source into tokens delimited by whitespace, parens, comma, dot,
// semicolon. Strip a leading atom-marker char (`-~+^!?=`) so e.g. `+card`,
// `~card`, `card` all match each other. Skip variables (start with uppercase
// or `_`) and wildcards.
function scanSymbolTokens(text: string): Array<{ start: number; end: number; name: string }> {
  const out: Array<{ start: number; end: number; name: string }> = [];
  const isSep = (c: string) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" ||
    c === "(" || c === ")" || c === "," || c === "." || c === ";";
  let i = 0;
  while (i < text.length) {
    if (isSep(text[i]!)) { i++; continue; }
    let j = i;
    while (j < text.length && !isSep(text[j]!)) j++;
    let s = i;
    const marker = text[s]!;
    if (marker === "-" || marker === "~" || marker === "+" || marker === "^" ||
        marker === "!" || marker === "?" || marker === "=") {
      if (j - s > 1) s++;
    }
    const name = text.slice(s, j);
    const c0 = name[0];
    if (c0 !== undefined && c0 !== "_" && !(c0 >= "A" && c0 <= "Z")) {
      out.push({ start: s, end: j, name });
    }
    i = j;
  }
  return out;
}

let symbolTokens: Array<{ start: number; end: number; name: string }> = [];
let symbolTokensFor: string | null = null;

function ensureSymbolTokens(): void {
  if (symbolTokensFor === sourceEl.value) return;
  symbolTokens = scanSymbolTokens(sourceEl.value);
  symbolTokensFor = sourceEl.value;
}

function syncOverlayBox(): void {
  symbolOverlayEl.style.top = `${sourceEl.offsetTop}px`;
  symbolOverlayEl.style.left = `${sourceEl.offsetLeft}px`;
  symbolOverlayEl.style.width = `${sourceEl.offsetWidth}px`;
  symbolOverlayEl.style.height = `${sourceEl.offsetHeight}px`;
}

function updateSymbolHighlights(): void {
  syncOverlayBox();
  ensureSymbolTokens();
  const pos = sourceEl.selectionStart;
  const hasSelection = sourceEl.selectionStart !== sourceEl.selectionEnd;
  let target: string | null = null;
  let cursorTokenStart = -1;
  if (!hasSelection) {
    for (const t of symbolTokens) {
      if (pos >= t.start && pos <= t.end) {
        target = t.name;
        cursorTokenStart = t.start;
        break;
      }
    }
  }
  if (target === null) {
    symbolOverlayEl.textContent = "";
    return;
  }
  const value = sourceEl.value;
  const matches = symbolTokens.filter((t) => t.name === target && t.start !== cursorTokenStart);
  if (matches.length === 0) {
    symbolOverlayEl.textContent = "";
    return;
  }
  let html = "";
  let i = 0;
  for (const m of matches) {
    if (m.start > i) html += escapeHtml(value.slice(i, m.start));
    html += `<mark>${escapeHtml(value.slice(m.start, m.end))}</mark>`;
    i = m.end;
  }
  if (i < value.length) html += escapeHtml(value.slice(i));
  symbolOverlayEl.innerHTML = html;
  symbolOverlayEl.scrollTop = sourceEl.scrollTop;
  symbolOverlayEl.scrollLeft = sourceEl.scrollLeft;
}

sourceEl.addEventListener("scroll", () => {
  symbolOverlayEl.scrollTop = sourceEl.scrollTop;
  symbolOverlayEl.scrollLeft = sourceEl.scrollLeft;
});

window.addEventListener("resize", () => updateSymbolHighlights());

function getLineMetrics(): { lineHeight: number; paddingTop: number } {
  const style = getComputedStyle(sourceEl);
  return {
    lineHeight: parseFloat(style.lineHeight),
    paddingTop: parseFloat(style.paddingTop),
  };
}

function highlightSourceLine(line: number): void {
  const { lineHeight, paddingTop } = getLineMetrics();
  const top = sourceEl.offsetTop + paddingTop + (line - 1) * lineHeight - sourceEl.scrollTop;
  sourceLineHighlightEl.style.display = "block";
  sourceLineHighlightEl.style.top = `${top}px`;
  sourceLineHighlightEl.style.height = `${lineHeight}px`;
}

function clearSourceHighlight(): void {
  sourceLineHighlightEl.style.display = "none";
}

// Walk every Atom in the rules; record the source line of any whose marker
// emits a tuple (asserts: `~`/`+`/`^`, plus `?`/`!` which desugar to assert
// rows at eval time). Pure matches (`-`) don't qualify.
function collectPositiveLines(rules: Rule[]): Set<number> {
  const out = new Set<number>();
  function walk(body: RuleAtom[]): void {
    for (const a of body) {
      if (a.tag === "Sub") { walk(a.body); continue; }
      if (a.tag !== "Atom") continue;
      if (a.marker === "match") continue;
      out.add(a.span.line);
    }
  }
  for (const r of rules) walk(r.body);
  return out;
}

function highlightDbFromSource(): void {
  dbEl.querySelectorAll(".source-highlight").forEach((el) => el.classList.remove("source-highlight"));
  if (currentLine === null || !positiveLines.has(currentLine)) return;
  const matches = dbEl.querySelectorAll(`[data-source-line="${currentLine}"]`);
  matches.forEach((el) => el.classList.add("source-highlight"));
  const last = matches[matches.length - 1];
  if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

dbEl.addEventListener("mouseover", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) return;
  const line = +target.getAttribute("data-source-line")!;
  highlightSourceLine(line);
  dbEl.querySelectorAll(`[data-source-line="${line}"]`).forEach((el) =>
    el.classList.add("hover-highlight"),
  );
});

dbEl.addEventListener("mouseout", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) return;
  clearSourceHighlight();
  dbEl.querySelectorAll(".hover-highlight").forEach((el) => el.classList.remove("hover-highlight"));
});

sourceEl.addEventListener("scroll", () => {
  if (sourceLineHighlightEl.style.display !== "none") clearSourceHighlight();
});

dbEl.addEventListener("click", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) return;
  const line = +target.getAttribute("data-source-line")!;
  focusSourceLine(line);
});

function focusSourceLine(line: number): void {
  const value = sourceEl.value;
  const lines = value.split("\n");
  const li = Math.min(Math.max(line, 1), lines.length) - 1;
  let lineStart = 0;
  for (let i = 0; i < li; i++) lineStart += lines[i]!.length + 1;
  const lineEnd = lineStart + lines[li]!.length;
  sourceEl.focus();
  sourceEl.setSelectionRange(lineEnd, lineEnd);
  // Center the line in the viewport, then re-show the overlay after the
  // scroll listener clears it.
  const { lineHeight, paddingTop } = getLineMetrics();
  const lineTop = paddingTop + li * lineHeight;
  sourceEl.scrollTop = lineTop - sourceEl.clientHeight / 2 + lineHeight / 2;
  requestAnimationFrame(() => highlightSourceLine(line));
  updateCursorLine();
}

for (const ev of ["keyup", "click", "select", "focus"] as const) {
  sourceEl.addEventListener(ev, updateCursorLine);
}
document.addEventListener("selectionchange", () => {
  if (document.activeElement === sourceEl) updateCursorLine();
});

// --- Key handling ---
//
// Tab / Shift-Tab indent or de-dent the current line (or selected lines) by
// two spaces. Enter inserts a newline plus the current line's leading
// whitespace.
//
// All edits go through `document.execCommand("insertText", …)` so the
// existing input listener fires (debounced run + PUT) and the textarea's
// undo stack stays intact.
function lineBoundsAt(value: string, pos: number): { start: number; end: number } {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  let end = value.indexOf("\n", pos);
  if (end < 0) end = value.length;
  return { start, end };
}

function indentRange(start: number, endLine: number, dedent: boolean): void {
  const value = sourceEl.value;
  const selStart = sourceEl.selectionStart;
  const selEnd = sourceEl.selectionEnd;
  const slice = value.slice(start, endLine);
  const lines = slice.split("\n");
  // Per-line delta in characters and the cumulative offset of each line's
  // start (in the original slice). We compute new selection points by
  // walking lines and accumulating deltas.
  const lineStartsOrig: number[] = [];
  let cur = start;
  for (const ln of lines) {
    lineStartsOrig.push(cur);
    cur += ln.length + 1; // +1 for the \n separator
  }
  const deltas: number[] = lines.map((ln) => {
    if (dedent) {
      if (ln.startsWith("  ")) return -2;
      if (ln.startsWith(" ")) return -1;
      return 0;
    }
    return 2;
  });
  const out = lines.map((ln, i) => (dedent ? ln.slice(-deltas[i]!) : "  " + ln));
  const replacement = out.join("\n");

  // Map an original-document offset p (within [start, endLine]) to its new
  // position after the indent change.
  function mapOffset(p: number): number {
    if (p < start) return p;
    if (p > endLine) return p + (replacement.length - slice.length);
    let shift = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineStart = lineStartsOrig[i]!;
      const lineEnd = lineStart + lines[i]!.length;
      if (p > lineEnd) {
        shift += deltas[i]!;
        continue;
      }
      // p is on this line. For indent, the 2 chars are prepended at
      // lineStart, so any p ≥ lineStart shifts by +2. For dedent, removed
      // chars are at the line's leading edge; clamp the cursor to the new
      // line start if it sat inside the removed run.
      if (dedent) {
        const removed = -deltas[i]!;
        const colWithin = p - lineStart;
        const removedHere = Math.min(colWithin, removed);
        shift -= removedHere;
      } else {
        shift += 2;
      }
      break;
    }
    return p + shift;
  }

  const newSelStart = mapOffset(selStart);
  const newSelEnd = mapOffset(selEnd);
  // execCommand("insertText") goes through the browser's input pipeline so
  // the edit lands on the native undo stack (setRangeText does not). We
  // select the range we're rewriting, run insertText with the new content,
  // then restore the user's selection.
  sourceEl.focus();
  sourceEl.setSelectionRange(start, endLine);
  document.execCommand("insertText", false, replacement);
  sourceEl.setSelectionRange(newSelStart, newSelEnd);
}

sourceEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const value = sourceEl.value;
    const selStart = sourceEl.selectionStart;
    const selEnd = sourceEl.selectionEnd;
    const firstLine = lineBoundsAt(value, selStart);
    const lastLine = lineBoundsAt(value, selEnd);
    indentRange(firstLine.start, lastLine.end, e.shiftKey);
    return;
  }
  if (e.key === "Home" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const value = sourceEl.value;
    const selStart = sourceEl.selectionStart;
    const selEnd = sourceEl.selectionEnd;
    const dir = sourceEl.selectionDirection;
    const pos = dir === "backward" ? selStart : selEnd;
    const anchor = dir === "backward" ? selEnd : selStart;
    const { start } = lineBoundsAt(value, pos);
    const before = value.slice(start, pos);
    const indentMatch = value.slice(start).match(/^[ \t]*/);
    const indentEnd = start + (indentMatch ? indentMatch[0].length : 0);
    const target = /^[ \t]*$/.test(before) ? start : indentEnd;
    e.preventDefault();
    if (e.shiftKey) {
      const lo = Math.min(anchor, target);
      const hi = Math.max(anchor, target);
      sourceEl.setSelectionRange(lo, hi, target < anchor ? "backward" : "forward");
    } else {
      sourceEl.setSelectionRange(target, target);
    }
    return;
  }
  if (e.key === "Delete" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const value = sourceEl.value;
    const selStart = sourceEl.selectionStart;
    const selEnd = sourceEl.selectionEnd;
    if (selStart === selEnd) {
      const { end } = lineBoundsAt(value, selStart);
      if (selStart === end && end < value.length && value[end] === "\n") {
        const wsMatch = value.slice(end + 1).match(/^[ \t]*/);
        const wsLen = wsMatch ? wsMatch[0].length : 0;
        e.preventDefault();
        sourceEl.focus();
        sourceEl.setSelectionRange(end, end + 1 + wsLen);
        document.execCommand("insertText", false, "");
        sourceEl.setSelectionRange(end, end);
        return;
      }
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const value = sourceEl.value;
    const pos = sourceEl.selectionStart;
    const { start, end } = lineBoundsAt(value, pos);
    const line = value.slice(start, end);
    sourceEl.focus();
    if (line.length > 0 && /^[ \t]+$/.test(line)) {
      // Whitespace-only line: wipe it before inserting the newline so the
      // cursor lands at column 0 instead of inheriting stale indent.
      sourceEl.setSelectionRange(start, end);
      document.execCommand("insertText", false, "\n");
      return;
    }
    const lineToCursor = value.slice(start, pos);
    const indentMatch = lineToCursor.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : "";
    document.execCommand("insertText", false, "\n" + indent);
    return;
  }
});

hideInternalEl.addEventListener("change", () => {
  void run();
});

dbTemporalEl.addEventListener("change", () => {
  if (lastStore !== null) renderDatabase(lastStore);
});

// Bootstrap: try to load `data/v2/ttt.t` from the server. If unavailable
// (static file server not running), the textarea starts empty.
async function bootstrap(): Promise<void> {
  if (playgroundMode) {
    const code = new URL(window.location.href).searchParams.get("code");
    if (code) {
      try { sourceEl.value = b64UrlDecode(code); }
      catch { /* malformed — leave empty */ }
    }
    // Ensure the URL always carries the current code (even if empty/missing).
    updatePlaygroundUrl();
  } else {
    const fileParam = new URL(window.location.href).searchParams.get("file");
    const requested = fileParam && fileParam.length > 0 ? fileParam : "ttt.t";
    const name = requested.endsWith(".t") ? requested : `${requested}.t`;
    try {
      const res = await fetch(`/api/v2-file/${encodeURIComponent(name)}`);
      if (res.ok) {
        const { content } = await res.json() as { content: string };
        sourceEl.value = content;
        loadedFile = name;
      } else if (res.status === 404) {
        // File doesn't exist yet; attach anyway so the first edit creates it.
        loadedFile = name;
      }
    } catch {
      // No server — stay detached; edits won't save.
    }
  }
  try {
    const saved = sessionStorage.getItem(TAB_KEY);
    if (saved === "timeline") setActiveTab("timeline");
  } catch { /* ignore */ }
  await run();
  sourceEl.focus();
  sourceEl.setSelectionRange(0, 0);
}

void bootstrap();
