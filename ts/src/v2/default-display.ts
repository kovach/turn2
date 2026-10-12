// Bundled default display: renders any program via the `icon T` and
// `at X -> L` relations. Activated by web-v2.ts when the program has no
// `-- display: <file>` directive.
//
// Layout: one icon div per `icon T` row, nested under its parent(s) per
// `at X -> L` rows. Both `icon` and `at` are restricted to rows whose
// interval contains the selected component's choice-component moment M.
// Within a container, `left:right A B` / `above:below A B` rows arrange the
// sibling icons on a grid (see icon-layout.ts); a container with no such
// constraints renders as a plain wrapping row, as it always has.
//
// Interaction: the host (web-v2.ts) owns the choices strip above the
// display and passes its state in: `ctx.selectedIdx` names the selected
// component, which drives both the moment filter and the candidate
// computation. Clicking an icon whose term is a valid value for exactly one
// slot of the selected component commits the choice; an ambiguous click
// hands the term to the host as pending (`DisplayApi.setPending`), which
// re-renders with `ctx.pending` set and lets the user pick the slot in the
// strip.
//
// All click handlers commit via DisplayApi.commit; the returned `clicks`
// map is empty.

import type { Atom, Term } from "./term.js";
import type { Store } from "./store.js";
import type { ComponentOptions } from "./types.js";
import { candidatesByHead, intervalContains, tokenOf } from "./store.js";
import { isTrivialLayout, layoutIcons, type LayoutEdge } from "./icon-layout.js";

interface ClickIntent {
  activeTerms: Term[];
  optionTuple: Term[];
}

interface DisplayApi {
  addStyles(css: string): void;
  peek(term: Term, store: Store): Atom | null;
  renderTerm: (store: Store, t: Term) => string;
  tokensEq: (a: Term, b: Term, store: Store) => boolean;
  commit: (intent: ClickIntent) => void;
  setPending: (term: Term | null) => void;
  // Tooltips and context menus for entities (display-kit.ts); display
  // modules use it, the default display doesn't yet.
  kit?: import("./display-kit.js").DisplayKit;
}

interface DisplayCallContext {
  components: ComponentOptions[];
  selectedIdx: number;
  pending: Term | null;
}

interface DisplayModule {
  render(
    store: Store,
    ctx: DisplayCallContext,
  ): { element: HTMLElement; clicks: Map<HTMLElement, ClickIntent> } | null;
}

const CSS = `
.dd-root { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 8px; }
.dd-icons { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; border: 1px dashed var(--border); border-radius: 4px; min-width: 200px; font-size: 16px; }
.dd-icon { padding: 6px 10px; border: 2px solid var(--border); border-radius: 4px; background: var(--bg-2); font-family: monospace; font-size: 16px; display: flex; flex-direction: column; gap: 6px; color: var(--fg); }
.dd-icon-children { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 6px; }
.dd-grid { display: grid; gap: 6px; grid-auto-columns: min-content; align-items: start; justify-items: start; }
.dd-grid-cell { display: flex; flex-wrap: wrap; gap: 6px; }
.dd-icon.clickable { cursor: pointer; border-color: var(--syn-head); }
.dd-icon.ambiguous { cursor: pointer; border-color: var(--syn-ref); }
.dd-icon.pending { background: var(--bg-3); border-style: dashed; }
html.mode-dark  .dd-icon.hot { background: #3a3a3a; }
html.mode-light .dd-icon.hot { background: #ffffff; }
.dd-warn { color: var(--err); font-size: 11px; }
`;

interface IconNode {
  term: Term;
  termKey: number;
  label: string;
  parents: number[];       // termKeys of parents (or [] for top-level)
}

// Pseudo-parent for icons with no `at` parent: the top-level row is a
// container like any other, so a program with no `at` rows can still use
// `left:right` / `above:below`.
const ROOT_KEY = -1;

interface Constraints {
  horizontal: LayoutEdge[];
  vertical: LayoutEdge[];
}

interface ScopedConstraints {
  byContainer: Map<number, Constraints>;
  // Constraints between icons that never share a container.
  ignored: number;
}

interface LayoutWarnings {
  hCycle: boolean;
  vCycle: boolean;
}

// Threaded through rendering: per-container constraints plus the mutable
// warning flags the containers raise as they lay themselves out.
interface LayoutCtx {
  byContainer: Map<number, Constraints>;
  warn: LayoutWarnings;
}

export function createDefaultDisplay(api: DisplayApi): DisplayModule {
  api.addStyles(CSS);

  // The moment at which to interpret `icon` / `at` rows. While choices are
  // active, this is the selected component's choice-component moment.
  // After all choices are made (no active components), pass `store.top` —
  // it contains every interval, so the filter is effectively "everything
  // visible at the end of the program".
  function renderMoment(ctx: DisplayCallContext, store: Store): Term {
    const c = ctx.components[ctx.selectedIdx];
    return c ? c.moment : store.top;
  }

  // Collect `icon:name I N` rows whose interval contains M, indexed by
  // tokenOf(I). Last writer wins on collision.
  function collectIconNames(store: Store, M: Term): Map<number, string> {
    const names = new Map<number, string>();
    for (const idx of candidatesByHead(store, "icon:name")) {
      const t = store.tuples[idx]!;
      const ts = t.atom.terms;
      // [head, I, N, id]
      if (ts.length !== 4) continue;
      if (!intervalContains(store, t.l, t.r, M, M)) continue;
      names.set(tokenOf(store, ts[1]!), api.renderTerm(store, ts[2]!));
    }
    return names;
  }

  // Collect `icon T` rows whose interval contains M. Dedup by term token.
  function collectIcons(store: Store, M: Term, names: Map<number, string>): IconNode[] {
    const seen = new Map<number, IconNode>();
    const order: IconNode[] = [];
    for (const idx of candidatesByHead(store, "icon")) {
      const t = store.tuples[idx]!;
      const ts = t.atom.terms;
      // [head, T, id]
      if (ts.length !== 3) continue;
      if (!intervalContains(store, t.l, t.r, M, M)) continue;
      const term = ts[1]!;
      const key = tokenOf(store, term);
      if (seen.has(key)) continue;
      const node: IconNode = {
        term,
        termKey: key,
        label: names.get(key) ?? api.renderTerm(store, term),
        parents: [],
      };
      seen.set(key, node);
      order.push(node);
    }
    return order;
  }

  function collectAt(
    store: Store,
    M: Term,
    iconKeys: Set<number>,
  ): { childToParents: Map<number, number[]>; orphans: Term[] } {
    const childToParents = new Map<number, number[]>();
    const orphans: Term[] = [];

    function record(X: Term, L: Term): void {
      const xk = tokenOf(store, X);
      const lk = tokenOf(store, L);
      if (!iconKeys.has(xk)) return;
      if (!iconKeys.has(lk)) { orphans.push(L); return; }
      let arr = childToParents.get(xk);
      if (arr === undefined) { arr = []; childToParents.set(xk, arr); }
      if (!arr.includes(lk)) arr.push(lk);
    }

    // `at X L` rows alive at M: plain tuples, or the point rows of an
    // `#acc at : e (@last loc)` relation (one per temporally latest move).
    for (const idx of candidatesByHead(store, "at")) {
      const t = store.tuples[idx]!;
      const ts = t.atom.terms;
      // [head, X, L, id]
      if (ts.length !== 4) continue;
      if (!intervalContains(store, t.l, t.r, M, M)) continue;
      record(ts[1]!, ts[2]!);
    }
    return { childToParents, orphans };
  }

  // Collect `left:right A B` / `above:below A B` rows whose interval contains
  // M and whose endpoints are both icons. Non-icon endpoints are dropped here;
  // sibling scoping happens in `scopeConstraints`.
  function collectConstraints(
    store: Store,
    M: Term,
    iconKeys: Set<number>,
  ): { cons: Constraints; dropped: number } {
    let dropped = 0;
    function collect(head: string): LayoutEdge[] {
      const out: LayoutEdge[] = [];
      for (const idx of candidatesByHead(store, head)) {
        const t = store.tuples[idx]!;
        const ts = t.atom.terms;
        // [head, A, B, id]
        if (ts.length !== 4) continue;
        if (!intervalContains(store, t.l, t.r, M, M)) continue;
        const from = tokenOf(store, ts[1]!);
        const to = tokenOf(store, ts[2]!);
        if (!iconKeys.has(from) || !iconKeys.has(to)) { dropped++; continue; }
        out.push({ from, to });
      }
      return out;
    }
    const horizontal = collect("left:right");
    const vertical = collect("above:below");
    return { cons: { horizontal, vertical }, dropped };
  }

  // Restrict each constraint to the containers in which both endpoints are
  // siblings. An edge used by no container is counted as ignored.
  function scopeConstraints(
    containers: Map<number, IconNode[]>,
    cons: Constraints,
  ): ScopedConstraints {
    const byContainer = new Map<number, Constraints>();
    const usedH = new Set<number>();
    const usedV = new Set<number>();

    for (const [key, members] of containers) {
      const memberKeys = new Set(members.map((m) => m.termKey));
      const horizontal: LayoutEdge[] = [];
      const vertical: LayoutEdge[] = [];
      cons.horizontal.forEach((e, i) => {
        if (e.from === e.to) return;
        if (!memberKeys.has(e.from) || !memberKeys.has(e.to)) return;
        usedH.add(i);
        horizontal.push(e);
      });
      cons.vertical.forEach((e, i) => {
        if (e.from === e.to) return;
        if (!memberKeys.has(e.from) || !memberKeys.has(e.to)) return;
        usedV.add(i);
        vertical.push(e);
      });
      byContainer.set(key, { horizontal, vertical });
    }

    const ignored =
      (cons.horizontal.length - usedH.size) + (cons.vertical.length - usedV.size);
    return { byContainer, ignored };
  }

  // candidates(T, C_sel): set of slot indices i such that some option row
  // has tokensEq(row[i], T). Returns the set as an array of (slotIdx, var).
  // Slots labeled `rng` are never offered (plans/v2-choice-actors.md): a
  // click can only bind a `you` slot; rng slots resolve automatically once
  // the `you` terms are committed.
  function candidatesFor(
    T: Term,
    comp: ComponentOptions,
    store: Store,
  ): number[] {
    const hits = new Set<number>();
    for (const row of comp.options) {
      for (let i = 0; i < row.length; i++) {
        if (comp.actors[i] === "rng") continue;
        if (api.tokensEq(row[i]!, T, store)) hits.add(i);
      }
    }
    return [...hits].sort((a, b) => a - b);
  }

  // Compute the option tuple for committing slot `slotIdx <- T`. We pick
  // any row that has `row[slotIdx] === T`; for length-1 components this is
  // unambiguous, for multi-arity ones we pass a length-1 intent (just that
  // slot), which handleClick accepts.
  function commitSlot(comp: ComponentOptions, slotIdx: number, T: Term, store: Store): ClickIntent | null {
    // Defense in depth: an rng-labeled slot is never user-committable
    // (candidatesFor already filters them out).
    if (comp.actors[slotIdx] === "rng") return null;
    for (const row of comp.options) {
      if (slotIdx >= row.length) continue;
      if (!api.tokensEq(row[slotIdx]!, T, store)) continue;
      return {
        activeTerms: [comp.activeTerms[slotIdx]!],
        optionTuple: [T],
      };
    }
    return null;
  }

  function buildIconTree(
    icons: IconNode[],
    childToParents: Map<number, number[]>,
  ): {
    roots: IconNode[];
    childrenOf: Map<number, IconNode[]>;
    cycleWarning: boolean;
  } {
    const byKey = new Map<number, IconNode>();
    for (const ic of icons) byKey.set(ic.termKey, ic);
    for (const ic of icons) {
      ic.parents = childToParents.get(ic.termKey) ?? [];
    }
    // Cycle detection: gray/black DFS over parent links.
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<number, number>();
    let cycleWarning = false;
    function visit(k: number): void {
      const c = color.get(k) ?? WHITE;
      if (c === GRAY) { cycleWarning = true; return; }
      if (c === BLACK) return;
      color.set(k, GRAY);
      const node = byKey.get(k);
      if (node) {
        for (const p of node.parents) visit(p);
      }
      color.set(k, BLACK);
    }
    for (const ic of icons) visit(ic.termKey);
    // If cycle: drop *all* parent links on cycle participants. Simpler than
    // surgically removing back-edges, and the warning lets the user know.
    if (cycleWarning) {
      for (const ic of icons) ic.parents = [];
    }
    const childrenOf = new Map<number, IconNode[]>();
    const roots: IconNode[] = [];
    for (const ic of icons) {
      if (ic.parents.length === 0) {
        roots.push(ic);
      } else {
        for (const pk of ic.parents) {
          let arr = childrenOf.get(pk);
          if (arr === undefined) { arr = []; childrenOf.set(pk, arr); }
          arr.push(ic);
        }
      }
    }
    return { roots, childrenOf, cycleWarning };
  }

  // Hover highlight that doesn't bleed across nested icons. `mouseenter`
  // alone gives both parent and child the `hot` class when the cursor
  // enters a child (parent's mouseenter has already fired and its
  // mouseleave doesn't fire on descent). `mouseover`/`mouseout` *do*
  // bubble, so on child→parent transitions both events fire on both
  // elements with the correct semantics; `stopPropagation` keeps the
  // outer icon from re-receiving the inner icon's events.
  function attachHotHandlers(el: HTMLElement): void {
    el.addEventListener("mouseover", (e) => {
      e.stopPropagation();
      el.classList.add("hot");
    });
    el.addEventListener("mouseout", (e) => {
      e.stopPropagation();
      el.classList.remove("hot");
    });
  }

  // Render one container's worth of sibling icons. With no applicable
  // constraint the layout is a single cell and we emit the historical
  // wrapping-row markup; otherwise a grid, one cell div per occupied
  // position, icons within a cell (unrelated by any constraint) side by side.
  function renderContainer(
    containerKey: number,
    members: IconNode[],
    baseClass: string,
    childrenOf: Map<number, IconNode[]>,
    comp: ComponentOptions | null,
    store: Store,
    pending: Term | null,
    lay: LayoutCtx,
  ): HTMLElement {
    const el = document.createElement("div");
    const cons = lay.byContainer.get(containerKey);
    const layout = layoutIcons(
      members.map((m) => m.termKey),
      cons?.horizontal ?? [],
      cons?.vertical ?? [],
    );
    if (layout.hCycle) lay.warn.hCycle = true;
    if (layout.vCycle) lay.warn.vCycle = true;

    if (isTrivialLayout(layout)) {
      el.className = baseClass;
      for (const m of members) {
        el.appendChild(renderIcon(m, childrenOf, comp, store, pending, lay));
      }
      return el;
    }

    el.className = `${baseClass} dd-grid`;
    const cells = new Map<string, HTMLElement>();
    for (let i = 0; i < members.length; i++) {
      const p = layout.placements[i]!;
      const cellKey = `${p.row},${p.col}`;
      let cell = cells.get(cellKey);
      if (cell === undefined) {
        cell = document.createElement("div");
        cell.className = "dd-grid-cell";
        cell.style.gridRow = String(p.row + 1);
        cell.style.gridColumn = String(p.col + 1);
        cells.set(cellKey, cell);
        el.appendChild(cell);
      }
      cell.appendChild(renderIcon(members[i]!, childrenOf, comp, store, pending, lay));
    }
    return el;
  }

  function renderIcon(
    icon: IconNode,
    childrenOf: Map<number, IconNode[]>,
    comp: ComponentOptions | null,
    store: Store,
    pending: Term | null,
    lay: LayoutCtx,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = "dd-icon";

    const label = document.createElement("div");
    label.textContent = icon.label;
    el.appendChild(label);

    const kids = childrenOf.get(icon.termKey);
    if (kids && kids.length > 0) {
      el.appendChild(renderContainer(
        icon.termKey, kids, "dd-icon-children",
        childrenOf, comp, store, pending, lay,
      ));
      el.classList.add("dd-icon-container");
    }

    if (comp !== null) {
      const cands = candidatesFor(icon.term, comp, store);
      const isPending = pending !== null && api.tokensEq(pending, icon.term, store);
      if (cands.length === 0) {
        // no listener
      } else if (cands.length === 1) {
        el.classList.add("clickable");
        const slot = cands[0]!;
        attachHotHandlers(el);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const intent = commitSlot(comp, slot, icon.term, store);
          if (intent) api.commit(intent);
        });
      } else {
        el.classList.add("ambiguous");
        if (isPending) el.classList.add("pending");
        attachHotHandlers(el);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          api.setPending(isPending ? null : icon.term);
        });
      }
    }
    return el;
  }

  function renderInner(
    container: HTMLElement,
    store: Store,
    ctx: DisplayCallContext,
  ): void {
    container.innerHTML = "";
    const M = renderMoment(ctx, store);
    const names = collectIconNames(store, M);
    const icons = collectIcons(store, M, names);
    const iconKeys = new Set(icons.map((i) => i.termKey));
    const { childToParents, orphans } = collectAt(store, M, iconKeys);
    const { roots, childrenOf, cycleWarning } = buildIconTree(icons, childToParents);

    const containers = new Map<number, IconNode[]>([[ROOT_KEY, roots]]);
    for (const [pk, kids] of childrenOf) containers.set(pk, kids);
    const { cons, dropped } = collectConstraints(store, M, iconKeys);
    const scoped = scopeConstraints(containers, cons);
    const lay: LayoutCtx = {
      byContainer: scoped.byContainer,
      warn: { hCycle: false, vCycle: false },
    };

    const comp = ctx.components[ctx.selectedIdx] ?? null;
    container.appendChild(renderContainer(
      ROOT_KEY, roots, "dd-icons", childrenOf, comp, store, ctx.pending, lay,
    ));

    if (cycleWarning) {
      const w = document.createElement("div");
      w.className = "dd-warn";
      w.textContent = "warning: `at` cycle detected; promoted to top level";
      container.appendChild(w);
    }
    if (orphans.length > 0) {
      const w = document.createElement("div");
      w.className = "dd-warn";
      w.textContent = `warning: ${orphans.length} \`at\` target(s) missing \`icon\``;
      container.appendChild(w);
    }
    function warn(text: string): void {
      const w = document.createElement("div");
      w.className = "dd-warn";
      w.textContent = text;
      container.appendChild(w);
    }
    if (lay.warn.hCycle) warn("warning: `left:right` cycle; horizontal layout ignored");
    if (lay.warn.vCycle) warn("warning: `above:below` cycle; vertical layout ignored");
    const unusable = dropped + scoped.ignored;
    if (unusable > 0) {
      warn(`warning: ${unusable} layout constraint(s) ignored (not sibling icons)`);
    }
  }

  return {
    render(store, ctx) {
      const root = document.createElement("div");
      root.className = "dd-root";
      renderInner(root, store, ctx);
      return { element: root, clicks: new Map() };
    },
  };
}
