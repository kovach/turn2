// Bidirectional source-atom ↔ output linking, shared by the v2 editor page
// and presentation-mode code blocks (plans/v2-source-timeline-link.md,
// plans/v2-atom-span-provenance.md).
//
// One linker binds one Editor to N output roots whose renderers stamp
// `data-source-span` (a `spanKey`, "line:startCol-endCol") on tuple-derived
// elements (db rows, timeline bars/facts/sidebar rows).
//
// Forward: the caret sitting *inside* a positive (emitting) atom puts
// `.source-highlight` on that atom's elements across all outputs; a caret
// elsewhere on a line with emitting atoms (whitespace, a pure match)
// highlights all of the line's emitting atoms, matching the old per-line
// behavior. The timeline is never auto-scrolled; Ctrl-. (or a double-click
// in the editor) cycles through the active atom's timeline occurrences,
// centering each in the scroll container in turn.
// Reverse: hovering a linked element highlights its atom's column range
// (Editor overlay) plus sibling elements from the same atom; clicking moves
// the caret into that atom.

import type { Rule, RuleAtom } from "./types.js";
import { spanKey, type Span } from "./term.js";
import type { Editor } from "./editor.js";

export interface SourceLink {
  // Re-arm after a run: rules rebuild positiveSpans, and (since the outputs
  // were just re-rendered) forward highlights are re-applied from the
  // current caret. Pass [] on parse/eval failure to clear.
  update(rules: Rule[]): void;
  // Forward direction. Always re-applies (outputs may have re-rendered);
  // the Ctrl-. cycle resets only when the active atom actually changed.
  // The caret column is read off the Editor directly, so callers keep
  // passing just the line.
  setCaretLine(line: number | null): void;
  destroy(): void;
}

// Spans of atoms whose marker emits a tuple (asserts `~`/`+`/`^`, plus
// `?`/`!` which desugar to assert rows at eval time), indexed by source line
// so the caret lookup is cheap. Pure matches (`-`) don't qualify. Exception
// items (tag "Exception") are skipped, as before — the lowered rules emit
// under the `{...}` block's span, which has no per-atom link target.
export function collectPositiveSpans(rules: Rule[]): Map<number, Span[]> {
  const out = new Map<number, Span[]>();
  function walk(body: RuleAtom[]): void {
    for (const a of body) {
      if (a.tag === "Sub") { walk(a.body); continue; }
      if (a.tag !== "Atom") continue;
      if (a.marker === "match") continue;
      const bucket = out.get(a.span.line);
      if (bucket === undefined) out.set(a.span.line, [a.span]);
      else bucket.push(a.span);
    }
  }
  for (const r of rules) walk(r.body);
  return out;
}

function parseKey(key: string): { line: number; startCol: number; endCol: number } | null {
  const m = /^(\d+):(\d+)-(\d+)$/.exec(key);
  if (m === null) return null;
  return { line: +m[1]!, startCol: +m[2]!, endCol: +m[3]! };
}

function removeClassAll(roots: HTMLElement[], cls: string): void {
  for (const root of roots) {
    root.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
  }
}

export function attachSourceLink(editor: Editor, outputs: HTMLElement[]): SourceLink {
  let positiveSpans = new Map<number, Span[]>();
  let caret: { line: number; col: number } | null = null;
  // Ctrl-. cycle state: how many presses have happened while `state`
  // (the active span key, or "<line>:*" for the whole-line fallback) held.
  let cycle: { state: string; presses: number } | null = null;

  const ta = editor.element;

  // The span keys the caret currently activates: the single atom containing
  // the caret column, or — caret in whitespace, on a marker-less match, or
  // otherwise outside every emitting atom — all emitting atoms on the line.
  function activeKeys(pos: { line: number; col: number }): { keys: string[]; state: string } {
    const spans = positiveSpans.get(pos.line) ?? [];
    const hit = spans.find(
      (s) => s.startCol !== undefined && s.endCol !== undefined
        && pos.col >= s.startCol && pos.col <= s.endCol,
    );
    const hitKey = spanKey(hit);
    if (hitKey !== undefined) return { keys: [hitKey], state: hitKey };
    const keys = [...new Set(spans.map(spanKey).filter((k): k is string => k !== undefined))];
    return { keys, state: `${pos.line}:*` };
  }

  function matchesFor(key: string): Element[] {
    const out: Element[] = [];
    for (const root of outputs) {
      root.querySelectorAll(`[data-source-span="${key}"]`).forEach((el) => out.push(el));
    }
    return out;
  }

  function resetCycle(): void {
    cycle = null;
    removeClassAll(outputs, "cycle-focus");
  }

  function applyCaretHighlight(): void {
    removeClassAll(outputs, "source-highlight");
    if (caret === null) return;
    const { keys } = activeKeys(caret);
    if (keys.length === 0) return;
    for (const root of outputs) {
      let lastHtml: Element | null = null;
      for (const key of keys) {
        root.querySelectorAll(`[data-source-span="${key}"]`).forEach((el) => {
          el.classList.add("source-highlight");
          if (!(el instanceof SVGElement)) lastHtml = el;
        });
      }
      // Scroll only HTML outputs (db rows). scrollIntoView on an SVG child
      // scrolls the whole timeline unpredictably; the timeline scrolls only
      // via the Ctrl-. cycle below.
      if (lastHtml !== null) {
        (lastHtml as Element).scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  function setCaretLine(line: number | null): void {
    const pos = line === null ? null : editor.caretPos();
    if (pos !== null) {
      const { state } = activeKeys(pos);
      if (cycle !== null && cycle.state !== state) resetCycle();
    } else {
      resetCycle();
    }
    caret = pos;
    applyCaretHighlight();
  }

  // --- Ctrl-. : cycle timeline occurrences of the atom under the caret ---

  // Attribute coordinates are CSS pixels here: the timeline SVG has no
  // scaling transform and its viewBox matches width/height 1:1.
  function extentOf(el: SVGElement): { x: number; w: number; y: number; h: number } | null {
    const x = parseFloat(el.getAttribute("x") ?? "");
    const y = parseFloat(el.getAttribute("y") ?? "");
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const w = parseFloat(el.getAttribute("width") ?? "") || 0;
    const h = parseFloat(el.getAttribute("height") ?? "") || 0;
    return { x, w, y, h };
  }

  function scrollToTarget(el: SVGElement): void {
    const svg = el.ownerSVGElement;
    if (!svg) return;
    const scroller = svg.parentElement;
    if (!scroller) return;
    const ext = extentOf(el);
    if (ext === null) return;
    // Always center: each press should give visible motion even when the
    // next occurrence is already on screen.
    const opts: ScrollToOptions = { behavior: "smooth" };
    if (scroller.scrollWidth > scroller.clientWidth) {
      opts.left = ext.x + ext.w / 2 - scroller.clientWidth / 2;
    }
    if (scroller.scrollHeight > scroller.clientHeight) {
      opts.top = ext.y + ext.h / 2 - scroller.clientHeight / 2;
    }
    if (opts.left !== undefined || opts.top !== undefined) scroller.scrollTo(opts);
  }

  function cyclePress(): void {
    const { keys, state } = activeKeys(editor.caretPos());
    const svgMatches = keys.flatMap(matchesFor).filter((el): el is SVGElement => el instanceof SVGElement);
    if (svgMatches.length === 0) return;
    // One entry per bar: prefer rects over their label texts. Fact labels
    // (text without data-bar-label) stay.
    let targets = svgMatches.filter((el) => !el.hasAttribute("data-bar-label"));
    if (targets.length === 0) targets = svgMatches;
    if (cycle === null || cycle.state !== state) cycle = { state, presses: 0 };
    const target = targets[cycle.presses % targets.length]!;
    cycle.presses++;
    removeClassAll(outputs, "cycle-focus");
    target.classList.add("cycle-focus");
    scrollToTarget(target);
  }

  // --- Listeners ---

  const outputHandlers: Array<{
    root: HTMLElement;
    over: (e: Event) => void;
    out: (e: Event) => void;
    click: (e: Event) => void;
  }> = [];

  for (const root of outputs) {
    const over = (e: Event): void => {
      const target = (e.target as Element).closest("[data-source-span]");
      if (!target) return;
      const key = target.getAttribute("data-source-span")!;
      const span = parseKey(key);
      if (span === null) return;
      editor.highlightRange(span.line, span.startCol, span.endCol);
      for (const el of matchesFor(key)) el.classList.add("hover-highlight");
    };
    const out = (e: Event): void => {
      const target = (e.target as Element).closest("[data-source-span]");
      if (!target) return;
      editor.clearHighlight();
      removeClassAll(outputs, "hover-highlight");
    };
    const click = (e: Event): void => {
      const target = (e.target as Element).closest("[data-source-span]");
      if (!target) return;
      const span = parseKey(target.getAttribute("data-source-span")!);
      if (span === null) return;
      // Land the caret inside the atom so the forward highlight (and the
      // Ctrl-. cycle) target exactly the clicked atom.
      editor.focusLine(span.line, span.startCol);
      setCaretLine(span.line);
    };
    root.addEventListener("mouseover", over);
    root.addEventListener("mouseout", out);
    root.addEventListener("click", click);
    outputHandlers.push({ root, over, out, click });
  }

  const refreshCaret = (): void => setCaretLine(editor.caretLine());
  const CARET_EVENTS = ["keyup", "click", "select", "focus"] as const;
  for (const ev of CARET_EVENTS) ta.addEventListener(ev, refreshCaret);
  const selectionHandler = (): void => {
    if (document.activeElement === ta) refreshCaret();
  };
  document.addEventListener("selectionchange", selectionHandler);

  const keyHandler = (ev: KeyboardEvent): void => {
    if (ev.key !== "." || !ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    ev.preventDefault();
    cyclePress();
  };
  ta.addEventListener("keydown", keyHandler);

  // Double-click cycles too (same action as Ctrl-.); the browser's own
  // word-selection is left intact.
  const dblclickHandler = (): void => cyclePress();
  ta.addEventListener("dblclick", dblclickHandler);

  return {
    update(rules: Rule[]): void {
      positiveSpans = collectPositiveSpans(rules);
      resetCycle();
      applyCaretHighlight();
    },
    setCaretLine,
    destroy(): void {
      for (const h of outputHandlers) {
        h.root.removeEventListener("mouseover", h.over);
        h.root.removeEventListener("mouseout", h.out);
        h.root.removeEventListener("click", h.click);
      }
      for (const ev of CARET_EVENTS) ta.removeEventListener(ev, refreshCaret);
      document.removeEventListener("selectionchange", selectionHandler);
      ta.removeEventListener("keydown", keyHandler);
      ta.removeEventListener("dblclick", dblclickHandler);
      editor.clearHighlight();
    },
  };
}
