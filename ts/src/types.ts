export type Term =
  | { tag: "Symbol"; name: string }
  | { tag: "Variable"; name: string }
  | { tag: "Atom"; atom: Atom }
  | { tag: "Wildcard" };

export type LiteralType = "Match" | "Assert" | "Ask" | "Constrain";

export interface Atom {
  terms: Term[];
}

export interface Literal {
  literalType: LiteralType;
  atom: Atom;
}

export interface Tree {
  id: Term;
  literal: Literal;
  children: Tree[];
}

export type Substitution = Map<string, Term>;

export const sym = (name: string): Term => ({ tag: "Symbol", name });
export const vari = (name: string): Term => ({ tag: "Variable", name });
export const atom = (terms: Term[]): Atom => ({ terms });
export const literal = (literalType: LiteralType, terms: Term[]): Literal => ({
  literalType,
  atom: { terms },
});
export const root = (children: Tree[]): Tree => ({
  id: { tag: "Variable", name: "0" },
  literal: { literalType: "Match", atom: { terms: [] } },
  children,
});

export const node = (id: Term, terms: Term[], children: Tree[] = []): Tree => ({
  id,
  literal: { literalType: "Match", atom: { terms } },
  children,
});

export const fact = (id: Term, terms: Term[], children: Tree[] = []): Tree => ({
  id,
  literal: { literalType: "Assert", atom: { terms } },
  children,
});
