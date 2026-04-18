import { parsePatterns, formatTerm } from "./parse.js";
import { fixpoint0 } from "./fixpoint.js";
import type { Tree, Literal, Term } from "./types.js";

const patternsEl = document.getElementById("patterns") as HTMLTextAreaElement;
const resultEl = document.getElementById("result") as HTMLDivElement;
const errorBar = document.getElementById("error-bar") as HTMLDivElement;
const iterationsEl = document.getElementById("iterations") as HTMLSpanElement;
const fileNameEl = document.getElementById("file-name") as HTMLSpanElement;
const syncStatusEl = document.getElementById("sync-status") as HTMLSpanElement;

// --- Server sync state ---

type Mode = "attached" | "detached";
let mode: Mode = "detached";
let currentFile: string | null = null; // non-null only in attached mode
let pendingSync = false;               // attached: PUT not yet called with current content
let fileList: string[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const GAS = 20;

function isValid(text: string): boolean {
  const parsed = parsePatterns(text);
  if ("message" in parsed) return false;
  const { steps } = fixpoint0(parsed);
  return steps < GAS;
}

function updateSyncStatus() {
  if (mode === "detached") {
    syncStatusEl.textContent = "∅";
    syncStatusEl.style.color = "#555";
  } else if (!isValid(patternsEl.value)) {
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
    if (mode !== "attached" || currentFile === null || !isValid(patternsEl.value)) return;
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
  if (mode !== "attached" || currentFile === null || pendingSync || !isValid(patternsEl.value)) return;
  const idx = fileList.indexOf(currentFile);
  if (idx === -1) return;
  const next = fileList[(idx + dir + fileList.length) % fileList.length]!;
  await loadFile(next);
}

// --- Click interaction ---

let selectedAsk: string | null = null;

resultEl.addEventListener("click", (e) => {
  const target = (e.target as Element).closest("[data-literal-type]");
  if (!target) { clearSelection(); return; }
  const lt = target.getAttribute("data-literal-type")!;
  const id = target.getAttribute("data-id")!;
  if (lt === "Ask") {
    if (selectedAsk === id) {
      clearSelection();
    } else {
      clearSelection();
      selectedAsk = id;
      target.classList.add("node-selected");
    }
  } else if (lt === "Assert" && selectedAsk !== null) {
    assertClick(selectedAsk, id);
    clearSelection();
  } else {
    clearSelection();
  }
});

function clearSelection() {
  selectedAsk = null;
  resultEl.querySelectorAll(".node-selected").forEach((el) => el.classList.remove("node-selected"));
}

function assertClick(askId: string, assertId: string) {
  patternsEl.focus();
  patternsEl.setSelectionRange(patternsEl.value.length, patternsEl.value.length);
  document.execCommand("insertText", false, `\n\n+ is ${askId} ${assertId}`);
}

// --- Rendering ---

function showError(msg: string) {
  errorBar.textContent = msg;
  errorBar.style.display = "block";
}

function clearError() {
  errorBar.style.display = "none";
}

function run() {
  const parsedPatterns = parsePatterns(patternsEl.value);
  if ("message" in parsedPatterns) {
    showError(`Patterns — line ${parsedPatterns.line}: ${parsedPatterns.message}`);
    resultEl.innerHTML = "";
    iterationsEl.textContent = "";
    return;
  }

  clearError();

  const { result, steps } = fixpoint0(parsedPatterns);
  iterationsEl.textContent = `${steps} step${steps === 1 ? "" : "s"}`;
  resultEl.innerHTML = result.children.map((c) => renderTree(c, 0)).join("");
}

function renderTree(tree: Tree, depth: number): string {
  const indent = "  ".repeat(depth);
  return indent + renderNode(tree) + "\n" +
    tree.children.map((c) => renderTree(c, depth + 1)).join("");
}

function renderNode(tree: Tree): string {
  const lt = tree.literal.literalType;
  const [prefix, cls] = literalStyle(lt);
  const terms = tree.literal.atom.terms.map(renderTerm).join(" ");
  const body = terms === "" ? prefix : `${prefix} ${terms}`;
  const clickable = lt === "Ask" || lt === "Assert";
  if (clickable) {
    const id = formatTerm(tree.id);
    return `<span class="${cls} node-clickable" data-id="${id}" data-literal-type="${lt}">${body}</span>`;
  }
  return `<span class="${cls}">${body}</span>`;
}

function renderTerm(term: Term): string {
  switch (term.tag) {
    case "Symbol":   return `<span class="lit-symbol">${esc(term.name)}</span>`;
    case "Variable": return `<span class="lit-variable">${esc(term.name)}</span>`;
    case "Atom":     return `(${term.atom.terms.map(renderTerm).join(" ")})`;
    case "Wildcard": return `<span class="lit-wildcard">_</span>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function literalStyle(t: Literal["literalType"]): [string, string] {
  switch (t) {
    case "Match":     return ["-", "lit-match"];
    case "Assert":    return ["+", "lit-assert"];
    case "Ask":       return ["?", "lit-ask"];
    case "Constrain": return ["!", "lit-constrain"];
  }
}

// --- Input and key handling ---

patternsEl.addEventListener("input", () => {
  run();
  if (mode === "attached") {
    pendingSync = true;
    if (isValid(patternsEl.value)) {
      schedulePut();
    } else if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
  updateSyncStatus();
});

patternsEl.addEventListener("keydown", onKey);

initServer().then(() => {
  if (mode === "detached") run();
  patternsEl.focus();
});

const MARKERS = new Set(["-", "+", "?", "!"]);

function isWeak(line: string): boolean {
  return /^\s*[-+?!]?\s*$/.test(line);
}

// Use execCommand so edits land on the browser's native undo stack.
function execReplace(start: number, end: number, text: string) {
  patternsEl.setSelectionRange(start, end);
  document.execCommand("insertText", false, text);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) dedent(); else handleTab();
  } else if (e.key === "Enter") {
    e.preventDefault();
    handleReturn();
  } else if ((e.key === "+" || e.key === "-" || e.key === "!" || e.key === "?") && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
  const markerMatch = line.match(/^(\s*)([-+?!])/);
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
    const markerMatch = line.match(/^(\s*)([-+?!])/);
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
  const { selectionStart, value } = el;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  if (value.slice(lineStart, lineStart + 2) === "  ") {
    const newPos = Math.max(lineStart, selectionStart - 2);
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
