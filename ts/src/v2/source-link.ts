// Bidirectional source-line ↔ output linking, shared by the v2 editor page
// and presentation-mode code blocks (plans/v2-source-timeline-link.md).
//
// One linker binds one Editor to N output roots whose renderers stamp
// `data-source-line` on tuple-derived elements (db rows, timeline bars/
// facts/sidebar rows).
//
// Forward: the caret entering a line with a positive (emitting) atom puts
// `.source-highlight` on every matching element across all outputs. The
// timeline is never auto-scrolled; Ctrl-. (or a double-click in the editor)
// cycles through the caret line's timeline occurrences, centering each in
// the scroll container in turn.
// Reverse: hovering a linked element highlights its source line (Editor
// overlay) plus sibling elements from the same line; clicking moves the
// caret to that line.

import type { Rule, RuleAtom } from "./types.js";
import type { Editor } from "./editor.js";

export interface SourceLink {
  // Re-arm after a run: rules rebuild positiveLines, and (since the outputs
  // were just re-rendered) forward highlights are re-applied from the
  // current caret. Pass [] on parse/eval failure to clear.
  update(rules: Rule[]): void;
  // Forward direction. Always re-applies (outputs may have re-rendered);
  // the Ctrl-. cycle resets only when the line actually changed.
  setCaretLine(line: number | null): void;
  destroy(): void;
}

// Source lines containing at least one atom whose marker emits a tuple
// (asserts `~`/`+`/`^`, plus `?`/`!` which desugar to assert rows at eval
// time). Pure matches (`-`) don't qualify.
export function collectPositiveLines(rules: Rule[]): Set<number> {
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

function removeClassAll(roots: HTMLElement[], cls: string): void {
  for (const root of roots) {
    root.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
  }
}

export function attachSourceLink(editor: Editor, outputs: HTMLElement[]): SourceLink {
  let positiveLines = new Set<number>();
  let caretLine: number | null = null;
  // Ctrl-. cycle state: how many presses have happened at `line`.
  let cycle: { line: number; presses: number } | null = null;

  const ta = editor.element;

  function matchesFor(line: number): Element[] {
    const out: Element[] = [];
    for (const root of outputs) {
      root.querySelectorAll(`[data-source-line="${line}"]`).forEach((el) => out.push(el));
    }
    return out;
  }

  function resetCycle(): void {
    cycle = null;
    removeClassAll(outputs, "cycle-focus");
  }

  function applyCaretHighlight(): void {
    removeClassAll(outputs, "source-highlight");
    if (caretLine === null || !positiveLines.has(caretLine)) return;
    for (const root of outputs) {
      const matches = root.querySelectorAll(`[data-source-line="${caretLine}"]`);
      let lastHtml: Element | null = null;
      matches.forEach((el) => {
        el.classList.add("source-highlight");
        if (!(el instanceof SVGElement)) lastHtml = el;
      });
      // Scroll only HTML outputs (db rows). scrollIntoView on an SVG child
      // scrolls the whole timeline unpredictably; the timeline scrolls only
      // via the Ctrl-. cycle below.
      if (lastHtml !== null) {
        (lastHtml as Element).scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  function setCaretLine(line: number | null): void {
    if (line !== caretLine) resetCycle();
    caretLine = line;
    applyCaretHighlight();
  }

  // --- Ctrl-. : cycle timeline occurrences of the caret line ---

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
    const line = editor.caretLine();
    const svgMatches = matchesFor(line).filter((el): el is SVGElement => el instanceof SVGElement);
    if (svgMatches.length === 0) return;
    // One entry per bar: prefer rects over their label texts. Fact labels
    // (text without data-bar-label) stay.
    let targets = svgMatches.filter((el) => !el.hasAttribute("data-bar-label"));
    if (targets.length === 0) targets = svgMatches;
    if (cycle === null || cycle.line !== line) cycle = { line, presses: 0 };
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
      const target = (e.target as Element).closest("[data-source-line]");
      if (!target) return;
      const line = +target.getAttribute("data-source-line")!;
      editor.highlightLine(line);
      for (const el of matchesFor(line)) el.classList.add("hover-highlight");
    };
    const out = (e: Event): void => {
      const target = (e.target as Element).closest("[data-source-line]");
      if (!target) return;
      editor.clearHighlight();
      removeClassAll(outputs, "hover-highlight");
    };
    const click = (e: Event): void => {
      const target = (e.target as Element).closest("[data-source-line]");
      if (!target) return;
      const line = +target.getAttribute("data-source-line")!;
      editor.focusLine(line);
      setCaretLine(line);
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
      positiveLines = collectPositiveLines(rules);
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
