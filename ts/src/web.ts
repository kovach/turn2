import { parseSource, formatTerm, buildSpanIndex } from "./parse.js";
import { fixpoint } from "./fixpoint.js";
import { expandTerm, type HashconsState } from "./hashcons.js";
import type { Tree, Term, Atom } from "./types.js";

// Single source of truth for line-leading markers. The `Record<LiteralTag, …>`
// shape makes TS fail this file if a new Tree case is added without a marker
// entry here; the rest of the keyboard/highlight pipeline is derived from it.
// The only out-of-file companion is a `.lit-<name>` CSS rule in ts/index.html.
type LiteralTag = Tree["tag"];

const LITERAL_MARKERS: Record<LiteralTag, { char: string; cssClass: string }> = {
  Match:     { char: "-", cssClass: "lit-match" },
  Before:    { char: "<", cssClass: "lit-before" },
  Overlap:   { char: ",", cssClass: "lit-overlap" },
  Assert:    { char: "+", cssClass: "lit-assert" },
  Ask:       { char: "?", cssClass: "lit-ask" },
  Constrain: { char: "!", cssClass: "lit-constrain" },
  Aggregate: { char: "#", cssClass: "lit-aggregate" },
  Equal:     { char: "=", cssClass: "lit-equal" },
};

// Non-literal line markers (e.g. comments). These participate in keyboard
// handling but don't appear as `LiteralType` tags, so they live alongside
// the table rather than inside it.
const EXTRA_MARKER_CHARS: string[] = ["/"];

const MARKER_CHARS: string[] = [
  ...Object.values(LITERAL_MARKERS).map((m) => m.char),
  ...EXTRA_MARKER_CHARS,
];
const MARKER_CHAR_SET: Set<string> = new Set(MARKER_CHARS);
// Char class built from MARKER_CHARS. `-` is escaped so it can't be read as
// a character range; `,`, `<`, `+`, etc. are safe verbatim inside a class.
const MARKER_CLASS: string = MARKER_CHARS.map((c) => (c === "-" ? "\\-" : c)).join("");
const MARKER_REGEX = new RegExp(`^(\\s*)([${MARKER_CLASS}])`);

// expandTerm may only be used on Refs whose stored atom is NOT id-headed.
// `(id …)` terms carry the previousVars chain and can be exponentially shared;
// expanding one fully materializes that DAG as a tree. User terms (e.g.
// `(s (s z))`, `(cell R C)`) are tree-shaped in practice and safe to expand.
// See plans/web-no-expand-term.md.
function isIdHeaded(atom: Atom): boolean {
  const h = atom.terms[0];
  return h?.tag === "Symbol" && h.name === "id";
}

const patternsEl = document.getElementById("patterns") as HTMLTextAreaElement;
const resultEl = document.getElementById("result") as HTMLDivElement;
const errorBar = document.getElementById("error-bar") as HTMLDivElement;
const iterationsEl = document.getElementById("iterations") as HTMLSpanElement;
const fileNameEl = document.getElementById("file-name") as HTMLSpanElement;
const syncStatusEl = document.getElementById("sync-status") as HTMLSpanElement;
const displayPaneEl = document.getElementById("display-pane") as HTMLDivElement;
const displayEl = document.getElementById("display") as HTMLDivElement;
const rightColumnEl = displayPaneEl.parentElement as HTMLDivElement;

// --- Server sync state ---

type Mode = "attached" | "detached";
let mode: Mode = "detached";
let currentFile: string | null = null; // non-null only in attached mode
let pendingSync = false;               // attached: PUT not yet called with current content
let fileList: string[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastValid = true;
let lastHc: HashconsState | null = null;

// Source-output linking state
let patternSpanIndex: Map<number, Tree[]> = new Map();
let idToLineMap: Map<string, number> = new Map();
let currentLine: number | null = null;

const GAS = 100;

// --- Display Module System ---

interface DisplayModule {
  render(root: Tree, hc: HashconsState): {
    element: HTMLElement;
    clicks: Map<HTMLElement, { askId: Term; targetId: Term }>;
  } | null;
}

interface DisplayAPI {
  // One-level unwrap of a Ref; null for non-Ref or missing. External display
  // modules use this instead of expandTerm — see plans/web-no-expand-term.md.
  peek: (ref: Term, hc: HashconsState) => Atom | null;
  formatTerm: typeof formatTerm;
  addStyles: (css: string) => void;
}

function peek(term: Term, hc: HashconsState): Atom | null {
  if (term.tag !== "Ref") return null;
  return hc.refToAtom.get(term.id) ?? null;
}

let currentDisplayModule: DisplayModule | null = null;
let currentDisplayName: string | null = null;
const injectedStyles = new Set<string>();

function addStyles(css: string): void {
  if (injectedStyles.has(css)) return;
  injectedStyles.add(css);
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

async function loadDisplay(name: string | undefined): Promise<DisplayModule | null> {
  if (!name) {
    currentDisplayModule = null;
    currentDisplayName = null;
    return null;
  }

  if (name === currentDisplayName && currentDisplayModule) {
    return currentDisplayModule;
  }

  try {
    const module = await import(`/data/${name}`);
    const api: DisplayAPI = { peek, formatTerm, addStyles };
    currentDisplayModule = module.create(api);
    currentDisplayName = name;
    return currentDisplayModule;
  } catch (e) {
    console.warn(`Failed to load display module: ${name}`, e);
    currentDisplayModule = null;
    currentDisplayName = null;
    return null;
  }
}

function handleDisplayClick(askId: Term, targetId: Term) {
  if (!lastHc) return;
  const { bindings, results } = compressRefs([askId, targetId], lastHc);
  const lines = [...bindings, `+ is ${results[0]} ${results[1]}`];
  const text = "\n\n" + lines.join("\n");

  patternsEl.focus();
  patternsEl.setSelectionRange(patternsEl.value.length, patternsEl.value.length);
  document.execCommand("insertText", false, text);
}

// --- Source-output linking helpers ---

function getSourceInfo(id: Term): { rule: string; lineId: string } | null {
  // Only the first three terms (the "id <rule> <lineId>" prefix) matter, and
  // in a hashconsed atom those are already non-Atom (Symbol/Ref). Read the
  // stored atom directly — no recursive expandTerm, which for a deeply shared
  // Ref would materialize the full subtree just to look at the head.
  let terms: Term[];
  if (id.tag === "Ref") {
    if (!lastHc) return null;
    const stored = lastHc.refToAtom.get(id.id);
    if (!stored) return null;
    terms = stored.terms;
  } else if (id.tag === "Atom") {
    terms = id.atom.terms;
  } else {
    return null;
  }
  if (terms.length < 3) return null;
  if (terms[0]?.tag !== "Symbol" || terms[0].name !== "id") return null;
  if (terms[1]?.tag !== "Symbol") return null;
  if (terms[2]?.tag !== "Symbol") return null;
  return { rule: terms[1].name, lineId: terms[2].name };
}

function buildIdToLineMap(expandedPatterns: Tree[]): Map<string, number> {
  const map = new Map<string, number>();
  function walk(node: Tree) {
    if (node.tag === "Equal") return;  // Equal has no id; leaf
    if (node.span && node.id.tag === "Atom") {
      const info = getSourceInfo(node.id);
      if (info) {
        map.set(`${info.rule}:${info.lineId}`, node.span.line);
      }
    }
    node.children.forEach(walk);
  }
  expandedPatterns.forEach(walk);
  return map;
}

function updateCursorLine() {
  const pos = patternsEl.selectionStart;
  const before = patternsEl.value.slice(0, pos);
  currentLine = before.split("\n").length;
  highlightResultNodes();
}

function highlightResultNodes() {
  resultEl.querySelectorAll(".source-highlight").forEach(el =>
    el.classList.remove("source-highlight")
  );

  if (currentLine === null) return;

  const patternNodes = patternSpanIndex.get(currentLine) ?? [];
  const hasPositive = patternNodes.some(n =>
    n.tag === "Assert" || n.tag === "Ask" || n.tag === "Constrain" || n.tag === "Aggregate"
  );

  if (!hasPositive) return;

  const matches = resultEl.querySelectorAll(`[data-source-line="${currentLine}"]`);
  matches.forEach(el => el.classList.add("source-highlight"));

  const first = resultEl.querySelector(".source-highlight");
  if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Source line highlight overlay
const sourceHighlightEl = document.createElement("div");
sourceHighlightEl.className = "source-line-highlight";
patternsEl.parentElement!.style.position = "relative";
patternsEl.parentElement!.insertBefore(sourceHighlightEl, patternsEl);

function getLineMetrics(): { lineHeight: number; paddingTop: number } {
  const style = getComputedStyle(patternsEl);
  return {
    lineHeight: parseFloat(style.lineHeight),
    paddingTop: parseFloat(style.paddingTop),
  };
}

function highlightSourceLine(line: number) {
  const { lineHeight, paddingTop } = getLineMetrics();
  const top = patternsEl.offsetTop + paddingTop + (line - 1) * lineHeight - patternsEl.scrollTop;

  sourceHighlightEl.style.display = "block";
  sourceHighlightEl.style.top = `${top}px`;
  sourceHighlightEl.style.height = `${lineHeight}px`;
}

function scrollToSourceLine(line: number) {
  const { lineHeight, paddingTop } = getLineMetrics();
  const lineTop = paddingTop + (line - 1) * lineHeight;
  const viewportHeight = patternsEl.clientHeight;

  // Center the line in the viewport
  patternsEl.scrollTop = lineTop - viewportHeight / 2 + lineHeight / 2;
  requestAnimationFrame(() => highlightSourceLine(line));
}

function clearSourceHighlight() {
  sourceHighlightEl.style.display = "none";
}

function updateSyncStatus() {
  if (mode === "detached") {
    syncStatusEl.textContent = "∅";
    syncStatusEl.style.color = "#555";
  } else if (!lastValid) {
    syncStatusEl.textContent = "✗";
    syncStatusEl.style.color = "#f87171";
  } else if (pendingSync) {
    syncStatusEl.textContent = "~";
    syncStatusEl.style.color = "#fbbf24";
  } else {
    syncStatusEl.textContent = "·";
    syncStatusEl.style.color = "#555";
  }
}

function detach() {
  if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
  mode = "detached";
  currentFile = null;
  pendingSync = false;
  fileNameEl.textContent = "";
  history.replaceState(null, "", location.pathname);
  updateSyncStatus();
}

function attach(name: string) {
  mode = "attached";
  currentFile = name;
  pendingSync = false;
  fileNameEl.textContent = name;
  history.replaceState(null, "", `?file=${encodeURIComponent(name)}`);
  updateSyncStatus();
}

async function loadFile(name: string) {
  const res = await fetch(`/api/file/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`GET failed: ${res.status}`);
  const { content } = await res.json() as { content: string };
  patternsEl.value = content;
  attach(name);
  run();
}

async function initServer() {
  try {
    const listRes = await fetch("/api/files");
    if (!listRes.ok) return;
    const { files } = await listRes.json() as { files: string[] };
    fileList = files;

    const param = new URLSearchParams(location.search).get("file") ?? fileList[0];
    if (param) {
      const fileRes = await fetch(`/api/file/${encodeURIComponent(param)}`);
      if (fileRes.ok) {
        const { content } = await fileRes.json() as { content: string };
        patternsEl.value = content;
        attach(param);
        run();
        return;
      }
      // File not found: detached with URL param as intended save name.
      fileNameEl.textContent = `${param} (unsaved)`;
    }
    updateSyncStatus();
  } catch {
    // No server — static mode, stay detached silently.
  }
}

function schedulePut() {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    if (mode !== "attached" || currentFile === null || !lastValid) return;
    try {
      const res = await fetch(`/api/file/${encodeURIComponent(currentFile)}`, {
        method: "PUT", body: patternsEl.value,
      });
      if (!res.ok) throw new Error();
      pendingSync = false;
      updateSyncStatus();
    } catch {
      showError("Sync failed — could not write to server.");
    }
  }, 300);
}

async function handleCtrlS() {
  if (mode === "attached" && currentFile !== null) {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    try {
      const res = await fetch(`/api/file/${encodeURIComponent(currentFile)}`, {
        method: "PUT", body: patternsEl.value,
      });
      if (!res.ok) throw new Error();
      pendingSync = false;
      updateSyncStatus();
    } catch {
      showError("Save failed.");
    }
  } else {
    const param = new URLSearchParams(location.search).get("file");
    const name = (param && param.endsWith(".sl")) ? param : `${Date.now()}.sl`;
    try {
      const res = await fetch(`/api/file/${encodeURIComponent(name)}`, {
        method: "POST", body: patternsEl.value,
      });
      if (res.status === 409) { showError(`"${name}" already exists.`); return; }
      if (!res.ok) { showError("Save failed."); return; }
      const listRes = await fetch("/api/files");
      if (listRes.ok) {
        const { files } = await listRes.json() as { files: string[] };
        fileList = files;
      }
      attach(name);
      clearError();
    } catch {
      showError("Save failed.");
    }
  }
}

async function cycleFile(dir: 1 | -1) {
  if (mode !== "attached" || currentFile === null || pendingSync || !lastValid) return;
  const idx = fileList.indexOf(currentFile);
  if (idx === -1) return;
  const next = fileList[(idx + dir + fileList.length) % fileList.length]!;
  await loadFile(next);
}

// --- Click interaction ---

let clickableTerms: Map<number, Term> = new Map();
let nextClickableKey = 0;
let selectedAskKey: number | null = null;

resultEl.addEventListener("click", (e) => {
  const target = (e.target as Element).closest("[data-literal-type]");
  if (!target) { clearSelection(); return; }

  // Scroll to source line if available
  const sourceLineAttr = target.getAttribute("data-source-line");
  if (sourceLineAttr) {
    scrollToSourceLine(parseInt(sourceLineAttr, 10));
  }

  const lt = target.getAttribute("data-literal-type")!;
  const key = parseInt(target.getAttribute("data-term-key")!, 10);
  if (lt === "Ask") {
    if (selectedAskKey === key) {
      clearSelection();
    } else {
      clearSelection();
      selectedAskKey = key;
      target.classList.add("node-selected");
    }
  } else if (lt === "Assert" && selectedAskKey !== null) {
    assertClick(selectedAskKey, key);
    clearSelection();
  } else {
    clearSelection();
  }
});

function clearSelection() {
  selectedAskKey = null;
  resultEl.querySelectorAll(".node-selected").forEach((el) => el.classList.remove("node-selected"));
}

// Share-aware compression. Walks the hashcons DAG via refToAtom, visiting
// each Ref at most once. Every Ref's stored body is emitted in exactly one
// output location — as a `= V… …` binding when shared (refCount ≥ 2 or root),
// or inlined at its sole reference site otherwise. Linear in distinct Refs,
// regardless of how deeply the DAG unfolds as a tree. No call to expandTerm.
function compressRefs(roots: Term[], hc: HashconsState): { bindings: string[]; results: string[] } {
  const refCount = new Map<number, number>();
  const visited = new Set<number>();

  function countRefs(t: Term): void {
    if (t.tag === "Ref") {
      refCount.set(t.id, (refCount.get(t.id) ?? 0) + 1);
      if (visited.has(t.id)) return;
      visited.add(t.id);
      const stored = hc.refToAtom.get(t.id);
      if (stored) for (const sub of stored.terms) countRefs(sub);
      return;
    }
    if (t.tag === "Atom") for (const sub of t.atom.terms) countRefs(sub);
  }
  for (const root of roots) countRefs(root);

  // Shared: refCount ≥ 2, plus any root that is itself a Ref.
  const shared = new Set<number>();
  for (const [id, count] of refCount) {
    if (count >= 2) shared.add(id);
  }
  for (const root of roots) {
    if (root.tag === "Ref") shared.add(root.id);
  }

  // hashcons ids are allocated bottom-up (hashconsTerm recurses before
  // emitting its own id), so ascending id order is a valid topological
  // order for the sharing DAG.
  const sharedList = [...shared].sort((a, b) => a - b);
  const varMap = new Map<number, string>();
  sharedList.forEach((id, i) => varMap.set(id, `V${i + 1}`));

  function renderInner(t: Term): string {
    if (t.tag === "Ref") {
      const v = varMap.get(t.id);
      if (v !== undefined) return v;
      // refCount === 1 and not a root → inline its body exactly once.
      const stored = hc.refToAtom.get(t.id);
      if (!stored) return `*${t.id}`;
      return `(${stored.terms.map(renderInner).join(" ")})`;
    }
    if (t.tag === "Atom") {
      return `(${t.atom.terms.map(renderInner).join(" ")})`;
    }
    return formatTerm(t);
  }

  const bindings: string[] = [];
  for (const id of sharedList) {
    const stored = hc.refToAtom.get(id);
    if (!stored) continue;
    bindings.push(`= ${varMap.get(id)} (${stored.terms.map(renderInner).join(" ")})`);
  }

  const results = roots.map(renderInner);
  return { bindings, results };
}

function assertClick(askKey: number, assertKey: number) {
  const askId = clickableTerms.get(askKey);
  const assertId = clickableTerms.get(assertKey);
  if (!askId || !assertId || !lastHc) return;

  const { bindings, results } = compressRefs([askId, assertId], lastHc);
  const lines = [...bindings, `+ is ${results[0]} ${results[1]}`];
  const text = "\n\n" + lines.join("\n");

  patternsEl.focus();
  patternsEl.setSelectionRange(patternsEl.value.length, patternsEl.value.length);
  document.execCommand("insertText", false, text);
}

// --- Rendering ---

function showError(msg: string) {
  errorBar.textContent = msg;
  errorBar.classList.add("has-error");
}

function clearError() {
  errorBar.textContent = "no issues";
  errorBar.classList.remove("has-error");
}

async function run() {
  const sourceResult = parseSource(patternsEl.value);
  if ("message" in sourceResult) {
    lastValid = false;
    showError(`Patterns — line ${sourceResult.line}: ${sourceResult.message}`);
    resultEl.innerHTML = "";
    displayEl.innerHTML = "";
    displayPaneEl.style.display = "none";
    rightColumnEl.classList.remove("has-display");
    iterationsEl.textContent = "";
    patternSpanIndex = new Map();
    idToLineMap = new Map();
    return;
  }

  clearError();

  const { frontmatter, patterns: parsedPatterns } = sourceResult;
  patternSpanIndex = buildSpanIndex(parsedPatterns);

  const { result, steps, hc, expandedPatterns } = fixpoint(parsedPatterns, GAS);
  lastValid = steps < GAS;
  lastHc = hc;
  idToLineMap = buildIdToLineMap(expandedPatterns);
  clickableTerms = new Map();
  nextClickableKey = 0;
  iterationsEl.textContent = `${steps} step${steps === 1 ? "" : "s"}`;
  resultEl.innerHTML = (result.tag === "Equal" ? [] : result.children).map((c: Tree) => renderTree(c, 0)).join("");

  // Render custom display if specified
  const display = await loadDisplay(frontmatter.display);
  if (display) {
    try {
      const renderResult = display.render(result, hc);
      if (renderResult) {
        displayEl.innerHTML = "";
        displayEl.appendChild(renderResult.element);

        // Wire up click handlers
        for (const [el, intent] of renderResult.clicks) {
          el.addEventListener("click", () => {
            handleDisplayClick(intent.askId, intent.targetId);
          });
        }

        displayPaneEl.style.display = "flex";
        rightColumnEl.classList.add("has-display");
      } else {
        displayEl.innerHTML = "";
        displayPaneEl.style.display = "none";
        rightColumnEl.classList.remove("has-display");
      }
    } catch (e) {
      displayEl.innerHTML = `<div style="color: #f87171; padding: 1em;">Display error: ${e}</div>`;
      displayPaneEl.style.display = "flex";
      rightColumnEl.classList.add("has-display");
    }
  } else {
    displayEl.innerHTML = "";
    displayPaneEl.style.display = "none";
    rightColumnEl.classList.remove("has-display");
  }

  highlightResultNodes();
}

function renderTree(tree: Tree, depth: number): string {
  const indent = "  ".repeat(depth);
  if (tree.tag === "Equal") return indent + renderNode(tree) + "\n";
  return indent + renderNode(tree) + "\n" +
    tree.children.map((c) => renderTree(c, depth + 1)).join("");
}

function renderNode(tree: Tree): string {
  const tag = tree.tag;
  const [prefix, cls] = literalStyle(tag);
  if (tree.tag === "Equal") {
    const lhs = renderTerm(tree.lhs, false);
    const rhs = renderTerm(tree.rhs, false);
    return `<span class="${cls}">${prefix} ${lhs} ${rhs}</span>`;
  }
  const terms = tree.atom.terms.map((t, i) => renderTerm(t, i === 0)).join(" ");
  const body = terms === "" ? prefix : `${prefix} ${terms}`;

  // Add source line attribute for linking
  const sourceInfo = getSourceInfo(tree.id);
  const sourceLine = sourceInfo ? idToLineMap.get(`${sourceInfo.rule}:${sourceInfo.lineId}`) : null;
  const sourceAttr = sourceLine ? ` data-source-line="${sourceLine}"` : "";

  const clickable = tag === "Ask" || tag === "Assert";
  if (clickable) {
    const termKey = nextClickableKey++;
    clickableTerms.set(termKey, tree.id);
    return `<span class="${cls} node-clickable" data-term-key="${termKey}" data-literal-type="${tag}"${sourceAttr}>${body}</span>`;
  }
  return `<span class="${cls}"${sourceAttr}>${body}</span>`;
}

function renderTerm(term: Term, isPredicate = false): string {
  if (term.tag === "Ref") {
    if (lastHc) {
      const stored = lastHc.refToAtom.get(term.id);
      if (stored && !isIdHeaded(stored)) {
        const expanded = expandTerm(term, lastHc);
        return renderTerm(expanded, isPredicate);
      }
    }
    return `<span class="lit-ref">*${term.id}</span>`;
  }
  switch (term.tag) {
    case "Symbol":   return `<span class="${isPredicate ? "lit-predicate" : "lit-symbol"}">${esc(term.name)}</span>`;
    case "Variable": return `<span class="lit-variable">${esc(term.name)}</span>`;
    case "Atom":     return `(${term.atom.terms.map((t) => renderTerm(t)).join(" ")})`;
    case "Wildcard": return `<span class="lit-wildcard">_</span>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function literalStyle(tag: LiteralTag): [string, string] {
  const m = LITERAL_MARKERS[tag];
  return [m.char, m.cssClass];
}

// --- Input and key handling ---

// Coalesce bursts of input events (e.g. execCommand("insertText") firing one
// event per character) into a single run() per animation frame.
let pendingRun: Promise<void> | null = null;
function scheduleRun(): Promise<void> {
  if (pendingRun) return pendingRun;
  pendingRun = new Promise<void>((resolve) => {
    requestAnimationFrame(async () => {
      try { await run(); } finally { pendingRun = null; resolve(); }
    });
  });
  return pendingRun;
}

patternsEl.addEventListener("input", () => {
  if (mode === "attached") pendingSync = true;
  scheduleRun().then(() => {
    if (mode === "attached") {
      if (lastValid) {
        schedulePut();
      } else if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
    updateSyncStatus();
  });
});

patternsEl.addEventListener("keydown", onKey);
patternsEl.addEventListener("keyup", updateCursorLine);
patternsEl.addEventListener("click", updateCursorLine);
patternsEl.addEventListener("scroll", () => {
  if (sourceHighlightEl.style.display !== "none") {
    clearSourceHighlight();
  }
});

// Reverse direction: hover on result → highlight source + sibling outputs
resultEl.addEventListener("mouseover", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) return;
  const line = parseInt(target.getAttribute("data-source-line")!, 10);
  highlightSourceLine(line);
  // Highlight all outputs from the same source line
  resultEl.querySelectorAll(`[data-source-line="${line}"]`).forEach(el =>
    el.classList.add("hover-highlight")
  );
});

resultEl.addEventListener("mouseout", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (target) {
    clearSourceHighlight();
    resultEl.querySelectorAll(".hover-highlight").forEach(el =>
      el.classList.remove("hover-highlight")
    );
  }
});

initServer().then(() => {
  if (mode === "detached") run();
  patternsEl.focus();
  patternsEl.setSelectionRange(0, 0);
});


const WEAK_REGEX = new RegExp(`^\\s*[${MARKER_CLASS}]?\\s*$`);
function isWeak(line: string): boolean {
  return WEAK_REGEX.test(line);
}

// Use execCommand so edits land on the browser's native undo stack.
function execReplace(start: number, end: number, text: string) {
  patternsEl.setSelectionRange(start, end);
  document.execCommand("insertText", false, text);
}

function moveLineDir(dir: 1 | -1) {
  const el = patternsEl;
  const { selectionStart: s, value } = el;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const col = s - lineStart;
  if (dir === -1) {
    if (lineStart === 0) return;
    const prevLineEnd = lineStart - 1;
    const prevLineStart = value.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const pos = Math.min(prevLineStart + col, prevLineEnd);
    el.setSelectionRange(pos, pos);
  } else {
    const lineEnd = value.indexOf("\n", s);
    if (lineEnd === -1) return;
    const nextLineStart = lineEnd + 1;
    const nextLineEnd = value.indexOf("\n", nextLineStart);
    const nextLineEndActual = nextLineEnd === -1 ? value.length : nextLineEnd;
    const pos = Math.min(nextLineStart + col, nextLineEndActual);
    el.setSelectionRange(pos, pos);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) dedent(); else handleTab();
  } else if (e.key === "Enter") {
    e.preventDefault();
    handleReturn();
  } else if (MARKER_CHAR_SET.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (handleMarkerKey(e.key)) e.preventDefault();
  } else if (e.key === "s" && e.ctrlKey) {
    e.preventDefault();
    void handleCtrlS();
  } else if (e.key === "]" && e.ctrlKey) {
    e.preventDefault();
    void cycleFile(+1);
  } else if (e.key === "[" && e.ctrlKey) {
    e.preventDefault();
    void cycleFile(-1);
  } else if (e.key === " " && e.ctrlKey) {
    e.preventDefault();
    detach();
    execReplace(0, patternsEl.value.length, "");
    run();
  } else if (e.key === "x" && e.ctrlKey) {
    e.preventDefault();
    cutSubtree();
  } else if (e.key === "b" && e.ctrlKey) {
    e.preventDefault();
    const pos = Math.max(0, patternsEl.selectionStart - 1);
    patternsEl.setSelectionRange(pos, pos);
  } else if (e.key === "f" && e.ctrlKey) {
    e.preventDefault();
    const pos = Math.min(patternsEl.value.length, patternsEl.selectionStart + 1);
    patternsEl.setSelectionRange(pos, pos);
  } else if (e.key === "a" && e.ctrlKey) {
    e.preventDefault();
    const lineStart = patternsEl.value.lastIndexOf("\n", patternsEl.selectionStart - 1) + 1;
    patternsEl.setSelectionRange(lineStart, lineStart);
  } else if (e.key === "e" && e.ctrlKey) {
    e.preventDefault();
    const lineEnd = patternsEl.value.indexOf("\n", patternsEl.selectionStart);
    const pos = lineEnd === -1 ? patternsEl.value.length : lineEnd;
    patternsEl.setSelectionRange(pos, pos);
  } else if (e.key === "p" && e.ctrlKey) {
    e.preventDefault();
    moveLineDir(-1);
  } else if (e.key === "n" && e.ctrlKey) {
    e.preventDefault();
    moveLineDir(1);
  }
}

function cutSubtree() {
  const el = patternsEl;
  const { selectionStart: s, selectionEnd: e, value } = el;

  if (s !== e) { document.execCommand("cut"); return; }

  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const lineEnd = value.indexOf("\n", lineStart);
  const lineEndActual = lineEnd === -1 ? value.length : lineEnd;
  const line = value.slice(lineStart, lineEndActual);
  const lineIndent = line.length - line.trimStart().length;

  // Walk forward to find the last line of the subtree (lines indented deeper, skipping blanks)
  let subtreeEnd = lineEndActual;
  let scan = lineEndActual;
  while (scan < value.length) {
    const nextStart = scan + 1; // step past \n
    const nextEnd = value.indexOf("\n", nextStart);
    const nextLineEnd = nextEnd === -1 ? value.length : nextEnd;
    const nextLine = value.slice(nextStart, nextLineEnd);
    if (nextLine.trim() !== "" && nextLine.length - nextLine.trimStart().length <= lineIndent) break;
    subtreeEnd = nextLineEnd;
    scan = nextLineEnd;
    if (nextEnd === -1) break;
  }

  // Include trailing \n; if at end of file, include preceding \n instead
  let cutStart: number, cutEnd: number;
  if (subtreeEnd < value.length) {
    cutStart = lineStart;
    cutEnd = subtreeEnd + 1;
  } else {
    cutStart = lineStart > 0 ? lineStart - 1 : 0;
    cutEnd = value.length;
  }

  el.setSelectionRange(cutStart, cutEnd);
  document.execCommand("cut");
}

function handleMarkerKey(char: string): boolean {
  const el = patternsEl;
  const { selectionStart: s, selectionEnd: e, value } = el;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const lineEnd = value.indexOf("\n", s);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  if (!isWeak(line)) return false;
  const markerMatch = line.match(MARKER_REGEX);
  if (markerMatch) {
    const markerPos = lineStart + markerMatch[1]!.length;
    if (s >= markerPos) {
      execReplace(markerPos, e, char + " ");
      return true;
    }
  }
  execReplace(s, e, char + " ");
  return true;
}

function handleTab() {
  const el = patternsEl;
  const { selectionStart: s, selectionEnd: e, value } = el;

  // Selection: indent every line in the region.
  if (s !== e) {
    const firstLineStart = value.lastIndexOf("\n", s - 1) + 1;
    const region = value.slice(firstLineStart, e);
    const indented = region.replace(/^/gm, "  ");
    const addedChars = indented.length - region.length;
    execReplace(firstLineStart, e, indented);
    el.setSelectionRange(s + 2, e + addedChars);
    return;
  }

  // No selection: indent the current line regardless of cursor position.
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  execReplace(lineStart, lineStart, "  ");
  el.setSelectionRange(s + 2, s + 2);
}

function dedent() {
  const el = patternsEl;
  const { selectionStart: s, selectionEnd: e, value } = el;

  if (s !== e) {
    const firstLineStart = value.lastIndexOf("\n", s - 1) + 1;
    const region = value.slice(firstLineStart, e);
    const dedented = region.replace(/^  /gm, "");
    const removedFirst = region.slice(0, 2) === "  " ? 2 : 0;
    const removedTotal = region.length - dedented.length;
    execReplace(firstLineStart, e, dedented);
    el.setSelectionRange(Math.max(firstLineStart, s - removedFirst), e - removedTotal);
    return;
  }

  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  if (value.slice(lineStart, lineStart + 2) === "  ") {
    const newPos = Math.max(lineStart, s - 2);
    execReplace(lineStart, lineStart + 2, "");
    el.setSelectionRange(newPos, newPos);
  }
}

function handleReturn() {
  const el = patternsEl;
  const { selectionStart: s, selectionEnd: e, value } = el;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const line = value.slice(lineStart, s);

  if (isWeak(line)) {
    execReplace(lineStart, e, "\n");
  } else {
    const indent = line.match(/^(\s*)/)![1]!;
    const marker = MARKER_CHAR_SET.has(line.trimStart()[0] ?? "") ? line.trimStart()[0]! + " " : "";
    execReplace(s, e, "\n" + indent + marker);
  }
}
