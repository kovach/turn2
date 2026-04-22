import type { Atom, Term } from "./types.js";

type Token = number;

interface TrieNode {
  id?: number;
  children?: Map<Token, TrieNode>;
}

export interface HashconsState {
  root: TrieNode;
  refToAtom: Map<number, Atom>;
  symIds: Map<string, number>;
  varIds: Map<string, number>;
  nextRefId: number;
  nextSymId: number;
  nextVarId: number;
  entryCount: number;
}

export function createHashcons(): HashconsState {
  return {
    root: {},
    refToAtom: new Map(),
    symIds: new Map(),
    varIds: new Map(),
    nextRefId: 1,
    nextSymId: 0,
    nextVarId: 0,
    entryCount: 0,
  };
}

// Disjoint integer ranges per tag keep tokens unambiguous as Map keys:
//   Ref       → +1, +2, +3, …
//   Wildcard  →  0
//   Symbol    → -1, -3, -5, …   (odd negatives)
//   Variable  → -2, -4, -6, …   (even negatives)
function tokenOf(term: Term, s: HashconsState): Token {
  switch (term.tag) {
    case "Ref":      return term.id;
    case "Wildcard": return 0;
    case "Symbol": {
      let id = s.symIds.get(term.name);
      if (id === undefined) { id = -(2 * s.nextSymId++ + 1); s.symIds.set(term.name, id); }
      return id;
    }
    case "Variable": {
      let id = s.varIds.get(term.name);
      if (id === undefined) { id = -(2 * s.nextVarId++ + 2); s.varIds.set(term.name, id); }
      return id;
    }
    case "Atom":
      throw new Error("tokenOf: nested Atom should have been flattened to Ref");
  }
}

export function hashconsTerm(term: Term, state: HashconsState): Term {
  if (term.tag !== "Atom") return term;

  const flatTerms = term.atom.terms.map((t) => hashconsTerm(t, state));

  let node = state.root;
  for (const t of flatTerms) {
    const tok = tokenOf(t, state);
    const children = node.children ?? (node.children = new Map());
    let next = children.get(tok);
    if (next === undefined) {
      next = {};
      children.set(tok, next);
    }
    node = next;
  }

  if (node.id !== undefined) return { tag: "Ref", id: node.id };

  const id = state.nextRefId++;
  node.id = id;
  state.refToAtom.set(id, { terms: flatTerms });
  state.entryCount++;
  return { tag: "Ref", id };
}

export function hashconsAtom(atom: Atom, state: HashconsState): Atom {
  return { terms: atom.terms.map((t) => hashconsTerm(t, state)) };
}

export function expandTerm(term: Term, state: HashconsState): Term {
  if (term.tag !== "Ref") return term;
  const atom = state.refToAtom.get(term.id);
  if (!atom) return term;
  return { tag: "Atom", atom: { terms: atom.terms.map((t) => expandTerm(t, state)) } };
}
