import type { Atom, NodeId, Term } from "./types.js";

interface TrieNode {
  id?: number;
  children?: Map<NodeId, TrieNode>;
}

export interface HashconsState {
  root: TrieNode;
  refToAtom: Map<number, Atom>;
  // Sparse tag table for Refs whose body was constructed with `tag: "Id"`.
  // Absence means the Ref's body was a regular `Atom`. Reads via `refTagOf`.
  refTag: Map<number, "Id">;
  symIds: Map<string, number>;
  varIds: Map<string, number>;
  nextRefId: number;
  nextSymId: number;
  nextVarId: number;
  entryCount: number;
  // Sentinel tokens used as the first trie key for hashcons body lookups,
  // to keep `Atom` and `Id` keyspaces disjoint even when their bodies are
  // structurally identical. Allocated once in `createHashcons` from the
  // Symbol pool with names that the parser rejects.
  atomTagToken: NodeId;
  idTagToken: NodeId;
}

export function createHashcons(): HashconsState {
  const state: HashconsState = {
    root: {},
    refToAtom: new Map(),
    refTag: new Map(),
    symIds: new Map(),
    varIds: new Map(),
    nextRefId: 1,
    nextSymId: 0,
    nextVarId: 0,
    entryCount: 0,
    atomTagToken: 0,  // overwritten below
    idTagToken: 0,    // overwritten below
  };
  // Reserve sentinel Symbol tokens. Names contain `*`, which the parser
  // rejects in symbol positions, so user input cannot synthesise them.
  state.atomTagToken = tokenOf({ tag: "Symbol", name: "*atom*" }, state);
  state.idTagToken = tokenOf({ tag: "Symbol", name: "*id*" }, state);
  return state;
}

export function refTagOf(state: HashconsState, refId: number): "Atom" | "Id" {
  return state.refTag.get(refId) ?? "Atom";
}

// Disjoint integer ranges per tag keep tokens unambiguous as Map keys:
//   Ref       → +1, +2, +3, …
//   Wildcard  →  0
//   Symbol    → -1, -3, -5, …   (odd negatives)
//   Variable  → -2, -4, -6, …   (even negatives)
//
// Exported as `tokenOfId` for RefStore keying. The precondition (nested Atoms
// are already hashconsed to Refs) holds for any term used as a node id, since
// atom ids are hashconsed before reaching the store.
export function tokenOfId(term: Term, s: HashconsState): NodeId {
  return tokenOf(term, s);
}

function tokenOf(term: Term, s: HashconsState): NodeId {
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
    case "Id":
      throw new Error(`tokenOf: nested ${term.tag} should have been flattened to Ref`);
  }
}

export function hashconsTerm(term: Term, state: HashconsState): Term {
  if (term.tag !== "Atom" && term.tag !== "Id") return term;

  const flatTerms = term.atom.terms.map((t) => hashconsTerm(t, state));

  // Symmetric tag-prefix keying: `Atom` and `Id` bodies live in disjoint
  // sub-tries off `state.root`, so two terms with identical bodies but
  // different tags never collide.
  let node = state.root;
  const tagToken = term.tag === "Id" ? state.idTagToken : state.atomTagToken;
  {
    const children = node.children ?? (node.children = new Map());
    let next = children.get(tagToken);
    if (next === undefined) {
      next = {};
      children.set(tagToken, next);
    }
    node = next;
  }
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
  if (term.tag === "Id") state.refTag.set(id, "Id");
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
  const tag = refTagOf(state, term.id);
  return { tag, atom: { terms: atom.terms.map((t) => expandTerm(t, state)) } };
}
