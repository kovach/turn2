// Per-component option enumeration for active choices.
//
// Mirrors v1's ts/src/constraint-query.ts adapted to the v2 store:
//
//   1. Gather active-term tokens from blocked `choose` rows.
//   2. Read `is` rows -> resolved-token set; ignore resolved active terms.
//   3. Read `constrain` rows; build a bipartite graph between unresolved
//      active terms and the constrain rows that mention them (recursively
//      walking each row's wrapped atom).
//   4. BFS to form components.
//   5. For each component, lift the constrain rows into a conjunctive query
//      over store.byHead, replacing active and existential subterms with
//      substitution slots; collect the joint bindings of active terms as
//      deduped option tuples.
//
// Empty-fringe check: any component containing at least one active term but
// no constrain rows is a programmer error (an unconstrained `?`).

import type { Atom, Term } from "../types.js";
import type { BlockedChoose, ComponentOptions } from "./types.js";
import { refTagOf } from "../hashcons.js";
import {
  candidatesByHead,
  intervalContains,
  leastUpperBound,
  tokenOf,
  type Store,
} from "./store.js";
import { aggregateOver } from "./scheduler.js";

export type { ComponentOptions };

export type ComputeComponentsResult =
  | { kind: "ok"; components: ComponentOptions[]; surfaced: BlockedChoose[] }
  | { kind: "empty-fringe-error"; choice: BlockedChoose; activeTerm: Term };

interface ChoiceContext {
  resolved: Set<number>;
  activeSet: Set<number>;
  termByTok: Map<number, Term>;
}

function gatherChoiceContext(store: Store, blocked: BlockedChoose[]): ChoiceContext {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "is")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  const activeSet = new Set<number>();
  const termByTok = new Map<number, Term>();
  for (const c of blocked) {
    for (const a of c.activeTerms) {
      const tok = tokenOf(store, a);
      if (resolved.has(tok)) continue;
      activeSet.add(tok);
      termByTok.set(tok, a);
    }
  }
  return { resolved, activeSet, termByTok };
}

// Walk every nested term inside `atom` recursively (through Refs whose body
// is a regular Atom) and report the set of unresolved active-term tokens it
// touches. Ids are opaque: a Ref whose body was hashconsed as `Id`, or a
// literal `Id` term, is checked for active-term identity but never unfolded.
function activeTokensIn(atom: Atom, store: Store, activeSet: Set<number>): Set<number> {
  const out = new Set<number>();
  function walk(term: Term): void {
    const tok = tokenOf(store, term);
    if (activeSet.has(tok)) {
      out.add(tok);
      return;
    }
    if (term.tag === "Ref") {
      if (refTagOf(store.hash, term.id) === "Id") return;
      const inner = store.hash.refToAtom.get(term.id);
      if (inner === undefined) return;
      for (const t of inner.terms) walk(t);
      return;
    }
    if (term.tag === "Atom") {
      for (const t of term.atom.terms) walk(t);
    }
  }
  for (const t of atom.terms) walk(t);
  return out;
}

interface ConstrainRow {
  rowIndex: number;
  // "plain": match candidates one tuple at a time by overlap + structural
  // unification. "agg": fold candidates whose interval *contains* this row's
  // interval via the relation's schema aggregator (no `_do-agg`/`_agg-
  // result` rows are inserted into the store).
  kind: "plain" | "agg";
  // The wrapped atom inside the constrain row's terms[1].
  wrapped: Atom;
  // Active tokens this row touches.
  touched: Set<number>;
  // The constrain row's stored left endpoint. Used to compute the
  // component's canonical moment `M = lub(row.l for row in comp)`; the
  // row's own right endpoint is not consulted (the component evaluates
  // against `M` rather than per-row intervals).
  l: Term;
}

function gatherConstrainRows(store: Store, activeSet: Set<number>): ConstrainRow[] {
  const out: ConstrainRow[] = [];
  for (const head of ["_constrain", "_constrain-agg"] as const) {
    const kind = head === "_constrain" ? "plain" : "agg";
    for (const idx of candidatesByHead(store, head)) {
      const t = store.tuples[idx]!;
      const wrappedTerm = t.atom.terms[1];
      if (wrappedTerm === undefined) continue;
      const wrapped = unwrapAtom(wrappedTerm, store);
      if (wrapped === null) continue;
      const touched = activeTokensIn(wrapped, store, activeSet);
      if (touched.size === 0) continue;
      out.push({ rowIndex: idx, kind, wrapped, touched, l: t.l });
    }
  }
  return out;
}

function unwrapAtom(term: Term, store: Store): Atom | null {
  if (term.tag === "Ref") {
    const a = store.hash.refToAtom.get(term.id);
    return a ?? null;
  }
  if (term.tag === "Atom" || term.tag === "Id") return term.atom;
  return null;
}

interface RawComponent {
  members: Set<number>;       // active-term tokens in this component
  rows: ConstrainRow[];
}

function buildComponents(activeSet: Set<number>, rows: ConstrainRow[]): RawComponent[] {
  // term -> rows incident to it
  const incident = new Map<number, ConstrainRow[]>();
  for (const r of rows) {
    for (const tok of r.touched) {
      let list = incident.get(tok);
      if (list === undefined) {
        list = [];
        incident.set(tok, list);
      }
      list.push(r);
    }
  }
  const visited = new Set<number>();
  const components: RawComponent[] = [];
  for (const start of activeSet) {
    if (visited.has(start)) continue;
    const members = new Set<number>([start]);
    const compRows: ConstrainRow[] = [];
    const seenRows = new Set<number>();
    let frontier: number[] = [start];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const u of frontier) {
        const adj = incident.get(u);
        if (adj === undefined) continue;
        for (const r of adj) {
          if (seenRows.has(r.rowIndex)) continue;
          seenRows.add(r.rowIndex);
          compRows.push(r);
          for (const u2 of r.touched) {
            if (!members.has(u2)) {
              members.add(u2);
              next.push(u2);
            }
          }
        }
      }
      frontier = next;
    }
    for (const k of members) visited.add(k);
    components.push({ members, rows: compRows });
  }
  return components;
}

// Backtracking conjunctive query. For a fixed component, run each constrain
// row's wrapped atom against `store.byHead`, threading a substitution from
// active-term tokens to ground Terms.
function runComponent(
  store: Store,
  comp: RawComponent,
  activeSet: Set<number>,
  termByTok: Map<number, Term>,
  schema: Map<string, string>,
): ComponentOptions {
  const activeKeys = [...comp.members].filter((k) => activeSet.has(k)).sort((a, b) => a - b);
  const activeTerms = activeKeys.map((k) => termByTok.get(k)!);

  // Canonical moment M: LUB of all row left endpoints. The moment graph
  // is a lattice (see notes/moment-insertion.md), so M is guaranteed
  // non-null whenever the component has ≥1 row. A zero-row component is
  // unreachable: empty-fringe in computeComponents intercepts it.
  if (comp.rows.length === 0) {
    throw new Error("runComponent: zero-row component (should be caught by empty-fringe)");
  }
  const M = leastUpperBound(store, comp.rows.map((r) => r.l));
  if (M === null) {
    throw new Error("runComponent: moment graph invariant violated — expected lattice");
  }

  const seen = new Set<string>();
  const options: Term[][] = [];

  function emit(sub: Map<number, Term>) {
    const tup: Term[] = [];
    const key: number[] = [];
    for (const k of activeKeys) {
      const v = sub.get(k);
      if (v === undefined) return; // unbound active term — skip
      tup.push(v);
      key.push(tokenOf(store, v));
    }
    const skey = key.join(",");
    if (seen.has(skey)) return;
    seen.add(skey);
    options.push(tup);
  }

  function go(rowIdx: number, sub: Map<number, Term>): void {
    if (rowIdx === comp.rows.length) {
      emit(sub);
      return;
    }
    const row = comp.rows[rowIdx]!;
    const headTerm = row.wrapped.terms[0];
    if (headTerm === undefined || headTerm.tag !== "Symbol") return;
    if (row.kind === "agg") {
      runAggRow(row, sub, go, rowIdx, store, activeSet, schema, M);
      return;
    }
    const arity = row.wrapped.terms.length;
    for (const cidx of candidatesByHead(store, headTerm.name)) {
      const cand = store.tuples[cidx]!;
      // Stored candidates carry the universal trailing id slot; the wrapped
      // pattern (extracted from the _constrain row) doesn't. Match the
      // user-facing prefix and ignore the trailing id.
      if (cand.atom.terms.length !== arity + 1) continue;
      if (!intervalContains(store, cand.l, cand.r, M, M)) continue;
      const trial = new Map(sub);
      let ok = true;
      for (let i = 0; i < arity; i++) {
        if (!matchTerm(row.wrapped.terms[i]!, cand.atom.terms[i]!, trial, store, activeSet)) {
          ok = false;
          break;
        }
      }
      if (ok) go(rowIdx + 1, trial);
    }
  }

  go(0, new Map());
  return { activeTerms, options };
}

// Evaluate one `_constrain-agg` row. Build an agg-pattern from `row.wrapped`
// by rewriting active-token positions and the weight slot to `_free`, run
// `aggregateOver`, then for each resulting group unify the original wrapped
// pattern back against the group's filled terms + aggregated weight via
// `matchTerm` (active tokens act as substitution slots, others demand
// hashcons-token equality). Recurse to the next row per successful unify.
function runAggRow(
  row: ConstrainRow,
  sub: Map<number, Term>,
  go: (rowIdx: number, sub: Map<number, Term>) => void,
  rowIdx: number,
  store: Store,
  activeSet: Set<number>,
  schema: Map<string, string>,
  M: Term,
): void {
  const wrapped = row.wrapped;
  const arity = wrapped.terms.length;
  if (arity < 2) return;
  const SYM_FREE: Term = { tag: "Symbol", name: "_free" };
  const aggTerms: Term[] = [wrapped.terms[0]!];
  for (let i = 1; i < arity - 1; i++) {
    const t = wrapped.terms[i]!;
    aggTerms.push(activeSet.has(tokenOf(store, t)) ? SYM_FREE : t);
  }
  aggTerms.push(SYM_FREE); // weight position always free
  const aggPattern: Atom = { terms: aggTerms };
  const results = aggregateOver(store, aggPattern, M, M, schema);
  for (const res of results) {
    const trial = new Map(sub);
    let ok = true;
    // res.filledTerms has length arity-1 (head + keys). Unify each key
    // position against the original wrapped pattern's term.
    for (let i = 1; i < arity - 1; i++) {
      if (!matchTerm(wrapped.terms[i]!, res.filledTerms[i]!, trial, store, activeSet)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Unify the weight slot.
    if (!matchTerm(wrapped.terms[arity - 1]!, res.weight, trial, store, activeSet)) continue;
    go(rowIdx + 1, trial);
  }
}

// Match pattern term against value term, threading substitutions for active
// (and existential) tokens via `sub`. Active-token slots act as variables;
// other tokens must match by hashcons-token equality. Recursion goes through
// Refs whose body is a regular Atom.
function matchTerm(
  pat: Term,
  val: Term,
  sub: Map<number, Term>,
  store: Store,
  activeSet: Set<number>,
): boolean {
  const ptok = tokenOf(store, pat);
  if (activeSet.has(ptok)) {
    const bound = sub.get(ptok);
    if (bound !== undefined) return tokenOf(store, bound) === tokenOf(store, val);
    sub.set(ptok, val);
    return true;
  }
  if (ptok === tokenOf(store, val)) return true;
  // Decompose if pat is compound.
  const pTerms = childrenOf(pat, store);
  const vTerms = childrenOf(val, store);
  if (pTerms === null || vTerms === null) return false;
  if (pTerms.length !== vTerms.length) return false;
  for (let i = 0; i < pTerms.length; i++) {
    if (!matchTerm(pTerms[i]!, vTerms[i]!, sub, store, activeSet)) return false;
  }
  return true;
}

function childrenOf(term: Term, store: Store): readonly Term[] | null {
  if (term.tag === "Atom" || term.tag === "Id") return term.atom.terms;
  if (term.tag === "Ref") {
    const a = store.hash.refToAtom.get(term.id);
    return a ? a.terms : null;
  }
  return null;
}

export function computeComponents(
  store: Store,
  blocked: BlockedChoose[],
  schema: Map<string, string>,
  // Restrict surfaced components to those reachable (via shared `_constrain`
  // / `_constrain-agg` rows) from these seed choose rows. The closure pulls
  // in entangled non-seed chooses; other blocked chooses stay blocked and
  // re-surface on a subsequent fixpoint round.
  seedChoices: BlockedChoose[],
): ComputeComponentsResult {
  const { activeSet, termByTok } = gatherChoiceContext(store, blocked);
  if (activeSet.size === 0) return { kind: "ok", components: [], surfaced: [] };

  const allRows = gatherConstrainRows(store, activeSet);

  // BFS from seed active tokens over the bipartite (token ↔ constrain-row)
  // graph: a row is reachable iff it touches a reachable token; touching a
  // reachable row marks all of its other touched tokens reachable.
  const closedActive = new Set<number>();
  for (const c of seedChoices) {
    for (const a of c.activeTerms) {
      const tok = tokenOf(store, a);
      if (activeSet.has(tok)) closedActive.add(tok);
    }
  }
  const reachableRows = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < allRows.length; i++) {
      if (reachableRows.has(i)) continue;
      const row = allRows[i]!;
      let hits = false;
      for (const tok of row.touched) {
        if (closedActive.has(tok)) { hits = true; break; }
      }
      if (!hits) continue;
      reachableRows.add(i);
      for (const tok of row.touched) {
        if (!closedActive.has(tok)) {
          closedActive.add(tok);
          changed = true;
        }
      }
    }
  }
  const rowsForComponents = [...reachableRows].map((i) => allRows[i]!);
  const surfaced = blocked.filter((c) =>
    c.activeTerms.some((a) => closedActive.has(tokenOf(store, a))),
  );

  const components = buildComponents(closedActive, rowsForComponents);

  // Empty-fringe: any component with active members but no rows.
  for (const c of components) {
    if (c.rows.length > 0) continue;
    for (const k of c.members) {
      if (!closedActive.has(k)) continue;
      const choiceTerm = termByTok.get(k)!;
      const owning = surfaced.find((b) =>
        b.activeTerms.some((t) => tokenOf(store, t) === k),
      );
      if (owning === undefined) {
        throw new Error("computeComponents: active term has no owning choose row");
      }
      return { kind: "empty-fringe-error", choice: owning, activeTerm: choiceTerm };
    }
  }

  const out = components.map((c) => runComponent(store, c, closedActive, termByTok, schema));
  return { kind: "ok", components: out, surfaced };
}
