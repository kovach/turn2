// Bundled default display: renders any program via the `icon T` and
// `at X -> L` relations. Activated by web-v2.ts when the program has no
// `-- display: <file>` directive.
//
// Layout: one icon div per `icon T` row, nested under its parent(s) per
// `at X -> L` rows. Both `icon` and `at` are restricted to rows whose
// interval contains the selected component's choice-component moment M.
//
// Interaction: when active choice components are present, render group
// headers above the icon tree; one is "selected" and drives both the
// moment filter and the candidate computation. Clicking an icon whose
// term is a valid value for exactly one slot of the selected component
// commits the choice; ambiguous clicks enter a pending state cleared by
// clicking a header chip.
//
// All click handlers commit via DisplayApi.commit; the returned `clicks`
// map is empty since the module rebuilds its own DOM on internal events.

import type { Atom, Term } from "./term.js";
import type { Store } from "./store.js";
import type { ComponentOptions } from "./types.js";
import { candidatesByHead, intervalContains, tokenOf } from "./store.js";
import { aggregateOver } from "./scheduler.js";

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
}

interface DisplayCallContext {
  components: ComponentOptions[];
  schema: Map<string, string>;
}

interface DisplayModule {
  render(
    store: Store,
    ctx: DisplayCallContext,
  ): { element: HTMLElement; clicks: Map<HTMLElement, ClickIntent> } | null;
}

const CSS = `
.dd-root { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 8px; }
.dd-groups { display: flex; flex-direction: column; gap: 4px; }
.dd-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 6px; border: 2px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 12px; }
.dd-group.selected { background: var(--hover); }
.dd-group.selected.singleton { border-color: var(--syn-head); }
.dd-group.selected.multi { border-color: var(--syn-ref); }
.dd-group-label { color: var(--fg-mute2); }
.dd-chip { padding: 1px 6px; border: 1px solid var(--border); border-radius: 3px; background: var(--bg-2); font-family: monospace; color: var(--syn-var); }
.dd-chip.matchable { background: var(--bg-3); border-color: var(--syn-head); color: var(--syn-head); cursor: pointer; }
.dd-icons { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; border: 1px dashed var(--border); border-radius: 4px; min-width: 200px; font-size: 16px; }
.dd-icon { padding: 6px 10px; border: 2px solid var(--border); border-radius: 4px; background: var(--bg-2); font-family: monospace; font-size: 16px; display: flex; flex-direction: column; gap: 6px; color: var(--fg); }
.dd-icon-children { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 6px; }
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

interface RenderState {
  selectedIdx: number;
  // tokenKey of the pending icon term, or null. Pending state belongs to
  // the currently selected component.
  pending: number | null;
}

export function createDefaultDisplay(api: DisplayApi): DisplayModule {
  api.addStyles(CSS);

  // Module-local state, reset on every fresh render() call (= every
  // fixpoint re-run). Internal re-renders preserve it.
  let state: RenderState = { selectedIdx: 0, pending: null };

  // Rule names from a component's active terms. Each active term is a
  // `(*id rule lexPos (*chain ...) :varName)` template emitted by expand;
  // `terms[1]` is the rule-name Symbol. Dedups, preserves first-seen
  // order. The shape isn't expressible in the type system, so we assert
  // it and throw on violation.
  function ruleNamesOf(comp: ComponentOptions, store: Store): string {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const at of comp.activeTerms) {
      const a = api.peek(at, store);
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

  // The moment at which to interpret `icon` / `at` rows. While choices are
  // active, this is the selected component's choice-component moment.
  // After all choices are made (no active components), pass `store.top` —
  // it contains every interval, so the filter is effectively "everything
  // visible at the end of the program".
  function renderMoment(ctx: DisplayCallContext, store: Store): Term {
    const c = ctx.components[state.selectedIdx];
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
    schema: Map<string, string>,
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

    if (schema.has("at")) {
      // `#agg at * -> <aggregator>`: use aggregateOver so e.g. `last`
      // collapses multiple `+at X -> Y` contributions into one parent
      // per icon. Pattern: `(at _free _free)` — group key is the X
      // slot, weight is the target L.
      const SYM_FREE: Term = { tag: "Symbol", name: "_free" };
      const aggPattern: Atom = { terms: [{ tag: "Symbol", name: "at" }, SYM_FREE, SYM_FREE] };
      const results = aggregateOver(store, aggPattern, M, M, schema);
      for (const r of results) {
        // filledTerms = [head, X], weight = L.
        const X = r.filledTerms[1];
        const L = r.weight;
        if (X === undefined) continue;
        record(X, L);
      }
    } else {
      // No schema for `at`: fall back to raw iteration. Each `+at`
      // contribution is taken at face value.
      for (const idx of candidatesByHead(store, "at")) {
        const t = store.tuples[idx]!;
        const ts = t.atom.terms;
        // [head, X, L, id]
        if (ts.length !== 4) continue;
        if (!intervalContains(store, t.l, t.r, M, M)) continue;
        record(ts[1]!, ts[2]!);
      }
    }
    return { childToParents, orphans };
  }

  // candidates(T, C_sel): set of slot indices i such that some option row
  // has tokensEq(row[i], T). Returns the set as an array of (slotIdx, var).
  function candidatesFor(
    T: Term,
    comp: ComponentOptions,
    store: Store,
  ): number[] {
    const hits = new Set<number>();
    for (const row of comp.options) {
      for (let i = 0; i < row.length; i++) {
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

  function renderIcon(
    icon: IconNode,
    childrenOf: Map<number, IconNode[]>,
    comp: ComponentOptions | null,
    store: Store,
    rerender: () => void,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = "dd-icon";

    const label = document.createElement("div");
    label.textContent = icon.label;
    el.appendChild(label);

    const kids = childrenOf.get(icon.termKey);
    if (kids && kids.length > 0) {
      const kidsEl = document.createElement("div");
      kidsEl.className = "dd-icon-children";
      for (const k of kids) {
        kidsEl.appendChild(renderIcon(k, childrenOf, comp, store, rerender));
      }
      el.appendChild(kidsEl);
      el.classList.add("dd-icon-container");
    }

    if (comp !== null) {
      const cands = candidatesFor(icon.term, comp, store);
      const isPending = state.pending === icon.termKey;
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
          state.pending = state.pending === icon.termKey ? null : icon.termKey;
          rerender();
        });
      }
    }
    return el;
  }

  function renderGroups(
    ctx: DisplayCallContext,
    store: Store,
    rerender: () => void,
  ): HTMLElement | null {
    if (ctx.components.length === 0) return null;
    const wrap = document.createElement("div");
    wrap.className = "dd-groups";
    // For pending state, find which chips are matchable.
    const sel = ctx.components[state.selectedIdx]!;
    let matchableSlots: Set<number> | null = null;
    if (state.pending !== null) {
      matchableSlots = new Set();
      for (const row of sel.options) {
        for (let i = 0; i < row.length; i++) {
          if (tokenOf(store, row[i]!) === state.pending) matchableSlots.add(i);
        }
      }
    }
    for (let i = 0; i < ctx.components.length; i++) {
      const comp = ctx.components[i]!;
      const row = document.createElement("div");
      const isSelected = i === state.selectedIdx;
      const isSingleton = comp.options.length === 1;
      const classes = ["dd-group"];
      if (isSelected) {
        classes.push("selected");
        classes.push(isSingleton ? "singleton" : "multi");
      }
      row.className = classes.join(" ");
      const lab = document.createElement("span");
      lab.className = "dd-group-label";
      lab.textContent = `${ruleNamesOf(comp, store)} |`;
      row.appendChild(lab);
      for (let j = 0; j < comp.activeTerms.length; j++) {
        const chip = document.createElement("span");
        chip.className = "dd-chip";
        chip.textContent = api.renderTerm(store, comp.activeTerms[j]!);
        if (i === state.selectedIdx && matchableSlots !== null && matchableSlots.has(j)) {
          chip.classList.add("matchable");
          chip.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (state.pending === null) return;
            // Recover the pending icon's term from the current icon set.
            const pendingKey = state.pending;
            for (const idx of candidatesByHead(store, "icon")) {
              const t = store.tuples[idx]!;
              const ts = t.atom.terms;
              if (ts.length !== 3) continue;
              const term = ts[1]!;
              if (tokenOf(store, term) !== pendingKey) continue;
              const intent = commitSlot(comp, j, term, store);
              if (intent) api.commit(intent);
              return;
            }
          });
        }
        row.appendChild(chip);
      }
      if (!isSelected) {
        row.addEventListener("click", () => {
          state.selectedIdx = i;
          state.pending = null;
          rerender();
        });
      } else if (isSingleton) {
        // Selected group with exactly one option row: click commits the
        // whole row, binding every active term in this component at once.
        row.addEventListener("click", () => {
          api.commit({
            activeTerms: comp.activeTerms,
            optionTuple: comp.options[0]!,
          });
        });
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderInner(
    container: HTMLElement,
    store: Store,
    ctx: DisplayCallContext,
    rerender: () => void,
  ): void {
    container.innerHTML = "";
    const M = renderMoment(ctx, store);
    const names = collectIconNames(store, M);
    const icons = collectIcons(store, M, names);
    const iconKeys = new Set(icons.map((i) => i.termKey));
    const { childToParents, orphans } = collectAt(store, M, iconKeys, ctx.schema);
    const { roots, childrenOf, cycleWarning } = buildIconTree(icons, childToParents);

    const groups = renderGroups(ctx, store, rerender);
    if (groups) container.appendChild(groups);

    const iconsEl = document.createElement("div");
    iconsEl.className = "dd-icons";
    const comp = ctx.components[state.selectedIdx] ?? null;
    for (const r of roots) {
      iconsEl.appendChild(renderIcon(r, childrenOf, comp, store, rerender));
    }
    container.appendChild(iconsEl);

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
  }

  return {
    render(store, ctx) {
      // Reset state on every fresh render. Clamp selectedIdx in case the
      // component count shrank.
      state = { selectedIdx: 0, pending: null };
      if (ctx.components.length === 0) state.selectedIdx = 0;
      else if (state.selectedIdx >= ctx.components.length) state.selectedIdx = 0;

      const root = document.createElement("div");
      root.className = "dd-root";
      const rerender = (): void => renderInner(root, store, ctx, rerender);
      rerender();
      return { element: root, clicks: new Map() };
    },
  };
}
