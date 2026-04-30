import { unifyConstraints, substAtom, substTerm } from "./unify.js";
import { lower } from "./lower.js";
import { hashconsTerm, hashconsAtom, type HashconsState } from "./hashcons.js";
import type { Constraint, Trail, Tree, TurnExpr } from "./types.js";
import { newTrail } from "./types.js";
import { addBeforeAfter, addParentChild, hasNode, insertRow, type RefStore } from "./refstore.js";

export const stepStats = {
  dedupSkipped: 0,
  inserted: 0,
  dupLog: [] as string[],
};

export function resetStepStats(): void {
  stepStats.dedupSkipped = 0;
  stepStats.inserted = 0;
  stepStats.dupLog = [];
}

// Reusing one trail across all step() calls preserves array backing capacity —
// after warmup, unification runs allocation-free on the trail itself.
const sharedTrail: Trail = newTrail();

// Per-pattern lowering cache. Lowering is deterministic and depends only on
// the pattern's identity; expand() returns the same Tree references across
// iterations, so a WeakMap keyed by the pattern lets us avoid re-walking
// every fixpoint pass.
const loweredCache = new WeakMap<Tree, TurnExpr>();
function loweredFor(pattern: Tree): TurnExpr {
  let te = loweredCache.get(pattern);
  if (te === undefined) {
    te = lower(pattern);
    loweredCache.set(pattern, te);
  }
  return te;
}

// Mutates `reference` in place. Newly inserted rows carry gen === iteration,
// so they are invisible to passesConstraint during this same pass (see
// unify.ts notes on the mutation-during-iteration invariant).
export function step(pattern: Tree, reference: RefStore, hc: HashconsState, iteration: number = 1): boolean {
  if (pattern.tag === "Ask") {
    throw new Error("step: pattern is an Ask — should have been rewritten to Assert(`_choose`) by expand");
  }
  const te = loweredFor(pattern);
  let anyInserted = false;

  unifyConstraints(te, reference, sharedTrail, iteration, hc, (trail) => {
    for (const c of te.assertions) {
      if (c.tag === "Assert" || c.tag === "Constrain") {
        if (runAssertion(c, reference, trail, iteration, hc)) anyInserted = true;
      } else {
        runAssertIntervalRel(c, reference, trail, hc);
      }
    }
  });

  return anyInserted;
}

function runAssertion(
  c: Extract<Constraint, { tag: "Assert" | "Constrain" }>,
  reference: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
): boolean {
  const newAtom = hashconsAtom(substAtom(c.atom, trail), hc);
  const newId = hashconsTerm(substTerm(c.id, trail), hc);
  if (hasNode(reference, newId, hc)) {
    stepStats.dedupSkipped++;
    return false;
  }
  insertRow(reference, {
    tag: c.tag,
    id: newId,
    atom: newAtom,
    gen: iteration,
  }, hc);
  stepStats.inserted++;
  return true;
}

function runAssertIntervalRel(
  c: Extract<Constraint, { tag: "AssertIntervalRel" }>,
  reference: RefStore,
  trail: Trail,
  hc: HashconsState,
): void {
  const aId = hashconsTerm(substTerm(c.a, trail), hc);
  const bId = hashconsTerm(substTerm(c.b, trail), hc);
  switch (c.kind) {
    case "contains":
      addParentChild(reference, aId, bId, hc);
      return;
    case "before:after":
      addBeforeAfter(reference, aId, bId, hc);
      return;
  }
}
