import { substTerm } from "./unify.js";
import type { Substitution, Term, Tree } from "./types.js";

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

export function findPath(id: Term, tree: Tree, path: number[] = []): number[] | null {
  if (termEq(tree.id, id)) return path;
  for (let i = 0; i < tree.children.length; i++) {
    const result = findPath(id, tree.children[i]!, [...path, i]);
    if (result !== null) return result;
  }
  return null;
}

export function nodeAt(tree: Tree, path: number[]): Tree | null {
  let node = tree;
  for (const idx of path) {
    if (idx >= node.children.length) return null;
    node = node.children[idx]!;
  }
  return node;
}

export function cloneTree(tree: Tree): Tree {
  return { ...tree, children: tree.children.map(cloneTree) };
}

export function collectPositiveNodes(tree: Tree): Tree[] {
  const self = tree.literal.literalType !== "Match" ? [tree] : [];
  return self.concat(tree.children.flatMap(collectPositiveNodes));
}

export function insertAt(tree: Tree, path: number[], child: Tree): void {
  const parent = nodeAt(tree, path);
  if (parent === null) throw new Error(`no node at path [${path}]`);
  parent.children.push(child);
}

// Given a node N (by id) in pattern, a reference tree, and a substitution from
// unifyTree, returns the reference node that is deepest among the images of all
// ancestors of N (including N itself) under the substitution.
export function deepestAncestorImage(
  nodeId: Term,
  pattern: Tree,
  reference: Tree,
  subst: Substitution
): Tree | null {
  const patPath = findPath(nodeId, pattern);
  if (patPath === null) return null;

  let deepestNode: Tree | null = null;
  let deepestDepth = -1;

  for (let len = 0; len <= patPath.length; len++) {
    const patNode = nodeAt(pattern, patPath.slice(0, len))!;
    const refId = substTerm(patNode.id, subst);
    const refPath = findPath(refId, reference);
    if (refPath === null) continue;
    if (refPath.length > deepestDepth) {
      deepestDepth = refPath.length;
      deepestNode = nodeAt(reference, refPath);
    }
  }

  return deepestNode;
}
