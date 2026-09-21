// The moment walk (plans/v2-moment-walk.md): the scheduler's interface for
// calculating things along the moment order.
//
// A Turn program has a monotone part (the rules, run to quiescence by the
// inner loop) and a non-monotone part (aggregate folds, choice resolution)
// that must observe a *complete* state at a moment. The walk stratifies the
// non-monotone part by the temporal order the monotone part computed: after
// each monotone fixpoint it takes the minimal unresolved moments — the
// frontier — and runs every registered `MomentHandler` at each of them. A
// handler may add tuples (progress), may be waiting on the outside world
// (blocked — a `you` choice), or may have nothing to do. A moment is marked
// resolved once a round at the frontier makes no progress anywhere and no
// handler is blocked at it. The walk itself knows nothing about aggregates
// or choices; those are handlers in scheduler.ts.
//
// `store.resolved` is kept as a down-set of the moment order: a moment is
// marked only when everything strictly below it is marked. That is what
// lets the frontier be computed from asserted predecessor edges alone.

import type { Term } from "./term.js";
import { lessThan, type Store } from "./store.js";

export interface HandlerOutcome {
  // True iff the handler added at least one new tuple at this moment.
  progress: boolean;
  // True iff the handler is waiting on external input at this moment (an
  // unresolved `you` choice); the moment cannot be marked resolved.
  blocked: boolean;
}

export interface MomentHandler {
  name: string;
  // Run at moment `m` — a frontier moment, or an already-resolved moment
  // this handler `demanded`. Must be idempotent: a second call on the same
  // store state adds nothing.
  run(store: Store, m: Term): HandlerOutcome;
  // Optional: moment tokens where this handler has pending work regardless
  // of the frontier. Demand-style handlers use it for rows whose left
  // endpoint is already resolved (late work arriving through a same-moment
  // `^` chain, or a choose row minted after its moment resolved). Such
  // moments are run alongside the frontier without being re-opened —
  // everything below them is settled, so the answer is as final as it gets.
  demanded?(store: Store): Iterable<number>;
  // Optional: called once for each moment the walk marks resolved, after
  // marking, in the same step (`resolveMoments`). Runs only once every
  // `run` round at `m` has settled, so it sees the final state at `m`. May
  // add tuples at `m`; returns true iff it did. Used by the acc handler
  // (acc.ts, plans/v2-acc-relations.md): acc rows are a snapshot of the
  // state at `m` as of resolution, and what readers then emit at `m` does
  // not re-open it.
  resolve?(store: Store, m: Term): boolean;
}

// Tokens of every moment the store has seen (`momentTerms`) except `top`
// and the already-resolved ones. `bot` is a moment: rule-initial `^` emits
// live at `(bot, top)` and a rule-initial read samples there.
export function unresolvedMoments(store: Store): number[] {
  const out: number[] = [];
  for (const tok of store.momentTerms.keys()) {
    if (tok === store.topTok) continue;
    if (store.resolved.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

// Minimal elements of the unresolved set. Under the down-set invariant a
// moment is minimal iff all of its immediate predecessors (asserted edges
// in `orderBwd`, plus the implicit `bot` for every non-bot moment) are
// resolved: if some unresolved `u < m` existed, the edge path `u → … → p →
// m` would end in a resolved `p` with an unresolved `u < p`, contradicting
// the invariant. Hand-built stores whose moments carry no asserted edges get
// only the implicit `bot` predecessor, which is the correct order for them.
//
// The edge test assumes the asserted order is acyclic. It is not always:
// the `"old"` strategy never checks, and a body like `a, (+p); +q` leaves a
// point anchor `(a_r, a_r)` whose next fact asserts `a_r < q_l < a_r`. Cycle
// members each have an unresolved predecessor (the other), so the edge test
// excludes them — and everything above them — forever. The edge-based set
// is always a *subset* of the true frontier (it only ever excludes), so when
// it comes up empty with moments still pending we fall back to minimality
// under the strict order: `m` is minimal iff no unresolved `u` has `u < m`
// without `m < u`. Mutually-reachable moments are neither strictly below
// the other, so a cycle resolves as a unit. Quadratic, but only on that
// path.
export function frontier(store: Store, unresolved: readonly number[]): number[] {
  const out: number[] = [];
  const botResolved = store.resolved.has(store.botTok);
  for (const tok of unresolved) {
    if (tok !== store.botTok && !botResolved) continue;
    const preds = store.orderBwd.get(tok);
    let ok = true;
    if (preds !== undefined) {
      for (const p of preds) {
        if (p === store.botTok) continue; // implicit, checked above
        if (!store.resolved.has(p)) { ok = false; break; }
      }
    }
    if (ok) out.push(tok);
  }
  if (out.length > 0 || unresolved.length === 0) return out;
  return strictMinimal(store, unresolved);
}

function strictMinimal(store: Store, unresolved: readonly number[]): number[] {
  const terms = unresolved.map((tok) => store.momentTerms.get(tok)!);
  const out: number[] = [];
  for (let i = 0; i < terms.length; i++) {
    const m = terms[i]!;
    let minimal = true;
    for (let j = 0; j < terms.length; j++) {
      if (i === j) continue;
      const u = terms[j]!;
      if (lessThan(store, u, m) && !lessThan(store, m, u)) { minimal = false; break; }
    }
    if (minimal) out.push(unresolved[i]!);
  }
  return out;
}

export function markResolved(store: Store, toks: Iterable<number>): void {
  for (const t of toks) store.resolved.add(t);
}

// Run every handler's `resolve` hook at each just-marked moment. Returns
// true iff any handler added a tuple (the caller then re-enters the inner
// loop so readers of the new rows fire).
export function resolveMoments(store: Store, handlers: readonly MomentHandler[], toks: Iterable<number>): boolean {
  let progress = false;
  for (const tok of toks) {
    const m = store.momentTerms.get(tok);
    if (m === undefined) continue;
    for (const h of handlers) {
      if (h.resolve === undefined) continue;
      if (h.resolve(store, m)) progress = true;
    }
  }
  return progress;
}

export interface WalkRound {
  // Frontier moments this round ran at (tokens).
  frontier: number[];
  // Already-resolved moments some handler demanded (tokens).
  late: number[];
  // Some handler added a tuple somewhere this round.
  progress: boolean;
  // Moments (frontier or late) at which some handler is blocked.
  blocked: Set<number>;
  // True iff there was nothing to run at all: every moment is resolved and
  // no handler demanded anything.
  exhausted: boolean;
}

// One round of the walk: compute the frontier and the late demanded set, run
// every handler at every such moment, and report. Does NOT mark anything
// resolved — the caller decides (fixpoint.ts `runLoop`): if `progress`, the
// monotone part must run again before anything is judged; otherwise the
// unblocked frontier moments are resolved and the walk continues; if every
// frontier moment is blocked, the choices there surface.
export function runWalkRound(store: Store, handlers: readonly MomentHandler[]): WalkRound {
  const U = unresolvedMoments(store);
  const F = frontier(store, U);
  const lateSet = new Set<number>();
  for (const h of handlers) {
    if (h.demanded === undefined) continue;
    for (const tok of h.demanded(store)) {
      if (store.resolved.has(tok)) lateSet.add(tok);
    }
  }
  const late = [...lateSet];
  const round: WalkRound = {
    frontier: F,
    late,
    progress: false,
    blocked: new Set(),
    exhausted: F.length === 0 && late.length === 0,
  };
  if (round.exhausted) return round;
  for (const tok of [...F, ...late]) {
    const m = store.momentTerms.get(tok);
    if (m === undefined) continue; // unreachable: tokens come from momentTerms
    for (const h of handlers) {
      const r = h.run(store, m);
      if (r.progress) round.progress = true;
      if (r.blocked) round.blocked.add(tok);
    }
  }
  return round;
}
