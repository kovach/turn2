import { unifyTree, substAtom, substTerm } from "./unify.js";
import { collectPositiveNodes } from "./tree.js";
import { hashconsTerm, hashconsAtom, type HashconsState } from "./hashcons.js";
import type { Trail, Tree } from "./types.js";
import { newTrail } from "./types.js";
import { addBeforeAfter, hasNode, insertChild, nodeRowFromTree, type RefStore } from "./refstore.js";

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

// Mutates `reference` in place. Newly inserted rows carry gen === iteration,
// so they are invisible to passesConstraint during this same pass (see
// unify.ts notes on the mutation-during-iteration invariant).
export function step(pattern: Tree, reference: RefStore, hc: HashconsState, iteration: number = 1): boolean {
  const positives = collectPositiveNodes(pattern);
  let anyInserted = false;

  unifyTree(pattern, reference, sharedTrail, iteration, hc, (trail) => {
    for (const { node: posNode, parent: posParent, prevBindableSibling } of positives) {
      const parentRefId = hashconsTerm(substTerm(posParent.id, trail), hc);
      if (!hasNode(reference, parentRefId, hc)) continue;

      const rawAtom = substAtom(posNode.atom, trail);
      const rawId = substTerm(posNode.id, trail);
      const newAtom = hashconsAtom(rawAtom, hc);
      const newId = hashconsTerm(rawId, hc);

      // Global id uniqueness: hashconsed ids are content-addressed, so if
      // this id exists anywhere in the store the row is a duplicate.
      if (hasNode(reference, newId, hc)) {
        stepStats.dedupSkipped++;
        continue;
      }

      insertChild(reference, parentRefId, nodeRowFromTree(posNode, {
        id: newId,
        atom: newAtom,
        gen: iteration,
      }), hc);

      // Emit `before:after(prevSibling, new)` iff the positive node's
      // pattern-preceding sibling binds an id — this is the "positive as
      // sibling of match" case in plans/temporal-relationships.md §Step.ts.
      if (prevBindableSibling !== null) {
        const prevId = hashconsTerm(substTerm(prevBindableSibling.id, trail), hc);
        if (hasNode(reference, prevId, hc)) {
          addBeforeAfter(reference, prevId, newId, hc);
        }
      }

      stepStats.inserted++;
      anyInserted = true;
    }
  });

  return anyInserted;
}
