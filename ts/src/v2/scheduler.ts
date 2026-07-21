// v2 scheduler. Reads store contents at outer-loop quiescence to find
// blocked do-agg / choose rows; selects the earliest tier under the
// moment-order `prior` relation; closes earliest aggs by emitting
// `agg-result` rows. Knows nothing about rule continuations — paused work
// lives entirely in the store.

import type { Atom, Term } from "./term.js";
import { hashconsTerm, refTagOf } from "./hashcons.js";
import { getAggregator } from "./aggregators.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  comparable,
  intervalContains,
  leastUpperBound,
  lessEq,
  lessThan,
  tokenOf,
  type Store,
} from "./store.js";
import type { BlockedChoose, Rule, RuleAtom } from "./types.js";
import { collectBlockedDoAggCs, SYM_AGG_EMPTY, type BlockedDoAggC } from "./comp-aggregate.js";

const SYM_AGGVAL: Term = { tag: "Symbol", name: "_aggval" };
const SYM_AGGVAL_ID: Term = { tag: "Symbol", name: "*aggval-id" };
const SYM_FREE: Term = { tag: "Symbol", name: "_free" };
const SYM_TOP: Term = { tag: "Symbol", name: "top" };

// A do-agg row whose matching agg-result row does not yet exist.
interface BlockedDoAgg {
  rowIndex: number;
  // Universal trailing id slot — also serves as the do-agg ↔ agg-result
  // correlation key (one identifier suffices).
  id: Term;
  idTok: number;
  wrappedAtom: Atom;          // unwrapped from terms[1]
  l: Term;
  r: Term;
}

// A reactive breakpoint pending materialization: relation `foo`'s value, for a
// single group `key`, at moment `bp` (a join-closure element of *that group's*
// source-tuple left endpoints — see plans/v2-per-group-breakpoints.md) for which
// no `_aggval` row at `[bp, top]` yet exists. `l`/`r` mirror the `BlockedDoAgg`
// shape so `selectEarliestTier` orders it by `bp`.
export interface ReactiveFinalization {
  foo: Term;    // head Symbol of the reactive relation
  key: Term[];  // group key column values (source layout minus head/weight/id)
  bp: Term;     // breakpoint moment
  l: Term;      // == bp
  r: Term;      // == top
}

type Blocked =
  | { kind: "agg"; row: BlockedDoAgg }
  | { kind: "aggc"; row: BlockedDoAggC }
  | { kind: "choose"; row: BlockedChoose }
  | { kind: "reactive"; row: ReactiveFinalization };

// Scan store for do-agg rows lacking matching agg-result rows. The id at
// the trailing slot of each row is the correlation key.
export function collectBlockedDoAggs(store: Store): BlockedDoAgg[] {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "_agg-result")) {
    const t = store.tuples[idx]!;
    const idTerm = t.atom.terms[t.atom.terms.length - 1];
    if (idTerm === undefined) continue;
    resolved.add(tokenOf(store, idTerm));
  }
  const out: BlockedDoAgg[] = [];
  for (const idx of candidatesByHead(store, "_do-agg")) {
    const t = store.tuples[idx]!;
    const wrappedTerm = t.atom.terms[1];
    const idTerm = t.atom.terms[2];
    if (wrappedTerm === undefined || idTerm === undefined) continue;
    const idTok = tokenOf(store, idTerm);
    if (resolved.has(idTok)) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    out.push({ rowIndex: idx, id: idTerm, idTok, wrappedAtom, l: t.l, r: t.r });
  }
  return out;
}

// Scan store for choose rows whose wrapped atom contains at least one
// non-Symbol term lacking a matching `is <activeTerm> _` row.
export function collectBlockedChooses(store: Store): BlockedChoose[] {
  // Gather resolved active-term tokens from `is` rows.
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "is")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  const out: BlockedChoose[] = [];
  for (const idx of candidatesByHead(store, "_choose")) {
    const t = store.tuples[idx]!;
    const chooseId = t.atom.terms[1];
    const wrappedTerm = t.atom.terms[2];
    if (chooseId === undefined || wrappedTerm === undefined) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    const active: Term[] = [];
    collectActiveTerms(wrappedAtom, store, resolved, active);
    if (active.length > 0) {
      out.push({ rowIndex: idx, chooseId, wrappedAtom, activeTerms: active, l: t.l, r: t.r });
    }
  }
  return out;
}

function collectActiveTerms(atom: Atom, store: Store, resolved: Set<number>, out: Term[]): void {
  for (const term of atom.terms) {
    const t = term.tag === "Ref" ? expandRef(term, store) : term;
    if (t === null) continue;
    if (t.tag === "Symbol") continue;
    if (t.tag === "Variable" || t.tag === "Wildcard") continue; // shouldn't occur in stored rows
    if (t.tag === "Atom" || t.tag === "Id") {
      // A fresh-id term has head sym starting with `*id` or `*choose`. Treat
      // any compound atom term as a candidate active term: check resolution.
      const tok = tokenOf(store, term);
      if (!resolved.has(tok)) out.push(term);
      // Don't recurse — active terms are only at the top level of the
      // wrapped atom.
    }
  }
}

function unwrapAtom(term: Term, store: Store): Atom | null {
  let t: Term = term;
  if (t.tag === "Ref") {
    const a = store.hash.refToAtom.get(t.id);
    if (a === undefined) return null;
    return a;
  }
  if (t.tag === "Atom" || t.tag === "Id") return t.atom;
  return null;
}

function expandRef(term: Term, store: Store): Term | null {
  if (term.tag !== "Ref") return term;
  const a = store.hash.refToAtom.get(term.id);
  if (a === undefined) return null;
  // Preserve the Ref's backing tag so callers see Atom vs Id correctly.
  // (Ids are opaque per notes/v2-design.md — callers must not unfold them.)
  const tag = refTagOf(store.hash, term.id);
  return { tag, atom: a };
}

// `prior` over intervals: A is prior to B iff A starts strictly before B.
function isPrior(store: Store, a: { l: Term; r: Term }, b: { l: Term; r: Term }): boolean {
  return lessThan(store, a.l, b.l);
}

// Earliest tier: minimal elements of the `prior` partial order — items with
// no other item strictly prior to them.
export function selectEarliestTier(store: Store, items: Blocked[]): Blocked[] {
  return items.filter((item) =>
    !items.some((other) => other !== item && isPrior(store, other.row, item.row))
  );
}

export function collectAllBlocked(store: Store): Blocked[] {
  const out: Blocked[] = [];
  for (const a of collectBlockedDoAggs(store)) out.push({ kind: "agg", row: a });
  for (const c of collectBlockedDoAggCs(store)) out.push({ kind: "aggc", row: c });
  for (const c of collectBlockedChooses(store)) out.push({ kind: "choose", row: c });
  return out;
}

// Close one do-agg row by computing its aggregate and emitting agg-result.
// Always returns true: count/sum emit a result, `last` may legitimately have
// nothing to emit, and that case is closed with the `*agg-empty` sentinel so
// the producer stops blocking the outer loop (see SYM_AGG_EMPTY).
export function closeDoAgg(
  store: Store,
  blocked: BlockedDoAgg,
  schema: Map<string, string>,
): boolean {
  const wrapped = blocked.wrappedAtom;
  const results = aggregateOver(store, wrapped, blocked.l, blocked.r, schema);
  let any = false;
  for (const r of results) {
    if (emitAggResultRow(store, blocked, wrapped, r.rep, r.weight)) any = true;
  }
  if (!any) {
    const sym: Term = { tag: "Symbol", name: "_agg-result" };
    const atom: Atom = { terms: [sym, SYM_AGG_EMPTY, blocked.id] };
    if (addTuple(store, atom, blocked.l, blocked.r, store.tupleSource[blocked.rowIndex])) {
      addOrder(store, blocked.l, blocked.r);
      any = true;
    }
  }
  return any;
}

// Generic aggregation over candidates inside `[l, r]` matching the
// `_do-agg`-style wrapped pattern `[head, k1..kK, weight]`. Returns one
// result per group (sum/count) or one per maximal candidate per group
// (last). Each result carries the `filledTerms` for the wrapped-pattern
// positions (with free positions substituted by the representative
// candidate's actual values) plus the aggregated `weight`. Empty input:
// `last` -> []; sum/count with no free key positions -> one zero row;
// sum/count with free key positions -> [].
export interface AggregateResult {
  // Wrapped-pattern positions 0..arity-2 substituted with rep values where
  // the position contained `_free`. Length arity-1 (head + keys, no weight).
  filledTerms: Term[];
  // Aggregated weight (sum/count) or candidate weight (last).
  weight: Term;
  // Representative candidate (group's first; for `last`, the maximal
  // candidate this result corresponds to). null only for the zero-row case
  // with no free key positions and no contributions.
  rep: { terms: readonly Term[] } | null;
}

export function aggregateOver(
  store: Store,
  wrapped: Atom,
  l: Term,
  r: Term,
  schema: Map<string, string>,
): AggregateResult[] {
  const headTerm = wrapped.terms[0];
  if (headTerm === undefined || headTerm.tag !== "Symbol") return [];
  const aggName = schema.get(headTerm.name);
  if (aggName === undefined) {
    throw new Error(`weighted query '${headTerm.name}' has no schema declaration`);
  }
  const aggregator = getAggregator(aggName);

  // wrapped.terms layout: [headSym, k1, ..., kK, weight]. The reserved
  // Symbol `_free` acts as a wildcard, *recursively* — `(cell _free _free)`
  // at a top-level position means that position takes any cell value and
  // contributes the cell to the group key. A position is "free" if it
  // contains `_free` at any depth; otherwise its candidate value must match
  // the wrapped pattern by recursive token unification.
  const arity = wrapped.terms.length;
  if (arity < 2) return [];

  // Candidates: tuples with same head sym + arity, interval contains
  // [l, r], and each non-free wrapped position structurally matches the
  // candidate's term.
  type Cand = { idx: number; terms: readonly Term[] };
  const candidates: Cand[] = [];
  for (const idx of candidatesByHead(store, headTerm.name)) {
    const t = store.tuples[idx]!;
    // Stored candidates carry the universal trailing id slot; the wrapped
    // pattern doesn't (it's user-pattern + weight). Skip the id when
    // checking arity / matching positions.
    if (t.atom.terms.length !== arity + 1) continue;
    if (!intervalContains(store, t.l, t.r, l, r)) continue;
    let ok = true;
    for (let i = 0; i < arity; i++) {
      if (!matchFreePattern(wrapped.terms[i]!, t.atom.terms[i]!, store)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    candidates.push({ idx, terms: t.atom.terms });
  }

  // Group by positions whose wrapped term contains `_free` anywhere
  // (positions 1..arity-2; the weight position is excluded). Key signature
  // is a `|`-joined string of the candidate's full-position hashcons tokens.
  const keyPositions: number[] = [];
  for (let i = 1; i < arity - 1; i++) {
    if (containsFree(wrapped.terms[i]!, store)) keyPositions.push(i);
  }
  const groups = new Map<string, Cand[]>();
  for (const c of candidates) {
    const sig = keyPositions.map((p) => tokenOf(store, c.terms[p]!)).join("|");
    let bucket = groups.get(sig);
    if (bucket === undefined) { bucket = []; groups.set(sig, bucket); }
    bucket.push(c);
  }

  const out: AggregateResult[] = [];
  if (groups.size === 0) {
    // No contributions:
    //   - last: no result.
    //   - sum/count with free key positions: no groups -> no result.
    //   - sum/count with no free key positions: one zero-row result.
    if (aggName === "last") return out;
    if (keyPositions.length > 0) return out;
    out.push({ filledTerms: buildFilledTerms(wrapped, null, store), weight: aggregator.zero, rep: null });
    return out;
  }
  for (const group of groups.values()) {
    if (aggName === "last") {
      // `c` is dominated by `d` iff c started strictly before d (comparing
      // left endpoints). Right endpoints are unsuitable because `+` facts
      // extend to SYM_TOP, so c.r <= d.l is never true for persistent
      // facts even when c was emitted strictly before d.
      const maximal = group.filter((c) => {
        const ci = store.tuples[c.idx]!;
        for (const d of group) {
          if (d === c) continue;
          const di = store.tuples[d.idx]!;
          if (!comparable(store, ci.l, di.l)) continue;
          if (lessEq(store, ci.l, di.l) && !lessEq(store, di.l, ci.l)) return false;
        }
        return true;
      });
      for (const c of maximal) {
        out.push({ filledTerms: buildFilledTerms(wrapped, c, store), weight: c.terms[arity - 1]!, rep: c });
      }
      continue;
    }
    let acc = aggregator.zero;
    for (const c of group) {
      try { acc = aggregator.fold(acc, c.terms[arity - 1]!); } catch { /* skip */ }
    }
    const rep = group[0]!;
    out.push({ filledTerms: buildFilledTerms(wrapped, rep, store), weight: acc, rep });
  }
  return out;
}

// Fill the wrapped pattern's positions 0..arity-2 (head + keys, no weight):
// each free-containing position is replaced by the representative candidate's
// actual value at that index. Non-free positions are kept as-is.
function buildFilledTerms(
  wrapped: Atom,
  rep: { terms: readonly Term[] } | null,
  store: Store,
): Term[] {
  const arity = wrapped.terms.length;
  const filled: Term[] = [];
  for (let i = 0; i < arity - 1; i++) {
    const w = wrapped.terms[i]!;
    if (containsFree(w, store)) {
      if (rep === null) filled.push(w);
      else filled.push(rep.terms[i]!);
    } else {
      filled.push(w);
    }
  }
  return filled;
}

// Construct an agg-result row. Its 3rd term mirrors the wrapped pattern's
// shape: head + key positions + weight, where each free key position is
// replaced by the representative candidate's actual value at that index.
// `weight` is the aggregated value (sum/count) or candidate's weight (last).
function emitAggResultRow(
  store: Store,
  blocked: BlockedDoAgg,
  wrapped: Atom,
  rep: { terms: readonly Term[] } | null,
  weight: Term,
): boolean {
  const filledTerms = buildFilledTerms(wrapped, rep, store);
  filledTerms.push(weight);
  const inner: Term = { tag: "Atom", atom: { terms: filledTerms.map((t) => hashconsTerm(t, store.hash)) } };
  const internedInner = hashconsTerm(inner, store.hash);
  const sym: Term = { tag: "Symbol", name: "_agg-result" };
  // Copy the source _do-agg's trailing id over so the consumer Match's
  // structural unification on idTpl finds this row.
  const atom: Atom = { terms: [sym, internedInner, blocked.id] };
  const inserted = addTuple(store, atom, blocked.l, blocked.r, store.tupleSource[blocked.rowIndex]);
  if (inserted) {
    addOrder(store, blocked.l, blocked.r);
  }
  return inserted;
}

// Recursive structural match where the reserved Symbol `_free` in `pat`
// stands for any value. Both `pat` and `val` are ground (no Variables).
// Returns true iff every non-`_free` position in `pat` matches `val` by
// hashcons-token equality, descending through Atom-tagged Refs / literal
// Atoms. `Id`-tagged terms are opaque per notes/v2-design.md — they're
// compared by token only.
function matchFreePattern(pat: Term, val: Term, store: Store): boolean {
  if (pat.tag === "Symbol" && pat.name === "_free") return true;
  if (tokenOf(store, pat) === tokenOf(store, val)) return true;
  const pTerms = atomChildren(pat, store);
  const vTerms = atomChildren(val, store);
  if (pTerms === null || vTerms === null) return false;
  if (pTerms.length !== vTerms.length) return false;
  for (let i = 0; i < pTerms.length; i++) {
    if (!matchFreePattern(pTerms[i]!, vTerms[i]!, store)) return false;
  }
  return true;
}

// True iff `t` contains the reserved Symbol `_free` at any depth, walking
// only through Atom-tagged compound structure (Id terms are opaque).
function containsFree(t: Term, store: Store): boolean {
  if (t.tag === "Symbol") return t.name === "_free";
  const children = atomChildren(t, store);
  if (children === null) return false;
  for (const c of children) if (containsFree(c, store)) return true;
  return false;
}

// Children of an Atom-tagged compound, or null for non-compound / Id terms.
function atomChildren(term: Term, store: Store): readonly Term[] | null {
  if (term.tag === "Atom") return term.atom.terms;
  if (term.tag === "Ref") {
    if (refTagOf(store.hash, term.id) !== "Atom") return null;
    const a = store.hash.refToAtom.get(term.id);
    return a ? a.terms : null;
  }
  return null;
}

// ----- Reactive aggregates (eager breakpoint materialization) -----
//
// See plans/v2-reactive-aggregates.md. A `#reactive` relation's value is
// materialized into `_aggval head key... value` rows at the breakpoints where
// its step function can change. Breakpoints are the join-closure of its source
// tuples' left endpoints; the value at each is the ordinary `aggregateOver`
// fold evaluated at the point `[bp, bp]`. The outer loop finalizes earliest
// breakpoints first (non-monotone aggregation must be stratified by moment).

// Join-closure of a moment set under pairwise least-upper-bound. Every join
// exists as a moment by the subdivision-lattice property
// (notes/moment-insertion.md); a `null` lub means that invariant is broken.
function joinClosure(store: Store, moments: Term[]): Term[] {
  const byTok = new Map<number, Term>();
  for (const m of moments) byTok.set(tokenOf(store, m), m);
  let frontier = [...byTok.values()];
  let guard = 0;
  while (frontier.length > 0) {
    const next: Term[] = [];
    const all = [...byTok.values()];
    for (const a of frontier) {
      for (const b of all) {
        if (++guard > 100000) return [...byTok.values()]; // runaway backstop
        const lub = leastUpperBound(store, [a, b]);
        if (lub === null) {
          throw new Error(
            "v2 reactive: least upper bound of two moments does not exist " +
            "(moment order is not a lattice — see notes/moment-insertion.md)",
          );
        }
        const tk = tokenOf(store, lub);
        if (!byTok.has(tk)) { byTok.set(tk, lub); next.push(lub); }
      }
    }
    frontier = next;
  }
  return [...byTok.values()];
}

// Fold a reactive relation's contributors at the point `[bp, bp]` for a single
// group (the `key` column values bound), returning that group's aggregate
// result(s) — at most one for `sum`/`count`/`last` (more only if a `last` group
// has incomparable maximal contributors). Binding the key restricts the fold to
// one group, so a sibling group's breakpoint never re-stamps this one
// (plans/v2-per-group-breakpoints.md). Shared by the pending-residual check and
// `finalizeReactive` so the two never disagree on what a breakpoint's value is.
function foldGroupAt(
  store: Store,
  head: Term,
  key: Term[],
  bp: Term,
  schema: Map<string, string>,
): AggregateResult[] {
  if (head.tag !== "Symbol") return [];
  // Wrapped pattern `[head, key..., _free]`: the key columns are bound to this
  // group's values and the trailing weight slot is `_free` (folded). With every
  // key position bound, `aggregateOver` groups by nothing → just this group.
  const wrappedTerms: Term[] = [head, ...key, SYM_FREE];
  return aggregateOver(store, { terms: wrappedTerms }, bp, bp, schema);
}

// The key column values of a reactive source tuple: layout is
// `[head, key..., weight, id]`, so the keys are positions `1 .. arity-2` where
// `arity = terms.length - 1` (drop the trailing id; the weight sits at arity-1).
function groupKeyOf(store: Store, tupleIdx: number): Term[] {
  const terms = store.tuples[tupleIdx]!.atom.terms;
  const arity = terms.length - 1;
  return terms.slice(1, arity - 1);
}

// Pending reactive breakpoints across all `#reactive` relations. Materialization
// is **per group** (plans/v2-per-group-breakpoints.md): each group's value is a
// step function over *its own* contributors, so its breakpoints are the
// join-closure of that group's source-tuple lefts — not the relation-wide pool.
// Folding a sibling group at a breakpoint it didn't generate only re-stamps an
// unchanged value, so we partition the sources by group key first and enumerate
// each group's breakpoints independently.
//
// A breakpoint is listed only when its fold has a **residual** — a group/value
// the `_aggval` rows don't yet materialize. Residual, not mere `(relation, bp)`
// existence: a recursive aggregate (its own contributors derived from reads of
// its `_aggval`) lands all at one moment and must re-finalize as new groups
// appear. A coarse "already touched this breakpoint" skip stops it after the
// first round — see the single-moment stratification section of
// plans/v2-reactive-aggregates.md. Re-listing is safe because `emitAggValRow`
// dedups on a deterministic Id.
export function collectReactiveFinalizations(
  store: Store,
  reactive: Set<string>,
  schema: Map<string, string>,
): Blocked[] {
  if (reactive.size === 0) return [];
  // Signatures of already-materialized `_aggval` rows: `${leftTok}#${content}`,
  // content = tokens of `[head, key..., value]` (drop the `_aggval` head sym and
  // the trailing id). A folded result matching one of these is not residual.
  const have = new Set<string>();
  for (const idx of candidatesByHead(store, "_aggval")) {
    const t = store.tuples[idx]!;
    const content = t.atom.terms.slice(1, -1).map((x) => tokenOf(store, x)).join("|");
    have.add(`${tokenOf(store, t.l)}#${content}`);
  }
  const out: Blocked[] = [];
  for (const foo of reactive) {
    const cands = candidatesByHead(store, foo);
    if (cands.length === 0) continue;
    const fooTerm: Term = { tag: "Symbol", name: foo };
    // Partition source tuples by group key; each group keeps its own lefts.
    const groups = new Map<string, { key: Term[]; lefts: Term[] }>();
    for (const idx of cands) {
      const key = groupKeyOf(store, idx);
      const sig = key.map((x) => tokenOf(store, x)).join("|");
      let g = groups.get(sig);
      if (g === undefined) { g = { key, lefts: [] }; groups.set(sig, g); }
      g.lefts.push(store.tuples[idx]!.l);
    }
    for (const g of groups.values()) {
      // Breakpoints of THIS group only: the join-closure of its own lefts.
      for (const bp of joinClosure(store, g.lefts)) {
        const bpTok = tokenOf(store, bp);
        let pending = false;
        for (const res of foldGroupAt(store, fooTerm, g.key, bp, schema)) {
          // Hashcons before tokenizing: a folded value (e.g. a `count` Peano
          // numeral) is a raw nested Atom; `emitAggValRow` hashconses the same
          // terms, so the signatures line up with the materialized `have` set.
          const content = [...res.filledTerms, res.weight]
            .map((x) => tokenOf(store, hashconsTerm(x, store.hash)))
            .join("|");
          if (!have.has(`${bpTok}#${content}`)) { pending = true; break; }
        }
        if (pending) {
          out.push({ kind: "reactive", row: { foo: fooTerm, key: g.key, bp, l: bp, r: SYM_TOP } });
        }
      }
    }
  }
  return out;
}

// Materialize one reactive group's value at one breakpoint: fold that group at
// `[bp, bp]` and emit its `_aggval` row. Returns true iff a new row was added.
//
// Soundness relies on earliest-first scheduling: when this group's `bp` is
// finalized, no already-materialized breakpoint of the same group dominates a
// not-yet-incorporated contributor (else its stored value would be stale). The
// outer loop's globally-earliest-first selection guarantees this; see
// plans/v2-per-group-breakpoints.md.
export function finalizeReactive(
  store: Store,
  item: ReactiveFinalization,
  schema: Map<string, string>,
): boolean {
  let any = false;
  for (const res of foldGroupAt(store, item.foo, item.key, item.bp, schema)) {
    if (emitAggValRow(store, res.filledTerms, res.weight, item.bp)) any = true;
  }
  return any;
}

// Static aggregate dependency strata over the `#reactive` relations, computed
// from the TIME-MARKED dependency graph (plans/v2-stratification-analysis.md).
//
// For each rule, link every READ head (a `match`/`aggregate` body atom) to every
// PRODUCED head, marking the edge by how the produce places its moment relative
// to the anchor:
//   - `^h`   (anchor):           no fresh moment, `h` at the anchor   -> `=`
//   - `+h`/`~h`/`?h` (fact/episode/ask): fresh, strictly-later moment -> `<`
// A consumer depends on a producer AT ONE MOMENT iff there is an all-`=` path
// between them; any `<` edge means the producer is at a strictly earlier moment,
// which the moment-primary scheduler already orders (no stratum needed). So the
// stratum graph keeps `=` edges ONLY — `<` producers are dropped here.
//
// Edges span ALL relations (not just reactive), so an all-`=` dependency can
// chain through intermediate plain relations: `A -> …, ^c …` then `c …, ^B -> …`
// gives `A =→ c =→ B`. SCCs of the reactive `=`-subgraph are the strata; the
// returned map gives each reactive relation a stratum index strictly greater
// than every relation it `=`-depends on (one SCC — incl. a same-moment self-loop
// like transitive closure `p =→ p` — shares an index). The outer loop finalizes
// the lowest stratum present at a moment first, so a consumer aggregate is never
// folded against a not-yet-settled same-moment source.
//
// NOTE: the `=` mark is a heuristic over-approximation — `^h` is marked `=`
// against every read though it only truly coincides with the anchor (latest)
// read (open question 2 of the plan). It is sound (only ever adds within-moment
// ordering) but may over-serialize, or treat a time-stratified loop as an
// all-`=` cycle.
export function computeAggStrata(rules: Rule[], reactive: Set<string>): Map<string, number> {
  const READ = new Set<string>(["match", "aggregate"]);
  // `=` producers only: `anchor` (`^`) emits at the anchor, the same moment as
  // its reads. `fact`/`episode`/`ask` (`+`/`~`/`?`) mint a fresh, strictly-later
  // moment (`<`) and are intentionally NOT edges in the stratum graph — the
  // moment order handles those dependencies.
  const EQ_PRODUCE = new Set<string>(["anchor"]);
  // General `=`-edge graph: read-head =→ produce-head, over ALL relations.
  const gsucc = new Map<string, Set<string>>();
  const addEdge = (r: string, h: string): void => {
    let s = gsucc.get(r);
    if (s === undefined) { s = new Set(); gsucc.set(r, s); }
    s.add(h);
  };
  const collect = (atoms: RuleAtom[], reads: string[], produces: string[]): void => {
    for (const a of atoms) {
      if (a.tag === "Sub") { collect(a.body, reads, produces); continue; }
      if (a.tag === "AggComp") {
        // Every atom head inside a bracket aggregation is a read.
        collectAggCompReads(a.body, reads);
        continue;
      }
      if (a.tag !== "Atom") continue;
      const head = a.atom.terms[0];
      if (head === undefined || head.tag !== "Symbol") continue;
      if (READ.has(a.marker)) reads.push(head.name);
      else if (EQ_PRODUCE.has(a.marker)) produces.push(head.name);
    }
  };
  for (const rule of rules) {
    const reads: string[] = [];
    const produces: string[] = [];
    collect(rule.body, reads, produces);
    for (const r of reads) for (const h of produces) addEdge(r, h);
  }

  function collectAggCompReads(body: RuleAtom[], reads: string[]): void {
    for (const b of body) {
      if (b.tag === "AggComp") { collectAggCompReads(b.body, reads); continue; }
      if (b.tag !== "Atom") continue;
      const head = b.atom.terms[0];
      if (head !== undefined && head.tag === "Symbol") reads.push(head.name);
    }
  }
  // Transitive reachability over the general graph.
  const allNodes = new Set<string>(reactive);
  for (const [r, hs] of gsucc) { allNodes.add(r); for (const h of hs) allNodes.add(h); }
  const greach = new Map<string, Set<string>>();
  for (const n of allNodes) greach.set(n, new Set(gsucc.get(n) ?? []));
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of allNodes) {
      const rn = greach.get(n)!;
      for (const m of [...rn]) {
        for (const w of gsucc.get(m) ?? []) {
          if (!rn.has(w)) { rn.add(w); changed = true; }
        }
      }
    }
  }
  // Reactive subgraph from general reachability: `succ` (excl. self) feeds the
  // level computation, `reaches` (incl. self) feeds the SCC test.
  const nodes = [...reactive];
  const succ = new Map<string, Set<string>>();
  const reaches = new Map<string, Set<string>>();
  for (const A of nodes) {
    const ga = greach.get(A) ?? new Set<string>();
    const s = new Set<string>();
    const rset = new Set<string>([A]);
    for (const B of nodes) {
      if (!ga.has(B)) continue;
      rset.add(B);
      if (B !== A) s.add(B);
    }
    succ.set(A, s);
    reaches.set(A, rset);
  }
  // SCC id by mutual reachability.
  const sccId = new Map<string, number>();
  let nextScc = 0;
  for (const n of nodes) {
    if (sccId.has(n)) continue;
    const id = nextScc++;
    sccId.set(n, id);
    for (const m of nodes) {
      if (sccId.has(m)) continue;
      if (reaches.get(n)!.has(m) && reaches.get(m)!.has(n)) sccId.set(m, id);
    }
  }
  // Longest-path level over the condensation DAG (A→B ⇒ level(B) > level(A)).
  const level = new Map<number, number>();
  for (let i = 0; i < nextScc; i++) level.set(i, 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of nodes) {
      const su = sccId.get(u)!;
      for (const v of succ.get(u) ?? []) {
        const sv = sccId.get(v)!;
        if (su === sv) continue;
        if (level.get(sv)! < level.get(su)! + 1) { level.set(sv, level.get(su)! + 1); changed = true; }
      }
    }
  }
  const strata = new Map<string, number>();
  for (const n of nodes) strata.set(n, level.get(sccId.get(n)!)!);
  return strata;
}

// Emit `_aggval head key... value <id>` at `[bp, top]`. The id is a
// deterministic Id over the row contents + breakpoint so re-finalizing the
// same breakpoint dedups. `filledTerms` is `[head, key...]` from
// `aggregateOver`.
function emitAggValRow(
  store: Store,
  filledTerms: Term[],
  weight: Term,
  bp: Term,
): boolean {
  const userTerms = [SYM_AGGVAL, ...filledTerms, weight].map((t) => hashconsTerm(t, store.hash));
  const idInner: Term = {
    tag: "Id",
    atom: { terms: [SYM_AGGVAL_ID, ...filledTerms, weight, bp].map((t) => hashconsTerm(t, store.hash)) },
  };
  const id = hashconsTerm(idInner, store.hash);
  const atom: Atom = { terms: [...userTerms, id] };
  // [bp, top]: the `bp < top` edge is implicit, so no addOrder needed.
  return addTuple(store, atom, bp, SYM_TOP);
}
