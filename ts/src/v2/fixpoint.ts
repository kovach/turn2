// Outer loop: re-evaluate every rule until the store stops changing.
// Tuples / outputs / order edges all dedupe, so re-firing a rule with the
// same substitution is idempotent.

import type { Program } from "./types.js";
import { evaluateRule } from "./eval.js";
import { type Store, createStore } from "./store.js";

export interface FixpointResult {
  store: Store;
  iterations: number;
}

export function runFixpoint(program: Program, gas = 100): FixpointResult {
  const store = createStore();
  let iter = 0;
  while (iter < gas) {
    const before = storeSize(store);
    for (const rule of program.rules) evaluateRule(rule, store, program.schema);
    const after = storeSize(store);
    iter++;
    if (before === after) break;
  }
  return { store, iterations: iter };
}

function storeSize(store: Store): number {
  return store.tuples.length + store.outputs.length + store.edgeSet.size;
}
