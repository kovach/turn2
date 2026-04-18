import { unifyTree, substAtom, substTerm } from "./unify.js";
import { cloneTree, collectPositiveNodes, deepestAncestorImage, findPath, nodeAt, insertAt } from "./tree.js";
import type { Term, Tree } from "./types.js";

function termEq(a: Term, b: Term): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "Symbol" && b.tag === "Symbol") return a.name === b.name;
  if (a.tag === "Variable" && b.tag === "Variable") return a.name === b.name;
  if (a.tag === "Atom" && b.tag === "Atom") {
    const at = a.atom.terms, bt = b.atom.terms;
    return at.length === bt.length && at.every((t, i) => termEq(t, bt[i]!));
  }
  if (a.tag === "Wildcard") return true;
  return false;
}

export function step(pattern: Tree, reference: Tree): Tree | null {
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
        const P = deepestAncestorImage(parent.id, pattern, refCopy, subst);
        if (P === null) continue;
        pPath = findPath(P.id, refCopy)!;
      }

      const newAtom = substAtom(posNode.literal.atom, subst);
      const newId = substTerm(posNode.id, subst);
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
