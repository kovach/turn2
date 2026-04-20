import { isPositive } from "./types.js";
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
  const self = isPositive(tree.literal.literalType) ? [tree] : [];
  return self.concat(tree.children.flatMap(collectPositiveNodes));
}

// Path-based temporal ordering: a is before b and not an ancestor of b.
// True iff the first index where the paths diverge has a[i] < b[i].
// Returns false if a is an ancestor of b, a equals b, or a is after b.
export function isTemporallyBefore(aPath: number[], bPath: number[]): boolean {
  const n = Math.min(aPath.length, bPath.length);
  for (let i = 0; i < n; i++) {
    if (aPath[i]! < bPath[i]!) return true;
    if (aPath[i]! > bPath[i]!) return false;
  }
  return false;
}

// Nodes strictly before `target` in the temporal order defined in overview.md:
// siblings ordered by child index, and nested children inherit the ordering of
// their ancestor. Equivalent to: pre-order predecessors of target that are not
// ancestors of target.
export function nodesBefore(root: Tree, target: Tree): Tree[] {
  const visited: Tree[] = [];
  const ancestors = new Set<Tree>();
  let found = false;
  function walk(t: Tree): void {
    if (found) return;
    if (t === target) { found = true; return; }
    visited.push(t);
    ancestors.add(t);
    for (const c of t.children) {
      walk(c);
      if (found) return;
    }
    ancestors.delete(t);
  }
  walk(root);
  return visited.filter((n) => !ancestors.has(n));
}

export function insertAt(tree: Tree, path: number[], child: Tree): void {
  const parent = nodeAt(tree, path);
  if (parent === null) throw new Error(`no node at path [${path}]`);
  parent.children.push(child);
}

