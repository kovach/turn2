import type { Atom, Term } from "./types.js";

export interface HashconsState {
  atomToRef: Map<string, number>;
  refToAtom: Map<number, Atom>;
  nextId: number;
}

export function createHashcons(): HashconsState {
  return { atomToRef: new Map(), refToAtom: new Map(), nextId: 1 };
}

function canonicalizeTerm(term: Term): string {
  switch (term.tag) {
    case "Symbol": return `s:${term.name}`;
    case "Variable": return `v:${term.name}`;
    case "Ref": return `r:${term.id}`;
    case "Wildcard": return "_";
    case "Atom": return `(${term.atom.terms.map(canonicalizeTerm).join(" ")})`;
  }
}

function canonicalize(atom: Atom): string {
  return atom.terms.map(canonicalizeTerm).join(" ");
}

export function hashconsTerm(term: Term, state: HashconsState): Term {
  if (term.tag !== "Atom") return term;

  const flatTerms = term.atom.terms.map(t => hashconsTerm(t, state));
  const flatAtom: Atom = { terms: flatTerms };

  const key = canonicalize(flatAtom);
  const existing = state.atomToRef.get(key);
  if (existing !== undefined) {
    return { tag: "Ref", id: existing };
  }

  const id = state.nextId++;
  state.atomToRef.set(key, id);
  state.refToAtom.set(id, flatAtom);
  return { tag: "Ref", id };
}

export function hashconsAtom(atom: Atom, state: HashconsState): Atom {
  return { terms: atom.terms.map(t => hashconsTerm(t, state)) };
}

export function expandTerm(term: Term, state: HashconsState): Term {
  if (term.tag !== "Ref") return term;
  const atom = state.refToAtom.get(term.id);
  if (!atom) return term;
  return { tag: "Atom", atom: { terms: atom.terms.map(t => expandTerm(t, state)) } };
}
