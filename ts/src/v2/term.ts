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
  startCol?: number; // 0-indexed, inclusive; line.slice(startCol, endCol)
  endCol?: number;   // is the atom's source text (marker char included)
  // Set on top-level items (rules, acc rules, `#acc` / `#js` / `#js-def`
  // declarations): the last source line the item's tokens come from, so
  // `line..endLine` is its text (comment-only lines inside included).
  endLine?: number;
}

// DOM attribute value for per-atom source ↔ output linking
// (`data-source-span`, see source-link.ts): "12:4-19". Returns undefined for
// a column-less span so a regression in the parser's column stamping surfaces
// as missing links rather than collapsing distinct atoms onto one line key.
export function spanKey(s: Span | undefined): string | undefined {
  if (s === undefined || s.startCol === undefined || s.endCol === undefined) return undefined;
  return `${s.line}:${s.startCol}-${s.endCol}`;
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
  // pop rather than `length = mark`: unwinds are almost always a few
  // entries, and shrinking via `length` makes V8 re-trim the backing store.
  const names = t.names, terms = t.terms;
  while (names.length > mark) { names.pop(); terms.pop(); }
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

// String literals (plans/v2-strings-icon-css.md) are Symbols whose name is
// the literal's source text, quotes included: `"a b"`. Escapes are `\"` and
// `\\`, so the source spelling is canonical and the name round-trips as is.
export function isStringName(name: string): boolean {
  return name.length >= 2 && name[0] === "\"" && name[name.length - 1] === "\"";
}

// The value of a string literal term, or null for anything else.
export function stringValue(t: Term): string | null {
  if (t.tag !== "Symbol" || !isStringName(t.name)) return null;
  return t.name.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

// The literal (Symbol name) for a string value.
export function quoteString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => "\\" + c)}"`;
}

export const str = (s: string): Term => ({ tag: "Symbol", name: quoteString(s) });
