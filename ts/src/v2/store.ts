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
  // Eager-strategy state. Populated only when ORDER_STRATEGY === "eager".
  // `gt[a]` is the full forward closure { b | a < b }; `orderBwd[b]` is
  // the set of immediate predecessors of `b` (not closure), used to
  // back-walk ancestors of the insertion point.
  gt: Map<number, Set<number>>;
  orderBwd: Map<number, Set<number>>;
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

// Sentinel thrown by `addTuple` when `tupleGas` is exhausted. Caught by
// `runFixpoint` so deeply nested CPS evaluator state can unwind cleanly.
export class GasError extends Error {
  constructor() { super("v2: tupleGas exhausted"); }
}

export function createStore(): Store {
  const hash = createHashcons();
  const bot = hashconsTerm({ tag: "Symbol", name: "bot" }, hash);
  const top = hashconsTerm({ tag: "Symbol", name: "top" }, hash);
  const botTok = tokenOfId(bot, hash);
  const topTok = tokenOfId(top, hash);
  const momentTerms = new Map<number, Term>([[botTok, bot], [topTok, top]]);
  return {
    hash,
    tuples: [],
    tupleSource: [],
    byHead: new Map(),
    orderFwd: new Map(),
    bot,
    top,
    botTok,
    topTok,
    momentTerms,
    edgeSet: new Set(),
    ltPos: new Map(),
    ltNeg: new Map(),
    gt: new Map(),
    orderBwd: new Map(),
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
  if (!store.momentTerms.has(lTok)) store.momentTerms.set(lTok, l);
  if (!store.momentTerms.has(rTok)) store.momentTerms.set(rTok, r);
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
export function addOrder(store: Store, lt: Term, gt: Term): void {
  const ltTok = tokenOf(store, lt);
  const gtTok = tokenOf(store, gt);
  if (!store.momentTerms.has(ltTok)) store.momentTerms.set(ltTok, lt);
  if (!store.momentTerms.has(gtTok)) store.momentTerms.set(gtTok, gt);
  if (ltTok === gtTok) return;
  if (ltTok === store.botTok || gtTok === store.topTok) return;
  if (ORDER_STRATEGY === "old") {
    const key = `${ltTok},${gtTok}`;
    if (store.edgeSet.has(key)) return;
    store.edgeSet.add(key);
    // A new edge can convert previously-false reachability into true; ltPos
    // remains valid (monotone), but ltNeg must be discarded.
    store.ltNeg.clear();
    let succs = store.orderFwd.get(ltTok);
    if (succs === undefined) {
      succs = new Set();
      store.orderFwd.set(ltTok, succs);
    }
    succs.add(gtTok);
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
  // DFS closure search. Every node we reach from aTok satisfies aTok < node,
  // so cache it as we go — even on early-return for the queried bTok the
  // partial walk leaves useful positive facts behind for future queries.
  let posCache = store.ltPos.get(aTok);
  if (posCache === undefined) { posCache = new Set(); store.ltPos.set(aTok, posCache); }
  const stack = [aTok];
  const seen = new Set<number>([aTok]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const succs = store.orderFwd.get(cur);
    if (succs === undefined) continue;
    for (const s of succs) {
      if (seen.has(s)) continue;
      seen.add(s);
      posCache.add(s);
      if (s === bTok) return true;
      stack.push(s);
    }
  }
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

// Tuple candidates whose first term is the given symbol. Returned by index
// in `tuples` so callers can iterate without copying.
export function candidatesByHead(store: Store, head: string): readonly number[] {
  return store.byHead.get(head) ?? [];
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
