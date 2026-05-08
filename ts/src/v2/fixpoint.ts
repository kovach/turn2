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

export interface FixpointResult {
  store: Store;
  iterations: number;
  status: FixpointStatus;
}

export function runFixpoint(program: Program, gas = 200, tupleGas = 5000): FixpointResult {
  const expanded = expand(program);
  const store = createStore();
  store.tupleGas = tupleGas;
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
    const cc = computeComponents(store, choices);
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
    for (const rule of program.rules) evaluateRule(rule, store, program.schema);
    const after = storeSize(store);
    iter++;
    if (before === after) break;
  }
  return iter;
}

function storeSize(store: Store): number {
  return store.tuples.length + store.edgeSet.size;
}
