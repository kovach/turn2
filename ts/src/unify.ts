import type { Atom, Literal, Substitution, Term, Tree } from "./types.js";
import { findPath, isTemporallyBefore } from "./tree.js";
import { hashconsTerm, type HashconsState } from "./hashcons.js";

// --- Term substitution ---

export function substTerm(term: Term, subst: Substitution): Term {
  let t = term;
  while (t.tag === "Variable" && subst.has(t.name)) {
    t = subst.get(t.name)!;
  }
  if (t.tag === "Atom") {
    return { tag: "Atom", atom: substAtom(t.atom, subst) };
  }
  return t;
}

export function substAtom(atom: Atom, subst: Substitution): Atom {
  return { terms: atom.terms.map((t) => substTerm(t, subst)) };
}

// --- Term unification ---

let _hcState: HashconsState | null = null;

export function setUnifyHashcons(hc: HashconsState | null): void {
  _hcState = hc;
}

export function unifyTerms(
  a: Term,
  b: Term,
  subst: Substitution
): Substitution | null {
  const sa = substTerm(a, subst);
  const sb = substTerm(b, subst);

  if (sa.tag === "Wildcard" || sb.tag === "Wildcard") return subst;

  if (sa.tag === "Symbol" && sb.tag === "Symbol") {
    return sa.name === sb.name ? subst : null;
  }

  if (sa.tag === "Ref" && sb.tag === "Ref") {
    return sa.id === sb.id ? subst : null;
  }

  if (sa.tag === "Variable") {
    if (sb.tag === "Variable" && sa.name === sb.name) return subst;
    const next = new Map(subst);
    next.set(sa.name, sb);
    return next;
  }

  if (sb.tag === "Variable") {
    const next = new Map(subst);
    next.set(sb.name, sa);
    return next;
  }

  if (sa.tag === "Atom" && sb.tag === "Atom") {
    return unifyAtoms(sa.atom, sb.atom, subst);
  }

  // Atom vs Ref: look up the ref to get the stored atom
  if (sa.tag === "Atom" && sb.tag === "Ref" && _hcState) {
    const refAtom = _hcState.refToAtom.get(sb.id);
    if (refAtom) return unifyAtoms(sa.atom, refAtom, subst);
  }
  if (sa.tag === "Ref" && sb.tag === "Atom" && _hcState) {
    const refAtom = _hcState.refToAtom.get(sa.id);
    if (refAtom) return unifyAtoms(refAtom, sb.atom, subst);
  }

  return null;
}

function unifyAtoms(
  pa: Atom,
  ra: Atom,
  subst: Substitution
): Substitution | null {
  if (pa.terms.length !== ra.terms.length) return null;
  let s: Substitution | null = subst;
  for (let i = 0; i < pa.terms.length; i++) {
    s = unifyTerms(pa.terms[i]!, ra.terms[i]!, s!);
    if (s === null) return null;
  }
  return s;
}

function unifyLiterals(
  pl: Literal,
  rl: Literal,
  subst: Substitution
): Substitution | null {
  return unifyAtoms(pl.atom, rl.atom, subst);
}

// --- Node unification (id + literal) ---

function unifyNode(
  pat: Tree,
  ref: Tree,
  subst: Substitution
): Substitution | null {
  if (pat.literal.literalType !== "Match" && pat.literal.literalType !== "Before") return null;
  if (ref.literal.literalType !== "Assert" && ref.literal.literalType !== "Ask") return null;
  const s1 = unifyTerms(pat.id, ref.id, subst);
  if (s1 === null) return null;
  return unifyAtoms(pat.literal.atom, ref.literal.atom, s1);
}

// --- Reference tree enumeration ---

interface Candidate {
  path: number[];
  node: Tree;
}

function collectNodes(tree: Tree, path: number[]): Candidate[] {
  const out: Candidate[] = [{ path, node: tree }];
  for (let i = 0; i < tree.children.length; i++) {
    out.push(...collectNodes(tree.children[i]!, [...path, i]));
  }
  return out;
}

function isStrictDescendant(ancestor: number[], path: number[]): boolean {
  if (path.length <= ancestor.length) return false;
  return ancestor.every((v, i) => v === path[i]);
}

// --- Main search ---

interface SearchState {
  deepest: number[];
  subst: Substitution;
  root: Tree;
}

function matchChildren(
  patChildren: Tree[],
  candidates: Candidate[],
  state: SearchState
): SearchState[] {
  return matchChildrenFrom(patChildren, 0, candidates, state);
}

function matchChildrenFrom(
  patChildren: Tree[],
  idx: number,
  candidates: Candidate[],
  state: SearchState
): SearchState[] {
  if (idx >= patChildren.length) return [state];
  const head = patChildren[idx]!;
  const ht = head.literal.literalType;

  if (ht === "Equal") {
    const terms = head.literal.atom.terms;
    if (terms.length !== 2) return [];
    const unified = unifyTerms(terms[0]!, terms[1]!, state.subst);
    if (unified === null) return [];
    return matchChildrenFrom(patChildren, idx + 1, candidates, { ...state, subst: unified });
  }

  if (ht !== "Match" && ht !== "Before") {
    return matchChildrenFrom(patChildren, idx + 1, candidates, state);
  }

  const anchor = computeAnchor(patChildren, idx, state);
  const headResults = matchSubtree(head, candidates, state, anchor);
  return headResults.flatMap((s) =>
    matchChildrenFrom(patChildren, idx + 1, candidates, { ...state, subst: s.subst })
  );
}

function computeAnchor(
  siblings: Tree[],
  idx: number,
  state: SearchState
): number[] {
  const node = siblings[idx]!;
  if (node.literal.literalType !== "Before") return state.deepest;

  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i]!;
    const lt = sib.literal.literalType;
    if (lt === "Match" || lt === "Before") {
      const boundId = substTerm(sib.id, state.subst);
      const path = findPath(boundId, state.root);
      if (path !== null) return path;
    }
  }
  return state.deepest;
}

function matchSubtree(
  pat: Tree,
  candidates: Candidate[],
  state: SearchState,
  anchor: number[]
): SearchState[] {
  const results: SearchState[] = [];
  const isBefore = pat.literal.literalType === "Before";
  for (const { path, node } of candidates) {
    if (isBefore) {
      if (!isTemporallyBefore(path, anchor)) continue;
    } else {
      if (!isStrictDescendant(state.deepest, path)) continue;
    }
    const s = unifyNode(pat, node, state.subst);
    if (s === null) continue;
    const childResults = matchChildren(pat.children, candidates, {
      deepest: path,
      subst: s,
      root: state.root,
    });
    results.push(...childResults);
  }
  return results;
}

// --- Entry point ---

export function unifyTree(pattern: Tree, reference: Tree): Substitution[] {
  if (pattern.literal.literalType !== "Match" || pattern.literal.atom.terms.length !== 0) return [];
  const rootSubst = unifyTerms(pattern.id, reference.id, new Map());
  if (rootSubst === null) return [];
  const candidates = collectNodes(reference, []);
  return matchChildren(pattern.children, candidates, {
    deepest: [],
    subst: rootSubst,
    root: reference,
  }).map((s) => s.subst);
}
