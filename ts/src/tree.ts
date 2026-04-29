import type { BodyTree, Term, Tree } from "./types.js";
import { refTagOf, type HashconsState } from "./hashcons.js";

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
    if (a.tag === "Id" && b.tag === "Id") return atomEq(a.atom.terms, b.atom.terms, hc);
    if (a.tag === "Wildcard") return true;
    return false;
  }
  // Cross-type: Atom/Id vs Ref. Only equal when the Ref's stored body has a
  // matching tag (Atom-tagged refs to Id-tagged bodies are distinct kinds).
  if ((a.tag === "Atom" || a.tag === "Id") && b.tag === "Ref") {
    if (refTagOf(hc, b.id) !== a.tag) return false;
    const refAtom = hc.refToAtom.get(b.id);
    return refAtom ? atomEq(a.atom.terms, refAtom.terms, hc) : false;
  }
  if (a.tag === "Ref" && (b.tag === "Atom" || b.tag === "Id")) {
    if (refTagOf(hc, a.id) !== b.tag) return false;
    const refAtom = hc.refToAtom.get(a.id);
    return refAtom ? atomEq(refAtom.terms, b.atom.terms, hc) : false;
  }
  return false;
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
  if (term.tag === "Atom" || term.tag === "Id") {
    return term.atom.terms.some((t) => termContains(t, value, hc));
  }
  return false;
}

function atomContainsValue(tree: BodyTree, value: Term, hc: HashconsState): boolean {
  return tree.atom.terms.some((t) => termContains(t, value, hc));
}

function* walkTree(tree: Tree): Generator<BodyTree> {
  if (tree.tag === "Equal" || tree.tag === "Ask") return;
  yield tree;
  for (const child of tree.children) {
    yield* walkTree(child);
  }
}

export function* fringe(value: Term, tree: Tree, hc: HashconsState): Generator<BodyTree> {
  for (const node of walkTree(tree)) {
    if (atomContainsValue(node, value, hc)) yield node;
  }
}

export function* unionFringe(values: Term[], tree: Tree, hc: HashconsState): Generator<BodyTree> {
  for (const node of walkTree(tree)) {
    if (values.some((v) => atomContainsValue(node, v, hc))) yield node;
  }
}

export function* intersectionFringe(values: Term[], tree: Tree, hc: HashconsState): Generator<BodyTree> {
  if (values.length === 0) return;
  for (const node of walkTree(tree)) {
    if (values.every((v) => atomContainsValue(node, v, hc))) yield node;
  }
}
