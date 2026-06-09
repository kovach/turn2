// The core term layer for v2, duplicated from the v1 `types.ts` so v2 is
// free-standing (see plans/v1-cleanup.md). Only the term/trail subset lives
// here — the v1 Tree/Constraint/TurnExpr IRs stay in v1.

export type Term =
  | { tag: "Symbol"; name: string }
  | { tag: "Variable"; name: string }
  | { tag: "Atom"; atom: Atom }
  | { tag: "Id"; atom: Atom }
  | { tag: "Wildcard" }
  | { tag: "Ref"; id: number };

export interface Atom {
  terms: Term[];
}

// Integer key space for hashconsed terms. Disjoint ranges per tag (assigned
// by `tokenOfId` in hashcons.ts): Ref → +N, Wildcard → 0, Symbol → odd
// negatives, Variable → even negatives.
export type NodeId = number;

export interface Span {
  line: number;      // 1-indexed line in original input
  startCol?: number;
  endCol?: number;
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
export const idTerm = (a: Atom): Term => ({ tag: "Id", atom: a });
export const isId = (t: Term): t is { tag: "Id"; atom: Atom } => t.tag === "Id";
