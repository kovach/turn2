import { step } from "./step.js";
import { expandAll } from "./expand.js";
import { closeAggregates } from "./aggregate-fold.js";
import { createHashcons, type HashconsState } from "./hashcons.js";
import type { Tree } from "./types.js";

function innerFixpoint(patterns: Tree[], ref: Tree, gas: number, hc: HashconsState): { result: Tree; steps: number } {
  let changed: boolean;
  let steps = 0;
  do {
    if (steps >= gas) break;
    changed = false;
    for (const pattern of patterns) {
      const result = step(pattern, ref, hc);
      if (result !== null) {
        ref = result;
        changed = true;
      }
    }
    if (changed) steps++;
  } while (changed);
  return { result: ref, steps };
}

export function fixpoint(rawPatterns: Tree[], initial: Tree, gas = 20): { result: Tree; steps: number; hc: HashconsState; expandedPatterns: Tree[] } {
  const patterns = expandAll(rawPatterns);
  const hc = createHashcons();
  let ref = initial;
  let totalSteps = 0;
  let outerChanged: boolean;

  do {
    // Inner fixpoint: apply rules until stable
    const { result, steps } = innerFixpoint(patterns, ref, gas - totalSteps, hc);
    ref = result;
    totalSteps += steps;

    if (totalSteps >= gas) break;

    // Close aggregates: compute agg-result for any unclosed agg-instance
    outerChanged = closeAggregates(ref, hc);
    if (outerChanged) totalSteps++;
  } while (outerChanged);

  return { result: ref, steps: totalSteps, hc, expandedPatterns: patterns };
}

export function nilTree(): Tree {
  return { id: { tag: "Symbol", name: "root" }, literal: { literalType: "Match", atom: { terms: [] } }, children: [] };
}

export function fixpoint0(patterns: Tree[], gas = 20) {
  return fixpoint(patterns, nilTree(), gas);
}
