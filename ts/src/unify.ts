import type { Atom, Literal, Substitution, Term, Tree } from "./types.js";
import { isTemporallyBefore } from "./tree.js";

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
}

function matchChildren(
  patChildren: Tree[],
  candidates: Candidate[],
  state: SearchState
): SearchState[] {
  if (patChildren.length === 0) return [state];
  const [head, ...tail] = patChildren as [Tree, ...Tree[]];
  const ht = head.literal.literalType;
  if (ht !== "Match" && ht !== "Before") {
    return matchChildren(tail, candidates, state);
  }
  const headResults = matchSubtree(head, candidates, state);
  return headResults.flatMap((s) => matchChildren(tail, candidates, { deepest: state.deepest, subst: s.subst }));
}

function matchSubtree(
  pat: Tree,
  candidates: Candidate[],
  { deepest, subst }: SearchState
): SearchState[] {
  const results: SearchState[] = [];
  const isBefore = pat.literal.literalType === "Before";
  for (const { path, node } of candidates) {
    if (isBefore) {
      if (!isTemporallyBefore(path, deepest)) continue;
    } else {
      if (!isStrictDescendant(deepest, path)) continue;
    }
    const s = unifyNode(pat, node, subst);
    if (s === null) continue;
    const childResults = matchChildren(pat.children, candidates, {
      deepest: path,
      subst: s,
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
  }).map((s) => s.subst);
}
