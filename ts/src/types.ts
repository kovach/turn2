export type Term =
  | { tag: "Symbol"; name: string }
  | { tag: "Variable"; name: string }
  | { tag: "Atom"; atom: Atom }
  | { tag: "Wildcard" }
  | { tag: "Ref"; id: number };

export type MatchConstraint = "delta" | "old" | "any";

export interface AggregateInfo {
  funcName: string;
  args: Term[];
  out: Term;
}

export type LiteralType =
  | { tag: "Match"; constraint: MatchConstraint }
  | { tag: "Before"; constraint: MatchConstraint }
  | { tag: "Assert" }
  | { tag: "Ask" }
  | { tag: "Constrain" }
  | { tag: "Aggregate"; info: AggregateInfo }
  | { tag: "Equal" };

export const isNegative = (t: LiteralType): boolean => t.tag === "Match" || t.tag === "Before" || t.tag === "Equal";
export const isPositive = (t: LiteralType): boolean => !isNegative(t);

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

// Integer key space for hashconsed terms and RefStore rows. Disjoint ranges
// per tag (assigned by `tokenOfId` in hashcons.ts): Ref → +N, Wildcard → 0,
// Symbol → odd negatives, Variable → even negatives.
export type NodeId = number;

export interface Span {
  line: number;      // 1-indexed line in original input
  startCol?: number;
  endCol?: number;
}

export interface Tree {
  id: Term;
  literal: Literal;
  children: Tree[];
  macroInvocation?: MacroInvocation;
  span?: Span;
  gen?: number;
}

// Substitution trail: two parallel mutable arrays. Bind = push; backtrack = `.length = mark`.
// After warmup the backing capacity is retained, so hot-path bind/unwind is allocation-free.
// Lookup scans tail-first so the most recent binding of a name shadows earlier ones.
export interface Trail {
  names: string[];
  terms: Term[];
}

export const newTrail = (): Trail => ({ names: [], terms: [] });

export const trailLength = (t: Trail): number => t.names.length;

export function trailPush(t: Trail, name: string, term: Term): void {
  t.names.push(name);
  t.terms.push(term);
}

export function trailUnwind(t: Trail, mark: number): void {
  t.names.length = mark;
  t.terms.length = mark;
}

export function trailLookup(t: Trail, name: string): Term | undefined {
  const names = t.names;
  for (let i = names.length - 1; i >= 0; i--) {
    if (names[i] === name) return t.terms[i];
  }
  return undefined;
}

export const sym = (name: string): Term => ({ tag: "Symbol", name });
export const vari = (name: string): Term => ({ tag: "Variable", name });
export const ref = (id: number): Term => ({ tag: "Ref", id });
export const atom = (terms: Term[]): Atom => ({ terms });
export const literal = (literalType: LiteralType, terms: Term[]): Literal => ({
  literalType,
  atom: { terms },
});
export const match = (constraint: MatchConstraint = "any"): LiteralType => ({ tag: "Match", constraint });
export const before = (constraint: MatchConstraint = "any"): LiteralType => ({ tag: "Before", constraint });
export const assert_ = (): LiteralType => ({ tag: "Assert" });
export const ask = (): LiteralType => ({ tag: "Ask" });
export const constrain = (): LiteralType => ({ tag: "Constrain" });
export const aggregate = (info: AggregateInfo): LiteralType => ({ tag: "Aggregate", info });
export const equal = (): LiteralType => ({ tag: "Equal" });

export const root = (children: Tree[]): Tree => ({
  id: { tag: "Variable", name: "0" },
  literal: { literalType: match(), atom: { terms: [] } },
  children,
});

export const node = (id: Term, terms: Term[], children: Tree[] = []): Tree => ({
  id,
  literal: { literalType: match(), atom: { terms } },
  children,
});

export const fact = (id: Term, terms: Term[], children: Tree[] = []): Tree => ({
  id,
  literal: { literalType: assert_(), atom: { terms } },
  children,
});
