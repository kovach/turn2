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
  intern,
  internAtom,
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
  // tokenOf(activeTerm) -> bound value, transitive-closed over `is` rows.
  // Restricted to keys that are active-term tokens from some BlockedChoose,
  // so unrelated `is foo bar` rows don't pollute the map. Used by
  // substResolved to rewrite a constrain row's wrapped atom before query.
  boundValues: Map<number, Term>;
  // Existential `*var` template tokens collected across all constrain
  // rows in this round. Treated as fresh variables for matching purposes
  // (bind via `sub` like active terms) but never projected into the
  // emitted option tuples.
  existSet: Set<number>;
}

function gatherChoiceContext(store: Store, blocked: BlockedChoose[]): ChoiceContext {
  const resolved = new Set<number>();
  const rawBound = new Map<number, Term>();
  for (const idx of candidatesByHead(store, "is")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    const V = t.atom.terms[2];
    if (T === undefined || V === undefined) continue;
    const k = tokenOf(store, T);
    resolved.add(k);
    // Only fresh-id templates (`*id` / `*choose`-headed) participate in
    // the substitution map. A user's domain-level `is foo bar` row
    // doesn't get to rewrite arbitrary symbols inside constrain
    // patterns. Note we can't restrict to BlockedChoose's active terms
    // here — partial binding can fully resolve one _choose row while
    // another _constrain row still references the same id template, so
    // the substitution must be available across all rows.
    if (isFreshIdTemplate(T, store)) rawBound.set(k, V);
  }

  // Transitive closure: if rawBound[k] = v and tokenOf(v) is itself a
  // key, chase deeper. Iteratively flatten each entry, detecting cycles
  // via a per-entry visited set.
  const boundValues = new Map<number, Term>();
  for (const [k, v0] of rawBound) {
    let v = v0;
    const seen = new Set<number>([k]);
    while (true) {
      const vk = tokenOf(store, v);
      if (!rawBound.has(vk)) break;
      if (seen.has(vk)) {
        throw new Error("gatherChoiceContext: cycle in `is` substitution");
      }
      seen.add(vk);
      v = rawBound.get(vk)!;
    }
    boundValues.set(k, v);
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
  return { resolved, activeSet, termByTok, boundValues, existSet: new Set() };
}

// True if `t` is a fresh-id template — a Ref/Atom/Id whose head Symbol
// is `*id` or `*choose`. These are the only terms that can legitimately
// be a key in the substitution map.
function isFreshIdTemplate(t: Term, store: Store): boolean {
  return termHeadIsOneOf(t, store, ID_HEADS);
}

// True if `t` is a `*var`-headed template (an existential introduced by
// a `!(...)` block). Existentials are treated as fresh variables when
// matching but never appear in the user-visible option tuples.
function isFreshVarTemplate(t: Term, store: Store): boolean {
  return termHeadIsOneOf(t, store, VAR_HEADS);
}

const ID_HEADS = new Set(["*id", "*choose"]);
const VAR_HEADS = new Set(["*var"]);

function termHeadIsOneOf(t: Term, store: Store, names: Set<string>): boolean {
  let head: Term | undefined;
  if (t.tag === "Ref") {
    const body = store.hash.refToAtom.get(t.id);
    head = body?.terms[0];
  } else if (t.tag === "Atom" || t.tag === "Id") {
    head = t.atom.terms[0];
  }
  if (head?.tag !== "Symbol") return false;
  return names.has(head.name);
}

// Recursively rewrite `t` by replacing any leaf whose token is a key in
// `bound` with the bound value. Compound subterms whose contents change
// are rebuilt and re-interned via `internAtom`. Id-tagged literals/Refs
// are checked at the top by the `bound` lookup; if not bound, they're
// returned as-is (their bodies are opaque, per the v2 id-opacity
// invariant — see notes/v2-design.md). This means: if a substitution
// candidate lives nested *inside* an Id body, it stays untouched. In
// practice, active-term tokens occur only at top-level positions of a
// constrain row's wrapped atom or as direct children of a regular Atom,
// so the opacity boundary doesn't matter.
function substResolved(t: Term, bound: Map<number, Term>, store: Store): Term {
  const tok = tokenOf(store, t);
  const hit = bound.get(tok);
  if (hit !== undefined) return hit;
  if (t.tag === "Atom") {
    let changed = false;
    const next: Term[] = [];
    for (const sub of t.atom.terms) {
      const r = substResolved(sub, bound, store);
      if (r !== sub) changed = true;
      next.push(r);
    }
    if (!changed) return t;
    return intern(store, { tag: "Atom", atom: internAtom(store, { terms: next }) });
  }
  if (t.tag === "Ref") {
    if (refTagOf(store.hash, t.id) === "Id") return t;
    const body = store.hash.refToAtom.get(t.id);
    if (body === undefined) return t;
    let changed = false;
    const next: Term[] = [];
    for (const sub of body.terms) {
      const r = substResolved(sub, bound, store);
      if (r !== sub) changed = true;
      next.push(r);
    }
    if (!changed) return t;
    return intern(store, { tag: "Atom", atom: internAtom(store, { terms: next }) });
  }
  return t;
}

function substResolvedAtom(a: Atom, bound: Map<number, Term>, store: Store): Atom {
  let changed = false;
  const next: Term[] = [];
  for (const t of a.terms) {
    const r = substResolved(t, bound, store);
    if (r !== t) changed = true;
    next.push(r);
  }
  if (!changed) return a;
  return internAtom(store, { terms: next });
}

// Walk every nested term inside `atom` recursively (through Refs whose body
// is a regular Atom) and report the set of unresolved active-term tokens it
// touches. Ids are opaque: a Ref whose body was hashconsed as `Id`, or a
// literal `Id` term, is checked for active-term identity but never unfolded.

interface ConstrainSub {
  // "plain": match candidates one tuple at a time by structural
  // unification against the sub-atom. "agg": fold candidates via the
  // relation's schema aggregator. The choice component moment `M`
  // (see `choiceComponentMoment`) gates which candidates are visible
  // in either case.
  kind: "plain" | "agg";
  // The sub-atom's regular Atom (head + key positions; for `agg`, last
  // position is the weight slot, matching `_do-agg`'s layout).
  atom: Atom;
}

interface ConstrainRow {
  rowIndex: number;
  // Sub-atoms inside the row's `(*conj ...)` wrapper. Length ≥ 1.
  subs: ConstrainSub[];
  // Active tokens this row touches (unioned across subs, against the
  // post-`is`-substitution sub atoms).
  touched: Set<number>;
  // The constrain row's stored left endpoint. Used to compute the
  // choice component moment `M = lub(row.l for row in comp)`; the row's
  // own right endpoint is not consulted (the component evaluates against
  // `M` rather than per-row intervals).
  l: Term;
}

function gatherConstrainRows(
  store: Store,
  activeSet: Set<number>,
  boundValues: Map<number, Term>,
  existSet: Set<number>,
): ConstrainRow[] {
  const out: ConstrainRow[] = [];
  for (const idx of candidatesByHead(store, "_constrain")) {
    const t = store.tuples[idx]!;
    const wrappedTerm = t.atom.terms[1];
    if (wrappedTerm === undefined) continue;
    // The wrapped term is a `(*conj sub1 ... subN)` Id container.
    // Each `subi` is `(*c-plain (inner))` or `(*c-agg (inner))`.
    const conjAtom = unwrapAtom(wrappedTerm, store);
    if (conjAtom === null) continue;
    const conjHead = conjAtom.terms[0];
    if (conjHead === undefined || conjHead.tag !== "Symbol" || conjHead.name !== "*conj") continue;
    const subs: ConstrainSub[] = [];
    const touched = new Set<number>();
    for (let i = 1; i < conjAtom.terms.length; i++) {
      const sw = conjAtom.terms[i]!;
      const swAtom = unwrapAtom(sw, store);
      if (swAtom === null) continue;
      const swHead = swAtom.terms[0];
      if (swHead === undefined || swHead.tag !== "Symbol") continue;
      const kind: "plain" | "agg" =
        swHead.name === "*c-agg" ? "agg" :
        swHead.name === "*c-plain" ? "plain" : "plain";
      const innerTerm = swAtom.terms[1];
      if (innerTerm === undefined) continue;
      const rawInner = unwrapAtom(innerTerm, store);
      if (rawInner === null) continue;
      const inner = boundValues.size === 0
        ? rawInner
        : substResolvedAtom(rawInner, boundValues, store);
      // Find active and existential (`*var`) tokens inside the sub-atom.
      collectActiveAndExistTokens(inner, store, activeSet, touched, existSet);
      subs.push({ kind, atom: inner });
    }
    if (subs.length === 0) continue;
    if (touched.size === 0) continue;
    out.push({ rowIndex: idx, subs, touched, l: t.l });
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

// Walk `atom` recursively (through Refs whose body is a regular Atom,
// not through Id-tagged opaque ids). Add active-term tokens to
// `touched`; add `*var`-template tokens to `existOut`.
function collectActiveAndExistTokens(
  atom: Atom,
  store: Store,
  activeSet: Set<number>,
  touched: Set<number>,
  existOut: Set<number>,
): void {
  function walk(term: Term): void {
    const tok = tokenOf(store, term);
    if (activeSet.has(tok)) {
      touched.add(tok);
      return;
    }
    if (isFreshVarTemplate(term, store)) {
      existOut.add(tok);
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
}

interface RawComponent {
  members: Set<number>;       // active-term tokens in this component
  rows: ConstrainRow[];
}

// The choice component moment: the single moment `M` at which every
// constrain / constrain-agg row in `comp` is interpreted. Defined as the
// least upper bound of the rows' left endpoints. The moment graph is a
// lattice (see notes/moment-insertion.md), so `M` is guaranteed to exist
// uniquely whenever `comp` has at least one row. A zero-row component is
// unreachable in practice — the empty-fringe check in `computeComponents`
// intercepts it — but is asserted here as a defensive invariant.
function choiceComponentMoment(store: Store, comp: RawComponent): Term {
  if (comp.rows.length === 0) {
    throw new Error("choiceComponentMoment: zero-row component (should be caught by empty-fringe)");
  }
  const m = leastUpperBound(store, comp.rows.map((r) => r.l));
  if (m === null) {
    throw new Error("choiceComponentMoment: moment graph invariant violated — expected lattice");
  }
  return m;
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
  existSet: Set<number>,
  termByTok: Map<number, Term>,
  schema: Map<string, string>,
): ComponentOptions {
  const activeKeys = [...comp.members].filter((k) => activeSet.has(k)).sort((a, b) => a - b);
  const activeTerms = activeKeys.map((k) => termByTok.get(k)!);

  // The choice component moment — every row in `comp` is evaluated against
  // this single moment rather than its own stored interval.
  const M = choiceComponentMoment(store, comp);

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

  // `slotSet` unifies active and existential tokens for the purposes
  // of structural unification: both behave as fresh variables that bind
  // in `sub`. Existentials don't appear in `activeKeys`, so they never
  // surface in the emitted options.
  const slotSet = unionSets(activeSet, existSet);

  function go(rowIdx: number, sub: Map<number, Term>): void {
    if (rowIdx === comp.rows.length) {
      emit(sub);
      return;
    }
    const row = comp.rows[rowIdx]!;
    goRow(row, 0, sub, (sub2) => go(rowIdx + 1, sub2));
  }

  function goRow(
    row: ConstrainRow,
    ai: number,
    sub: Map<number, Term>,
    after: (sub: Map<number, Term>) => void,
  ): void {
    if (ai === row.subs.length) {
      after(sub);
      return;
    }
    const s = row.subs[ai]!;
    const headTerm = s.atom.terms[0];
    if (headTerm === undefined || headTerm.tag !== "Symbol") return;
    if (s.kind === "agg") {
      runAggSub(s, sub, store, slotSet, schema, M, (sub2) => goRow(row, ai + 1, sub2, after));
      return;
    }
    const arity = s.atom.terms.length;
    for (const cidx of candidatesByHead(store, headTerm.name)) {
      const cand = store.tuples[cidx]!;
      // Stored candidates carry the universal trailing id slot; the
      // sub-atom doesn't. Match the user-facing prefix and ignore the
      // trailing id.
      if (cand.atom.terms.length !== arity + 1) continue;
      if (!intervalContains(store, cand.l, cand.r, M, M)) continue;
      const trial = new Map(sub);
      let ok = true;
      for (let i = 0; i < arity; i++) {
        if (!matchTerm(s.atom.terms[i]!, cand.atom.terms[i]!, trial, store, slotSet)) {
          ok = false;
          break;
        }
      }
      if (ok) goRow(row, ai + 1, trial, after);
    }
  }

  go(0, new Map());
  return { activeTerms, options, moment: M };
}

function unionSets(a: Set<number>, b: Set<number>): Set<number> {
  if (b.size === 0) return a;
  if (a.size === 0) return b;
  const out = new Set<number>(a);
  for (const x of b) out.add(x);
  return out;
}

// Evaluate one aggregate sub-atom. Same shape as the legacy
// `runAggRow`, but scoped to a single sub (the row's other subs are
// handled by `goRow`'s outer recursion). The pattern's last position
// is the weight slot; key positions that are active or existential
// tokens become `_free` so `aggregateOver` aggregates across all
// possible bindings.
function runAggSub(
  s: ConstrainSub,
  sub: Map<number, Term>,
  store: Store,
  slotSet: Set<number>,
  schema: Map<string, string>,
  M: Term,
  after: (sub: Map<number, Term>) => void,
): void {
  const atom = s.atom;
  const arity = atom.terms.length;
  if (arity < 2) return;
  const SYM_FREE: Term = { tag: "Symbol", name: "_free" };
  const aggTerms: Term[] = [atom.terms[0]!];
  for (let i = 1; i < arity - 1; i++) {
    const t = atom.terms[i]!;
    aggTerms.push(slotSet.has(tokenOf(store, t)) ? SYM_FREE : t);
  }
  aggTerms.push(SYM_FREE); // weight position always free
  const aggPattern: Atom = { terms: aggTerms };
  const results = aggregateOver(store, aggPattern, M, M, schema);
  for (const res of results) {
    const trial = new Map(sub);
    let ok = true;
    for (let i = 1; i < arity - 1; i++) {
      if (!matchTerm(atom.terms[i]!, res.filledTerms[i]!, trial, store, slotSet)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (!matchTerm(atom.terms[arity - 1]!, res.weight, trial, store, slotSet)) continue;
    after(trial);
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
  // Restrict surfaced components to those reachable (via shared
  // `_constrain` rows) from these seed choose rows. The closure pulls in
  // entangled non-seed chooses; other blocked chooses stay blocked and
  // re-surface on a subsequent fixpoint round.
  seedChoices: BlockedChoose[],
): ComputeComponentsResult {
  const ctx = gatherChoiceContext(store, blocked);
  const { activeSet, termByTok, boundValues, existSet } = ctx;
  if (activeSet.size === 0) return { kind: "ok", components: [], surfaced: [] };

  const allRows = gatherConstrainRows(store, activeSet, boundValues, existSet);

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

  const out = components.map((c) => runComponent(store, c, closedActive, existSet, termByTok, schema));
  return { kind: "ok", components: out, surfaced };
}
