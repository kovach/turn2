import { parsePatterns, formatTerm, buildSpanIndex } from "./parse.js";
import { fixpoint0 } from "./fixpoint.js";
import { expandTerm, type HashconsState } from "./hashcons.js";
import type { Tree, Literal, Term } from "./types.js";

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

// --- Frontmatter parsing ---

interface Frontmatter {
  display?: string;
}

function parseFrontmatter(source: string): { frontmatter: Frontmatter; body: string } {
  // Frontmatter is slide comments: --- delimiters with --- key: value lines
  // e.g.:
  //   ---
  //   --- display: ttt.js
  //   ---
  // The entire source remains as body (frontmatter lines are valid comments)
  const frontmatter: Frontmatter = {};
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    for (const line of match[1]!.split("\n")) {
      // Parse lines like "--- key: value"
      const kvMatch = line.match(/^---\s+(\w+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1]!;
        const value = kvMatch[2]!;
        if (key === "display") {
          frontmatter.display = value;
        }
      }
    }
  }
  return { frontmatter, body: source };
}

// --- Display Module System ---

interface DisplayModule {
  render(root: Tree, hc: HashconsState): {
    element: HTMLElement;
    clicks: Map<HTMLElement, { askId: Term; targetId: Term }>;
  } | null;
}

interface DisplayAPI {
  expandTerm: typeof expandTerm;
  formatTerm: typeof formatTerm;
  addStyles: (css: string) => void;
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
    const api: DisplayAPI = { expandTerm, formatTerm, addStyles };
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
  const expandedAsk = lastHc ? expandTerm(askId, lastHc) : askId;
  const expandedTarget = lastHc ? expandTerm(targetId, lastHc) : targetId;

  const { bindings, results } = compressTerms([expandedAsk, expandedTarget]);
  const lines = [...bindings, `+ is ${results[0]} ${results[1]}`];
  const text = "\n\n" + lines.join("\n");

  patternsEl.focus();
  patternsEl.setSelectionRange(patternsEl.value.length, patternsEl.value.length);
  document.execCommand("insertText", false, text);
}

// --- Source-output linking helpers ---

function getSourceInfo(id: Term): { rule: string; lineId: string } | null {
  // Expand refs to get the actual atom
  let term = id;
  if (term.tag === "Ref" && lastHc) {
    term = expandTerm(term, lastHc);
  }
  if (term.tag !== "Atom") return null;
  const terms = term.atom.terms;
  if (terms.length < 3) return null;
  if (terms[0]?.tag !== "Symbol" || terms[0].name !== "id") return null;
  if (terms[1]?.tag !== "Symbol") return null;
  if (terms[2]?.tag !== "Symbol") return null;
  return { rule: terms[1].name, lineId: terms[2].name };
}

function buildIdToLineMap(expandedPatterns: Tree[]): Map<string, number> {
  const map = new Map<string, number>();
  function walk(node: Tree) {
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
    n.literal.literalType === "Assert" ||
    n.literal.literalType === "Ask" ||
    n.literal.literalType === "Constrain" ||
    n.literal.literalType === "Aggregate"
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

function compressTerms(terms: Term[]): { bindings: string[]; results: string[] } {
  const counts = new Map<string, number>();
  const termByKey = new Map<string, Term>();

  function collectSubterms(t: Term): void {
    if (t.tag !== "Atom") return;
    const key = formatTerm(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    termByKey.set(key, t);
    for (const sub of t.atom.terms) {
      collectSubterms(sub);
    }
  }

  for (const term of terms) {
    collectSubterms(term);
  }

  // Shared = appears more than once, or is a top-level Atom
  const shared = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) shared.add(key);
  }
  for (const term of terms) {
    if (term.tag === "Atom") shared.add(formatTerm(term));
  }

  if (shared.size === 0) {
    return { bindings: [], results: terms.map(formatTerm) };
  }

  // Sort by length (shorter = inner = processed first)
  const sharedList = [...shared].sort((a, b) => a.length - b.length);
  const varMap = new Map<string, string>();
  let varCounter = 1;
  for (const key of sharedList) {
    varMap.set(key, `V${varCounter++}`);
  }

  function rewrite(t: Term): Term {
    if (t.tag !== "Atom") return t;
    const key = formatTerm(t);
    if (varMap.has(key)) {
      return { tag: "Variable", name: varMap.get(key)! };
    }
    return { tag: "Atom", atom: { terms: t.atom.terms.map(rewrite) } };
  }

  const bindings: string[] = [];
  for (const key of sharedList) {
    const varName = varMap.get(key)!;
    const original = termByKey.get(key)!;
    if (original.tag !== "Atom") continue;
    const rewrittenInner = original.atom.terms.map(rewrite);
    const rewrittenTerm: Term = { tag: "Atom", atom: { terms: rewrittenInner } };
    bindings.push(`= ${varName} ${formatTerm(rewrittenTerm)}`);
  }

  const results = terms.map(t => formatTerm(rewrite(t)));

  return { bindings, results };
}

function assertClick(askKey: number, assertKey: number) {
  const askTerm = clickableTerms.get(askKey);
  const assertTerm = clickableTerms.get(assertKey);
  if (!askTerm || !assertTerm) return;

  const { bindings, results } = compressTerms([askTerm, assertTerm]);
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
  const { frontmatter, body } = parseFrontmatter(patternsEl.value);
  const parsedPatterns = parsePatterns(body);
  if ("message" in parsedPatterns) {
    lastValid = false;
    showError(`Patterns — line ${parsedPatterns.line}: ${parsedPatterns.message}`);
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

  patternSpanIndex = buildSpanIndex(parsedPatterns);

  const { result, steps, hc, expandedPatterns } = fixpoint0(parsedPatterns, GAS);
  lastValid = steps < GAS;
  lastHc = hc;
  idToLineMap = buildIdToLineMap(expandedPatterns);
  clickableTerms = new Map();
  nextClickableKey = 0;
  iterationsEl.textContent = `${steps} step${steps === 1 ? "" : "s"}`;
  resultEl.innerHTML = result.children.map((c) => renderTree(c, 0)).join("");

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
  return indent + renderNode(tree) + "\n" +
    tree.children.map((c) => renderTree(c, depth + 1)).join("");
}

function renderNode(tree: Tree): string {
  const lt = tree.literal.literalType;
  const [prefix, cls] = literalStyle(lt);
  const terms = tree.literal.atom.terms.map((t, i) => renderTerm(t, i === 0)).join(" ");
  const body = terms === "" ? prefix : `${prefix} ${terms}`;

  // Add source line attribute for linking
  const sourceInfo = getSourceInfo(tree.id);
  const sourceLine = sourceInfo ? idToLineMap.get(`${sourceInfo.rule}:${sourceInfo.lineId}`) : null;
  const sourceAttr = sourceLine ? ` data-source-line="${sourceLine}"` : "";

  const clickable = lt === "Ask" || lt === "Assert";
  if (clickable) {
    const expandedId = lastHc ? expandTerm(tree.id, lastHc) : tree.id;
    const termKey = nextClickableKey++;
    clickableTerms.set(termKey, expandedId);
    return `<span class="${cls} node-clickable" data-term-key="${termKey}" data-literal-type="${lt}"${sourceAttr}>${body}</span>`;
  }
  return `<span class="${cls}"${sourceAttr}>${body}</span>`;
}

function renderTerm(term: Term, isPredicate = false): string {
  // Expand refs to show full atom structure
  if (term.tag === "Ref" && lastHc) {
    const expanded = expandTerm(term, lastHc);
    if (expanded.tag === "Atom") {
      return `(${expanded.atom.terms.map((t) => renderTerm(t)).join(" ")})`;
    }
  }
  switch (term.tag) {
    case "Symbol":   return `<span class="${isPredicate ? "lit-predicate" : "lit-symbol"}">${esc(term.name)}</span>`;
    case "Variable": return `<span class="lit-variable">${esc(term.name)}</span>`;
    case "Atom":     return `(${term.atom.terms.map((t) => renderTerm(t)).join(" ")})`;
    case "Wildcard": return `<span class="lit-wildcard">_</span>`;
    case "Ref":      return `<span class="lit-ref">*${term.id}</span>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function literalStyle(t: Literal["literalType"]): [string, string] {
  switch (t) {
    case "Match":     return ["-", "lit-match"];
    case "Before":    return ["<", "lit-before"];
    case "Assert":    return ["+", "lit-assert"];
    case "Ask":       return ["?", "lit-ask"];
    case "Constrain": return ["!", "lit-constrain"];
    case "Aggregate": return ["#", "lit-aggregate"];
    case "Equal":     return ["=", "lit-equal"];
  }
}

// --- Input and key handling ---

patternsEl.addEventListener("input", () => {
  run();
  if (mode === "attached") {
    pendingSync = true;
    if (lastValid) {
      schedulePut();
    } else if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
  updateSyncStatus();
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
});

const MARKERS = new Set(["-", "<", "+", "?", "!", "#", "="]);

function isWeak(line: string): boolean {
  return /^\s*[-<+?!#=]?\s*$/.test(line);
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
  } else if ((e.key === "+" || e.key === "-" || e.key === "<" || e.key === "!" || e.key === "?" || e.key === "#" || e.key === "=") && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
  const markerMatch = line.match(/^(\s*)([-<+?!#=])/);
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

  // Case 3: text is highlighted → indent all highlighted lines
  if (s !== e) {
    const firstLineStart = value.lastIndexOf("\n", s - 1) + 1;
    const region = value.slice(firstLineStart, e);
    const indented = region.replace(/^/gm, "  ");
    const addedChars = indented.length - region.length;
    execReplace(firstLineStart, e, indented);
    el.setSelectionRange(s + 2, e + addedChars);
    return;
  }

  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const lineEnd = value.indexOf("\n", s);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  const beforeCursor = value.slice(lineStart, s);

  // Case 1: everything before cursor is whitespace
  if (/^\s*$/.test(beforeCursor)) {
    execReplace(s, e, "  ");
  } else {
    // Case 2: line is weak with a type marker
    const markerMatch = line.match(/^(\s*)([-<+?!#=])/);
    if (isWeak(line) && markerMatch) {
      const markerPos = lineStart + markerMatch[1]!.length;
      execReplace(markerPos, markerPos, "  ");
      el.setSelectionRange(s + 2, s + 2);
    } else {
      execReplace(s, e, "  ");
    }
  }
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
    const marker = MARKERS.has(line.trimStart()[0] ?? "") ? line.trimStart()[0]! + " " : "";
    execReplace(s, e, "\n" + indent + marker);
  }
}
