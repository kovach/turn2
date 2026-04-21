import { unifyTree, substAtom, substTerm, setUnifyHashcons } from "./unify.js";
import { cloneTree, collectPositiveNodes, findPath, nodeAt, insertAt, setTreeHashcons, termEq } from "./tree.js";
import { hashconsTerm, hashconsAtom, type HashconsState } from "./hashcons.js";
import type { Tree } from "./types.js";

export function step(pattern: Tree, reference: Tree, hc: HashconsState): Tree | null {
  setUnifyHashcons(hc);
  setTreeHashcons(hc);
  const substitutions = unifyTree(pattern, reference);
  const refCopy = cloneTree(reference);
  const positives = collectPositiveNodes(pattern);
  let anyInserted = false;

  for (const subst of substitutions) {
    for (const posNode of positives) {
      const posPath = findPath(posNode.id, pattern)!;

      let pPath: number[];
      if (posPath.length === 0) {
        pPath = [];
      } else {
        const parent = nodeAt(pattern, posPath.slice(0, -1))!;
        const parentRefId = substTerm(parent.id, subst);
        const found = findPath(parentRefId, refCopy);
        if (found === null) continue;
        pPath = found;
      }

      const rawAtom = substAtom(posNode.literal.atom, subst);
      const rawId = substTerm(posNode.id, subst);
      const newAtom = hashconsAtom(rawAtom, hc);
      const newId = hashconsTerm(rawId, hc);
      const parentNode = nodeAt(refCopy, pPath)!;
      if (parentNode.children.some((c) => termEq(c.id, newId))) continue;

      insertAt(refCopy, pPath, {
        id: newId,
        literal: { literalType: posNode.literal.literalType, atom: newAtom },
        children: [],
      });
      anyInserted = true;
    }
  }

  return anyInserted ? refCopy : null;
}
