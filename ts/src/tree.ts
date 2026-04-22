import { isPositive } from "./types.js";
import type { Term, Tree } from "./types.js";
import type { HashconsState } from "./hashcons.js";

function atomEq(aTerms: Term[], bTerms: Term[], hc: HashconsState): boolean {
  if (aTerms.length !== bTerms.length) return false;
  return aTerms.every((t, i) => termEq(t, bTerms[i]!, hc));
}

export function termEq(a: Term, b: Term, hc: HashconsState): boolean {
  if (a.tag === b.tag) {
    if (a.tag === "Symbol" && b.tag === "Symbol") return a.name === b.name;
    if (a.tag === "Variable" && b.tag === "Variable") return a.name === b.name;
    if (a.tag === "Ref" && b.tag === "Ref") return a.id === b.id;
    if (a.tag === "Atom" && b.tag === "Atom") return atomEq(a.atom.terms, b.atom.terms, hc);
    if (a.tag === "Wildcard") return true;
    return false;
  }
  // Cross-type: Atom vs Ref - look up ref to compare
  if (a.tag === "Atom" && b.tag === "Ref") {
    const refAtom = hc.refToAtom.get(b.id);
    return refAtom ? atomEq(a.atom.terms, refAtom.terms, hc) : false;
  }
  if (a.tag === "Ref" && b.tag === "Atom") {
    const refAtom = hc.refToAtom.get(a.id);
    return refAtom ? atomEq(refAtom.terms, b.atom.terms, hc) : false;
  }
  return false;
}

// Positive descendants of `pattern`, each carried with its parent and path.
// Pattern roots are Match, so the root itself is never positive; every
// returned entry has a non-null parent.
export interface PositiveNode {
  node: Tree;
  parent: Tree;
  path: number[];
}

export function collectPositiveNodes(pattern: Tree): PositiveNode[] {
  const out: PositiveNode[] = [];
  function walk(node: Tree, parent: Tree | null, path: number[]): void {
    if (parent !== null && isPositive(node.literal.literalType)) {
      out.push({ node, parent, path });
    }
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i]!, node, [...path, i]);
    }
  }
  walk(pattern, null, []);
  return out;
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

// --- Fringe functions (operate on nested pattern Trees) ---

function termContains(term: Term, value: Term, hc: HashconsState): boolean {
  if (termEq(term, value, hc)) return true;
  if (term.tag === "Atom") {
    return term.atom.terms.some((t) => termContains(t, value, hc));
  }
  return false;
}

function atomContainsValue(tree: Tree, value: Term, hc: HashconsState): boolean {
  return tree.literal.atom.terms.some((t) => termContains(t, value, hc));
}

function* walkTree(tree: Tree): Generator<Tree> {
  yield tree;
  for (const child of tree.children) {
    yield* walkTree(child);
  }
}

export function* fringe(value: Term, tree: Tree, hc: HashconsState): Generator<Tree> {
  for (const node of walkTree(tree)) {
    if (atomContainsValue(node, value, hc)) yield node;
  }
}

export function* unionFringe(values: Term[], tree: Tree, hc: HashconsState): Generator<Tree> {
  for (const node of walkTree(tree)) {
    if (values.some((v) => atomContainsValue(node, v, hc))) yield node;
  }
}

export function* intersectionFringe(values: Term[], tree: Tree, hc: HashconsState): Generator<Tree> {
  if (values.length === 0) return;
  for (const node of walkTree(tree)) {
    if (values.every((v) => atomContainsValue(node, v, hc))) yield node;
  }
}
