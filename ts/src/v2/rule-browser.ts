// The rule browser (plans/v2-rule-browser.md): the left pane's "Rules"
// view. A query picks segments of the source (rule-index.ts); each is shown
// at once as an editable card, and editing a card splices its text back into
// the source textarea, which stays the single source of truth. A pinned card
// stays visible whatever the query.
//
// Card identity across edits: every card tracks its own source range. Edits
// made through a card shift the other cards' ranges by the card's own diff;
// edits made in the source textarea are diffed against the last text seen
// (common prefix / suffix) and shift every range the same way. After each
// successful parse a card re-resolves to the segment at its start.

import { Editor, type EditorMark } from "./editor.js";
import { highlightLine } from "./highlight.js";
import type { Program } from "./types.js";
import type { Span } from "./term.js";
import {
  buildRuleIndex, parseQuery, runQuery, segmentFirstLine, segmentRange,
  type RuleIndex, type Segment, type SourceRange,
} from "./rule-index.js";

interface Card {
  range: SourceRange;
  el: HTMLElement;
  editor: Editor;
  pinned: boolean;
  focused: boolean;
  // Set while the card's own edit is being spliced into the source.
  splicing: boolean;
  // The segment last filled in, and the header parts: built once and only
  // relabelled, since a re-render can run between the mousedown and the
  // mouseup of a click on them (the click blurs a focused card, and blur
  // renders); a replaced button never gets the click.
  seg: Segment;
  nameEl: HTMLElement;
  locEl: HTMLButtonElement;
  pinEl: HTMLButtonElement;
}

export interface RuleBrowserOptions {
  host: HTMLElement;
  source: HTMLTextAreaElement;
  // Switch to the Source view with the caret at `offset`.
  openInSource: (offset: number) => void;
}

export class RuleBrowser {
  private readonly host: HTMLElement;
  private readonly source: HTMLTextAreaElement;
  private readonly opts: RuleBrowserOptions;
  private readonly queryEl: HTMLInputElement;
  private readonly predList: HTMLDataListElement;
  private readonly countEl: HTMLElement;
  private readonly backEl: HTMLButtonElement;
  private readonly fwdEl: HTMLButtonElement;
  private readonly resultsEl: HTMLElement;
  private text: string;
  private index: RuleIndex | null = null;
  private stale = false;
  private cards: Card[] = [];
  // The last rendered layout (group titles and card segments): a render
  // that would produce the same layout updates the cards in place, so a
  // focused card is never detached (which would blur it).
  private layoutKey = "";
  private history: string[] = [];
  private historyPos = -1;

  constructor(opts: RuleBrowserOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.source = opts.source;
    this.text = opts.source.value;
    this.host.classList.add("rb");
    const bar = el("div", "rb-bar");
    this.backEl = el("button", "rb-nav") as HTMLButtonElement;
    this.backEl.textContent = "‹";
    this.backEl.title = "Previous query";
    this.fwdEl = el("button", "rb-nav") as HTMLButtonElement;
    this.fwdEl.textContent = "›";
    this.fwdEl.title = "Next query";
    this.queryEl = el("input", "rb-query") as HTMLInputElement;
    this.queryEl.placeholder = "predicate";
    this.queryEl.spellcheck = false;
    this.predList = el("datalist") as HTMLDataListElement;
    this.predList.id = `rb-preds-${Math.random().toString(36).slice(2)}`;
    this.queryEl.setAttribute("list", this.predList.id);
    this.countEl = el("span", "rb-count");
    bar.append(this.backEl, this.fwdEl, this.queryEl, this.predList, this.countEl);
    this.resultsEl = el("div", "rb-results");
    this.host.append(bar, this.resultsEl);

    this.queryEl.addEventListener("input", () => this.render());
    this.queryEl.addEventListener("change", () => this.pushHistory(this.queryEl.value));
    this.backEl.addEventListener("click", () => this.go(-1));
    this.fwdEl.addEventListener("click", () => this.go(1));
    this.source.addEventListener("input", () => this.onSourceInput());
    this.refreshNav();
  }

  get query(): string { return this.queryEl.value; }

  // Set the query (e.g. from a ctrl-click on a relation name) and record it.
  setQuery(q: string): void {
    this.queryEl.value = q;
    this.pushHistory(q);
    this.render();
  }

  // Pin the card of the segment holding source `line` (1-indexed) and
  // scroll to it. The segment must be in the current results.
  pinLine(line: number): void {
    const ix = this.index;
    const seg = ix?.segOfLine.get(line);
    if (ix === null || seg === undefined) return;
    const start = segmentRange(ix.segs[seg]!).start;
    const card = this.cards.find((c) => c.range.start === start);
    if (card === undefined) return;
    card.pinned = true;
    this.render();
    card.el.scrollIntoView({ block: "nearest" });
    card.el.classList.add("rb-flash");
    setTimeout(() => card.el.classList.remove("rb-flash"), 900);
  }

  // After every successful parse of the source.
  update(text: string, program: Program): void {
    this.onSourceInput(text);
    this.index = buildRuleIndex(text, program);
    this.stale = false;
    this.predList.textContent = "";
    for (const p of [...this.index.uses.keys()].sort()) {
      const o = document.createElement("option");
      o.value = p;
      this.predList.appendChild(o);
    }
    // Typing in a card re-runs the program on every pause; leave the cards
    // alone until the card lets go (blur renders).
    if (this.cards.some((c) => c.focused)) return;
    this.render();
  }

  // The source no longer parses: keep the cards, mark the results stale.
  markStale(): void {
    this.stale = true;
    this.host.classList.add("rb-stale");
  }

  // Shift card ranges past an edit made outside the cards.
  private onSourceInput(text = this.source.value): void {
    const old = this.text;
    if (text === old) return;
    this.text = text;
    let p = 0;
    const max = Math.min(old.length, text.length);
    while (p < max && old.charCodeAt(p) === text.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && old.charCodeAt(old.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
    const editEnd = old.length - s;
    const delta = text.length - old.length;
    const shift = (x: number): number => (x >= editEnd ? x + delta : x > p ? p : x);
    for (const c of this.cards) {
      if (c.splicing) continue;
      c.range = { start: shift(c.range.start), end: shift(c.range.end) };
      if (!c.focused) this.syncCardText(c);
    }
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    this.host.classList.toggle("rb-stale", this.stale);
    const ix = this.index;
    if (ix === null) return;
    const q = parseQuery(this.queryEl.value);
    const result = q === null ? { groups: [] } : runQuery(q, ix);

    // Each segment is shown at most once (two editors over one range would
    // fight), in the first result group that has it. Clicking or pinning a
    // card never moves it: a pinned card stays in its group while the query
    // still picks it, and only pinned cards the query doesn't pick go to the
    // "Pinned" group on top. A focused card the query no longer picks (its
    // edit removed the use) stays, at the end, until it loses focus.
    type Item = { seg: number; marks: Span[]; card?: Card };
    const shown = new Set<number>();
    const groups: { title: string; items: Item[] }[] = [];
    const marksOf = new Map<number, Span[]>();
    for (const g of result.groups) for (const c of g.cards) marksOf.set(c.seg, [...(marksOf.get(c.seg) ?? []), ...c.marks]);
    for (const g of result.groups) {
      const items = g.cards.filter((c) => !shown.has(c.seg)).map((c) => ({ seg: c.seg, marks: marksOf.get(c.seg)! }));
      for (const it of items) shown.add(it.seg);
      if (items.length > 0) groups.push({ title: g.title, items });
    }
    const pinnedItems: Item[] = [];
    const editingItems: Item[] = [];
    const keep = new Set<Card>();
    for (const c of this.cards) {
      if (!c.pinned && !c.focused) continue;
      const seg = this.segmentAt(c.range.start);
      if (seg !== null && shown.has(seg)) continue; // placed with the results
      if (seg === null) {
        if (c.focused) keep.add(c); // mid-edit: keep the card until blur
        continue;
      }
      shown.add(seg);
      (c.pinned ? pinnedItems : editingItems).push({ seg, marks: [], card: c });
    }
    if (pinnedItems.length > 0) groups.unshift({ title: "Pinned", items: pinnedItems.sort((a, b) => a.seg - b.seg) });
    if (editingItems.length > 0) groups.push({ title: "Editing", items: editingItems });

    // Reuse the DOM of cards that survive; drop the rest.
    const bySeg = new Map<number, Card>();
    for (const c of this.cards) {
      const seg = this.segmentAt(c.range.start);
      if (seg !== null && !bySeg.has(seg)) bySeg.set(seg, c);
    }
    const key = JSON.stringify(groups.map((g) => [g.title, g.items.map((i) => i.seg)]));
    if (key === this.layoutKey) {
      for (const g of groups) {
        for (const it of g.items) {
          const card = it.card ?? bySeg.get(it.seg);
          if (card === undefined) continue;
          if (!card.focused) card.range = segmentRange(ix.segs[it.seg]!);
          this.fillCard(card, ix.segs[it.seg]!, it.marks);
        }
      }
      this.renderCount(q === null, result.groups, ix);
      return;
    }
    this.layoutKey = key;
    const next: Card[] = [];
    this.resultsEl.textContent = "";
    for (const g of groups) {
      const col = el("div", "rb-group");
      const h = el("div", "rb-group-title");
      h.textContent = `${g.title} (${g.items.length})`;
      col.appendChild(h);
      for (const it of g.items) {
        const seg = ix.segs[it.seg]!;
        const card = it.card ?? bySeg.get(it.seg) ?? this.makeCard(seg);
        if (!card.focused) card.range = segmentRange(seg);
        this.fillCard(card, seg, it.marks);
        col.appendChild(card.el);
        next.push(card);
      }
      this.resultsEl.appendChild(col);
    }
    for (const c of keep) if (!next.includes(c)) { next.push(c); this.resultsEl.prepend(c.el); }
    // Cards were filled before they were attached: size them now.
    for (const c of next) c.editor.refresh();
    for (const c of this.cards) if (!next.includes(c)) c.editor.destroy();
    this.cards = next;

    this.renderCount(q === null, result.groups, ix);
  }

  private renderCount(empty: boolean, groups: { title: string; cards: unknown[] }[], ix: RuleIndex): void {
    this.countEl.textContent = empty ? `${ix.segs.length} rules` :
      groups.map((g) => `${g.title.split(" ")[0]!.toLowerCase()} ${g.cards.length}`).join(" · ") || "no uses";
  }

  // The segment whose card range starts at `offset`, else the one that
  // contains it.
  private segmentAt(offset: number): number | null {
    const ix = this.index;
    if (ix === null) return null;
    let containing: number | null = null;
    for (let i = 0; i < ix.segs.length; i++) {
      const r = segmentRange(ix.segs[i]!);
      if (r.start === offset) return i;
      if (containing === null && r.start <= offset && offset <= r.end) containing = i;
    }
    return containing;
  }

  private makeCard(seg: Segment): Card {
    const root = el("div", "rb-card");
    const head = el("div", "rb-card-head");
    const body = el("div", "rb-card-body");
    root.append(head, body);
    const editor = new Editor({
      host: body,
      initial: "",
      saveBackend: "none",
      autoGrow: true,
      syntaxHighlight: true,
      firstLine: segmentFirstLine(seg),
    });
    const nameEl = el("span", "rb-card-name");
    const locEl = el("button", "rb-card-loc") as HTMLButtonElement;
    locEl.title = "Open in source";
    const pinEl = el("button", "rb-pin") as HTMLButtonElement;
    head.append(nameEl, locEl, pinEl);
    const card: Card = {
      range: segmentRange(seg), el: root, editor, pinned: false, focused: false, splicing: false,
      seg, nameEl, locEl, pinEl,
    };
    locEl.addEventListener("click", () => this.opts.openInSource(card.seg.code.start));
    pinEl.addEventListener("click", () => {
      card.pinned = !card.pinned;
      this.render();
    });
    const ta = editor.element;
    ta.addEventListener("focus", () => { card.focused = true; });
    ta.addEventListener("blur", () => {
      card.focused = false;
      // A split or merge made while typing shows up once the card lets go.
      // After the focus has moved, so a click into another card lands first.
      setTimeout(() => { if (!this.stale) this.render(); }, 0);
    });
    ta.addEventListener("input", () => this.spliceCard(card));
    // Double-click on a relation name pins this card and queries the name
    // (the card stays in view whatever the new query picks); Ctrl/Cmd-click
    // queries it without pinning.
    ta.addEventListener("dblclick", () => {
      const name = relationAt(ta.value, ta.selectionStart);
      if (name === null) return;
      card.pinned = true;
      this.setQuery(name);
    });
    ta.addEventListener("click", (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const name = relationAt(ta.value, ta.selectionStart);
      if (name !== null) this.setQuery(name);
    });
    return card;
  }

  private fillCard(card: Card, seg: Segment, marks: Span[]): void {
    card.seg = seg;
    card.nameEl.textContent = seg.kind === "rule" || seg.kind === "acc-rule" ? seg.name : `#${seg.kind.replace("-decl", "")} ${seg.name}`;
    card.locEl.textContent = `line ${seg.line}`;
    card.pinEl.textContent = card.pinned ? "unpin" : "pin";
    card.pinEl.title = card.pinned ? "Stop keeping this rule visible" : "Keep this rule visible whatever the query";
    card.el.classList.toggle("rb-pinned", card.pinned);
    if (card.focused) return;
    const first = segmentFirstLine(seg);
    card.editor.setFirstLine(first);
    this.syncCardText(card);
    card.editor.setMarks(marks.flatMap((m): EditorMark[] =>
      m.startCol === undefined || m.endCol === undefined ? [] :
        [{ line: m.line - first + 1, startCol: m.startCol, endCol: m.endCol }]));
  }

  private syncCardText(card: Card): void {
    const t = this.text.slice(card.range.start, card.range.end);
    if (card.editor.value !== t) card.editor.value = t;
  }

  // A card's text changed: replace its range in the source and shift every
  // other card past it.
  private spliceCard(card: Card): void {
    const src = this.source;
    const old = this.text;
    const { start, end } = card.range;
    const t = card.editor.value;
    const delta = t.length - (end - start);
    const next = old.slice(0, start) + t + old.slice(end);
    for (const c of this.cards) {
      if (c === card) continue;
      if (c.range.start >= end) c.range = { start: c.range.start + delta, end: c.range.end + delta };
    }
    card.range = { start, end: end + delta };
    this.text = next;
    // Keep the source's own selection where it was, relative to its text.
    const sel = [src.selectionStart, src.selectionEnd].map((x) => (x >= end ? x + delta : Math.min(x, start)));
    card.splicing = true;
    src.value = next;
    src.setSelectionRange(sel[0]!, sel[1]!);
    src.dispatchEvent(new Event("input"));
    card.splicing = false;
  }

  // ---------------------------------------------------------------- history

  private pushHistory(q: string): void {
    if (q.trim() === "" || this.history[this.historyPos] === q) return;
    this.history = this.history.slice(0, this.historyPos + 1);
    this.history.push(q);
    this.historyPos = this.history.length - 1;
    this.refreshNav();
  }

  private go(d: number): void {
    const i = this.historyPos + d;
    if (i < 0 || i >= this.history.length) return;
    this.historyPos = i;
    this.queryEl.value = this.history[i]!;
    this.refreshNav();
    this.render();
  }

  private refreshNav(): void {
    this.backEl.disabled = this.historyPos <= 0;
    this.fwdEl.disabled = this.historyPos >= this.history.length - 1;
  }
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  return e;
}

// The relation or symbol under `offset` in `text`, if the highlighter
// classes it as a relation head (`r`) or symbol (`s`).
export function relationAt(text: string, offset: number): string | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = text.indexOf("\n", offset);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const col = offset - lineStart;
  for (const t of highlightLine(line, { js: 0 })) {
    if (t.start <= col && col <= t.end && (t.cls === "r" || t.cls === "s")) return line.slice(t.start, t.end);
  }
  return null;
}
