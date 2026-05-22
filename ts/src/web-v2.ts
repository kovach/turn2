// v2 editor page. Owns: textarea source, parse/run loop, display-module
// dispatch, error/status panel. Choice resolutions are appended directly to
// the source textarea as `= V… (…)` shared bindings + `^ is L R` rows; no
// side-channel buffer.

import { parse } from "./v2/parse.js";
import { runFixpoint } from "./v2/fixpoint.js";
import { renderTerm, renderTermShallow, compressRefs, tokensEq } from "./v2/print.js";
import { renderTimeline } from "./v2/timeline.js";
import { renderTuples } from "./v2/render-output.js";
import { Editor } from "./v2/editor.js";
import type { Atom, Term } from "./types.js";
import type { Store } from "./v2/store.js";
import type { ComponentOptions, Rule, RuleAtom } from "./v2/types.js";
import { createDefaultDisplay } from "./v2/default-display.js";

// A click intent is an unresolved component plus the chosen option tuple.
// `activeTerms[i]` should bind to `optionTuple[i]`. `handleClick` reifies
// this into source via `compressRefs` and inserts at the textarea cursor.
interface ClickIntent {
  activeTerms: Term[];
  optionTuple: Term[];
}

interface DisplayCallContext {
  components: ComponentOptions[];
  schema: Map<string, string>;
}

interface DisplayApi {
  addStyles(css: string): void;
  // One-level peek for Refs; mirrors the v1 helper.
  peek(term: Term, store: Store): Atom | null;
  renderTerm: (store: Store, t: Term) => string;
  tokensEq: (a: Term, b: Term, store: Store) => boolean;
  // Commit a click intent directly. Modules that re-render their own DOM
  // (e.g. on internal selection changes) use this instead of populating the
  // `clicks` map, since post-construction wiring can't reach newly built
  // nodes.
  commit: (intent: ClickIntent) => void;
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
const laneCompactEl = document.getElementById("timeline-lane-compact") as HTMLButtonElement;
const laneNestedEl = document.getElementById("timeline-lane-nested") as HTMLButtonElement;
const laneTreeEl = document.getElementById("timeline-lane-tree") as HTMLButtonElement;

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

const displayApi: DisplayApi = { addStyles, peek, renderTerm, tokensEq, commit: handleClick };

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
    if (currentDisplayName === null && currentDisplayModule) return currentDisplayModule;
    currentDisplayModule = createDefaultDisplay(displayApi) as DisplayModule;
    currentDisplayName = null;
    return currentDisplayModule;
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

function renderDatabase(store: Store): void {
  renderTuples(dbEl, store, {
    hideInternal: hideInternalEl.checked,
    temporal: dbTemporalEl.checked,
  });
}

const ORIENT_KEY = "v2-timeline-orientation";
let timelineOrient: "horizontal" | "vertical" = "horizontal";
try {
  const v = sessionStorage.getItem(ORIENT_KEY);
  if (v === "vertical" || v === "horizontal") timelineOrient = v;
} catch { /* ignore */ }

const LANE_KEY = "v2-timeline-lane-mode";
let timelineLaneMode: "compact" | "nested" | "tree" = "tree";
try {
  const v = sessionStorage.getItem(LANE_KEY);
  if (v === "compact" || v === "nested" || v === "tree") timelineLaneMode = v;
} catch { /* ignore */ }

function refreshOrientButtons(): void {
  orientHEl.classList.toggle("active", timelineOrient === "horizontal");
  orientVEl.classList.toggle("active", timelineOrient === "vertical");
}
refreshOrientButtons();

function refreshLaneButtons(): void {
  laneCompactEl.classList.toggle("active", timelineLaneMode === "compact");
  laneNestedEl.classList.toggle("active", timelineLaneMode === "nested");
  laneTreeEl.classList.toggle("active", timelineLaneMode === "tree");
}
refreshLaneButtons();

function renderTimelineTab(store: Store): void {
  const out = renderTimeline(store, {
    hideInternal: hideInternalEl.checked,
    orientation: timelineOrient,
    laneMode: timelineLaneMode,
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

function setLaneMode(m: "compact" | "nested" | "tree"): void {
  if (timelineLaneMode === m) return;
  timelineLaneMode = m;
  refreshLaneButtons();
  try { sessionStorage.setItem(LANE_KEY, m); } catch { /* ignore */ }
  if (lastStore !== null) renderTimelineTab(lastStore);
}
laneCompactEl.addEventListener("click", () => setLaneMode("compact"));
laneNestedEl.addEventListener("click", () => setLaneMode("nested"));
laneTreeEl.addEventListener("click", () => setLaneMode("tree"));

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
      schema: parsed.schema,
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

// Editor: Tab/Shift-Tab indent, Enter auto-indent, smart Home, smart Delete.
// saveBackend "none" — this file owns the run/save lifecycle via its own
// input listener; Editor only provides keybindings.
new Editor({ existing: sourceEl, saveBackend: "none" });

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
