// Outer loop. The inner loop runs all rules to quiescence (no agg knowledge).
// At quiescence we collect blocked do-agg / choose rows from the store; if
// any aggs are in the earliest tier, close them (emit agg-result rows) and
// re-enter the inner loop. If the earliest tier is all choices, halt with
// `active-choices`.

import type { FixpointStatus, Program } from "./types.js";
import { evaluateRule } from "./eval.js";
import { type Store, createStore, GasError } from "./store.js";
import { expand } from "./expand.js";
import {
  closeDoAgg,
  collectAllBlocked,
  collectBlockedChooses,
  selectEarliestTier,
} from "./scheduler.js";
import { computeComponents } from "./constraint-query.js";
import { attachRules } from "./stats.js";

export interface FixpointResult {
  store: Store;
  iterations: number;
  status: FixpointStatus;
}

export function runFixpoint(
  program: Program,
  gas = 200,
  tupleGas = 5000,
  options?: { stats?: boolean },
): FixpointResult {
  const expanded = expand(program);
  const store = createStore();
  store.tupleGas = tupleGas;
  store.stats.enabled = options?.stats === true;
  attachRules(store.stats, expanded.rules.map((r) => r.name));
  let totalIters = 0;

  try {
    return runLoop(expanded, store, gas, totalIters);
  } catch (e) {
    if (e instanceof GasError) {
      return { store, iterations: totalIters, status: { kind: "gas", iterations: totalIters, tuples: store.tuples.length } };
    }
    throw e;
  }
}

function runLoop(expanded: Program, store: Store, gas: number, startIters: number): FixpointResult {
  let totalIters = startIters;
  while (true) {
    const innerIters = innerLoop(expanded, store, gas - totalIters);
    totalIters += innerIters;
    if (totalIters >= gas) {
      return { store, iterations: totalIters, status: { kind: "gas", iterations: totalIters, tuples: store.tuples.length } };
    }

    const blocked = collectAllBlocked(store);
    if (blocked.length === 0) {
      return { store, iterations: totalIters, status: { kind: "done" } };
    }
    const tier = selectEarliestTier(store, blocked);
    const aggsInTier = tier.flatMap((b) => b.kind === "agg" ? [b.row] : []);
    if (aggsInTier.length > 0) {
      let progressed = false;
      for (const a of aggsInTier) {
        if (closeDoAgg(store, a, expanded.schema)) progressed = true;
      }
      // Semi-naive: agg-result rows emitted by closeDoAgg should be the
      // next inner-loop pass's delta. Mirrors v1's iteration++ after
      // closeAggregates.
      if (progressed) {
        store.iteration++;
        swapHeads(store);
      }
      if (!progressed) {
        // Earliest aggs all empty (e.g., `last` on empty contribution sets).
        // Drop them by examining the next tier — but for now, halt to avoid
        // an infinite loop. A future pass might emit a sentinel agg-result.
        return { store, iterations: totalIters, status: { kind: "done" } };
      }
      continue;
    }
    // Earliest tier is all choices.
    const choices = collectBlockedChooses(store);
    const cc = computeComponents(store, choices, expanded.schema);
    if (cc.kind === "empty-fringe-error") {
      return {
        store,
        iterations: totalIters,
        status: { kind: "empty-fringe-error", choice: cc.choice, activeTerm: cc.activeTerm },
      };
    }
    return {
      store,
      iterations: totalIters,
      status: { kind: "active-choices", choices, components: cc.components },
    };
  }
}

function innerLoop(program: Program, store: Store, gas: number): number {
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
      evaluateRule(rule, store, program.schema, i);
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
