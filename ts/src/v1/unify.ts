import type { Atom, Constraint, MatchConstraint, MatchingConstraint, Term, Trail, Tree, TurnExpr } from "./types.js";
import { newTrail, trailLength, trailLookup, trailPush, trailUnwind } from "./types.js";
import { hashconsAtom, hashconsTerm, refTagOf, createHashcons, type HashconsState } from "./hashcons.js";
import type { Candidate, NodeId, NodeRow, RefStore, SymbolIndex } from "./refstore.js";
import { addBeforeAfter, addParentChild, allCandidates, ancestorsOf, beforeAfter, descendantsOf, emptyRefStore, getNode, idKey, insertRow, overlap, overlapsOf, predecessorsOf, prior, priorOf, strictlyContains, successorsOf } from "./refstore.js";
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
export function resolveVar(term: Term, trail: Trail): Term {
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

export function unifyAtoms(pa: Atom, ra: Atom, trail: Trail, hc: HashconsState): boolean {
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
// Walks `te.matching` (Match / IntervalRel / Equal), pushing/unwinding
// the trail at choice points. When the matching list is exhausted,
// calls `visit(trail)` once. The caller dispatches `te.assertions` in
// that callback (see step.ts).
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
  visit: (trail: Trail) => void,
): void {
  // `done` tracks which constraints the scheduler has already chosen on
  // the current branch. Sized to te.matching.length and reused via
  // mark/restore semantics inside unifyConstraintsAt.
  const done = new Array<boolean>(te.matching.length).fill(false);
  unifyConstraintsAt(te.matching, done, store, trail, iteration, hc, visit);
}

// Readiness classification: given the current trail, what mode does
// this constraint run in?
//
//   - "check"     — every term is bound; evaluate as yes/no (Equal and
//                   Match-with-bound-id may still propagate bindings).
//   - "enumerate" — at least one term is unbound, but the constraint
//                   can iterate candidates that satisfy it.
//   - "blocked"   — too unbound to make progress without an effectively
//                   unbounded scan. Only `IntervalRel` with both
//                   endpoints unbound reaches this state under current
//                   lowering; the scheduler treats it as "wait until
//                   another constraint binds something."
type ReadyMode = "check" | "enumerate" | "blocked";

// Deep ground check: every Variable inside `term` (recursively through
// Atom/Id sub-terms) must be bound on the trail. Match/IntervalRel
// readiness depends on this — a term whose top tag is `Id` but whose
// interior holds a free Variable cannot be looked up directly; the
// constraint has to enumerate so that the per-candidate `unifyTerms`
// binds the inner variable.
function isGround(term: Term, trail: Trail): boolean {
  const t = resolveVar(term, trail);
  // Wildcard means "any id" — semantically enumeration, not a ground
  // value. (Constraint-query lifts patterns whose `id` is Wildcard.)
  if (t.tag === "Variable" || t.tag === "Wildcard") return false;
  if (t.tag === "Atom" || t.tag === "Id") {
    for (const sub of t.atom.terms) if (!isGround(sub, trail)) return false;
  }
  return true;
}

function classify(c: MatchingConstraint, trail: Trail): ReadyMode {
  switch (c.tag) {
    case "Equal":
      // unifyTerms handles every combination of bound/unbound on both
      // sides — including unbound-vs-unbound (which becomes a var-var
      // alias). Always runs as a single deterministic check.
      return "check";
    case "Match":
      // "check" only when the id is fully ground; otherwise the
      // bound-id lookup would key on a non-ground Id atom and fail.
      return isGround(c.id, trail) ? "check" : "enumerate";
    case "IntervalRel": {
      const aBound = isGround(c.a, trail);
      const bBound = isGround(c.b, trail);
      if (aBound && bBound) return "check";
      if (aBound || bBound) return "enumerate";
      return "blocked";
    }
  }
}

// Cheap upper bound on the candidate set size for an "enumerate"
// constraint. Used by the scheduler's selection policy to prefer the
// smallest iterator. Returns Infinity when no cheap estimate is
// available — those constraints will still run, just sorted last.
function enumerateSize(c: MatchingConstraint, trail: Trail, store: RefStore, hc: HashconsState): number {
  switch (c.tag) {
    case "Match": {
      const first = c.atom.terms[0];
      if (first?.tag === "Symbol") {
        return store.index.get(first.name)?.length ?? 0;
      }
      return store.nodes.size;
    }
    case "IntervalRel": {
      const aTerm = substTerm(c.a, trail);
      const bTerm = substTerm(c.b, trail);
      const aBound = aTerm.tag !== "Variable";
      const bound = aBound ? aTerm : bTerm;
      const boundKey = idKey(toRefIfNested(bound, hc), hc);
      switch (c.kind) {
        case "contains":
          // descendantsOf is cached, so .size is essentially free.
          return descendantsOf(store, boundKey).size;
        case "before:after":
        case "overlap":
        case "prior":
          // No cheap cardinality estimate without computing the set.
          // Fall back to "scan the whole store" upper bound — these
          // constraints are still preferred over Match-allCandidates of
          // the same size, but lose to a tight contains.
          return store.nodes.size;
      }
      return store.nodes.size;
    }
    case "Equal":
      return 1;
  }
}

// Scheduler. Picks the best non-done constraint by readiness, dispatches,
// recurses. See plans/order-robust-unifier.md §Scheduler. Selection
// policy: check > enumerate (smallest candidate set first); ties broken
// by emission order (lowest index wins).
function unifyConstraintsAt(
  cs: readonly MatchingConstraint[],
  done: boolean[],
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail) => void,
): void {
  let bestCheckIdx = -1;
  let bestEnumIdx = -1;
  let bestEnumSize = Infinity;
  let anyUndone = false;
  let anyReady = false;

  for (let i = 0; i < cs.length; i++) {
    if (done[i]) continue;
    anyUndone = true;
    const m = classify(cs[i]!, trail);
    if (m === "blocked") continue;
    anyReady = true;
    if (m === "check") {
      if (bestCheckIdx === -1) bestCheckIdx = i;
    } else {
      const size = enumerateSize(cs[i]!, trail, store, hc);
      if (size < bestEnumSize) { bestEnumSize = size; bestEnumIdx = i; }
    }
  }

  if (!anyUndone) { visit(trail); return; }
  if (!anyReady) {
    throw new Error("unify: scheduler stalled — every remaining constraint is blocked");
  }

  const idx = bestCheckIdx !== -1 ? bestCheckIdx : bestEnumIdx;
  const c = cs[idx]!;
  done[idx] = true;
  try {
    dispatch(c, cs, done, store, trail, iteration, hc, visit);
  } finally {
    done[idx] = false;
  }
}

function dispatch(
  c: MatchingConstraint,
  cs: readonly MatchingConstraint[],
  done: boolean[],
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail) => void,
): void {
  if (c.tag === "Equal") {
    const mark = trailLength(trail);
    if (unifyTerms(c.lhs, c.rhs, trail, hc)) {
      unifyConstraintsAt(cs, done, store, trail, iteration, hc, visit);
    }
    trailUnwind(trail, mark);
    return;
  }
  if (c.tag === "IntervalRel") {
    const aTerm = substTerm(c.a, trail);
    const bTerm = substTerm(c.b, trail);
    const aBound = aTerm.tag !== "Variable";
    const bBound = bTerm.tag !== "Variable";
    if (aBound && bBound) {
      if (checkIntervalRelBound(c.kind, aTerm, bTerm, store, hc)) {
        unifyConstraintsAt(cs, done, store, trail, iteration, hc, visit);
      }
      return;
    }
    enumerateIntervalRel(c, aTerm, bTerm, aBound, bBound, cs, done, store, trail, iteration, hc, visit);
    return;
  }
  // c.tag === "Match"
  matchAt(c, cs, done, store, trail, iteration, hc, visit);
}

function matchAt(
  match: Extract<Constraint, { tag: "Match" }>,
  cs: readonly MatchingConstraint[],
  done: boolean[],
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail) => void,
): void {
  // Bound-id check path: when the id is fully ground, look the row up
  // directly and unify the atom. No candidate iteration. (Mirrors the
  // scheduler's `classify === "check"` decision.)
  if (isGround(match.id, trail)) {
    const idTerm = substTerm(match.id, trail);
    const node = getNode(store, toRefIfNested(idTerm, hc), hc);
    if (!node) return;
    if (!passesConstraint(node, match.mode, iteration)) return;
    if (node.tag === "Constrain") return;
    const mark = trailLength(trail);
    if (unifyAtoms(match.atom, node.atom, trail, hc)) {
      unifyConstraintsAt(cs, done, store, trail, iteration, hc, visit);
    }
    trailUnwind(trail, mark);
    return;
  }

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
      unifyConstraintsAt(cs, done, store, trail, iteration, hc, visit);
    }
    trailUnwind(trail, mark);
  }
}

function checkIntervalRelBound(
  kind: Extract<Constraint, { tag: "IntervalRel" }>["kind"],
  aTerm: Term,
  bTerm: Term,
  store: RefStore,
  hc: HashconsState,
): boolean {
  const aId = idKey(toRefIfNested(aTerm, hc), hc);
  const bId = idKey(toRefIfNested(bTerm, hc), hc);
  switch (kind) {
    case "contains":     return strictlyContains(store, aId, bId);
    case "before:after": return beforeAfter(store, aId, bId);
    case "overlap":      return overlap(store, aId, bId);
    case "prior":        return prior(store, aId, bId);
  }
}

// Enumerate candidates for an IntervalRel with one unbound endpoint. The
// remaining constraints are walked once per candidate, with the trail
// marked/unwound around the recurse so siblings start clean.
//
// Today the only enumerable case is `contains` with a bound parent and an
// unbound child — that's what lowering produces (IntervalRel-before-Match
// for nested Match nodes). The other kinds (before:after, overlap, prior)
// still reach the unifier as Match-then-IntervalRel-as-check, so they
// should not hit this path. If they do, lowering is bogus.
function enumerateIntervalRel(
  c: Extract<Constraint, { tag: "IntervalRel" }>,
  aTerm: Term,
  bTerm: Term,
  aBound: boolean,
  bBound: boolean,
  cs: readonly MatchingConstraint[],
  done: boolean[],
  store: RefStore,
  trail: Trail,
  iteration: number,
  hc: HashconsState,
  visit: (trail: Trail) => void,
): void {
  // Choose a candidate set based on which side is bound and the kind.
  // Each branch yields a `Set<NodeId>` of ids to bind into the unbound
  // side. Self-pair filtering depends on the relation:
  //   - contains is strict (a !== b)
  //   - before:after is irreflexive
  //   - overlap is reflexive (self overlaps self)
  //   - prior is irreflexive
  let candidates: Set<NodeId>;
  let bindUnboundOnSide: "a" | "b";
  let excludeSelf: NodeId | null;

  if (aBound && !bBound) {
    const aId = idKey(toRefIfNested(aTerm, hc), hc);
    bindUnboundOnSide = "b";
    switch (c.kind) {
      case "contains":
        candidates = descendantsOf(store, aId);
        excludeSelf = aId;
        break;
      case "before:after":
        candidates = successorsOf(store, aId);
        excludeSelf = null;
        break;
      case "overlap":
        candidates = overlapsOf(store, aId);
        excludeSelf = null;
        break;
      case "prior":
        // `prior(a, b)` = beforeAfter(a, b) ∨ contains(b, a). With `a`
        // bound, the second disjunct gives "a's strict ancestors";
        // first disjunct gives successors of a. (The `priorOf` helper
        // happens to encode the symmetric "given b" view; here we
        // rebuild "given a" from its parts.)
        candidates = new Set<NodeId>(successorsOf(store, aId));
        for (const anc of ancestorsOf(store, aId)) {
          if (anc !== aId) candidates.add(anc);
        }
        excludeSelf = aId;
        break;
    }
  } else if (bBound && !aBound) {
    const bId = idKey(toRefIfNested(bTerm, hc), hc);
    bindUnboundOnSide = "a";
    switch (c.kind) {
      case "contains":
        candidates = ancestorsOf(store, bId);
        excludeSelf = bId;
        break;
      case "before:after":
        candidates = predecessorsOf(store, bId);
        excludeSelf = null;
        break;
      case "overlap":
        candidates = overlapsOf(store, bId);
        excludeSelf = null;
        break;
      case "prior":
        candidates = priorOf(store, bId);
        excludeSelf = bId;
        break;
    }
  } else {
    throw new Error(
      "unify: enumerateIntervalRel requires exactly one bound endpoint",
    );
  }

  const targetTerm = bindUnboundOnSide === "b" ? bTerm : aTerm;
  for (const candKey of candidates) {
    if (excludeSelf !== null && candKey === excludeSelf) continue;
    const row = store.nodes.get(candKey);
    if (!row) continue;
    const mark = trailLength(trail);
    if (unifyTerms(targetTerm, row.id, trail, hc)) {
      unifyConstraintsAt(cs, done, store, trail, iteration, hc, visit);
    }
    trailUnwind(trail, mark);
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
