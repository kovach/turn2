import { step } from "./step.js";
import { expandAll, generateDeltaVariants } from "./expand.js";
import { closeAggregates, type AggInstance } from "./aggregate-fold.js";
import { collectSchedulables, selectEarliestTier, type UnresolvedChoice } from "./scheduler.js";
import { computeComponents, type ComponentOptions } from "./constraint-query.js";
import { createHashcons, type HashconsState } from "./hashcons.js";
import { emptyRefStore, refStoreToTree, type RefStore } from "./refstore.js";
import type { Term, Tree } from "./types.js";

// Outcome of a fixpoint run, in the order the outer loop checks them:
//   - "active-choices" — no aggs were eligible in the earliest tier; the
//     remaining schedulables are choices the user (or step 2's option
//     enumerator) needs to resolve. `components` carries one entry per
//     connected component of the constraint graph that touches any active
//     term, with the joint option list from the lifted match query.
//   - "empty-fringe-error" — an active choice term has no Constrain row in
//     its component; an unconstrained active term is a programmer error
//     that short-circuits the pause.
//   - "gas" — exhausted before reaching a stable state.
//   - "done" — store stable, nothing left to schedule.
export type FixpointStatus =
  | { kind: "done" }
  | { kind: "gas"; steps: number }
  | { kind: "active-choices"; choices: UnresolvedChoice[]; components: ComponentOptions[] }
  | { kind: "empty-fringe-error"; choice: UnresolvedChoice; choiceTerm: Term };

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

export function fixpoint(rawPatterns: Tree[], gas = 20): { result: Tree; steps: number; hc: HashconsState; expandedPatterns: Tree[]; status: FixpointStatus } {
  const expanded = expandAll(rawPatterns);
  const patterns = expanded.flatMap(generateDeltaVariants);
  const hc = createHashcons();
  const ref = emptyRefStore(hc);
  let totalSteps = 0;
  let iteration = 1;
  let status: FixpointStatus;

  while (true) {
    const inner = innerFixpoint(patterns, ref, gas - totalSteps, hc, iteration);
    totalSteps += inner.steps;
    iteration = inner.iteration;

    if (totalSteps >= gas) {
      status = { kind: "gas", steps: totalSteps };
      break;
    }

    const schedulables = collectSchedulables(ref, hc);
    if (schedulables.length === 0) {
      status = { kind: "done" };
      break;
    }

    const earliest = selectEarliestTier(ref, hc, schedulables);
    const aggs: AggInstance[] = [];
    for (const s of earliest) if (s.kind === "agg") aggs.push(s.instance);

    if (aggs.length > 0) {
      // Fold the eligible aggregates and re-enter the inner loop. Choices
      // in the same tier stay paused — their option enumeration is owned
      // by step 2 and only runs once no aggs remain in the earliest tier.
      closeAggregates(ref, hc, iteration, aggs);
      totalSteps++;
      iteration++;
      continue;
    }

    // Earliest tier is all choices: compute component options and stop.
    const choices: UnresolvedChoice[] = [];
    for (const s of earliest) if (s.kind === "choice") choices.push(s.choice);
    const compResult = computeComponents(ref, hc, choices);
    if (compResult.kind === "empty-fringe-error") {
      status = { kind: "empty-fringe-error", choice: compResult.choice, choiceTerm: compResult.choiceTerm };
    } else {
      status = { kind: "active-choices", choices, components: compResult.components };
    }
    break;
  }

  return { result: refStoreToTree(ref, hc), steps: totalSteps, hc, expandedPatterns: expanded, status };
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
