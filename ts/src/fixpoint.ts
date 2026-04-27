import { step } from "./step.js";
import { expandAll, generateDeltaVariants } from "./expand.js";
import { closeAggregates } from "./aggregate-fold.js";
import { createHashcons, type HashconsState } from "./hashcons.js";
import { emptyRefStore, refStoreToTree, type RefStore } from "./refstore.js";
import type { Tree } from "./types.js";

function innerFixpoint(patterns: Tree[], ref: RefStore, gas: number, hc: HashconsState, startIteration: number = 1): { steps: number; iteration: number } {
  let changed: boolean;
  let steps = 0;
  let iteration = startIteration;
  do {
    if (steps >= gas) break;
    changed = false;
    for (const pattern of patterns) {
      if (step(pattern, ref, hc, iteration)) {
        changed = true;
      }
    }
    if (changed) {
      steps++;
      iteration++;
    }
  } while (changed);
  return { steps, iteration };
}

export function fixpoint(rawPatterns: Tree[], gas = 20): { result: Tree; steps: number; hc: HashconsState; expandedPatterns: Tree[] } {
  const expanded = expandAll(rawPatterns);
  const patterns = expanded.flatMap(generateDeltaVariants);
  const hc = createHashcons();
  const ref = emptyRefStore(hc);
  let totalSteps = 0;
  let iteration = 1;
  let outerChanged: boolean;

  do {
    // Inner fixpoint: apply rules until stable
    const inner = innerFixpoint(patterns, ref, gas - totalSteps, hc, iteration);
    totalSteps += inner.steps;
    iteration = inner.iteration;

    if (totalSteps >= gas) break;

    // Close aggregates: compute agg-result for any unclosed agg-instance
    outerChanged = closeAggregates(ref, hc, iteration);
    if (outerChanged) {
      totalSteps++;
      iteration++;
    }
  } while (outerChanged);

  return { result: refStoreToTree(ref, hc), steps: totalSteps, hc, expandedPatterns: expanded };
}

export function nilTree(): Tree {
  return {
    tag: "Assert",
    id: { tag: "Symbol", name: "$root" },
    atom: { terms: [] },
    children: [],
    gen: 0,
  };
}
