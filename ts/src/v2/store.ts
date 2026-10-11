// v2 store: interval-bearing tuples + an output sink + the moment-order
// relation. All Term values pass through hashcons so identity comparison
// is just integer equality on Ref ids.

// Moment-order strategy. "old" preserves the lazy DFS + ltPos/ltNeg memo
// path; eager bookkeeping is fully inert in this mode. "eager" maintains
// the full forward closure `gt[a] = { b | a < b }` plus a thin back-edge
// map `orderBwd` used only at insert time to enumerate ancestors.
// `const` so V8 can dead-code-eliminate the unused branch.
export const ORDER_STRATEGY: "old" | "eager" = "old";

import type { Atom, Span, Term } from "./term.js";
import type { Tuple } from "./types.js";
import {
  createHashcons,
  hashconsAtom,
  hashconsTerm,
  tokenOfId,
  type HashconsState,
} from "./hashcons.js";
import { createTracker, getOrCreateHead, type StatsTracker } from "./stats.js";

export interface Store {
  hash: HashconsState;
  // Moment-lattice mode (`createStore({ lattice: true })`; see the "Moment
  // lattice" section below). Off by default: `max` / `min` of incomparable
  // moments fail relationally (the original semantics). On: they build a
  // `(*max ...)` / `(*min ...)` lattice-node moment instead.
  lattice: boolean;
  // Lattice-node moments by token: the node's kind and its element tokens
  // (an antichain, sorted by token). Empty unless `lattice`.
  latticeNodes: Map<number, LatticeNode>;
  // Memo for `latticeLe` (lattice mode only), same contract as
  // `ltPos` / `ltNeg`: positives are permanent, negatives are cleared on
  // every edge insert.
  lePos: Map<number, Set<number>>;
  leNeg: Map<number, Set<number>>;
  tuples: Tuple[];
  // Parallel to `tuples`: span of the source RuleAtom that emitted each
  // tuple. `undefined` for tuples whose origin has no span (e.g. test
  // fixtures that call `addTuple` directly). Used by the editor for
  // source ↔ output highlight linking. Exception default-rule re-emits are
  // re-attributed to the original assertion's span post-fixpoint by
  // `resolveExceptionProvenance` (fixpoint.ts).
  tupleSource: (Span | undefined)[];
  // head-sym name -> tuple indices in `tuples` whose first term is that sym
  byHead: Map<string, number[]>;
  // head-sym name -> left-endpoint token -> tuple indices: the same buckets
  // split by start moment, so a match whose left endpoint is already bound
  // (every acc point read, `[l, l]`) visits only the rows at that moment
  // instead of every row the relation has had at every moment.
  byHeadL: Map<string, Map<number, number[]>>;
  // Forward adjacency on the moment-order relation. Keyed and valued by
  // hashcons token (NodeId from tokenOfId). Closure is computed lazily by
  // BFS in `lessThan`.
  orderFwd: Map<number, Set<number>>;
  bot: Term;
  top: Term;
  botTok: number;
  topTok: number;
  // Token → Term recovery for moments — populated by addOrder, addTuple
  // (endpoints), and createStore (bot/top). Used by leastUpperBound to
  // return a Term when the LUB is a moment not in the input set.
  momentTerms: Map<number, Term>;
  // Dedup set for moment-order edges already asserted, keyed as
  // `${ltTok},${gtTok}`. Avoids re-walking the closure during inserts.
  edgeSet: Set<string>;
  // Memoization for `lessThanTok`. `ltPos` records pairs known to satisfy
  // a < b — monotone w.r.t. edge inserts, never invalidated. `ltNeg` records
  // pairs known to be false at the time they were computed; cleared on every
  // `addOrder` since a new edge can flip a previous `false` to `true`.
  ltPos: Map<number, Set<number>>;
  ltNeg: Map<number, Set<number>>;
  // Creation sequence number of each moment token (the order in which
  // `momentTerms` first saw it), and, per token `a`, the sequence number at
  // which `ltPos[a]` was last made complete by an exhaustive DFS. By the
  // creation-time ordering invariant (see `addOrder`) the order between two
  // existing moments never changes, so a complete closure answers every
  // query about a moment that existed when it was computed.
  momentSeq: Map<number, number>;
  ltClosedAt: Map<number, number>;
  // Eager-strategy state. Populated only when ORDER_STRATEGY === "eager".
  // `gt[a]` is the full forward closure { b | a < b }.
  gt: Map<number, Set<number>>;
  // Immediate predecessors of each moment over asserted edges (not the
  // closure): `orderBwd[b] = { a | addOrder(a, b) }`. Maintained under both
  // strategies. The eager branch back-walks ancestors with it; the moment
  // walk (moment-walk.ts) computes its frontier from it. Bot/top edges are
  // implicit and never recorded — `bot` is a predecessor of everything.
  orderBwd: Map<number, Set<number>>;
  // Moments the moment walk has resolved (plans/v2-moment-walk.md): the
  // non-monotone part has run to completion at each of them. Kept as a
  // down-set of the moment order — a moment is marked only once everything
  // strictly below it is marked. In-memory only: every run starts from a
  // fresh store.
  resolved: Set<number>;
  // Moments whose `settle` hooks have run (moment-walk.ts `settleMoments`):
  // the walk was quiet there, and the acc snapshot at the moment is fixed
  // (`accWatermark`; its rows are written then or on demand). A superset of
  // `resolved` — a moment with a pending choice is settled but not
  // resolved.
  settled: Set<number>;
  // `#acc` display bookkeeping (plans/v2-acc-timeline-display.md); never
  // consulted by evaluation. `accRelations` names every declared acc
  // relation and says whether some ordinary rule reads it (static; set by
  // `runFixpoint`). `accConsulted` records, per relation, the moment tokens
  // at which an ordinary rule's point read was attempted — whether or not
  // a row matched (`evalMatch`).
  accRelations: Map<string, { readByRules: boolean }>;
  accConsulted: Map<string, Set<number>>;
  // Demand-driven `#acc` evaluation (acc.ts `accHandler`). Acc rows at a
  // moment are computed only where something reads them. `accDemand` holds
  // every moment token at which acc rows were asked for — an ordinary rule's
  // point read of an acc relation, a `not` read's `_acc-at` read (both in
  // `evalMatch`), or a `_constrain` row's moment when some `!(...)` reads an
  // acc relation (the handler). `accPending` is `accDemand` minus
  // `accComputed` (the moments whose rows have been written). Use
  // `demandAcc` to add demand. `accWatermark` maps each settled moment to
  // `tuples.length` at its settle: the rows at `m` are a pure function of
  // the tuples with index below it (the store is append-only, and by the
  // creation-time ordering invariant — `addOrder` — whether an old tuple is
  // alive at `m` never changes), so they can be computed at any later time
  // and equal the settle-time snapshot.
  accDemand: Set<number>;
  accPending: Set<number>;
  accComputed: Set<number>;
  accWatermark: Map<number, number>;
  // Dedup set for tuples, keyed as `${atomTok},${lTok},${rTok}`.
  tupleSet: Set<string>;
  // Hard cap on inserted tuples. When exceeded, `addTuple` throws GasError;
  // `runFixpoint` catches it and surfaces a `gas` status. 0 disables the
  // check (initial value; runFixpoint sets a real budget).
  tupleGas: number;
  // Semi-naive evaluation: monotone round counter, bumped by the fixpoint
  // loop. Tuples carry the round they were inserted in (`gens`), so the
  // match candidate filter can split candidates into old/delta/any buckets.
  // Starts at 1 so that round-1 inserts get `gen === 1` and the inner-loop
  // delta filter (`gen === iteration - 1`) becomes nontrivial only from
  // round 2 onward — exactly the v1 contract.
  iteration: number;
  // Parallel to `tuples`: insertion-round of each tuple.
  gens: number[];
  // Diagnostic: number of `addTuple` calls rejected because the tuple was
  // already in `tupleSet`. With strict semi-naive (gen-strict any/old)
  // this would be 0; with our loose `any`, within-sweep cascades can
  // produce a tuple via the "any" path in round K and again via the
  // "delta" path in round K+1, so it's expected to be nonzero.
  tupleDupes: number;
  // Empty-delta short-circuit. `currHeads` accumulates head symbols of
  // tuples inserted during the *current* round; `prevHeads` is the
  // snapshot from the previous round. `innerLoop` swaps them when it
  // bumps `iteration`. A variant whose delta atom's head is not in
  // `prevHeads` can be skipped wholesale — there can be no delta-bucket
  // candidate for it this round.
  prevHeads: Set<string>;
  currHeads: Set<string>;
  // Diagnostic counters. Always present; counters are unconditional integer
  // adds (cheap). Only `wallMs` and report formatting consult `enabled`.
  // See plans/v2-stats-tracker.md.
  stats: StatsTracker;
}

export interface LatticeNode {
  kind: "max" | "min";
  elems: number[];
}

export interface StoreOptions {
  // Moment-lattice semantics for `max` / `min` (see `latticeMax`).
  lattice?: boolean;
}

// Sentinel thrown by `addTuple` when `tupleGas` is exhausted. Caught by
// `runFixpoint` so deeply nested CPS evaluator state can unwind cleanly.
export class GasError extends Error {
  constructor() { super("v2: tupleGas exhausted"); }
}

export function createStore(opts: StoreOptions = {}): Store {
  if (opts.lattice && ORDER_STRATEGY !== "old") {
    throw new Error("v2: lattice mode requires ORDER_STRATEGY 'old'");
  }
  const hash = createHashcons();
  const bot = hashconsTerm({ tag: "Symbol", name: "bot" }, hash);
  const top = hashconsTerm({ tag: "Symbol", name: "top" }, hash);
  const botTok = tokenOfId(bot, hash);
  const topTok = tokenOfId(top, hash);
  const momentTerms = new Map<number, Term>([[botTok, bot], [topTok, top]]);
  return {
    hash,
    lattice: opts.lattice ?? false,
    latticeNodes: new Map(),
    lePos: new Map(),
    leNeg: new Map(),
    tuples: [],
    tupleSource: [],
    byHead: new Map(),
    byHeadL: new Map(),
    orderFwd: new Map(),
    bot,
    top,
    botTok,
    topTok,
    momentTerms,
    edgeSet: new Set(),
    ltPos: new Map(),
    ltNeg: new Map(),
    momentSeq: new Map(),
    ltClosedAt: new Map(),
    gt: new Map(),
    orderBwd: new Map(),
    resolved: new Set(),
    settled: new Set(),
    accRelations: new Map(),
    accConsulted: new Map(),
    accDemand: new Set(),
    accPending: new Set(),
    accComputed: new Set(),
    accWatermark: new Map(),
    tupleSet: new Set(),
    tupleGas: 0,
    iteration: 1,
    gens: [],
    tupleDupes: 0,
    prevHeads: new Set(),
    currHeads: new Set(),
    stats: createTracker(false),
  };
}

export function intern(store: Store, term: Term): Term {
  return hashconsTerm(term, store.hash);
}

export function internAtom(store: Store, atom: Atom): Atom {
  return hashconsAtom(atom, store.hash);
}

export function tokenOf(store: Store, term: Term): number {
  return tokenOfId(term, store.hash);
}

// Add a tuple. Returns true iff the tuple was new. Assumes endpoints are
// already interned; the atom's `terms` may be a mix of Refs and atomic Terms
// (Symbol/Variable/Wildcard) — we re-hashcons to obtain a stable id.
export function addTuple(
  store: Store,
  atom: Atom,
  l: Term,
  r: Term,
  span?: Span,
  sourceRuleIdx?: number,
): boolean {
  const atomRef = hashconsTerm({ tag: "Atom", atom }, store.hash);
  const atomTok = tokenOfId(atomRef, store.hash);
  const lTok = tokenOf(store, l);
  const rTok = tokenOf(store, r);
  if (!store.momentTerms.has(lTok)) { store.momentTerms.set(lTok, l); store.momentSeq.set(lTok, store.momentSeq.size); }
  if (!store.momentTerms.has(rTok)) { store.momentTerms.set(rTok, r); store.momentSeq.set(rTok, store.momentSeq.size); }
  const key = `${atomTok},${lTok},${rTok}`;
  if (store.tupleSet.has(key)) {
    store.tupleDupes++;
    if (sourceRuleIdx !== undefined && sourceRuleIdx >= 0) {
      const rs = store.stats.rules[sourceRuleIdx];
      if (rs !== undefined) rs.tuplesDeduped++;
    }
    return false;
  }
  if (store.tupleGas > 0 && store.tuples.length >= store.tupleGas) {
    throw new GasError();
  }
  store.tupleSet.add(key);
  const t: Tuple = { atom, l, r };
  const idx = store.tuples.length;
  store.tuples.push(t);
  store.tupleSource.push(span);
  store.gens.push(store.iteration);
  const head = atom.terms[0];
  if (head !== undefined && head.tag === "Symbol") {
    let bucket = store.byHead.get(head.name);
    if (bucket === undefined) {
      bucket = [];
      store.byHead.set(head.name, bucket);
    }
    bucket.push(idx);
    let byL = store.byHeadL.get(head.name);
    if (byL === undefined) { byL = new Map(); store.byHeadL.set(head.name, byL); }
    const lBucket = byL.get(lTok);
    if (lBucket === undefined) byL.set(lTok, [idx]);
    else lBucket.push(idx);
    store.currHeads.add(head.name);
    const hs = getOrCreateHead(store.stats, head.name);
    hs.bucketSize = bucket.length;
    if (bucket.length > hs.peakBucketSize) hs.peakBucketSize = bucket.length;
  }
  if (sourceRuleIdx !== undefined && sourceRuleIdx >= 0) {
    const rs = store.stats.rules[sourceRuleIdx];
    if (rs !== undefined) rs.tuplesEmitted++;
  }
  return true;
}

// Assert lt < gt. No-op if already known. Bot/top edges are implicit and
// not stored.
//
// Creation-time ordering invariant: the evaluator only ever asserts order
// edges that involve a moment *as it is created* — an emit places its fresh
// `l` / `r` inside the current window (`XL < l < r < XR`), and that window is
// already known to be non-empty (`XL ≤ XR`, checked by the match `Le`s). So
// an edge never orders two pre-existing moments that were not already
// ordered: once both of two moments exist, whether they are comparable is
// fixed for the rest of the run. (The scheduler / comp-aggregate
// `addOrder(blocked.l, blocked.r)` calls are always already implied or
// bot/top no-ops.) Lattice mode depends on this — it is what makes collapsing
// `max(a, b)` to `b` when `a ≤ b` deterministic, and lets a lattice node be
// wired to its covers once, at creation. Not enforced here.
export function addOrder(store: Store, lt: Term, gt: Term): void {
  const ltTok = tokenOf(store, lt);
  const gtTok = tokenOf(store, gt);
  if (!store.momentTerms.has(ltTok)) { store.momentTerms.set(ltTok, lt); store.momentSeq.set(ltTok, store.momentSeq.size); }
  if (!store.momentTerms.has(gtTok)) { store.momentTerms.set(gtTok, gt); store.momentSeq.set(gtTok, store.momentSeq.size); }
  if (ltTok === gtTok) return;
  if (ltTok === store.botTok || gtTok === store.topTok) return;
  if (ORDER_STRATEGY === "old") {
    const key = `${ltTok},${gtTok}`;
    if (store.edgeSet.has(key)) return;
    store.edgeSet.add(key);
    // A new edge can convert previously-false reachability into true; ltPos
    // remains valid (monotone), but ltNeg must be discarded.
    store.ltNeg.clear();
    store.leNeg.clear();
    let succs = store.orderFwd.get(ltTok);
    if (succs === undefined) {
      succs = new Set();
      store.orderFwd.set(ltTok, succs);
    }
    succs.add(gtTok);
    let preds = store.orderBwd.get(gtTok);
    if (preds === undefined) { preds = new Set(); store.orderBwd.set(gtTok, preds); }
    preds.add(ltTok);
    return;
  }
  // Eager: maintain `gt` as full forward closure.
  // 1. Already implied → no-op.
  const gtLt = store.gt.get(ltTok);
  if (gtLt !== undefined && gtLt.has(gtTok)) return;
  // 2. Reverse edge already implied → cycle.
  const gtGt = store.gt.get(gtTok);
  if (gtGt !== undefined && gtGt.has(ltTok)) {
    throw new Error("v2: moment-order cycle");
  }
  // 3. Enumerate ancestors of ltTok (including ltTok itself) via back-DFS
  //    over orderBwd. Each ancestor x gains the new descendants B = gt[gt] ∪ {gt}.
  const ancestors = collectAncestors(store, ltTok);
  const newDescendants: number[] = [gtTok];
  if (gtGt !== undefined) for (const t of gtGt) newDescendants.push(t);
  for (const x of ancestors) {
    let row = store.gt.get(x);
    if (row === undefined) { row = new Set(); store.gt.set(x, row); }
    for (const d of newDescendants) row.add(d);
  }
  // 4. Record the immediate back-edge for future ancestor walks.
  let preds = store.orderBwd.get(gtTok);
  if (preds === undefined) { preds = new Set(); store.orderBwd.set(gtTok, preds); }
  preds.add(ltTok);
}

// Back-DFS over `orderBwd` returning { node | node ≤ start } as token list.
// Includes `start` itself. Eager strategy only.
function collectAncestors(store: Store, start: number): number[] {
  const out: number[] = [start];
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const preds = store.orderBwd.get(cur);
    if (preds === undefined) continue;
    for (const p of preds) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      stack.push(p);
    }
  }
  return out;
}

// Strict less-than over the moment-order relation, with bot/top sentinels
// universally below/above every other moment.
export function lessThan(store: Store, a: Term, b: Term): boolean {
  const aTok = tokenOf(store, a);
  const bTok = tokenOf(store, b);
  return lessThanTok(store, aTok, bTok);
}

function lessThanTok(store: Store, aTok: number, bTok: number): boolean {
  if (aTok === bTok) return false;
  if (store.lattice) return latticeLe(store, aTok, bTok) && !latticeLe(store, bTok, aTok);
  if (aTok === store.topTok) return false;
  if (bTok === store.botTok) return false;
  if (aTok === store.botTok) return true;
  if (bTok === store.topTok) return true;
  if (ORDER_STRATEGY === "eager") {
    return store.gt.get(aTok)?.has(bTok) ?? false;
  }
  const pos = store.ltPos.get(aTok);
  if (pos !== undefined && pos.has(bTok)) return true;
  const neg = store.ltNeg.get(aTok);
  if (neg !== undefined && neg.has(bTok)) return false;
  // A complete closure of aTok computed after bTok existed decides the query.
  const closedAt = store.ltClosedAt.get(aTok);
  if (closedAt !== undefined) {
    const bSeq = store.momentSeq.get(bTok);
    if (bSeq !== undefined && bSeq < closedAt) return false;
  }
  // DFS closure search. Every node we reach from aTok satisfies aTok < node,
  // so cache it as we go — even on early-return for the queried bTok the
  // partial walk leaves useful positive facts behind for future queries.
  let posCache = store.ltPos.get(aTok);
  if (posCache === undefined) { posCache = new Set(); store.ltPos.set(aTok, posCache); }
  const stack = [aTok];
  const seen = new Set<number>([aTok]);
  // Exhaustive (no early exit): the visited set becomes aTok's complete
  // closure, which answers all later queries from aTok in O(1).
  let found = false;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const succs = store.orderFwd.get(cur);
    if (succs === undefined) continue;
    for (const s of succs) {
      if (seen.has(s)) continue;
      seen.add(s);
      posCache.add(s);
      if (s === bTok) found = true;
      stack.push(s);
    }
  }
  store.ltClosedAt.set(aTok, store.momentSeq.size);
  if (found) return true;
  let negCache = store.ltNeg.get(aTok);
  if (negCache === undefined) { negCache = new Set(); store.ltNeg.set(aTok, negCache); }
  negCache.add(bTok);
  return false;
}

export function lessEq(store: Store, a: Term, b: Term): boolean {
  const aTok = tokenOf(store, a);
  const bTok = tokenOf(store, b);
  if (aTok === bTok) return true;
  return lessThanTok(store, aTok, bTok);
}

// Comparable: a < b, b < a, or a == b derivable.
export function comparable(store: Store, a: Term, b: Term): boolean {
  const aTok = tokenOf(store, a);
  const bTok = tokenOf(store, b);
  if (aTok === bTok) return true;
  return lessThanTok(store, aTok, bTok) || lessThanTok(store, bTok, aTok);
}

// Overlap match per spec: (l1, r1) overlaps (l2, r2) iff l1 <= r2 && l2 <= r1
// AND the endpoint pairs are each comparable.
export function intervalsOverlap(
  store: Store,
  l1: Term, r1: Term,
  l2: Term, r2: Term,
): boolean {
  if (!comparable(store, l1, l2)) return false;
  if (!comparable(store, r1, r2)) return false;
  if (!lessEq(store, l1, r2)) return false;
  if (!lessEq(store, l2, r1)) return false;
  return true;
}

// Aggregation containment: outer contains inner iff
// outer_l <= inner_l && inner_r <= outer_r, with comparability required.
export function intervalContains(
  store: Store,
  outerL: Term, outerR: Term,
  innerL: Term, innerR: Term,
): boolean {
  if (!comparable(store, outerL, innerL)) return false;
  if (!comparable(store, outerR, innerR)) return false;
  if (!lessEq(store, outerL, innerL)) return false;
  if (!lessEq(store, innerR, outerR)) return false;
  return true;
}

// Record that acc rows at the moment `tok` are read (store.ts `accDemand`).
// A moment already computed needs nothing more; otherwise it is pending
// until the acc handler computes it (at settle, or later from the
// watermark).
export function demandAcc(store: Store, tok: number): void {
  if (store.accDemand.has(tok)) return;
  store.accDemand.add(tok);
  if (!store.accComputed.has(tok)) store.accPending.add(tok);
}

// Tuple candidates whose first term is the given symbol. Returned by index
// in `tuples` so callers can iterate without copying.
export function candidatesByHead(store: Store, head: string): readonly number[] {
  return store.byHead.get(head) ?? [];
}

const NO_CANDIDATES: readonly number[] = [];

// Candidates with the given head whose left endpoint is the moment `l`, when
// `l` is ground (a Ref or Symbol); otherwise every candidate with the head.
// A ground endpoint unifies only with a token-equal stored endpoint, so the
// narrowing never drops a tuple `candidatesByHead` would have matched.
export function candidatesByHeadAt(store: Store, head: string, l: Term): readonly number[] {
  if (l.tag !== "Ref" && l.tag !== "Symbol") return candidatesByHead(store, head);
  return store.byHeadL.get(head)?.get(tokenOf(store, l)) ?? NO_CANDIDATES;
}

// Least upper bound (join) of a finite set of moments under the moment-
// order partial order. Empty input returns `bot` (the join of {}).
// Singleton returns its element. Otherwise folds `lubPair`; returns null
// if any intermediate step has no unique minimum (≥2 incomparable minimal
// upper bounds). See plans/v2-moment-lub.md.
export function leastUpperBound(store: Store, moments: Term[]): Term | null {
  if (moments.length === 0) return store.bot;
  let acc = moments[0]!;
  for (let i = 1; i < moments.length; i++) {
    const next = lubPair(store, acc, moments[i]!);
    if (next === null) return null;
    acc = next;
  }
  return acc;
}

function lubPair(store: Store, a: Term, b: Term): Term | null {
  const aT = tokenOf(store, a);
  const bT = tokenOf(store, b);
  if (aT === bT) return a;
  if (lessThanTok(store, aT, bT)) return b;
  if (lessThanTok(store, bT, aT)) return a;
  const ua = upperSetTok(store, aT);
  const ub = upperSetTok(store, bT);
  const [small, big] = ua.size <= ub.size ? [ua, ub] : [ub, ua];
  const U = new Set<number>();
  for (const m of small) if (big.has(m)) U.add(m);
  if (U.size === 0) return null; // unreachable: top is in every upper set
  // U is upward-closed → m is non-minimal iff some asserted-edge ancestor
  // is in U. `top` is universally above other moments but has no incoming
  // edges in orderFwd, so it must be disqualified explicitly when U has
  // any other member.
  const notMin = new Set<number>();
  for (const m of U) {
    const succ = store.orderFwd.get(m);
    if (succ === undefined) continue;
    for (const n of succ) if (U.has(n)) notMin.add(n);
  }
  if (U.size > 1 && U.has(store.topTok)) notMin.add(store.topTok);
  let lub = -1;
  for (const m of U) {
    if (notMin.has(m)) continue;
    if (lub !== -1) return null; // ≥2 incomparable minimal upper bounds
    lub = m;
  }
  if (lub === -1) return null;
  return store.momentTerms.get(lub) ?? null;
}

function upperSetTok(store: Store, t: number): Set<number> {
  if (ORDER_STRATEGY === "eager") {
    const closure = store.gt.get(t);
    const out = new Set<number>(closure ?? []);
    out.add(t);
    out.add(store.topTok);
    return out;
  }
  const out = new Set<number>([t, store.topTok]);
  const stack = [t];
  while (stack.length > 0) {
    const x = stack.pop()!;
    const succ = store.orderFwd.get(x);
    if (succ === undefined) continue;
    for (const y of succ) if (!out.has(y)) { out.add(y); stack.push(y); }
  }
  return out;
}

// ===== Moment lattice (lattice mode only) =====
//
// With `store.lattice` set, `max` / `min` never fail (eval.ts `evalExpr`).
// The join / meet of two moments is:
//   - the larger / smaller argument when the two are comparable (this
//     collapse is deterministic by the creation-time ordering invariant on
//     `addOrder`: comparability of existing moments never changes);
//   - otherwise a lattice-node moment `(*max e1 .. en)` / `(*min e1 .. en)`.
//     Its elements are flattened (no `*max` directly inside a `*max`),
//     stripped of the unit (`bot` for max, `top` for min; the other sentinel
//     absorbs), reduced to an antichain, and sorted by token, so equal
//     joins / meets hashcons to the same token.
//
// A node is wired into the order graph when it is created, so the moment
// walk, the timeline and `lessThan`'s reachability see it as an ordinary
// moment: a join gets edges from its elements and to the minimal common
// upper bounds of its elements; a meet gets edges to its elements and from
// the maximal common lower bounds. Later moments are ordered against it by
// the edges asserted when *they* are created (e.g. `+ (*max ..) < l`), which
// stay conjunctive: asserting `+ j < l` for a join `j` means "l after every
// element of j", and `+ m < l` for a meet `m` means "l after every common
// lower bound of m's elements" — weaker than "after one of them", which
// would be a disjunction.
//
// `latticeLe` decides `≤` exactly over this structure: a join is below `b`
// iff all its elements are; `a` is below a meet iff it is below all its
// elements; everything else is reachability over the wired graph.

export function latticeMax(store: Store, a: Term, b: Term): Term {
  return latticeOp(store, "max", a, b);
}

export function latticeMin(store: Store, a: Term, b: Term): Term {
  return latticeOp(store, "min", a, b);
}

const LATTICE_HEAD: Record<LatticeNode["kind"], Term> = {
  max: { tag: "Symbol", name: "*max" },
  min: { tag: "Symbol", name: "*min" },
};

function momentTermOf(store: Store, tok: number): Term {
  const t = store.momentTerms.get(tok);
  if (t === undefined) throw new Error(`internal: moment token ${tok} has no term`);
  return t;
}

function latticeOp(store: Store, kind: LatticeNode["kind"], a: Term, b: Term): Term {
  const unit = kind === "max" ? store.botTok : store.topTok;
  const absorb = kind === "max" ? store.topTok : store.botTok;
  const toks = new Set<number>();
  for (const t of [a, b]) {
    const tok = tokenOf(store, t);
    if (!store.momentTerms.has(tok)) store.momentTerms.set(tok, t);
    const node = store.latticeNodes.get(tok);
    if (node !== undefined && node.kind === kind) for (const e of node.elems) toks.add(e);
    else toks.add(tok);
  }
  if (toks.has(absorb)) return momentTermOf(store, absorb);
  toks.delete(unit);
  // x is dropped when some other element is at least as extreme; between
  // mutually-≤ distinct tokens, the smaller token survives.
  const below = (x: number, y: number) => kind === "max" ? latticeLe(store, x, y) : latticeLe(store, y, x);
  const cand = [...toks].sort((x, y) => x - y);
  const elems = cand.filter((x) => !cand.some((y) => y !== x && below(x, y) && (!below(y, x) || y < x)));
  if (elems.length === 0) return momentTermOf(store, unit);
  if (elems.length === 1) return momentTermOf(store, elems[0]!);
  const term = intern(store, {
    tag: "Id",
    atom: { terms: [LATTICE_HEAD[kind], ...elems.map((e) => momentTermOf(store, e))] },
  });
  const tok = tokenOf(store, term);
  if (!store.latticeNodes.has(tok)) {
    store.momentTerms.set(tok, term);
    store.latticeNodes.set(tok, { kind, elems });
    wireLatticeNode(store, tok, kind, elems);
  }
  return term;
}

function addEdgeTok(store: Store, a: number, b: number): void {
  addOrder(store, momentTermOf(store, a), momentTermOf(store, b));
}

// Edges from / to a new node's covers. See the section comment.
function wireLatticeNode(store: Store, n: number, kind: LatticeNode["kind"], elems: number[]): void {
  const up = kind === "max";
  // Structural side: the elements, plus older same-kind nodes related to n
  // only through the all-elements rule (a join below n whose elements are
  // spread over several of n's), filtered to the covers.
  for (const e of elems) up ? addEdgeTok(store, e, n) : addEdgeTok(store, n, e);
  const related: number[] = [];
  for (const [y, yn] of store.latticeNodes) {
    if (y === n || yn.kind !== kind || elems.includes(y)) continue;
    const rel = up ? latticeLe(store, y, n) && !latticeLe(store, n, y) : latticeLe(store, n, y) && !latticeLe(store, y, n);
    if (rel) related.push(y);
  }
  for (const y of related) {
    const covered = related.some((z) => z !== y && (up ? latticeLe(store, y, z) : latticeLe(store, z, y)));
    if (!covered) up ? addEdgeTok(store, y, n) : addEdgeTok(store, n, y);
  }
  // Other side: the extreme elements of the common upper (join) / lower
  // (meet) set of the elements. That set is closed under reachability, so an
  // element is extreme iff none of its immediate neighbours toward the
  // elements is in the set.
  const adjOut = up ? store.orderFwd : store.orderBwd;
  const adjIn = up ? store.orderBwd : store.orderFwd;
  let common: Set<number> | null = null;
  for (const e of elems) {
    const reach = closure(adjOut, e);
    if (common === null) common = reach;
    else for (const x of common) if (!reach.has(x)) common.delete(x);
  }
  if (common === null) return;
  common.delete(n);
  common.delete(store.topTok);
  common.delete(store.botTok);
  for (const x of common) {
    const ins = adjIn.get(x);
    let extreme = true;
    if (ins !== undefined) for (const p of ins) if (p !== n && common.has(p)) { extreme = false; break; }
    if (extreme) up ? addEdgeTok(store, n, x) : addEdgeTok(store, x, n);
  }
}

// Strict closure of `start` over `adj` (excluding `start` unless on a cycle).
function closure(adj: Map<number, Set<number>>, start: number): Set<number> {
  const out = new Set<number>();
  const stack = [start];
  while (stack.length > 0) {
    const x = stack.pop()!;
    const next = adj.get(x);
    if (next === undefined) continue;
    for (const y of next) if (!out.has(y)) { out.add(y); stack.push(y); }
  }
  return out;
}

// `a ≤ b` in lattice mode. Recursion depth is at most two: node elements
// are never nodes of the same kind.
function latticeLe(store: Store, a: number, b: number): boolean {
  if (a === b || a === store.botTok || b === store.topTok) return true;
  if (a === store.topTok || b === store.botTok) return false;
  if (store.lePos.get(a)?.has(b)) return true;
  if (store.leNeg.get(a)?.has(b)) return false;
  let res: boolean;
  const na = store.latticeNodes.get(a);
  const nb = store.latticeNodes.get(b);
  if (na?.kind === "max") res = na.elems.every((s) => latticeLe(store, s, b));
  else if (nb?.kind === "min") res = nb.elems.every((t) => latticeLe(store, a, t));
  else res = reachTok(store, a, b);
  const memo = res ? store.lePos : store.leNeg;
  let set = memo.get(a);
  if (set === undefined) { set = new Set(); memo.set(a, set); }
  set.add(b);
  return res;
}

// Reachability over asserted edges, caching every visited node as `a ≤ x`.
function reachTok(store: Store, a: number, b: number): boolean {
  let pos = store.lePos.get(a);
  if (pos === undefined) { pos = new Set(); store.lePos.set(a, pos); }
  const stack = [a];
  const seen = new Set<number>([a]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const succs = store.orderFwd.get(cur);
    if (succs === undefined) continue;
    for (const s of succs) {
      if (seen.has(s)) continue;
      seen.add(s);
      pos.add(s);
      if (s === b) return true;
      stack.push(s);
    }
  }
  return false;
}
