import type { Term, Tree } from "./types.js";
import { sym, vari } from "./types.js";
import { substAtom } from "./unify.js";

export function idExpand(tree: Tree, name: string): Tree {
  const previousVars: Term[] = [];
  let counter = 1;

  function walk(node: Tree): Tree {
    const isPositive = node.literal.literalType !== "Match";
    let newId: Term;
    if (isPositive) {
      newId = { tag: "Atom", atom: { terms: [sym("id"), sym(name), ...previousVars] } };
    } else {
      const isAutoId = node.id.tag === "Variable" && /^\d+$/.test(node.id.name);
      newId = isAutoId ? vari("X" + counter++) : node.id;
    }
    previousVars.push(newId);
    const atom = node.id.tag === "Variable"
      ? substAtom(node.literal.atom, new Map([[node.id.name, newId]]))
      : node.literal.atom;
    const children = node.children.map(walk);
    return { ...node, id: newId, literal: { ...node.literal, atom }, children };
  }

  const children = tree.children.map(walk);
  return { ...tree, children };
}

// Prune the tree to the pre-order prefix ending at targetIdx, converting
// positive nodes before targetIdx to Match.
function pruneAndConvert(node: Tree, targetIdx: number, counter: { n: number }): Tree | null {
  const myIdx = counter.n++;
  if (myIdx > targetIdx) return null;

  const literalType =
    myIdx < targetIdx && node.literal.literalType !== "Match"
      ? ("Match" as const)
      : node.literal.literalType;

  if (myIdx === targetIdx) {
    return { ...node, literal: { ...node.literal, literalType }, children: [] };
  }

  const children: Tree[] = [];
  for (const child of node.children) {
    const result = pruneAndConvert(child, targetIdx, counter);
    if (result === null) break;
    children.push(result);
  }
  return { ...node, literal: { ...node.literal, literalType }, children };
}

// Given a pattern, return one expanded rule per positive node: a prefix tree
// ending at that positive node, with all earlier positive nodes converted to Match.
export function expand(pattern: Tree): Tree[] {
  const positiveIdxs: number[] = [];
  const counter0 = { n: 0 };
  function findPositives(node: Tree): void {
    const idx = counter0.n++;
    if (node.literal.literalType !== "Match") positiveIdxs.push(idx);
    for (const child of node.children) findPositives(child);
  }
  for (const child of pattern.children) findPositives(child);

  return positiveIdxs.map((targetIdx) => {
    const counter = { n: 0 };
    const children: Tree[] = [];
    for (const child of pattern.children) {
      const result = pruneAndConvert(child, targetIdx, counter);
      if (result === null) break;
      children.push(result);
    }
    return { ...pattern, children };
  });
}

export function expandAll(patterns: Tree[]): Tree[] {
  return patterns.flatMap(expand);
}
