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
import type { ComponentOptions } from "./v2/types.js";

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
const displayEl = document.getElementById("display") as HTMLDivElement;
const dbEl = document.getElementById("db") as HTMLDivElement;
const infoEl = document.getElementById("info") as HTMLDivElement;
const statusEl = document.getElementById("status-line") as HTMLSpanElement;
const fileNameEl = document.getElementById("file-name") as HTMLSpanElement;
const hideInternalEl = document.getElementById("hide-internal") as HTMLInputElement;
const editorTabEl = document.getElementById("editor-tab") as HTMLDivElement;
const timelineTabEl = document.getElementById("timeline-tab") as HTMLDivElement;
const timelineMainEl = document.getElementById("timeline-main") as HTMLDivElement;
const timelineSidebarEl = document.getElementById("timeline-sidebar-host") as HTMLDivElement;
const tabBtnEditor = document.getElementById("tab-editor") as HTMLButtonElement;
const tabBtnTimeline = document.getElementById("tab-timeline") as HTMLButtonElement;
const orientHEl = document.getElementById("timeline-orient-h") as HTMLButtonElement;
const orientVEl = document.getElementById("timeline-orient-v") as HTMLButtonElement;

const GAS = 50;
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

const SAVE_DEBOUNCE_MS = 400;

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
  if (loadedFile !== null) parts.push(`${loadedFile} ${saveMarker()}`);
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

function renderDatabase(store: Store): void {
  const hide = hideInternalEl.checked;
  // Group tuples by head sym name. Tuples without a Symbol head fall under
  // "(other)".
  const groups = new Map<string, number[]>();
  for (let i = 0; i < store.tuples.length; i++) {
    const head = store.tuples[i]!.atom.terms[0];
    const name = head !== undefined && head.tag === "Symbol" ? head.name : "(other)";
    let bucket = groups.get(name);
    if (bucket === undefined) { bucket = []; groups.set(name, bucket); }
    bucket.push(i);
  }
  const userKeys: string[] = [];
  const internalKeys: string[] = [];
  for (const k of groups.keys()) {
    if (k.startsWith("_") || k === "choose" || k === "constrain" || k === "do-agg" || k === "agg-result") {
      internalKeys.push(k);
    } else {
      userKeys.push(k);
    }
  }
  userKeys.sort();
  internalKeys.sort();
  const orderedKeys = hide ? userKeys : [...userKeys, ...internalKeys];

  if (orderedKeys.length === 0) {
    dbEl.innerHTML = `<span style="color:#666">(empty)</span>`;
    return;
  }

  const lines: string[] = [];
  for (const key of orderedKeys) {
    const idxs = groups.get(key)!;
    lines.push(`<span class="group-heading">${escapeHtml(key)} (${idxs.length})</span>`);
    // Render each tuple. Args after the head are pretty-printed; the first
    // term is highlighted as a predicate.
    const rendered: { atom: string; interval: string }[] = [];
    let maxAtomLen = 0;
    for (const i of idxs) {
      const t = store.tuples[i]!;
      const head = t.atom.terms[0];
      const headStr = head !== undefined && head.tag === "Symbol"
        ? `<span class="pred">${escapeHtml(head.name)}</span>`
        : renderTermDb(store, head!);
      const args = t.atom.terms.slice(1).map((x) => renderTermDb(store, x)).join(" ");
      const atomStr = args === "" ? headStr : `${headStr} ${args}`;
      const intervalStr = `[${renderEndpoint(store, t.l)}, ${renderEndpoint(store, t.r)}]`;
      // Strip HTML for length calculation.
      const plain = atomStr.replace(/<[^>]+>/g, "");
      maxAtomLen = Math.max(maxAtomLen, plain.length);
      rendered.push({ atom: atomStr, interval: intervalStr });
    }
    const pad = Math.min(maxAtomLen, 48);
    for (const r of rendered) {
      const plainLen = r.atom.replace(/<[^>]+>/g, "").length;
      const gap = " ".repeat(Math.max(2, pad - plainLen + 2));
      lines.push(`  ${r.atom}${gap}<span class="interval">${escapeHtml(r.interval)}</span>`);
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
    return;
  }

  const result = runFixpoint(parsed, GAS, TUPLE_GAS);
  const { store, status, iterations } = result;
  lastStore = store;

  renderDatabase(store);
  renderTimelineTab(store);

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
  schedulePut();
});

// --- Key handling ---
//
// Tab / Shift-Tab indent or de-dent the current line (or selected lines) by
// two spaces. Enter inserts a newline plus the current line's leading
// whitespace; if the current line starts with `+ ` (after indent), the new
// line also gets `+ ` so successive asserts auto-prefix.
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
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const value = sourceEl.value;
    const pos = sourceEl.selectionStart;
    const { start } = lineBoundsAt(value, pos);
    const lineToCursor = value.slice(start, pos);
    const indentMatch = lineToCursor.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : "";
    // If the current line (up to cursor) is `<indent>+ <anything?>`, the
    // new line auto-prefixes with `+ `.
    const trimmed = lineToCursor.slice(indent.length);
    const needsPlus = trimmed.startsWith("+ ") || trimmed === "+";
    const inserted = "\n" + indent + (needsPlus ? "+ " : "");
    sourceEl.focus();
    document.execCommand("insertText", false, inserted);
    return;
  }
});

hideInternalEl.addEventListener("change", () => {
  void run();
});

// Bootstrap: try to load `data/v2/ttt.t` from the server. If unavailable
// (static file server not running), the textarea starts empty.
async function bootstrap(): Promise<void> {
  const name = "ttt.t";
  try {
    const res = await fetch(`/api/v2-file/${encodeURIComponent(name)}`);
    if (res.ok) {
      const { content } = await res.json() as { content: string };
      sourceEl.value = content;
      loadedFile = name;
    }
  } catch {
    // No server — stay detached; edits won't save.
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
