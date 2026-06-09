// Term unification and substitution for v2, duplicated from the v1
// `unify.ts` (see plans/v1-cleanup.md). Only the trail-based term layer is
// here; the v1 TurnExpr/RefStore-driven unifier (`unifyConstraints`,
// `unifyTree`, `collectMatches`) stays in v1.

import type { Atom, Term, Trail } from "./term.js";
import { trailLookup, trailPush } from "./term.js";
import { hashconsTerm, refTagOf, type HashconsState } from "./hashcons.js";

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
// Needed by external callers that materialize a concrete term for insertion /
// path lookup.
export function substTerm(term: Term, trail: Trail): Term {
  const t = resolveVar(term, trail);
  if (t.tag === "Atom" || t.tag === "Id") {
    return { tag: t.tag, atom: substAtom(t.atom, trail) };
  }
  return t;
}

export function substAtom(atom: Atom, trail: Trail): Atom {
  unifyStats.c++;
  return { terms: atom.terms.map((t) => substTerm(t, trail)) };
}

// --- Term unification ---
//
// Convention: primitives (`unifyTerms`, `unifyAtoms`) never unwind the trail
// on their own failure. Every choice-point caller must wrap the attempt in
// `mark = trailLength(...)` / `trailUnwind(..., mark)` so that partial
// bindings from a failed branch never leak into the next one.

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
