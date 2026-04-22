import { step } from "./step.js";
import { expandAll, generateDeltaVariants } from "./expand.js";
import { closeAggregates } from "./aggregate-fold.js";
import { createHashcons, type HashconsState } from "./hashcons.js";
import { buildIndexedTree, type IndexedTree } from "./unify.js";
import type { Tree } from "./types.js";
import { match } from "./types.js";

function setGenRecursive(tree: Tree, gen: number): void {
  tree.gen = gen;
  for (const child of tree.children) {
    setGenRecursive(child, gen);
  }
}

function innerFixpoint(patterns: Tree[], ref: IndexedTree, gas: number, hc: HashconsState, startIteration: number = 1): { steps: number; iteration: number } {
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

export function fixpoint(rawPatterns: Tree[], initial: Tree, gas = 20): { result: Tree; steps: number; hc: HashconsState; expandedPatterns: Tree[] } {
  const expanded = expandAll(rawPatterns);
  const patterns = expanded.flatMap(generateDeltaVariants);
  const hc = createHashcons();
  setGenRecursive(initial, 0);
  const ref = buildIndexedTree(initial);
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

  return { result: ref.root, steps: totalSteps, hc, expandedPatterns: expanded };
}

export function nilTree(): Tree {
  return { id: { tag: "Symbol", name: "root" }, literal: { literalType: match(), atom: { terms: [] } }, children: [], gen: 0 };
}

export function fixpoint0(patterns: Tree[], gas = 20) {
  return fixpoint(patterns, nilTree(), gas);
}
