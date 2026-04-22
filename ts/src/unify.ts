import type { Atom, MatchConstraint, NodeId, Term, Trail, Tree } from "./types.js";
import { newTrail, trailLength, trailLookup, trailPush, trailUnwind } from "./types.js";
import { hashconsTerm, tokenOfId, createHashcons, type HashconsState } from "./hashcons.js";
import type { Candidate, NodeRow, RefStore, SymbolIndex } from "./refstore.js";
import { allCandidates, before, buildRefStore, getNode, getRoot, idKey, overlap, strictlyContains } from "./refstore.js";

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
  if (t.tag === "Atom") {
    return { tag: "Atom", atom: substAtom(t.atom, trail) };
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
    if (r.tag === "Atom") assertGround(r.atom, trail);
  }
}

function bindable(t: Term, trail: Trail, hc: HashconsState): Term {
  if (t.tag !== "Atom") return t;
  const substituted = substAtom(t.atom, trail);
  assertGround(substituted, trail);
  return hashconsTerm({ tag: "Atom", atom: substituted }, hc);
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

  if (sa.tag === "Atom" && sb.tag === "Atom") {
    return unifyAtoms(sa.atom, sb.atom, trail, hc);
  }

  // Atom vs Ref: look up the ref to get the stored atom
  if (sa.tag === "Atom" && sb.tag === "Ref") {
    const refAtom = hc.refToAtom.get(sb.id);
    if (refAtom) return unifyAtoms(sa.atom, refAtom, trail, hc);
  }
  if (sa.tag === "Ref" && sb.tag === "Atom") {
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

// --- Node unification (id + literal) ---

function unifyNode(pat: Tree, ref: NodeRow, trail: Trail, hc: HashconsState): boolean {
  const patTag = pat.literal.literalType.tag;
  const refTag = ref.literal.literalType.tag;
  if (patTag !== "Match" && patTag !== "Before" && patTag !== "Overlap") return false;
  if (refTag !== "Assert" && refTag !== "Ask") return false;
  if (!unifyTerms(pat.id, ref.id, trail, hc)) return false;
  return unifyAtoms(pat.literal.atom, ref.literal.atom, trail, hc);
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

// --- Main search ---
//
// The search is visitor-style: each successful leaf invokes `visit()` while the
// trail is live, then backtracking unwinds the trail before moving to the next
// candidate. `SearchState` is a single long-lived record mutated in place during
// descent — `deepest` is save/restored inline to avoid per-branch object copies.
//
// The callback must NOT re-enter the unifier on the same trail. If a caller ever
// needs nested unification, it should pass a fresh trail to the inner call.

interface SearchState {
  // NodeId of the nearest pattern ancestor's reference image. Candidates for
  // a Match child must be strictly contained by this node. Initialised to
  // the reference root at unifyTree entry.
  deepest: NodeId;
  trail: Trail;
  store: RefStore;
  iteration: number;
  hc: HashconsState;
}

type Visit = () => void;

function matchChildren(patChildren: Tree[], state: SearchState, visit: Visit): void {
  matchChildrenFrom(patChildren, 0, state, visit);
}

function matchChildrenFrom(
  patChildren: Tree[],
  idx: number,
  state: SearchState,
  visit: Visit,
): void {
  if (idx >= patChildren.length) { visit(); return; }
  const head = patChildren[idx]!;
  const ht = head.literal.literalType;

  if (ht.tag === "Equal") {
    const terms = head.literal.atom.terms;
    if (terms.length !== 2) return;
    // Equal is not a choice point, but it pushes bindings that later siblings
    // must see. The unwind runs after the recursive call returns — later
    // siblings observe the binding during descent, and it disappears on return.
    const mark = trailLength(state.trail);
    if (unifyTerms(terms[0]!, terms[1]!, state.trail, state.hc)) {
      matchChildrenFrom(patChildren, idx + 1, state, visit);
    }
    trailUnwind(state.trail, mark);
    return;
  }

  if (ht.tag !== "Match" && ht.tag !== "Before" && ht.tag !== "Overlap") {
    matchChildrenFrom(patChildren, idx + 1, state, visit);
    return;
  }

  const anchor = computeAnchor(patChildren, idx, state);
  // Siblings at this level share the *outer* deepest (the parent's image), not the
  // current sibling's match path. Restore before descending into the next sibling
  // and re-apply on the way back so matchSubtree's loop continues correctly.
  const outerDeepest = state.deepest;
  matchSubtree(head, state, anchor, () => {
    const innerDeepest = state.deepest;
    state.deepest = outerDeepest;
    matchChildrenFrom(patChildren, idx + 1, state, visit);
    state.deepest = innerDeepest;
  });
}

function computeAnchor(
  siblings: Tree[],
  idx: number,
  state: SearchState,
): NodeId {
  const node = siblings[idx]!;
  if (node.literal.literalType.tag !== "Before") return state.deepest;

  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i]!;
    const lt = sib.literal.literalType.tag;
    if (lt === "Match" || lt === "Before" || lt === "Overlap") {
      const boundId = substTerm(sib.id, state.trail);
      const row = getNode(state.store, boundId, state.hc);
      if (row) return idKey(row.id, state.hc);
    }
  }
  return state.deepest;
}

function matchSubtree(
  pat: Tree,
  state: SearchState,
  anchor: NodeId,
  visit: Visit,
): void {
  const lt = pat.literal.literalType;
  const constraint = (lt.tag === "Match" || lt.tag === "Before" || lt.tag === "Overlap") ? lt.constraint : "any";

  const firstTerm = pat.literal.atom.terms[0];
  const candidates: Iterable<Candidate> = (firstTerm?.tag === "Symbol")
    ? (state.store.index.get(firstTerm.name) ?? [])
    : allCandidates(state.store);

  const prevDeepest = state.deepest;
  for (const { node } of candidates) {
    if (!passesConstraint(node, constraint, state.iteration)) continue;
    const candId = idKey(node.id, state.hc);
    if (lt.tag === "Before") {
      if (!before(state.store, candId, anchor)) continue;
    } else if (lt.tag === "Overlap") {
      if (!overlap(state.store, prevDeepest, candId)) continue;
    } else {
      if (!strictlyContains(state.store, prevDeepest, candId)) continue;
    }
    const mark = trailLength(state.trail);
    if (unifyNode(pat, node, state.trail, state.hc)) {
      state.deepest = candId;
      matchChildren(pat.children, state, visit);
    }
    trailUnwind(state.trail, mark);
  }
  state.deepest = prevDeepest;
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
  const lt = pattern.literal.literalType;
  if (lt.tag !== "Match" || pattern.literal.atom.terms.length !== 0) return;
  const root = getRoot(reference, hc);
  if (!passesConstraint(root, lt.constraint, iteration)) return;

  const mark = trailLength(trail);
  if (!unifyTerms(pattern.id, root.id, trail, hc)) {
    trailUnwind(trail, mark);
    return;
  }
  const state: SearchState = {
    deepest: tokenOfId(root.id, hc),
    trail,
    store: reference,
    iteration,
    hc,
  };
  matchChildren(pattern.children, state, () => visit(trail));
  trailUnwind(trail, mark);
}

// --- Test-only helper: collect all substitutions as plain records. ---
// Intended for tests that need to assert over the set of solutions.
export function collectMatches(
  pattern: Tree,
  reference: Tree,
  iteration: number = 1,
): Array<Map<string, Term>> {
  const out: Array<Map<string, Term>> = [];
  const trail = newTrail();
  const hc = createHashcons();
  const store = buildRefStore(reference, hc);
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
