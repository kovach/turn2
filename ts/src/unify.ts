import type { Atom, Constraint, MatchConstraint, Term, Trail, Tree, TurnExpr } from "./types.js";
import { isPositiveConstraint, newTrail, trailLength, trailLookup, trailPush, trailUnwind } from "./types.js";
import { hashconsAtom, hashconsTerm, refTagOf, createHashcons, type HashconsState } from "./hashcons.js";
import type { Candidate, NodeRow, RefStore, SymbolIndex } from "./refstore.js";
import { addBeforeAfter, addParentChild, allCandidates, beforeAfter, emptyRefStore, idKey, insertRow, overlap, prior, strictlyContains } from "./refstore.js";
import { lower } from "./lower.js";

export type { Candidate, SymbolIndex } from "./refstore.js";

export const unifyStats = {
  c: 0,
};

export function resetUnifyStats(): void {
  unifyStats.c = 0;
}

// --- Term substitution ---

// Chase variable bindings to the first non-Variable term. Does NOT recurse
// into atoms — sub-terms of atoms stay unresolved. This is what unifyTerms
// needs internally: any Variables inside an Atom will be resolved lazily
// when unifyAtoms descends into them.
function resolveVar(term: Term, trail: Trail): Term {
  let t = term;
  while (t.tag === "Variable") {
    const bound = trailLookup(trail, t.name);
    if (bound === undefined) break;
    t = bound;
  }
  return t;
}

// Full substitution: chase variables AND recursively substitute atom contents.
// Needed by external callers (step, expand, computeAnchor) that materialize a
// concrete term for insertion / path lookup.
export function substTerm(term: Term, trail: Trail): Term {
  const t = resolveVar(term, trail);
  if (t.tag === "Atom" || t.tag === "Id") {
    return { tag: t.tag, atom: substAtom(t.atom, trail) };
  }
  return t;
}

let counter = 0;

export function substAtom(atom: Atom, trail: Trail): Atom {
  unifyStats.c++;
  return { terms: atom.terms.map((t) => substTerm(t, trail)) };
}

// --- Term unification ---
//
// Convention: primitives (`unifyTerms`, `unifyAtoms`, `unifyNode`) never unwind the
// trail on their own failure. Every choice-point caller (`matchSubtree`, the Equal
// branch of `matchChildrenFrom`, and the top of `unifyTree`) must wrap the attempt
// in `mark = trailLength(...)` / `trailUnwind(..., mark)` so that partial bindings
// from a failed branch never leak into the next one.

// Invariant: a variable on the trail is never bound to a raw Atom. Atoms
// passed to trailPush get fully substituted and hashconsed to a Ref first,
// so later substTerm calls bottom out on the Ref instead of re-walking the
// bound body for every occurrence. See plans/trail-hashcons.md.
function assertGround(atom: Atom, trail: Trail): void {
  for (const t of atom.terms) {
    const r = resolveVar(t, trail);
    if (r.tag === "Variable") {
      throw new Error(`unify: cannot bind atom with free variable ${r.name}`);
    }
    if (r.tag === "Atom" || r.tag === "Id") assertGround(r.atom, trail);
  }
}

function bindable(t: Term, trail: Trail, hc: HashconsState): Term {
  if (t.tag !== "Atom" && t.tag !== "Id") return t;
  const substituted = substAtom(t.atom, trail);
  assertGround(substituted, trail);
  return hashconsTerm({ tag: t.tag, atom: substituted }, hc);
}

export function unifyTerms(a: Term, b: Term, trail: Trail, hc: HashconsState): boolean {
  const sa = resolveVar(a, trail);
  const sb = resolveVar(b, trail);

  if (sa.tag === "Wildcard" || sb.tag === "Wildcard") return true;

  if (sa.tag === "Symbol" && sb.tag === "Symbol") return sa.name === sb.name;
  if (sa.tag === "Ref" && sb.tag === "Ref") return sa.id === sb.id;

  if (sa.tag === "Variable") {
    if (sb.tag === "Variable" && sa.name === sb.name) return true;
    trailPush(trail, sa.name, bindable(sb, trail, hc));
    return true;
  }

  if (sb.tag === "Variable") {
    trailPush(trail, sb.name, bindable(sa, trail, hc));
    return true;
  }

  // Atom-vs-Atom and Id-vs-Id unify by body. Atom-vs-Id never unify — they
  // are distinct kinds (an `Id` term is opaque to the rest of the engine).
  if (sa.tag === "Atom" && sb.tag === "Atom") {
    return unifyAtoms(sa.atom, sb.atom, trail, hc);
  }
  if (sa.tag === "Id" && sb.tag === "Id") {
    return unifyAtoms(sa.atom, sb.atom, trail, hc);
  }

  // Atom/Id vs Ref: look up the ref's stored body and tag — only unify when
  // tags match. `refTagOf` returns "Atom" for refs whose body was stored as
  // a regular Atom, "Id" for id-headed bodies.
  if ((sa.tag === "Atom" || sa.tag === "Id") && sb.tag === "Ref") {
    if (refTagOf(hc, sb.id) !== sa.tag) return false;
    const refAtom = hc.refToAtom.get(sb.id);
    if (refAtom) return unifyAtoms(sa.atom, refAtom, trail, hc);
  }
  if (sa.tag === "Ref" && (sb.tag === "Atom" || sb.tag === "Id")) {
    if (refTagOf(hc, sa.id) !== sb.tag) return false;
    const refAtom = hc.refToAtom.get(sa.id);
    if (refAtom) return unifyAtoms(refAtom, sb.atom, trail, hc);
  }

  return false;
}

function unifyAtoms(pa: Atom, ra: Atom, trail: Trail, hc: HashconsState): boolean {
  if (pa.terms.length !== ra.terms.length) return false;
  for (let i = 0; i < pa.terms.length; i++) {
    if (!unifyTerms(pa.terms[i]!, ra.terms[i]!, trail, hc)) return false;
  }
  return true;
}

// --- Reference enumeration ---
//
// The reference tree is reified as a flat RefStore (see refstore.ts and
// plans/relational-storage.md). Candidate enumeration is either:
//   - a SymbolIndex bucket lookup when the pattern's first term is a Symbol, or
//   - `allCandidates(store)` — a scan of every row — otherwise.
//
// MUTATION NOTE: consumers may insert rows into `store` *during* iteration
// (a visit() callback deriving new facts). JS Map/Array iteration visits
// entries appended during iteration, so pushes into a live scan may produce
// extra yields. Safety relies on passesConstraint rejecting those newly
// inserted rows (gen === iteration falls outside every constraint:
// any/delta/old). If the constraint model ever grows a case that *should*
// see same-iteration nodes, this invariant has to be revisited.

// --- Constraint checking ---

function passesConstraint(row: { gen: number }, constraint: MatchConstraint, iteration: number): boolean {
  const gen = row.gen;
  if (constraint === "any") return gen < iteration;
  if (constraint === "delta") return gen === iteration - 1;
  if (constraint === "old") return gen < iteration - 1;
  return true;
}

// --- TE-driven unifier ---
//
// Walks the matching prefix of a TurnExpr (Match / IntervalRel / Equal),
// pushing/unwinding the trail at choice points. When the prefix is
// satisfied, calls `visit(trail, suffixStart)` — `suffixStart` is the
// index of the first positive constraint (Assert / Constrain /
// AssertIntervalRel), or `cs.length` if there are none. Caller dispatches
// the assertion suffix in the visit callback (see step.ts).
//
// IntervalRel.kind dispatch maps to the existing refstore helpers:
//   contains     → strictlyContains   (excludes self, matches Match descent today)
//   before:after → beforeAfter        (a precedes b)
//   overlap      → overlap
//   prior        → prior
//
// Mutation-during-iteration: row inserts during the visit are allocated
// with `gen === iteration`; passesConstraint hides them from the live
// matching pass under any/old/delta semantics. Edge inserts have no gen
// and are not matched against — they only refine subsequent constraints
// in the same TE, never spawn new candidates.

export function unifyConstraints(
  te: TurnExpr,
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail, suffixStart: number) => void,
): void {
  const cs = te.constraints;
  unifyConstraintsAt(cs, 0, store, trail, iteration, hc, visit);
}

function unifyConstraintsAt(
  cs: readonly Constraint[],
  start: number,
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail, suffixStart: number) => void,
): void {
  // Walk linear (no choice-point) constraints inline, recurse on choice
  // points (Match / Equal). Hand off to `visit` at the first positive
  // constraint or when the list is exhausted.
  let i = start;
  while (i < cs.length) {
    const c = cs[i]!;

    if (isPositiveConstraint(c)) {
      visit(trail, i);
      return;
    }

    if (c.tag === "IntervalRel") {
      if (!checkIntervalRel(c, store, trail, hc)) return;
      i++;
      continue;
    }

    if (c.tag === "Equal") {
      const mark = trailLength(trail);
      if (unifyTerms(c.lhs, c.rhs, trail, hc)) {
        unifyConstraintsAt(cs, i + 1, store, trail, iteration, hc, visit);
      }
      trailUnwind(trail, mark);
      return;
    }

    // c.tag === "Match" — choice point.
    matchAt(c, cs, i, store, trail, iteration, hc, visit);
    return;
  }
  visit(trail, cs.length);
}

function matchAt(
  match: Extract<Constraint, { tag: "Match" }>,
  cs: readonly Constraint[],
  i: number,
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail, suffixStart: number) => void,
): void {
  const firstTerm = match.atom.terms[0];
  const candidates: Iterable<Candidate> = (firstTerm?.tag === "Symbol")
    ? (store.index.get(firstTerm.name) ?? [])
    : allCandidates(store);

  for (const { node } of candidates) {
    if (!passesConstraint(node, match.mode, iteration)) continue;
    if (node.tag === "Constrain") continue;  // Constrain rows aren't unification targets
    const mark = trailLength(trail);
    if (unifyTerms(match.id, node.id, trail, hc) &&
        unifyAtoms(match.atom, node.atom, trail, hc)) {
      unifyConstraintsAt(cs, i + 1, store, trail, iteration, hc, visit);
    }
    trailUnwind(trail, mark);
  }
}

function checkIntervalRel(
  c: Extract<Constraint, { tag: "IntervalRel" }>,
  store: RefStore,
  trail: Trail,
  hc: HashconsState,
): boolean {
  const aTerm = substTerm(c.a, trail);
  const bTerm = substTerm(c.b, trail);
  if (aTerm.tag === "Variable" || bTerm.tag === "Variable") return false;
  const aId = idKey(toRefIfNested(aTerm, hc), hc);
  const bId = idKey(toRefIfNested(bTerm, hc), hc);
  switch (c.kind) {
    case "contains":     return strictlyContains(store, aId, bId);
    case "before:after": return beforeAfter(store, aId, bId);
    case "overlap":      return overlap(store, aId, bId);
    case "prior":        return prior(store, aId, bId);
  }
}

function toRefIfNested(t: Term, hc: HashconsState): Term {
  return (t.tag === "Atom" || t.tag === "Id") ? hashconsTerm(t, hc) : t;
}

// --- Entry point ---

/**
 * Enumerate matches of `pattern` against `reference`. For each successful match,
 * `visit(trail)` fires while the trail contains all bindings for that match.
 * The callback must consume (or snapshot) the bindings before returning — the
 * trail is unwound immediately afterward.
 *
 * The trail is caller-owned: passing the same Trail across many `unifyTree`
 * calls reuses its backing storage. The trail must be empty when passed in
 * and will be empty on return (assuming visit doesn't mutate it).
 *
 * Visit must not re-enter the unifier using the same trail.
 */
export function unifyTree(
  pattern: Tree,
  reference: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail) => void,
): void {
  // Shim: lower the pattern to a TurnExpr and drive matching via
  // unifyConstraints. The visit fires only after the matching prefix is
  // satisfied; the assertion suffix (Assert/Constrain/AssertIntervalRel)
  // is the caller's responsibility — they can iterate
  // `te.constraints.slice(suffixStart)` themselves. This shim ignores it,
  // matching the pre-TE `unifyTree` contract for callers that only want
  // bindings (see `collectMatches`, `constraint-query.ts`).
  const te = lower(pattern);
  unifyConstraints(te, reference, trail, iteration, hc, () => visit(trail));
}

// --- Test-only helper: collect all substitutions as plain records. ---
// Intended for tests that need to assert over the set of solutions. The
// `reference` Tree's outer wrapper is discarded — its children become the
// roots of the store's forest (parentless rows). Sibling `before:after`
// edges are emitted between consecutive children at every level, mirroring
// the implicit ordering that the source-tree-walker provided.
export function collectMatches(
  pattern: Tree,
  reference: Tree,
  iteration: number = 1,
): Array<Map<string, Term>> {
  const out: Array<Map<string, Term>> = [];
  const trail = newTrail();
  const hc = createHashcons();
  const store = emptyRefStore(hc);

  function insertSubtree(node: Tree, parentId: Term | null): Term {
    if (node.tag !== "Assert" && node.tag !== "Constrain") {
      throw new Error(`collectMatches: reference subtree has tag ${node.tag}; expected Assert/Constrain`);
    }
    const hashedId = hashconsTerm(node.id, hc);
    const hashedAtom = hashconsAtom(node.atom, hc);
    const row: NodeRow = {
      tag: node.tag,
      id: hashedId,
      atom: hashedAtom,
      gen: node.gen ?? 0,
    };
    insertRow(store, row, hc);
    if (parentId !== null) addParentChild(store, parentId, hashedId, hc);
    // Sibling before:after edges: mirror the ordering that the source-tree
    // walker provided for nested children.
    let prev: Term | null = null;
    for (const child of node.children) {
      const childId = insertSubtree(child, hashedId);
      if (prev !== null) addBeforeAfter(store, prev, childId, hc);
      prev = childId;
    }
    return hashedId;
  }
  if (reference.tag === "Equal" || reference.tag === "Ask") {
    throw new Error(`collectMatches: top-level ${reference.tag} is not a valid reference`);
  }
  let prev: Term | null = null;
  for (const child of reference.children) {
    const childId = insertSubtree(child, null);
    if (prev !== null) addBeforeAfter(store, prev, childId, hc);
    prev = childId;
  }

  unifyTree(pattern, store, trail, iteration, hc, (t) => {
    const row = new Map<string, Term>();
    // Tail-first so shadowing picks the most recent binding.
    for (let i = t.names.length - 1; i >= 0; i--) {
      const k = t.names[i]!;
      if (!row.has(k)) row.set(k, t.terms[i]!);
    }
    out.push(row);
  });
  return out;
}
