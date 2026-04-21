export type Term =
  | { tag: "Symbol"; name: string }
  | { tag: "Variable"; name: string }
  | { tag: "Atom"; atom: Atom }
  | { tag: "Wildcard" }
  | { tag: "Ref"; id: number };

export type LiteralType = "Match" | "Before" | "Assert" | "Ask" | "Constrain" | "Aggregate" | "Equal";

export const isNegative = (t: LiteralType): boolean => t === "Match" || t === "Before" || t === "Equal";
export const isPositive = (t: LiteralType): boolean => !isNegative(t);

export interface AggregateInfo {
  funcName: string;
  args: Term[];
  out: Term;
}

export interface Atom {
  terms: Term[];
}

export interface Literal {
  literalType: LiteralType;
  atom: Atom;
}

export interface MacroInvocation {
  name: string;
  args: Term[];
}

export interface Span {
  line: number;      // 1-indexed line in original input
  startCol?: number;
  endCol?: number;
}

export interface Tree {
  id: Term;
  literal: Literal;
  children: Tree[];
  aggregateInfo?: AggregateInfo;
  macroInvocation?: MacroInvocation;
  span?: Span;
}

export type Substitution = Map<string, Term>;

export const sym = (name: string): Term => ({ tag: "Symbol", name });
export const vari = (name: string): Term => ({ tag: "Variable", name });
export const ref = (id: number): Term => ({ tag: "Ref", id });
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
