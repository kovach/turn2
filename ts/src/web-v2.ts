// v2 editor page. Owns: textarea source, parse/run loop, display-module
// dispatch, the choices strip, status line. Choice resolutions are appended directly to
// the source textarea as `= V… (…)` shared bindings + `^ is L R` rows; no
// side-channel buffer.

import { parse } from "./v2/parse.js";
import { describeErrorStatus, runFixpoint } from "./v2/fixpoint.js";
import { renderTerm, renderTermShallow, compressRefs, tokensEq } from "./v2/print.js";
import { renderTuples, renderTimelineH, timelineCollapseKey, momentKey } from "./v2/render-output.js";
import { Editor } from "./v2/editor.js";
import { attachSourceLink } from "./v2/source-link.js";
import { RuleBrowser, relationAt, type RuleBrowserState } from "./v2/rule-browser.js";
import { createDisplayKit, type DisplayKit } from "./v2/display-kit.js";
import type { Atom, Term } from "./v2/term.js";
import { tokenOf, type Store } from "./v2/store.js";
import type { ComponentOptions, Rule } from "./v2/types.js";
import type { AccRow } from "./v2/eval.js";
import { createDefaultDisplay } from "./v2/default-display.js";
import { TestPanel } from "./v2/test-panel.js";

// A click intent is an unresolved component plus the chosen option tuple.
// `activeTerms[i]` should bind to `optionTuple[i]`. `handleClick` reifies
// this into source via `compressRefs` and inserts at the textarea cursor.
interface ClickIntent {
  activeTerms: Term[];
  optionTuple: Term[];
}

interface DisplayCallContext {
  components: ComponentOptions[];
  // Choices-strip state (see renderChoices): the selected component, whose
  // moment the display should render at, and the term an ambiguous click
  // parked for the user to place in a slot.
  selectedIdx: number;
  pending: Term | null;
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
  // Park `term` (or clear it) as the pending value: the strip highlights the
  // selected component's slots it fits, and clicking one commits it there.
  setPending: (term: Term | null) => void;
  // Tooltips + right-click menus for entities (v2/display-kit.ts):
  // `kit.entity(el, { label, rows, choice? })`, `kit.rows(store, head, M?)`.
  kit: DisplayKit;
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
const choicesEl = document.getElementById("choices") as HTMLDivElement;
const statusEl = document.getElementById("status-line") as HTMLSpanElement;
const fileNameEl = document.getElementById("file-name") as HTMLSpanElement;
const hideInternalEl = document.getElementById("hide-internal") as HTMLInputElement;
const dbTemporalEl = document.getElementById("db-temporal") as HTMLInputElement;
const timelineInlineEl = document.getElementById("timeline-inline") as HTMLDivElement;
const dbViewDatabaseEl = document.getElementById("db-view-database") as HTMLButtonElement;
const dbViewTimelineEl = document.getElementById("db-view-timeline") as HTMLButtonElement;
const dbViewTestsEl = document.getElementById("db-view-tests") as HTMLButtonElement;
const testsViewEl = document.getElementById("tests-view") as HTMLDivElement;
const testsChipEl = document.getElementById("tests-chip") as HTMLSpanElement;

const gasEl = document.getElementById("gas") as HTMLInputElement;
const tupleGasEl = document.getElementById("tuple-gas") as HTMLInputElement;
const gasCtlEl = document.getElementById("gas-ctl") as HTMLLabelElement;
const tupleGasCtlEl = document.getElementById("tuple-gas-ctl") as HTMLLabelElement;

// Gas defaults. Both limits are editable in the header, but the edit lasts
// only for the session — every reload starts back at these values.
const GAS_DEFAULT = 150;
const TUPLE_GAS_DEFAULT = 10000;

// Current limits, read from the inputs so an edit takes effect on the next
// run. A blank or non-positive field falls back to the default rather than
// running with zero gas.
function gasLimits(): { gas: number; tupleGas: number } {
  const gas = Number(gasEl.value);
  const tupleGas = Number(tupleGasEl.value);
  return {
    gas: Number.isInteger(gas) && gas > 0 ? gas : GAS_DEFAULT,
    tupleGas: Number.isInteger(tupleGas) && tupleGas > 0 ? tupleGas : TUPLE_GAS_DEFAULT,
  };
}

gasEl.value = String(GAS_DEFAULT);
tupleGasEl.value = String(TUPLE_GAS_DEFAULT);

// The gas fields are clutter for programs that terminate, so they stay hidden
// until a run actually runs out of gas. Once revealed they stay up for the rest
// of the session — otherwise raising a limit past the trip point would hide the
// field you'd need to lower it again.
let gasCtlsShown = false;
function revealGasControls(): void {
  if (gasCtlsShown) return;
  gasCtlsShown = true;
  gasCtlEl.classList.remove("hidden");
  tupleGasCtlEl.classList.remove("hidden");
}

// --- Collapsible panes ---
//
// Each `[data-collapse]` label in the page names one pane here; clicking it
// folds the pane down to its label row (the editor folds the whole left grid
// column away, splitter included). Persisted, unlike the timeline collapse
// state, because it's a layout preference rather than program content.
const COLLAPSE_KEY = "v2-collapsed";
const collapsePanes: Record<string, HTMLElement> = {
  editor: document.querySelector(".editors") as HTMLElement,
  display: document.querySelector(".display-pane") as HTMLElement,
  db: document.querySelector(".db-pane") as HTMLElement,
};
const workspaceEl = document.querySelector(".workspace") as HTMLElement;
const collapsed = new Set<string>();
try {
  const raw = localStorage.getItem(COLLAPSE_KEY);
  if (raw !== null) {
    for (const k of JSON.parse(raw) as string[]) {
      if (Object.prototype.hasOwnProperty.call(collapsePanes, k)) collapsed.add(k);
    }
  }
} catch { /* ignore */ }

function refreshCollapse(): void {
  for (const [key, el] of Object.entries(collapsePanes)) {
    el.classList.toggle("collapsed", collapsed.has(key));
  }
  workspaceEl.classList.toggle("editor-collapsed", collapsed.has("editor"));
  document.querySelectorAll("[data-collapse]").forEach((el) => {
    el.classList.toggle("collapsed", collapsed.has(el.getAttribute("data-collapse") ?? ""));
  });
}

document.querySelectorAll("[data-collapse]").forEach((el) => {
  el.addEventListener("click", () => {
    const key = el.getAttribute("data-collapse");
    if (key === null || !Object.prototype.hasOwnProperty.call(collapsePanes, key)) return;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* ignore */ }
    refreshCollapse();
  });
});
refreshCollapse();

let currentDisplayName: string | null = null;
let currentDisplayModule: DisplayModule | null = null;
const injectedStyles = new Set<string>();

// Last fixpoint store; used by `handleClick` to compress option intents
// into source-form text. `null` until the first `run()` completes.
let lastStore: Store | null = null;
// Expanded rules of the last run — needed to decode per-tuple bindings for
// the editor's live-value notes (plans/v2-live-values-in-editor.md).
let lastRules: Rule[] = [];

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

// Tooltips + right-click menus for display entities (plans/v2-display-kit.md).
// The hooks reach `rules` / `setLeftView`, defined further down; they only
// run on user interaction, after the page has loaded.
const displayKit = createDisplayKit({
  store: () => lastStore,
  sourceLine: (line) => sourceEl.value.split("\n")[line - 1],
  showRules: (query, pinLine) => {
    setLeftView("rules");
    rules.setQuery(query);
    if (pinLine !== undefined) rules.pinLine(pinLine);
  },
  showTuples: (idx) => showTuples(idx),
  commit: (intent) => handleClick(intent),
});

// Highlight these tuples' db rows / timeline bars and scroll to the first.
function showTuples(idx: number[]): void {
  document.querySelectorAll(".kit-shown").forEach((e) => e.classList.remove("kit-shown", "source-highlight"));
  let first: Element | null = null;
  for (const i of idx) {
    for (const e of Array.from(document.querySelectorAll(`[data-tl-tuple="${i}"]`))) {
      e.classList.add("kit-shown", "source-highlight");
      if (first === null && (e as HTMLElement | SVGElement).getClientRects().length > 0) first = e;
    }
  }
  first?.scrollIntoView({ block: "center", inline: "center" });
}

const displayApi: DisplayApi = {
  kit: displayKit,
  addStyles, peek, renderTerm, tokensEq, commit: handleClick,
  setPending(term) {
    choiceState.pending = term;
    renderView();
  },
};

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

// `-- gas: <iterations> [<tuples>]` in the same leading block: a program that
// is known to need more than the session defaults (e.g. a whole game replayed
// on every click) raises the limits for itself. The header fields still win
// when they are set higher.
function parseGasDirective(source: string): { gas: number; tupleGas: number | null } | null {
  for (const line of source.split("\n")) {
    const t = line.trimStart();
    if (t === "") continue;
    if (!t.startsWith("--")) break;
    const m = line.match(/^\s*--\s*gas:\s*(\d+)(?:\s+(\d+))?\s*$/);
    if (m) return { gas: Number(m[1]), tupleGas: m[2] ? Number(m[2]) : null };
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
  statusText = text;
  statusEl.textContent = text;
  // The line truncates long errors; the full text is on hover.
  statusEl.title = text;
  statusEl.classList.toggle("error", isError);
  updateStale();
}

// Edits don't re-run the program; Ctrl+Enter does (runNow). While the text
// differs from the one last run, `body.stale` puts color bars on the panes
// and the status line says so; undoing back to that text clears it.
let statusText = "";
let lastRunText: string | null = null;
function updateStale(): void {
  const stale = lastRunText !== null && sourceEl.value !== lastRunText;
  document.body.classList.toggle("stale", stale);
  statusEl.classList.toggle("dirty", stale);
  statusEl.textContent = stale ? `${statusText} · edited, Ctrl+Enter to run` : statusText;
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

// --- Choices strip + display ---
//
// While choices are pending, a strip above the display lists one row per
// component: the rules that asked, then each active term with its distinct
// candidate values as clickable links. The strip belongs to the page rather
// than to a display module, so every display (bundled or `-- display:`) gets
// the same chooser, and the value links are the fallback for values no
// display draws. One row is selected; the display renders at its moment
// (`ctx.selectedIdx`). An ambiguous icon click parks its term as `pending`
// (DisplayApi.setPending), the strip marks the selected row's slots it fits,
// and clicking one commits it there.

interface ChoiceState {
  selectedIdx: number;
  pending: Term | null;
}
let choiceState: ChoiceState = { selectedIdx: 0, pending: null };

// What the last successful run left for the strip and display. Choice-state
// changes re-render both from it without re-running the program. `null`
// after a parse or evaluation error.
interface View {
  store: Store;
  components: ComponentOptions[];
  display: DisplayModule | null;
}
let view: View | null = null;

// Rule names from a component's active terms. Each active term is a
// `(*id rule lexPos (*chain ...) :varName)` template emitted by expand;
// `terms[1]` is the rule-name Symbol. Dedups, preserves first-seen
// order. The shape isn't expressible in the type system, so we assert
// it and throw on violation.
function ruleNamesOf(comp: ComponentOptions, store: Store): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const at of comp.activeTerms) {
    const a = peek(at, store);
    if (a === null) throw new Error("ruleNamesOf: active term has no atom body");
    const head = a.terms[0];
    const rule = a.terms[1];
    if (head?.tag !== "Symbol" || (head.name !== "*id" && head.name !== "*choose")) {
      throw new Error(`ruleNamesOf: unexpected active-term head ${JSON.stringify(head)}`);
    }
    if (rule?.tag !== "Symbol") {
      throw new Error(`ruleNamesOf: active-term rule slot is not a Symbol: ${JSON.stringify(rule)}`);
    }
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);
    names.push(rule.name);
  }
  return names.join(", ");
}

// Chip text for an active term: the asked variable's name (the `:varName`
// slot of its `*id` template), falling back to the rendered term.
function activeTermLabel(term: Term, store: Store): string {
  const v = peek(term, store)?.terms[4];
  if (v?.tag === "Symbol" && v.name.startsWith(":")) return v.name.slice(1);
  return renderTerm(store, term);
}

// Distinct values slot `j` takes across the component's option tuples, in
// first-seen order.
function slotValues(comp: ComponentOptions, j: number, store: Store): Term[] {
  const seen = new Set<number>();
  const out: Term[] = [];
  for (const row of comp.options) {
    const v = row[j];
    if (v === undefined) continue;
    const tok = tokenOf(store, v);
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(v);
  }
  return out;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function renderChoices(v: View | null): void {
  choicesEl.innerHTML = "";
  const comps = v?.components ?? [];
  choicesEl.classList.toggle("hidden", comps.length === 0);
  if (v === null) return;
  const { store } = v;
  const pending = choiceState.pending;
  for (let i = 0; i < comps.length; i++) {
    const comp = comps[i]!;
    const isSelected = i === choiceState.selectedIdx;
    const isSingleton = comp.options.length === 1;
    const row = document.createElement("div");
    row.className = "choice-row";
    if (isSelected) row.classList.add("selected", isSingleton ? "singleton" : "multi");
    row.title = `asked at ${renderTermShallow(store, comp.moment)}`;
    row.appendChild(span("choice-rules", ruleNamesOf(comp, store)));
    for (let j = 0; j < comp.activeTerms.length; j++) {
      const term = comp.activeTerms[j]!;
      const slot = span("choice-slot", "");
      const chip = span("choice-chip", activeTermLabel(term, store));
      chip.title = renderTerm(store, term);
      slot.appendChild(chip);
      row.appendChild(slot);
      // rng slots resolve automatically once the `you` terms are committed
      // (plans/v2-choice-actors.md); they are shown but never offered.
      if (comp.actors[j] === "rng") {
        chip.classList.add("rng");
        chip.title = "resolved automatically (rng)";
        continue;
      }
      const values = slotValues(comp, j, store);
      if (isSelected && pending !== null && values.some((val) => tokensEq(val, pending, store))) {
        chip.classList.add("matchable");
        chip.title = `place ${renderTerm(store, pending)} here`;
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          handleClick({ activeTerms: [term], optionTuple: [pending] });
        });
      }
      for (const val of values) {
        const opt = span("choice-opt", renderTerm(store, val));
        opt.addEventListener("click", (ev) => {
          ev.stopPropagation();
          handleClick({ activeTerms: [term], optionTuple: [val] });
        });
        slot.appendChild(opt);
      }
    }
    if (!isSelected) {
      row.addEventListener("click", () => {
        choiceState = { selectedIdx: i, pending: null };
        renderView();
      });
    } else if (isSingleton) {
      // Selected component with exactly one option row: clicking the row
      // commits all its `you` slots at once. rng slots are left to the
      // scheduler (with one option it lands on the same values, but the
      // binding stays attributed to rng — plans/v2-choice-actors.md).
      row.addEventListener("click", () => {
        const youIdx: number[] = [];
        for (let k = 0; k < comp.activeTerms.length; k++) {
          if (comp.actors[k] !== "rng") youIdx.push(k);
        }
        if (youIdx.length === 0) return;
        handleClick({
          activeTerms: youIdx.map((k) => comp.activeTerms[k]!),
          optionTuple: youIdx.map((k) => comp.options[0]![k]!),
        });
      });
    }
    choicesEl.appendChild(row);
  }
}

function renderDisplay(v: View): void {
  displayEl.innerHTML = "";
  if (v.display === null) return;
  const ctx: DisplayCallContext = {
    components: v.components,
    selectedIdx: choiceState.selectedIdx,
    pending: choiceState.pending,
  };
  try {
    const out = v.display.render(v.store, ctx);
    if (out) {
      displayEl.appendChild(out.element);
      for (const [el, intent] of out.clicks) {
        el.addEventListener("click", () => handleClick(intent));
      }
    }
  } catch (e) {
    showDisplayError(`display error: ${e}`);
  }
}

function renderView(): void {
  if (view === null) return;
  renderChoices(view);
  renderDisplay(view);
}

function showDisplayError(text: string): void {
  const err = document.createElement("div");
  err.className = "display-error";
  err.textContent = text;
  displayEl.appendChild(err);
}

// A run that produced nothing to display: clear the strip and show the
// error, in full, where the display would be. The status line carries the
// same text but may be truncated.
function showRunError(text: string): void {
  view = null;
  renderChoices(null);
  displayEl.innerHTML = "";
  showDisplayError(text);
}

// The db pane toggles between the tuple database and an inline timeline
// (renderTimelineH). Only the active view is rendered on each run; switching
// re-renders the newly visible view from `lastStore`. A third view, Tests
// (v2/test-panel.ts), shows when the server has scenario tests; it renders
// itself as results arrive and is not restored on reload (its button may
// stay hidden).
const DB_VIEW_KEY = "v2-db-view";
let dbView: "database" | "timeline" | "tests" = "timeline";
try {
  const v = sessionStorage.getItem(DB_VIEW_KEY);
  if (v === "database" || v === "timeline") dbView = v;
} catch { /* ignore */ }

function refreshDbViewButtons(): void {
  dbViewDatabaseEl.classList.toggle("active", dbView === "database");
  dbViewTimelineEl.classList.toggle("active", dbView === "timeline");
  dbEl.classList.toggle("hidden", dbView !== "database");
  timelineInlineEl.classList.toggle("hidden", dbView !== "timeline");
  dbViewTestsEl.classList.toggle("active", dbView === "tests");
  testsViewEl.classList.toggle("hidden", dbView !== "tests");
}
refreshDbViewButtons();
const tests = new TestPanel({ view: testsViewEl, chip: testsChipEl, button: dbViewTestsEl, fallback: dbViewTimelineEl });

// Episodes the user has collapsed in the timeline, keyed by structural
// fingerprint (see timelineCollapseKey) so a collapse sticks across the
// re-evaluations that edits and appended `is` rows trigger. Right-clicking a
// bar toggles its key. Deliberately in-memory only: unlike the theme and the
// split position, this state is about one program's content, so it does not
// outlive the page.
const collapsedKeys = new Set<string>();

// Collapse keys of every episode spanning the same interval as `tupleIndex`,
// itself included — the set that one `...` bar stands for.
function intervalPeers(store: Store, tupleIndex: number): string[] {
  const t = store.tuples[tupleIndex];
  if (t === undefined) return [];
  const lTok = tokenOf(store, t.l);
  const rTok = tokenOf(store, t.r);
  const out: string[] = [];
  for (let i = 0; i < store.tuples.length; i++) {
    const u = store.tuples[i]!;
    if (tokenOf(store, u.l) !== lTok || tokenOf(store, u.r) !== rTok) continue;
    const key = timelineCollapseKey(store, i);
    if (key !== null) out.push(key);
  }
  return out;
}

timelineInlineEl.addEventListener("contextmenu", (e: MouseEvent) => {
  const target = (e.target as Element | null)?.closest("[data-tl-tuple]");
  if (target === null || target === undefined) return;
  const idx = Number(target.getAttribute("data-tl-tuple"));
  if (lastStore === null || !Number.isInteger(idx)) return;
  const key = timelineCollapseKey(lastStore, idx);
  if (key === null) return;
  e.preventDefault();
  if (collapsedKeys.has(key)) {
    // Expanding clears every episode over this interval, not just the one the
    // stand-in is named after: co-extensive episodes collapse together, so a
    // peer key left behind would keep the interval folded with no bar left to
    // click.
    for (const peer of intervalPeers(lastStore, idx)) collapsedKeys.delete(peer);
  } else {
    collapsedKeys.add(key);
  }
  renderDbPane(lastStore);
  link.setCaretLine(editor.caretLine());
});

// `#acc` display state (plans/v2-acc-timeline-display.md). `accOverrides`
// holds the relations whose checkbox the user has touched, by name, so a
// choice survives re-evaluation; untouched relations follow the default
// (shown iff an ordinary rule reads them). `inspectKey` is the moment the
// inspector is open on, by structural fingerprint (momentKey) for the same
// reason collapse keys are. Both are in-memory only, like `collapsedKeys`.
// `inspectAll`: the user asked the inspector to compute every relation at
// its moment (demand mode computes only what something read); reset when
// the inspector moves. `lastAccAt` is the last run's `accAt` (fixpoint.ts).
const accOverrides = new Map<string, boolean>();
let inspectKey: string | null = null;
let inspectAll = false;
let lastAccAt: ((tok: number) => Map<string, AccRow[]> | undefined) | undefined;

function rerenderTimeline(): void {
  if (lastStore === null) return;
  renderDbPane(lastStore);
  link.setCaretLine(editor.caretLine());
}

timelineInlineEl.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as Element | null;
  if (target === null || lastStore === null) return;
  if (target.closest("[data-acc-inspector-close]") !== null) {
    inspectKey = null;
    inspectAll = false;
    rerenderTimeline();
    return;
  }
  if (target.closest("[data-acc-inspect-all]") !== null) {
    inspectAll = true;
    rerenderTimeline();
    return;
  }
  const dot = target.closest("[data-tl-moment]");
  if (dot === null) return;
  const key = momentKey(lastStore, Number(dot.getAttribute("data-tl-moment")));
  // Clicking the selected moment again closes the inspector.
  inspectKey = key === inspectKey ? null : key;
  inspectAll = false;
  rerenderTimeline();
});

timelineInlineEl.addEventListener("change", (e: Event) => {
  const box = (e.target as Element | null)?.closest("[data-acc-toggle]") as HTMLInputElement | null;
  if (box === null) return;
  accOverrides.set(box.getAttribute("data-acc-toggle")!, box.checked);
  rerenderTimeline();
});

function renderDbPane(store: Store): void {
  if (dbView === "tests") return;
  if (dbView === "timeline") {
    renderTimelineH(timelineInlineEl, store, {
      hideInternal: hideInternalEl.checked,
      collapsedKeys,
      accOverrides,
      accControls: true,
      inspectKey,
      accAt: lastAccAt,
      inspectAll,
    });
  } else {
    renderTuples(dbEl, store, {
      hideInternal: hideInternalEl.checked,
      temporal: dbTemporalEl.checked,
    });
  }
}

function setDbView(v: "database" | "timeline" | "tests"): void {
  if (dbView === v) return;
  dbView = v;
  refreshDbViewButtons();
  try { sessionStorage.setItem(DB_VIEW_KEY, v); } catch { /* ignore */ }
  if (lastStore !== null) {
    renderDbPane(lastStore);
    // Carry the caret highlight over to the freshly rendered view.
    link.setCaretLine(editor.caretLine());
  }
}
dbViewDatabaseEl.addEventListener("click", () => setDbView("database"));
dbViewTimelineEl.addEventListener("click", () => setDbView("timeline"));
dbViewTestsEl.addEventListener("click", () => setDbView("tests"));

// Reify `activeTerms[i] := values[i]` bindings into source: `= V… (…)`
// shared-binding lines plus one `^ is <term> <value>` row each, appended at
// the end of the textarea. Shared by user clicks (handleClick) and rng-roll
// persistence (plans/v2-choice-actors.md).
// Set while the page edits the source itself (appendIsRows), which runs the
// program itself, unlike the user's own edits.
let programmaticEdit = false;

function appendIsRows(activeTerms: Term[], values: Term[]): void {
  if (lastStore === null) return;
  const N = activeTerms.length;
  const roots = [...activeTerms, ...values];
  const { bindings, results } = compressRefs(roots, lastStore);
  const isLines: string[] = [];
  for (let i = 0; i < N; i++) isLines.push(`^ is ${results[i]} ${results[i + N]}`);
  const lines = [...bindings, ...isLines];
  // One rule: continuation lines are indented (offside rule).
  const text = "\n\n" + lines.map((l, i) => (i === 0 ? l : "  " + l)).join("\n");
  // Append to the textarea via execCommand so the edit lands on its undo
  // history and the "input" listener saves it (PUT / playground URL).
  const prevStart = sourceEl.selectionStart;
  const prevEnd = sourceEl.selectionEnd;
  sourceEl.focus();
  sourceEl.setSelectionRange(sourceEl.value.length, sourceEl.value.length);
  const before = sourceEl.value;
  programmaticEdit = true;
  // Only into the source: if it couldn't take focus (the Rules view hides
  // it), execCommand would type into whatever has focus instead.
  if (document.activeElement === sourceEl) document.execCommand("insertText", false, text);
  // execCommand needs an editable, focused textarea; when the editor pane is
  // collapsed or hidden (or the page lacks focus) it does nothing, so append
  // directly and fire the same "input" listener (this path skips the undo
  // history).
  if (sourceEl.value === before) {
    sourceEl.value = before + text;
    sourceEl.dispatchEvent(new Event("input"));
  }
  programmaticEdit = false;
  // Restore the caret to where it was; the insert was at the end, so the
  // original offsets are unaffected.
  sourceEl.setSelectionRange(prevStart, prevEnd);
  // Run here rather than from the input listener, whose event need not
  // arrive while `programmaticEdit` is set; every GUI's choice, the choices
  // strip and rng rolls all come through here.
  scheduleRun();
}

function handleClick(intent: ClickIntent): void {
  if (lastStore === null) return;
  if (intent.activeTerms.length !== intent.optionTuple.length) {
    console.warn("handleClick: activeTerms / optionTuple length mismatch");
    return;
  }
  appendIsRows(intent.activeTerms, intent.optionTuple);
}

async function run(): Promise<void> {
  const userSource = sourceEl.value;
  lastRunText = userSource;
  // Scenario tests that use this file re-run on the same text, in a worker.
  if (loadedFile !== null) void tests.rerun(loadedFile, userSource);
  const parsed = parse(userSource);
  if ("message" in parsed) {
    const msg = `parse error line ${parsed.line}: ${parsed.message}`;
    setStatus(msg, true);
    showRunError(msg);
    link.update([]);
    rules.markStale();
    return;
  }
  rules.update(userSource, parsed);
  if (rulesTimer !== null) { clearTimeout(rulesTimer); rulesTimer = null; }

  const limits = gasLimits();
  const directive = parseGasDirective(userSource);
  const gas = Math.max(limits.gas, directive?.gas ?? 0);
  const tupleGas = Math.max(limits.tupleGas, directive?.tupleGas ?? 0);
  let result;
  try {
    // `?lattice` in the page URL: moment-lattice max/min (v2/store.ts).
    const params = new URLSearchParams(location.search);
    const lattice = params.has("lattice");
    // `#acc` rows: demand mode (the default) computes a relation only where
    // something reads it, so the timeline's acc bars appear only there; the
    // moment inspector can compute the rest on request (`accAt`).
    // `?acc=eager` computes every relation at every settled moment (bars
    // everywhere; slower).
    const accMode = params.get("acc") === "eager" ? "eager" : "demand";
    result = runFixpoint(parsed, gas, tupleGas, { lattice, accMode });
  } catch (e) {
    // Compile error from a `#js` body, a `@js(...)` runtime throw, or any
    // other evaluation failure — show it rather than swallowing it.
    setStatus((e as Error).message, true);
    showRunError((e as Error).message);
    link.update([]);
    return;
  }
  const { store, status, iterations } = result;
  lastStore = store;
  lastRules = result.rules ?? [];
  lastAccAt = result.accAt;

  // Persist rng rolls (plans/v2-choice-actors.md): every `rng` choice the
  // scheduler committed this run is appended as `^ is` rows — same shape as
  // a user click — so the roll happens exactly once and survives re-runs.
  // Gated on the source being unchanged since the run started, so a roll
  // from a transient mid-typing program is discarded rather than persisted.
  // The append fires the input listener, which re-runs; the appended rows
  // then resolve the terms before the scheduler sees them, so the loop
  // terminates.
  if (result.rngCommits.length > 0 && sourceEl.value === userSource) {
    appendIsRows(
      result.rngCommits.map((c) => c.activeTerm),
      result.rngCommits.map((c) => c.value),
    );
  }

  renderDbPane(store);
  link.update(parsed.rules);

  // Status line.
  switch (status.kind) {
    case "done":
      setStatus(`done — ${iterations} iter${iterations === 1 ? "" : "s"}, ${store.tuples.length} tuples`, false);
      break;
    case "gas":
      revealGasControls();
      // Either limit can trigger this, so report where the run stopped
      // against both.
      setStatus(
        `gas — stopped at ${status.iterations}/${gas} iters, ${status.tuples}/${tupleGas} tuples`,
        true,
      );
      break;
    case "active-choices":
      setStatus(`active-choices(${status.choices.length}) — ${iterations} iter${iterations === 1 ? "" : "s"}`, false);
      break;
    case "empty-fringe-error":
    case "late-constraint-error":
      setStatus(describeErrorStatus(store, status) ?? status.kind, true);
      break;
  }

  // Display module + file/save indicator.
  const displayName = parseDisplayDirective(userSource);
  updateFileNameDisplay(displayName);
  const display = await loadDisplay(displayName);
  if (status.kind === "empty-fringe-error" || status.kind === "late-constraint-error") {
    showRunError(describeErrorStatus(store, status) ?? status.kind);
    return;
  }
  // Every run starts from the first component with nothing pending: the
  // components are recomputed, so old indices and terms may not survive.
  choiceState = { selectedIdx: 0, pending: null };
  view = {
    store,
    components: status.kind === "active-choices" ? status.components : [],
    display,
  };
  renderView();
}

// Debounced run, for edits the page makes itself (appended `is` rows from a
// choice click or an rng roll), which re-run like before.
let runTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRun(): void {
  if (runTimer !== null) clearTimeout(runTimer);
  runTimer = setTimeout(() => {
    runTimer = null;
    void run();
  }, 150);
}

function runNow(): void {
  if (runTimer !== null) { clearTimeout(runTimer); runTimer = null; }
  void run();
}

// The rules view follows edits by parsing only (cheap), not running.
let rulesTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRulesRefresh(): void {
  if (rulesTimer !== null) clearTimeout(rulesTimer);
  rulesTimer = setTimeout(() => {
    rulesTimer = null;
    const text = sourceEl.value;
    const parsed = parse(text);
    if ("message" in parsed) rules.markStale();
    else rules.update(text, parsed);
  }, 150);
}

// Ctrl/Cmd+Enter anywhere (the source, a rule card, the query bar) runs.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || !(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
  ev.preventDefault();
  runNow();
}, true);

sourceEl.addEventListener("input", () => {
  if (!programmaticEdit) updateStale();
  scheduleRulesRefresh();
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
}

// --- Source ↔ output linking ---
//
// The linking logic (forward caret highlight, reverse hover/click, Ctrl-.
// timeline cycling) lives in v2/source-link.ts, bound to the Editor and
// both db-pane views.

for (const ev of ["keyup", "click", "select", "focus"] as const) {
  sourceEl.addEventListener(ev, updateCursorLine);
}
document.addEventListener("selectionchange", () => {
  if (document.activeElement === sourceEl) updateCursorLine();
});

// Editor: Tab/Shift-Tab indent, Enter auto-indent, smart Home, smart Delete,
// line-highlight overlay. saveBackend "none" — this file owns the run/save
// lifecycle via its own input listener.
const editor = new Editor({
  existing: sourceEl, saveBackend: "none", enableAutocomplete: true, enableContextMenu: true, syntaxHighlight: true,
});

// Source | Rules (plans/v2-rule-browser.md): the Rules view shows the rules a
// query picks as editable cards that write through to the source.
const editorsEl = document.querySelector(".editors") as HTMLElement;
const rulesViewEl = document.getElementById("rules-view") as HTMLElement;
const leftViewSourceEl = document.getElementById("left-view-source") as HTMLButtonElement;
const leftViewRulesEl = document.getElementById("left-view-rules") as HTMLButtonElement;
const LEFT_VIEW_KEY = "v2-left-view";
// The Rules view's query, history and pins, per file, survive a reload.
const rulesStateKey = (): string => `v2-rules:${loadedFile ?? "(playground)"}`;
const rules = new RuleBrowser({
  host: rulesViewEl,
  source: sourceEl,
  openInSource: (offset) => {
    setLeftView("source");
    const before = sourceEl.value.slice(0, offset);
    const line = before.split("\n").length;
    editor.focusLine(line, offset - (before.lastIndexOf("\n") + 1));
  },
  onState: (st) => {
    try { localStorage.setItem(rulesStateKey(), JSON.stringify(st)); } catch { /* ignore */ }
  },
});
function restoreRulesState(): void {
  try {
    const raw = localStorage.getItem(rulesStateKey());
    if (raw !== null) rules.restore(JSON.parse(raw) as RuleBrowserState);
  } catch { /* ignore */ }
}
function setLeftView(v: "source" | "rules"): void {
  editorsEl.classList.toggle("rules-mode", v === "rules");
  rulesViewEl.classList.toggle("hidden", v !== "rules");
  leftViewSourceEl.classList.toggle("active", v === "source");
  leftViewRulesEl.classList.toggle("active", v === "rules");
  try { localStorage.setItem(LEFT_VIEW_KEY, v); } catch { /* ignore */ }
}
leftViewSourceEl.addEventListener("click", () => setLeftView("source"));
leftViewRulesEl.addEventListener("click", () => setLeftView("rules"));
try { if (localStorage.getItem(LEFT_VIEW_KEY) === "rules") setLeftView("rules"); } catch { /* ignore */ }
// Ctrl/Cmd-click a relation name in the source: show the rules that use it.
sourceEl.addEventListener("click", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  const name = relationAt(sourceEl.value, sourceEl.selectionStart);
  if (name === null) return;
  setLeftView("rules");
  rules.setQuery(name);
});
const link = attachSourceLink(editor, [dbEl, timelineInlineEl], {
  getRun: () => (lastStore === null ? null : { store: lastStore, rules: lastRules }),
});

hideInternalEl.addEventListener("change", () => {
  void run();
});

// Gas edits re-run immediately. `change` (not `input`) so typing a
// multi-digit number doesn't re-run per keystroke.
for (const el of [gasEl, tupleGasEl]) {
  el.addEventListener("change", () => {
    const { gas, tupleGas } = gasLimits();
    // Normalize the field: an empty or bad value shows the default it fell
    // back to rather than silently disagreeing with what ran.
    el.value = String(el === gasEl ? gas : tupleGas);
    void run();
  });
}

dbTemporalEl.addEventListener("change", () => {
  if (lastStore !== null) {
    renderDbPane(lastStore);
    link.setCaretLine(editor.caretLine());
  }
});

// Bootstrap: try to load `data/v2/ttt.t` from the server. If unavailable
// (static file server not running), the textarea starts empty.
async function bootstrap(): Promise<void> {
  if (playgroundMode) {
    const code = new URL(window.location.href).searchParams.get("code");
    if (code) {
      try { editor.value = b64UrlDecode(code); }
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
        editor.value = content;
        loadedFile = name;
      } else if (res.status === 404) {
        // File doesn't exist yet; attach anyway so the first edit creates it.
        loadedFile = name;
      }
    } catch {
      // No server — stay detached; edits won't save.
    }
  }
  restoreRulesState();
  await run();
  sourceEl.focus();
  sourceEl.setSelectionRange(0, 0);
}

void bootstrap();
