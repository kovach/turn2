import { unifyTree, substAtom, substTerm, indexedInsertAt, type IndexedTree } from "./unify.js";
import { collectPositiveNodes, findPath, nodeAt, termEq } from "./tree.js";
import { hashconsTerm, hashconsAtom, expandTerm, type HashconsState } from "./hashcons.js";
import { formatLiteral } from "./parse.js";
import type { Atom, Trail, Tree } from "./types.js";
import { newTrail } from "./types.js";

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

function prettyAtom(atom: Atom, hc: HashconsState): Atom {
  return { terms: atom.terms.map((t) => expandTerm(t, hc)) };
}

// Reusing one trail across all step() calls preserves array backing capacity —
// after warmup, unification runs allocation-free on the trail itself.
const sharedTrail: Trail = newTrail();

// Mutates `reference` in place. Newly inserted nodes carry gen === iteration,
// so they are invisible to passesConstraint during this same pass (see
// unify.ts notes on walkAllCandidates and the symbol-index loop).
export function step(pattern: Tree, reference: IndexedTree, hc: HashconsState, iteration: number = 1): boolean {
  const positives = collectPositiveNodes(pattern);
  let anyInserted = false;

  unifyTree(pattern, reference, sharedTrail, iteration, hc, (trail) => {
    for (const posNode of positives) {
      const posPath = findPath(posNode.id, pattern, hc)!;

      let pPath: number[];
      if (posPath.length === 0) {
        pPath = [];
      } else {
        const parent = nodeAt(pattern, posPath.slice(0, -1))!;
        const parentRefId = substTerm(parent.id, trail);
        const found = findPath(parentRefId, reference.root, hc);
        if (found === null) continue;
        pPath = found;
      }

      const rawAtom = substAtom(posNode.literal.atom, trail);
      const rawId = substTerm(posNode.id, trail);
      const newAtom = hashconsAtom(rawAtom, hc);
      const newId = hashconsTerm(rawId, hc);
      const parentNode = nodeAt(reference.root, pPath)!;
      if (parentNode.children.some((c) => termEq(c.id, newId, hc))) {
        stepStats.dedupSkipped++;
        continue;
      }

      indexedInsertAt(reference, pPath, {
        id: newId,
        literal: { literalType: posNode.literal.literalType, atom: newAtom },
        children: [],
        gen: iteration,
      });
      stepStats.inserted++;
      anyInserted = true;
    }
  });

  return anyInserted;
}
