// Outer loop. The inner loop runs all rules to quiescence (no agg knowledge).
// At quiescence we collect blocked do-agg / choose rows from the store; if
// any aggs are in the earliest tier, close them (emit agg-result rows) and
// re-enter the inner loop. If the earliest tier is all choices, halt with
// `active-choices`.

import type { Actor, ComponentOptions, FixpointStatus, Program, ProvLink, Rule } from "./types.js";
import { maxActor } from "./types.js";
import type { Span } from "./term.js";
import { compileJsDefs, evaluateRule, type CompiledJs } from "./eval.js";
import { compileJsRels, type CompiledJsRel } from "./js-rel.js";
import { type Store, createStore, candidatesByHead, tokenOf, GasError } from "./store.js";
import { applyExceptions, expand, expandMacros } from "./expand.js";
import {
  closeDoAgg,
  collectAllBlocked,
  collectBlockedChooses,
  markDeadChoice,
  collectReactiveFinalizations,
  computeAggStrata,
  finalizeReactive,
  programSeededRandom,
  resolveRngChoice,
  selectEarliestTier,
  type RngCommit,
} from "./scheduler.js";
import { computeComponents } from "./constraint-query.js";
import { closeDoAggC } from "./comp-aggregate.js";
import { attachRules } from "./stats.js";

export interface FixpointResult {
  store: Store;
  iterations: number;
  status: FixpointStatus;
  // The expanded rules the evaluator actually ran (set by `runFixpoint`;
  // absent on the inner `runLoop` results). Needed to decode per-tuple
  // bindings from the id slot (`tupleBindings` in print.ts).
  rules?: Rule[];
  // Every `rng` choice binding committed during this run, in commit order
  // (plans/v2-choice-actors.md). The harness persists these as `^ is` rows
  // so a roll happens exactly once. Empty when nothing was rolled.
  rngCommits: RngCommit[];
}

export function runFixpoint(
  program: Program,
  gas = 200,
  tupleGas = 5000,
  options?: { stats?: boolean; random?: () => number },
): FixpointResult {
  // Expand aggregation-synonym macros first, so exception rewriting sees the
  // relation reads their bodies perform and `computeAggStrata` below never
  // sees a macro use. Then eliminate `{...}` exception atoms, so the
  // pre-expand rules handed to computeAggStrata (and expand itself) are
  // exception-free.
  program = expandMacros(program);
  program = applyExceptions(program);
  const expanded = expand(program);
  const jsFuncs = compileJsDefs(expanded.jsDefs);
  const jsRelFuncs = compileJsRels(expanded.jsRels);
  // Aggregate dependency strata: computed from the pre-expand rules (markers
  // still present) so the outer loop can order same-moment reactive
  // finalizations by dependency. See plans/v2-reactive-aggregates.md.
  const strata = computeAggStrata(program.rules, program.reactive);
  const store = createStore();
  store.tupleGas = tupleGas;
  store.stats.enabled = options?.stats === true;
  attachRules(store.stats, expanded.rules.map((r) => r.name));
  let totalIters = 0;
  const rngCommits: RngCommit[] = [];

  try {
    const result = runLoop(expanded, store, gas, totalIters, jsFuncs, jsRelFuncs, strata, options?.random, rngCommits);
    resolveExceptionProvenance(store, program.provLinks);
    return { ...result, rules: expanded.rules };
  } catch (e) {
    if (e instanceof GasError) {
      // Partial (gas-limited) stores feed the views too — fix up their
      // provenance as well.
      resolveExceptionProvenance(store, program.provLinks);
      return { store, iterations: totalIters, status: { kind: "gas", iterations: totalIters, tuples: store.tuples.length }, rules: expanded.rules, rngCommits };
    }
    throw e;
  }
}

// Post-fixpoint provenance fixup for exception default rules
// (plans/v2-exception-default-provenance.md). A default rule re-emits a
// matched `_<p>_prime<k>` tuple under the user head with identical argument
// terms and endpoints (only the head symbol and the trailing per-firing id
// slot differ), but its Emit atom's static span is the exception's line. The
// prime tuple keeps the original assertion's span, so re-attribute each
// linked tuple by locating its prime tuple in the store and copying the
// span, following links transitively for chained exceptions. Tuples with no
// structural match (emits that escaped renaming: weighted or off-arity)
// keep their own span.
function resolveExceptionProvenance(store: Store, links: ProvLink[] | undefined): void {
  if (links === undefined || links.length === 0) return;
  // Keyed by head only — a head can carry one link per arity (`{x => e}`
  // and `{x A => e}` coexist), so resolution selects by tuple width.
  const byHead = new Map<string, ProvLink[]>();
  for (const l of links) {
    const bucket = byHead.get(l.head);
    if (bucket === undefined) byHead.set(l.head, [l]);
    else bucket.push(l);
  }
  for (const head of byHead.keys()) {
    for (const idx of candidatesByHead(store, head)) {
      const span = chaseProvSpan(store, byHead, idx);
      if (span !== undefined) store.tupleSource[idx] = span;
    }
  }
}

// Span the tuple at `idx` should adopt, or undefined to keep its own: the
// deepest tuple with a defined span reachable by following prime links.
// Chains cannot cycle — link targets are freshly minted prime names.
function chaseProvSpan(
  store: Store,
  byHead: Map<string, ProvLink[]>,
  idx: number,
): Span | undefined {
  const tup = store.tuples[idx]!;
  const width = tup.atom.terms.length;
  const link = byHead
    .get(headName(tup.atom.terms[0]))
    // Stored width = user arity + head + trailing universal id slot.
    ?.find((l) => l.arity + 2 === width);
  if (link === undefined) return undefined;
  const primeIdx = findPrimeTuple(store, link.prime, idx);
  if (primeIdx === undefined) return undefined;
  return chaseProvSpan(store, byHead, primeIdx) ?? store.tupleSource[primeIdx];
}

function headName(t: { tag: string; name?: string } | undefined): string {
  return t !== undefined && t.tag === "Symbol" && t.name !== undefined ? t.name : "";
}

// Stored prime tuple matching the tuple at `idx`: same width, equal
// argument terms after the head and excluding the trailing id slot, equal
// endpoints — all by hashcons token.
function findPrimeTuple(store: Store, prime: string, idx: number): number | undefined {
  const tup = store.tuples[idx]!;
  const width = tup.atom.terms.length;
  const lTok = tokenOf(store, tup.l);
  const rTok = tokenOf(store, tup.r);
  for (const pIdx of candidatesByHead(store, prime)) {
    const pt = store.tuples[pIdx]!;
    if (pt.atom.terms.length !== width) continue;
    if (tokenOf(store, pt.l) !== lTok || tokenOf(store, pt.r) !== rTok) continue;
    let same = true;
    for (let i = 1; i < width - 1; i++) {
      if (tokenOf(store, tup.atom.terms[i]!) !== tokenOf(store, pt.atom.terms[i]!)) {
        same = false;
        break;
      }
    }
    if (same) return pIdx;
  }
  return undefined;
}

function runLoop(expanded: Program, store: Store, gas: number, startIters: number, jsFuncs: Map<string, CompiledJs>, jsRelFuncs: Map<string, CompiledJsRel[]>, strata: Map<string, number>, explicitRandom: (() => number) | undefined, rngCommits: RngCommit[]): FixpointResult {
  let totalIters = startIters;
  // The random stream is latched at the first rng roll: an explicitly
  // passed options.random wins (harness control); else a program-provided
  // seed (`+ rng-seed n`, read from the store — asserted rules have run to
  // quiescence by then); else Math.random. `rng-seed` tuples appearing
  // after the latch have no effect ("seed once, at startup").
  let random: (() => number) | null = explicitRandom ?? null;
  while (true) {
    const innerIters = innerLoop(expanded, store, gas - totalIters, jsFuncs, jsRelFuncs);
    totalIters += innerIters;
    if (totalIters >= gas) {
      return { store, iterations: totalIters, status: { kind: "gas", iterations: totalIters, tuples: store.tuples.length }, rngCommits };
    }

    const blocked = [
      ...collectAllBlocked(store),
      ...collectReactiveFinalizations(store, expanded.reactive, expanded.schema),
    ];
    if (blocked.length === 0) {
      return { store, iterations: totalIters, status: { kind: "done" }, rngCommits };
    }
    const tier = selectEarliestTier(store, blocked);
    const aggsInTier = tier.flatMap((b) => b.kind === "agg" ? [b.row] : []);
    const aggCsInTier = tier.flatMap((b) => b.kind === "aggc" ? [b.row] : []);
    // Single-moment stratification: within the earliest moment, finalize only
    // the lowest aggregate-dependency stratum present, so a consumer aggregate
    // (e.g. `count p`) is not folded until the relation it reads (`p`) has
    // settled at this moment. Higher strata reappear in later outer iterations.
    // See plans/v2-reactive-aggregates.md.
    const reactiveAll = tier.flatMap((b) => b.kind === "reactive" ? [b.row] : []);
    const stratumOf = (r: typeof reactiveAll[number]): number =>
      r.foo.tag === "Symbol" ? (strata.get(r.foo.name) ?? 0) : 0;
    const minStratum = reactiveAll.reduce((m, r) => Math.min(m, stratumOf(r)), Infinity);
    const reactiveInTier = reactiveAll.filter((r) => stratumOf(r) === minStratum);
    if (aggsInTier.length > 0 || aggCsInTier.length > 0 || reactiveInTier.length > 0) {
      let progressed = false;
      for (const a of aggsInTier) {
        if (closeDoAgg(store, a, expanded.schema)) progressed = true;
      }
      for (const c of aggCsInTier) {
        if (closeDoAggC(store, c)) progressed = true;
      }
      // Reactive: materialize this tier's breakpoints (earliest first, so
      // non-monotone aggregation is stratified by moment).
      for (const r of reactiveInTier) {
        if (finalizeReactive(store, r, expanded.schema)) progressed = true;
      }
      // Semi-naive: agg-result / _aggval rows emitted here should be the
      // next inner-loop pass's delta. Mirrors v1's iteration++ after
      // closeAggregates.
      if (progressed) {
        store.iteration++;
        swapHeads(store);
      }
      if (!progressed) {
        // Safety net against an infinite outer loop. Aggregates no longer
        // reach here: an empty one closes with the `*agg-empty` sentinel
        // (see SYM_AGG_EMPTY in comp-aggregate.ts), which resolves its
        // producer so the blocked set strictly shrinks. Before that, an
        // empty aggregate at an early moment stalled the whole program —
        // the outer loop only works the earliest tier, so every later
        // aggregate went unclosed and the run reported `done`.
        return { store, iterations: totalIters, status: { kind: "done" }, rngCommits };
      }
      continue;
    }
    // Earliest tier is all choices. Surface only components reachable from
    // the earliest-tier seed; later-tier chooses entangled via shared
    // constrain rows are pulled in by `computeComponents`, the rest stay
    // blocked for the next round.
    const choices = collectBlockedChooses(store);
    const seedChoices = tier.flatMap((b) => b.kind === "choose" ? [b.row] : []);
    const cc = computeComponents(store, choices, expanded.schema, seedChoices, jsRelFuncs);
    if (cc.kind === "empty-fringe-error") {
      return {
        store,
        iterations: totalIters,
        status: { kind: "empty-fringe-error", choice: cc.choice, activeTerm: cc.activeTerm },
        rngCommits,
      };
    }
    // Dead-choice resolution: a surfaced component with zero option
    // tuples can never gain any — temporal monotonicity: the component
    // is evaluated at its moment M, and no fact emitted after this
    // quiescence point can have an interval containing M. Such a
    // component is complete: mark every active term dead (`_dead-choice`
    // rows, read back by collectBlockedChooses / gatherChoiceContext as
    // resolutions) and re-enter the loop instead of blocking forever.
    // The owning asks' continuations simply never fire — the Ceptre
    // "transition not applicable" case. Applies to `you` and `rng`
    // components alike (this supersedes surfacing for empty rng
    // components, which previously fell through to active-choices).
    const emptyComps = cc.components.filter((c) => c.options.length === 0);
    if (emptyComps.length > 0) {
      for (const comp of emptyComps) {
        for (const t of comp.activeTerms) markDeadChoice(store, t);
      }
      // Semi-naive bookkeeping, mirroring the commit paths (the marker
      // rows trigger no rules, but keep every tuple in a proper
      // iteration bucket).
      store.iteration++;
      swapHeads(store);
      continue;
    }

    // rng auto-resolution (plans/v2-choice-actors.md): a component whose
    // controlling (highest) actor is `rng` is resolved by the scheduler —
    // one option tuple picked uniformly at random, all its active terms
    // committed jointly — and the loop re-enters instead of halting. Mixed
    // components (controlling actor `you`) surface untouched: the user's
    // one-at-a-time commits resolve the `you` terms first, and the
    // recomputed all-rng remainder rolls on a later round (highest actor
    // first). If nothing committed (all rng components had zero options),
    // fall through and surface everything rather than looping forever.
    const controlling = (c: ComponentOptions): Actor => c.actors.reduce(maxActor, "rng");
    const rngComps = cc.components.filter((c) => controlling(c) === "rng");
    if (rngComps.length > 0) {
      if (random === null) random = programSeededRandom(store) ?? Math.random;
      let committed = false;
      for (const comp of rngComps) {
        const got = resolveRngChoice(store, comp, random);
        if (got !== null) {
          rngCommits.push(...got);
          committed = true;
        }
      }
      if (committed) {
        // Semi-naive: the `is` rows emitted here are the next inner-loop
        // pass's delta, mirroring the agg-result path above.
        store.iteration++;
        swapHeads(store);
        continue;
      }
    }
    return {
      store,
      iterations: totalIters,
      status: { kind: "active-choices", choices: cc.surfaced, components: cc.components },
      rngCommits,
    };
  }
}

function innerLoop(program: Program, store: Store, gas: number, jsFuncs: Map<string, CompiledJs>, jsRelFuncs: Map<string, CompiledJsRel[]>): number {
  let iter = 0;
  while (iter < gas) {
    const before = storeSize(store);
    const dupesBefore = store.tupleDupes;
    let rulesRan = 0;
    let rulesSkipped = 0;
    for (let i = 0; i < program.rules.length; i++) {
      const rule = program.rules[i]!;
      // Empty-delta short-circuit: if the variant's delta atom's head
      // received no inserts in the previous round, the delta bucket is
      // empty and the entire prefix walk would be wasted. Only safe
      // when no positive atom precedes the delta — otherwise we'd skip
      // the early asserts too. `deltaHead` is `undefined` for matchless
      // rules (always run) and `null` when the head is a non-Symbol.
      const dh = rule.deltaHead;
      if (
        rule.deltaSafeSkip === true
        && dh !== undefined
        && dh !== null
        && !store.prevHeads.has(dh)
      ) {
        rulesSkipped++;
        const rs = store.stats.rules[i];
        if (rs !== undefined) rs.skipped++;
        continue;
      }
      rulesRan++;
      evaluateRule(rule, store, program.schema, jsFuncs, jsRelFuncs, i);
    }
    const after = storeSize(store);
    store.stats.iterations.push({
      iter: store.iteration,
      tuplesAdded: after - before,
      dupes: store.tupleDupes - dupesBefore,
      rulesRan,
      rulesSkipped,
    });
    iter++;
    if (before === after) break;
    // Semi-naive: bump after a productive sweep so the rows added this
    // round become next round's `delta`. Matching v1's "increment on
    // change" rule keeps the delta bucket non-empty exactly when there's
    // new work to push through it.
    store.iteration++;
    swapHeads(store);
  }
  return iter;
}

function swapHeads(store: Store): void {
  store.prevHeads = store.currHeads;
  store.currHeads = new Set();
}

function storeSize(store: Store): number {
  return store.tuples.length + store.edgeSet.size;
}
