import { step } from "./step.js";
import { expandAll } from "./expand.js";
import type { Tree } from "./types.js";

export function fixpoint(rawPatterns: Tree[], initial: Tree, gas = 20): { result: Tree; steps: number } {
  const patterns = expandAll(rawPatterns);
  let ref = initial;
  let changed: boolean;
  let steps = 0;
  do {
    if (steps >= gas) break;
    changed = false;
    for (const pattern of patterns) {
      const result = step(pattern, ref);
      if (result !== null) {
        ref = result;
        changed = true;
      }
    }
    if (changed) steps++;
  } while (changed);
  return { result: ref, steps };
}

export function nilTree(): Tree {
  return { id: { tag: "Symbol", name: "root" }, literal: { literalType: "Match", atom: { terms: [] } }, children: [] };
}

export function fixpoint0(patterns: Tree[], gas = 20) {
  return fixpoint(patterns, nilTree(), gas);
}
