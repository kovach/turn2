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

export interface Atom {
  terms: Term[];
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

export interface TreeBase {
  macroInvocation?: MacroInvocation;
  span?: Span;
  gen?: number;
}

// Body fields common to every Tree case except Equal — see
// plans/refactor-tree-type-pt3.md.
export interface TreeBody {
  id: Term;
  atom: Atom;
  children: Tree[];
}

export type Tree =
  | (TreeBase & TreeBody & { tag: "Match"; constraint: MatchConstraint })
  | (TreeBase & TreeBody & { tag: "Before"; constraint: MatchConstraint })
  | (TreeBase & TreeBody & { tag: "Overlap"; constraint: MatchConstraint })
  | (TreeBase & TreeBody & { tag: "Assert" })
  | (TreeBase & TreeBody & { tag: "Constrain" })
  | (TreeBase & TreeBody & { tag: "Aggregate"; info: AggregateInfo })
  | (TreeBase & { tag: "Ask"; id: Term; atom: Atom })
  | (TreeBase & { tag: "Equal"; lhs: Term; rhs: Term });

// Body-bearing cases — every Tree case except Equal and Ask. Walkers that
// recurse on `tree.children` should narrow to this with
// `tree.tag !== "Equal" && tree.tag !== "Ask"` first.
export type BodyTree = Extract<Tree, TreeBody>;

// Safe accessors for the body fields. Equal carries none of these and Ask
// carries id+atom but no children — the accessors return empty/undefined
// for the missing positions so callers (mostly tests and generic walkers)
// don't have to repeat the tag guard inline.
export const treeChildren = (t: Tree): readonly Tree[] =>
  t.tag === "Equal" || t.tag === "Ask" ? [] : t.children;
export const treeAtom = (t: Tree): Atom | undefined =>
  t.tag === "Equal" ? undefined : t.atom;
export const treeAtomTerms = (t: Tree): readonly Term[] =>
  t.tag === "Equal" ? [] : t.atom.terms;
export const treeId = (t: Tree): Term | undefined =>
  t.tag === "Equal" ? undefined : t.id;

export const isPositiveTag = (tag: Tree["tag"]): boolean =>
  tag === "Assert" || tag === "Ask" || tag === "Constrain" || tag === "Aggregate";
export const isNegativeTag = (tag: Tree["tag"]): boolean => !isPositiveTag(tag);
export const isPositive = (t: Tree): boolean => isPositiveTag(t.tag);
export const isNegative = (t: Tree): boolean => isNegativeTag(t.tag);

// Cross-tag construction within the body-bearing cases: take the TreeBase
// + TreeBody fields from `base` and combine them with a fresh `tag` +
// per-case `payload`. Equal opts out — converting to or from Equal needs a
// different shape and isn't useful in practice (no caller does it).
type BodyTag = BodyTree["tag"];
type Payload<T extends BodyTag> =
  Omit<Extract<Tree, { tag: T }>, keyof TreeBase | keyof TreeBody | "tag">;

export function retag<T extends BodyTag>(
  base: BodyTree,
  tag: T,
  payload: Payload<T>,
): Extract<Tree, { tag: T }> {
  const { id, atom, children, macroInvocation, span, gen } = base;
  const out: Record<string, unknown> = { tag, id, atom, children, ...payload };
  if (macroInvocation !== undefined) out.macroInvocation = macroInvocation;
  if (span !== undefined) out.span = span;
  if (gen !== undefined) out.gen = gen;
  return out as unknown as Extract<Tree, { tag: T }>;
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

export const root = (children: Tree[]): Tree => ({
  tag: "Match",
  constraint: "any",
  id: { tag: "Wildcard" },
  atom: { terms: [] },
  children,
});

export const node = (id: Term, terms: Term[], children: Tree[] = []): Tree => ({
  tag: "Match",
  constraint: "any",
  id,
  atom: { terms },
  children,
});

export const fact = (id: Term, terms: Term[], children: Tree[] = []): Tree => ({
  tag: "Assert",
  id,
  atom: { terms },
  children,
});

export const eq = (lhs: Term, rhs: Term): Tree => ({ tag: "Equal", lhs, rhs });
