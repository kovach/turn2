// v2 single-rule evaluator. CPS-style backtracking over substitutions.
//
// State:
//   - trail:        Trail (positional stack of (name, term) bindings; mark/
//                   unwind for backtracking). Bindings are eagerly hashconsed
//                   per v1 convention so repeated `substTerm` walks bottom out
//                   on Refs.
//   - anchorStack:  [Term, Term][] - the anchor stack; top is the current
//                   anchor (l, r). Sub-rules push a copy on entry.
//
// Per-atom dispatch follows plans/new-semantics.md §Pipeline.
//
// Unification primitives are reused from v1 (../unify.ts) so v2 inherits the
// Atom-vs-Id tag check and the bindable / assertGround invariant on bindings.

import type { Atom, Term, Trail } from "../types.js";
import { newTrail, trailLength, trailLookup, trailPush, trailUnwind } from "../types.js";
import { hashconsTerm } from "../hashcons.js";
import { resolveVar, substTerm, unifyAtoms, unifyTerms } from "../unify.js";
import type { Rule, RuleAtom } from "./types.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  intern,
  internAtom,
  intervalsOverlap,
  lessThan,
  type Store,
} from "./store.js";

type Anchor = [Term, Term];

interface Ctx {
  store: Store;
  schema: Map<string, string>;
  trail: Trail;
  anchorStack: Anchor[];
  ruleName: string;
}

export function evaluateRule(rule: Rule, store: Store, schema: Map<string, string>): void {
  const ctx: Ctx = {
    store,
    schema,
    trail: newTrail(),
    anchorStack: [[store.bot, store.top]],
    ruleName: rule.name,
  };
  evalSeq(rule.body, 0, ctx, () => {});
}

function evalSeq(body: RuleAtom[], i: number, ctx: Ctx, k: () => void): void {
  if (i >= body.length) { k(); return; }
  const a = body[i]!;
  const next = () => evalSeq(body, i + 1, ctx, k);

  if (a.tag === "Equal") {
    const mark = trailLength(ctx.trail);
    if (unifyTerms(a.lhs, a.rhs, ctx.trail, ctx.store.hash)) {
      next();
    }
    trailUnwind(ctx.trail, mark);
    return;
  }

  if (a.tag === "Sub") {
    const outer = topAnchor(ctx);
    ctx.anchorStack.push([outer[0], outer[1]]);
    evalSeq(a.body, 0, ctx, () => {
      const innerCopy = ctx.anchorStack.pop()!;
      if (a.sequence) {
        const idx = ctx.anchorStack.length - 1;
        const saved = ctx.anchorStack[idx]!;
        ctx.anchorStack[idx] = [innerCopy[1], saved[1]];
        next();
        ctx.anchorStack[idx] = saved;
      } else {
        next();
      }
      ctx.anchorStack.push(innerCopy);
    });
    ctx.anchorStack.pop();
    return;
  }

  switch (a.marker) {
    case "match":
      if (a.weight !== undefined) {
        throw new Error("internal: weighted match should have been split by expand into do-agg/agg-result");
      }
      evalMatch(a, ctx, next);
      return;
    case "episode":
    case "fact":
    case "anchor":
      evalAssert(a, ctx, next);
      return;
    case "ask":
      evalAsk(a, ctx, next);
      return;
    case "constrain":
      evalConstrain(a, ctx, next);
      return;
  }
}

function topAnchor(ctx: Ctx): Anchor {
  return ctx.anchorStack[ctx.anchorStack.length - 1]!;
}

function evalMatch(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, next: () => void): void {
  const head = headSymOf(a.atom);
  if (head === null) return;
  const anchor = topAnchor(ctx);
  for (const idx of candidatesByHead(ctx.store, head)) {
    const tup = ctx.store.tuples[idx]!;
    if (!intervalsOverlap(ctx.store, anchor[0], anchor[1], tup.l, tup.r)) continue;
    if (a.lLit !== undefined) {
      const lLit = intern(ctx.store, a.lLit);
      if (lLit !== tup.l) continue;
    }
    if (a.rLit !== undefined) {
      const rLit = intern(ctx.store, a.rLit);
      if (rLit !== tup.r) continue;
    }
    const mark = trailLength(ctx.trail);
    if (!unifyAtoms(a.atom, tup.atom, ctx.trail, ctx.store.hash)) {
      trailUnwind(ctx.trail, mark);
      continue;
    }
    bindIdSlots(a, ctx, tup.l, tup.r);
    // Intersect anchor.
    const newL = maxMoment(ctx.store, anchor[0], tup.l);
    const newR = minMoment(ctx.store, anchor[1], tup.r);
    const stkIdx = ctx.anchorStack.length - 1;
    const savedAnchor = ctx.anchorStack[stkIdx]!;
    ctx.anchorStack[stkIdx] = [newL, newR];
    next();
    ctx.anchorStack[stkIdx] = savedAnchor;
    trailUnwind(ctx.trail, mark);
  }
}

function evalAssert(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, next: () => void): void {
  const anchor = topAnchor(ctx);
  const mark = trailLength(ctx.trail);
  const baseTerms = a.atom.terms.map((t) => bindUnbound(t, a, ctx));
  if (a.weight !== undefined) baseTerms.push(bindUnbound(a.weight, a, ctx));
  const internedAtom = internAtom(ctx.store, { terms: baseTerms });

  let l: Term, r: Term;
  switch (a.marker) {
    case "episode": {
      l = intern(ctx.store, freshMoment(a, ctx, "l"));
      r = intern(ctx.store, freshMoment(a, ctx, "r"));
      addOrder(ctx.store, anchor[0], l);
      addOrder(ctx.store, l, r);
      addOrder(ctx.store, r, anchor[1]);
      break;
    }
    case "fact": {
      l = intern(ctx.store, freshMoment(a, ctx, "l"));
      r = ctx.store.top;
      addOrder(ctx.store, anchor[0], l);
      addOrder(ctx.store, l, anchor[1]);
      break;
    }
    case "anchor": {
      l = anchor[0];
      r = anchor[1];
      break;
    }
    default: throw new Error("unreachable");
  }

  addTuple(ctx.store, internedAtom, l, r, a.span);
  bindIdSlots(a, ctx, l, r);

  const stkIdx = ctx.anchorStack.length - 1;
  const saved = ctx.anchorStack[stkIdx]!;
  ctx.anchorStack[stkIdx] = [maxMoment(ctx.store, saved[0], l), minMoment(ctx.store, saved[1], r)];
  next();
  ctx.anchorStack[stkIdx] = saved;
  trailUnwind(ctx.trail, mark);
}

// Ask `? T1 T2 …` desugars to `+ choose <chooseId> (<wrapped>)`. Each unbound
// active variable is bound to its fresh `*id` term — uniformly, regardless
// of whether an `is`-resolution row already exists. Downstream rules see the
// fresh-id as the canonical identity of the choice; rules that want the
// resolved value query `is <freshId> V` explicitly.
//
// The scheduler decides whether a choose row is blocked by scanning `is`
// rows itself. The evaluator's job is just to emit the row.
//
// Stored row terms (3 entries):
//   [ Symbol "_choose", chooseId, Atom { wrappedTerms } ]
function evalAsk(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, next: () => void): void {
  const anchor = topAnchor(ctx);
  const mark = trailLength(ctx.trail);
  const wrappedTerms = a.atom.terms.map((t) => bindUnbound(t, a, ctx));
  const wrappedAtom: Term = { tag: "Atom", atom: { terms: wrappedTerms } };
  const chooseId = freshChooseId(a, ctx);
  const rowTerms: Term[] = [
    { tag: "Symbol", name: "_choose" },
    chooseId,
    wrappedAtom,
  ];
  const internedAtom = internAtom(ctx.store, { terms: rowTerms });
  const l = intern(ctx.store, freshMoment(a, ctx, "l"));
  const r = ctx.store.top;
  addOrder(ctx.store, anchor[0], l);
  addOrder(ctx.store, l, anchor[1]);
  addTuple(ctx.store, internedAtom, l, r, a.span);
  bindIdSlots(a, ctx, l, r);

  const stkIdx = ctx.anchorStack.length - 1;
  const saved = ctx.anchorStack[stkIdx]!;
  ctx.anchorStack[stkIdx] = [maxMoment(ctx.store, saved[0], l), minMoment(ctx.store, saved[1], r)];
  next();
  ctx.anchorStack[stkIdx] = saved;
  trailUnwind(ctx.trail, mark);
}

// Constrain `! atom` desugars to `+ constrain (<atom>)`. Stored row terms (2
// entries): [ Symbol "_constrain", Atom { atom.terms with bindUnbound } ].
function evalConstrain(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, next: () => void): void {
  const anchor = topAnchor(ctx);
  const mark = trailLength(ctx.trail);
  const wrappedTerms = a.atom.terms.map((t) => bindUnbound(t, a, ctx));
  const wrappedAtom: Term = { tag: "Atom", atom: { terms: wrappedTerms } };
  const rowTerms: Term[] = [
    { tag: "Symbol", name: "_constrain" },
    wrappedAtom,
  ];
  const internedAtom = internAtom(ctx.store, { terms: rowTerms });
  const l = intern(ctx.store, freshMoment(a, ctx, "l"));
  const r = ctx.store.top;
  addOrder(ctx.store, anchor[0], l);
  addOrder(ctx.store, l, anchor[1]);
  addTuple(ctx.store, internedAtom, l, r, a.span);
  bindIdSlots(a, ctx, l, r);

  const stkIdx = ctx.anchorStack.length - 1;
  const saved = ctx.anchorStack[stkIdx]!;
  ctx.anchorStack[stkIdx] = [maxMoment(ctx.store, saved[0], l), minMoment(ctx.store, saved[1], r)];
  next();
  ctx.anchorStack[stkIdx] = saved;
  trailUnwind(ctx.trail, mark);
}

// Bind the atom's `_l_<lexPos>` / `_r_<lexPos>` slot Variables on the trail to
// the actual l, r moments emitted (asserts) or matched (matches). Subsequent
// atoms reference these via their `id.chain` Variable list, so fresh-id
// terms downstream depend on which tuples earlier matches selected.
//
// `l` and `r` are interned moment Refs; passing them directly satisfies the
// trail's "ground value" invariant.
function bindIdSlots(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  ctx: Ctx,
  l: Term,
  r: Term,
): void {
  const id = a.id;
  if (id === undefined) {
    throw new Error("internal: atom missing static id (expand.assignIds not run?)");
  }
  if (id.l.tag === "Variable" && trailLookup(ctx.trail, id.l.name) === undefined) {
    trailPush(ctx.trail, id.l.name, l);
  }
  if (id.r.tag === "Variable" && trailLookup(ctx.trail, id.r.name) === undefined) {
    trailPush(ctx.trail, id.r.name, r);
  }
}

// Like `substTerm`, but for terms appearing in *positive* positions (asserts
// and outputs): every unbound Variable gets a fresh atom term derived from
// the enclosing atom's static `id` template, and is added to the trail so
// subsequent atoms in the same rule see the same value. Wildcards become
// anonymous fresh ids (no trail entry). Returns hashconsed Refs.
function bindUnbound(t: Term, a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx): Term {
  t = resolveVar(t, ctx.trail);
  if (t.tag === "Variable") {
    const fresh = hashconsTerm(freshIdTerm(a, ctx, t.name), ctx.store.hash);
    trailPush(ctx.trail, t.name, fresh);
    return fresh;
  }
  if (t.tag === "Wildcard") {
    return hashconsTerm(freshIdTerm(a, ctx, "_"), ctx.store.hash);
  }
  if (t.tag === "Atom" || t.tag === "Id") {
    const innerTerms = t.atom.terms.map((x) => bindUnbound(x, a, ctx));
    return hashconsTerm({ tag: t.tag, atom: { terms: innerTerms } }, ctx.store.hash);
  }
  return t;
}

// Pull the atom's static `id.chain` template, instantiate its Variables
// against the current trail, and return the resulting [headSym, ruleName,
// lexPos, ...chainValues] term sequence. Used to derive the three flavors
// of fresh term below.
function instantiatedIdTerms(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx): Term[] {
  const id = a.id;
  if (id === undefined || id.chain.tag !== "Id") {
    throw new Error("internal: atom missing static id chain (expand.assignIds not run?)");
  }
  return id.chain.atom.terms.map((x) => substTerm(x, ctx.trail));
}

// All three fresh-* helpers below construct `Id`-tagged terms. Per
// notes/v2-design.md, every compiler-generated identity term is `Id`-tagged
// so the unifier and traversals treat it as opaque and never recursively
// unfold its body — that's what keeps id chains from blowing up.

// `(*id <ruleName> <lexPos> ...prevVarValues <varName>)`. Lowercase varName
// so it reparses as a Symbol rather than a Variable.
function freshIdTerm(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, varName: string): Term {
  const terms = instantiatedIdTerms(a, ctx);
  terms.push({ tag: "Symbol", name: varName.toLowerCase() });
  return { tag: "Id", atom: { terms } };
}

// `(*choose <ruleName> <lexPos> ...prevVarValues)`. Same id without varName,
// head Symbol swapped from `*id` to `*choose`. Interned because callers
// place it directly in the stored choose row.
function freshChooseId(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx): Term {
  const terms = instantiatedIdTerms(a, ctx);
  terms[0] = { tag: "Symbol", name: "*choose" };
  return intern(ctx.store, { tag: "Id", atom: { terms } });
}

// `(*mom <ruleName> <lexPos> ...prevVarValues <side>)`. Head swap and
// trailing "l"|"r" discriminator.
function freshMoment(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, side: "l" | "r"): Term {
  const terms = instantiatedIdTerms(a, ctx);
  terms[0] = { tag: "Symbol", name: "*mom" };
  terms.push({ tag: "Symbol", name: side });
  return { tag: "Id", atom: { terms } };
}

function maxMoment(s: Store, a: Term, b: Term): Term {
  return lessThan(s, a, b) ? b : a;
}

function minMoment(s: Store, a: Term, b: Term): Term {
  return lessThan(s, a, b) ? a : b;
}

function headSymOf(atom: Atom): string | null {
  const head = atom.terms[0];
  if (head === undefined || head.tag !== "Symbol") return null;
  return head.name;
}
