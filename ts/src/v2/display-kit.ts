// Display kit (plans/v2-display-kit.md): every visible entity of a game GUI
// explains itself. A display module declares an entity with the store rows
// it was drawn from (`entity(el, { label, rows })`); the kit gives it a
// tooltip (the label and those rows, each with the line of the rule that
// emitted it) and a right-click menu into the code behind it (the emitting
// rules, the rules using its relations, its rows in the timeline, the choice
// it stands for). Shift+right-click keeps the browser's own menu.
//
// Everything is built on demand from tuple indices, so declaring an entity
// is cheap. The kit only reads the store; actions go through `KitHost`.

import type { Store } from "./store.js";
import { intervalContains } from "./store.js";
import type { Term } from "./term.js";
import { renderTerm } from "./print.js";

export interface ClickIntent {
  activeTerms: Term[];
  optionTuple: Term[];
}

// A store row as a display reads it: `terms` without the head and the
// trailing id slot.
export interface KitRow {
  idx: number;
  head: string;
  terms: Term[];
  l: Term;
  r: Term;
}

export interface EntitySpec {
  label: string;
  rows?: (KitRow | number)[];
  choice?: ClickIntent;
  notes?: string[];
}

export interface KitHost {
  store(): Store | null;
  sourceLine(line: number): string | undefined;
  // The Rules view with `query`, pinning the card holding `pinLine`.
  showRules(query: string, pinLine?: number): void;
  // Highlight these tuples in the outputs and scroll to the first.
  showTuples(idx: number[]): void;
  commit(intent: ClickIntent): void;
}

export interface DisplayKit {
  entity(el: Element, spec: EntitySpec | (() => EntitySpec)): void;
  rows(store: Store, head: string, at?: Term): KitRow[];
}

const CSS = `
.kit-entity { cursor: context-menu; }
.kit-entity.kit-choice { cursor: pointer; }
.kit-tip, .kit-menu {
  position: fixed; z-index: 1000; max-width: 460px;
  font: 12px/1.45 monospace; color: var(--fg, #1a1a1a);
  background: var(--bg-2, #f5f5f0); border: 1px solid var(--border, #ccc);
  border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
}
.kit-tip { padding: 6px 9px; pointer-events: none; }
.kit-tip-label { font: 600 13px/1.4 system-ui, sans-serif; margin-bottom: 3px; }
.kit-tip-note { font-family: system-ui, sans-serif; color: var(--fg-mute, #555); }
.kit-row { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.kit-row .kit-head { color: var(--t-r, inherit); font-weight: 600; }
.kit-row .kit-src { color: var(--fg-faint, #888); }
.kit-tip-hint { margin-top: 4px; color: var(--fg-faint, #888); font: 11px system-ui, sans-serif; }
.kit-menu { padding: 3px 0; min-width: 220px; }
.kit-menu-title { padding: 3px 10px 4px; font: 600 12px system-ui, sans-serif; border-bottom: 1px solid var(--border-2, #ddd); margin-bottom: 2px; }
.kit-menu-item { padding: 3px 10px; cursor: pointer; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.kit-menu-item:hover { background: var(--hover, #e8e8e0); }
.kit-menu-sep { border-top: 1px solid var(--border-2, #ddd); margin: 3px 0; }
`;

const MAX_ROWS = 12;

export function createDisplayKit(host: KitHost): DisplayKit {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  let tip: HTMLDivElement | null = null;
  let menu: HTMLDivElement | null = null;
  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  const specs = new WeakMap<Element, EntitySpec | (() => EntitySpec)>();

  const specOf = (el: Element): EntitySpec | null => {
    const s = specs.get(el);
    return s === undefined ? null : typeof s === "function" ? s() : s;
  };

  function rowsOf(spec: EntitySpec, store: Store): KitRow[] {
    return (spec.rows ?? []).flatMap((r) => {
      if (typeof r !== "number") return [r];
      const t = store.tuples[r];
      if (t === undefined) return [];
      const head = t.atom.terms[0];
      return [{ idx: r, head: head?.tag === "Symbol" ? head.name : "?", terms: t.atom.terms.slice(1, -1), l: t.l, r: t.r }];
    });
  }

  function rowEl(row: KitRow, store: Store): HTMLDivElement {
    const d = document.createElement("div");
    d.className = "kit-row";
    const h = document.createElement("span");
    h.className = "kit-head";
    h.textContent = row.head;
    d.append(h, " " + row.terms.map((t) => renderTerm(store, t)).join(" "));
    const span = store.tupleSource[row.idx];
    const src = document.createElement("span");
    src.className = "kit-src";
    src.textContent = span !== undefined ? `   line ${span.line}` : "   (#acc)";
    d.append(src);
    return d;
  }

  function place(box: HTMLElement, x: number, y: number): void {
    box.style.left = "0px";
    box.style.top = "0px";
    const w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    box.style.top = `${Math.max(4, y + h + 4 > window.innerHeight ? y - h - 8 : y)}px`;
  }

  function hideTip(): void {
    if (tipTimer !== null) { clearTimeout(tipTimer); tipTimer = null; }
    tip?.remove();
    tip = null;
  }

  function showTip(el: Element, x: number, y: number): void {
    const store = host.store();
    const spec = specOf(el);
    if (store === null || spec === null) return;
    hideTip();
    tip = document.createElement("div");
    tip.className = "kit-tip";
    const label = document.createElement("div");
    label.className = "kit-tip-label";
    label.textContent = spec.label;
    tip.append(label);
    for (const n of spec.notes ?? []) {
      const d = document.createElement("div");
      d.className = "kit-tip-note";
      d.textContent = n;
      tip.append(d);
    }
    const rows = rowsOf(spec, store);
    for (const row of rows.slice(0, MAX_ROWS)) tip.append(rowEl(row, store));
    if (rows.length > MAX_ROWS) tip.append(`… ${rows.length - MAX_ROWS} more`);
    const hint = document.createElement("div");
    hint.className = "kit-tip-hint";
    hint.textContent = "right-click: the code behind it";
    tip.append(hint);
    document.body.append(tip);
    place(tip, x + 14, y + 16);
  }

  function hideMenu(): void {
    menu?.remove();
    menu = null;
    document.removeEventListener("mousedown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
  }
  const onAway = (ev: Event): void => { if (menu !== null && !menu.contains(ev.target as Node)) hideMenu(); };
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Escape") hideMenu(); };

  function showMenu(el: Element, x: number, y: number): void {
    const store = host.store();
    const spec = specOf(el);
    if (store === null || spec === null) return;
    hideTip();
    hideMenu();
    menu = document.createElement("div");
    menu.className = "kit-menu";
    const title = document.createElement("div");
    title.className = "kit-menu-title";
    title.textContent = spec.label;
    menu.append(title);
    const item = (text: string, act: () => void, tipText?: string): void => {
      const d = document.createElement("div");
      d.className = "kit-menu-item";
      d.textContent = text;
      if (tipText !== undefined) d.title = tipText;
      d.addEventListener("click", () => { hideMenu(); act(); });
      menu!.append(d);
    };
    const sep = (): void => { const d = document.createElement("div"); d.className = "kit-menu-sep"; menu!.append(d); };

    const rows = rowsOf(spec, store);
    if (spec.choice !== undefined) {
      const c = spec.choice;
      item("Choose this", () => host.commit(c));
      sep();
    }
    // The rule that emitted each row (one item per source line).
    const byLine = new Map<number, KitRow>();
    for (const row of rows) {
      const span = store.tupleSource[row.idx];
      if (span !== undefined && !byLine.has(span.line)) byLine.set(span.line, row);
    }
    for (const [line, row] of [...byLine].sort((a, b) => a[0] - b[0])) {
      const text = (host.sourceLine(line) ?? "").trim();
      item(`${row.head}: line ${line}  ${text}`, () => host.showRules(row.head, line), "Show the rule that emitted it (pinned)");
    }
    const heads = [...new Set(rows.map((r) => r.head))];
    if (heads.length > 0) {
      if (byLine.size > 0) sep();
      for (const h of heads) item(`Rules using ${h}`, () => host.showRules(h));
      sep();
      item("Show in timeline", () => host.showTuples(rows.map((r) => r.idx)));
    }
    if (menu.lastElementChild?.className === "kit-menu-sep") menu.lastElementChild.remove();
    document.body.append(menu);
    place(menu, x, y);
    document.addEventListener("mousedown", onAway, true);
    document.addEventListener("keydown", onKey, true);
  }

  return {
    entity(el, spec) {
      specs.set(el, spec);
      el.classList.add("kit-entity");
      if (typeof spec !== "function" && spec.choice !== undefined) el.classList.add("kit-choice");
      // Native SVG <title> tooltips would double up with ours.
      for (const t of Array.from(el.children)) if (t.tagName.toLowerCase() === "title") t.remove();
      el.addEventListener("mouseenter", (ev) => {
        const e = ev as MouseEvent;
        if (tipTimer !== null) clearTimeout(tipTimer);
        tipTimer = setTimeout(() => { tipTimer = null; if (menu === null) showTip(el, e.clientX, e.clientY); }, 250);
      });
      el.addEventListener("mousemove", (ev) => {
        const e = ev as MouseEvent;
        if (tip !== null) place(tip, e.clientX + 14, e.clientY + 16);
      });
      el.addEventListener("mouseleave", () => hideTip());
      el.addEventListener("contextmenu", (ev) => {
        const e = ev as MouseEvent;
        if (e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation(); // the innermost entity owns the menu
        showMenu(el, e.clientX, e.clientY);
      });
    },

    rows(store, head, at) {
      const out: KitRow[] = [];
      for (const idx of store.byHead.get(head) ?? []) {
        const t = store.tuples[idx]!;
        if (at !== undefined && !intervalContains(store, t.l, t.r, at, at)) continue;
        out.push({ idx, head, terms: t.atom.terms.slice(1, -1), l: t.l, r: t.r });
      }
      return out;
    },
  };
}
