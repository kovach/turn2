// v2 single-rule evaluator. CPS-style backtracking over substitutions.
//
// State:
//   - subst:        Map<varName, Term>  (Term values may be uninterned)
//   - boundOrder:   string[] - var names in binding order, used by fresh-
//                   moment construction so each firing's moments differ
//   - anchorStack:  [Term, Term][] - the anchor stack; top is the current
//                   anchor (l, r). Sub-rules push a copy on entry.
//   - position:     a counter incremented per Atom encountered, used as the
//                   lexical position when constructing fresh moments
//
// Per-atom dispatch follows plans/new-semantics.md §Pipeline.

import type { Atom, Term } from "../types.js";
import { getAggregator } from "../aggregators.js";
import type { Program, Rule, RuleAtom } from "./types.js";
import {
  addOrder,
  addOutput,
  addTuple,
  candidatesByHead,
  comparable,
  intern,
  internAtom,
  intervalContains,
  intervalsOverlap,
  lessEq,
  lessThan,
  type Store,
} from "./store.js";

type Anchor = [Term, Term];

interface Ctx {
  store: Store;
  schema: Map<string, string>;
  subst: Map<string, Term>;
  boundOrder: string[];
  anchorStack: Anchor[];
  ruleName: string;
  position: number;
}

export function evaluateRule(rule: Rule, store: Store, schema: Map<string, string>): void {
  const ctx: Ctx = {
    store,
    schema,
    subst: new Map(),
    boundOrder: [],
    anchorStack: [[store.bot, store.top]],
    ruleName: rule.name,
    position: 0,
  };
  evalSeq(rule.body, 0, ctx, () => {});
}

function evalSeq(body: RuleAtom[], i: number, ctx: Ctx, k: () => void): void {
  if (i >= body.length) { k(); return; }
  const a = body[i]!;
  const next = () => evalSeq(body, i + 1, ctx, k);

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

  ctx.position++;
  switch (a.marker) {
    case "match":
      if (a.weight !== undefined) evalWeightedMatch(a, ctx, next);
      else evalMatch(a, ctx, next);
      return;
    case "episode":
    case "fact":
    case "anchor":
      evalAssert(a, ctx, next);
      return;
    case "output":
      evalOutput(a, ctx, next);
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
    const added: string[] = [];
    if (!unifyAtom(a.atom, tup.atom, ctx, added)) {
      revert(ctx, added);
      continue;
    }
    // Intersect anchor.
    const newL = maxMoment(ctx.store, anchor[0], tup.l);
    const newR = minMoment(ctx.store, anchor[1], tup.r);
    const stkIdx = ctx.anchorStack.length - 1;
    const savedAnchor = ctx.anchorStack[stkIdx]!;
    ctx.anchorStack[stkIdx] = [newL, newR];
    next();
    ctx.anchorStack[stkIdx] = savedAnchor;
    revert(ctx, added);
  }
}

function evalAssert(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, next: () => void): void {
  const anchor = topAnchor(ctx);
  const added: string[] = [];
  const baseTerms = a.atom.terms.map((t) => bindUnbound(t, ctx, added));
  if (a.weight !== undefined) baseTerms.push(bindUnbound(a.weight, ctx, added));
  const internedAtom = internAtom(ctx.store, { terms: baseTerms });

  let l: Term, r: Term;
  switch (a.marker) {
    case "episode": {
      l = intern(ctx.store, freshMoment(ctx, "l"));
      r = intern(ctx.store, freshMoment(ctx, "r"));
      addOrder(ctx.store, anchor[0], l);
      addOrder(ctx.store, l, r);
      addOrder(ctx.store, r, anchor[1]);
      break;
    }
    case "fact": {
      l = intern(ctx.store, freshMoment(ctx, "l"));
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

  addTuple(ctx.store, internedAtom, l, r);

  const stkIdx = ctx.anchorStack.length - 1;
  const saved = ctx.anchorStack[stkIdx]!;
  ctx.anchorStack[stkIdx] = [maxMoment(ctx.store, saved[0], l), minMoment(ctx.store, saved[1], r)];
  next();
  ctx.anchorStack[stkIdx] = saved;
  revert(ctx, added);
}

function evalOutput(a: Extract<RuleAtom, { tag: "Atom" }>, ctx: Ctx, next: () => void): void {
  const added: string[] = [];
  const baseTerms = a.atom.terms.map((t) => bindUnbound(t, ctx, added));
  if (a.weight !== undefined) baseTerms.push(bindUnbound(a.weight, ctx, added));
  const internedAtom = internAtom(ctx.store, { terms: baseTerms });
  addOutput(ctx.store, internedAtom);
  next();
  revert(ctx, added);
}

function evalWeightedMatch(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const head = headSymOf(a.atom);
  if (head === null) return;
  const aggName = ctx.schema.get(head);
  if (aggName === undefined) {
    throw new Error(`weighted query against '${head}' has no schema declaration`);
  }
  const aggregator = getAggregator(aggName);
  const anchor = topAnchor(ctx);

  // Gather candidates: same atom shape (pattern.terms.length + 1 = tuple.terms.length),
  // interval contains anchor.
  type Cand = { idx: number; weight: Term; bindings: Map<string, Term> };
  const candidates: Cand[] = [];
  for (const idx of candidatesByHead(ctx.store, head)) {
    const tup = ctx.store.tuples[idx]!;
    if (tup.atom.terms.length !== a.atom.terms.length + 1) continue;
    if (!intervalContains(ctx.store, tup.l, tup.r, anchor[0], anchor[1])) continue;
    const tmp = new Map(ctx.subst);
    let ok = true;
    for (let i = 0; i < a.atom.terms.length; i++) {
      if (!unifyTerms(a.atom.terms[i]!, tup.atom.terms[i]!, tmp, ctx.store)) { ok = false; break; }
    }
    if (!ok) continue;
    const bindings = diff(tmp, ctx.subst);
    const weight = tup.atom.terms[tup.atom.terms.length - 1]!;
    candidates.push({ idx, weight, bindings });
  }

  if (aggName === "last") {
    const maximal = candidates.filter((c) => {
      const ci = ctx.store.tuples[c.idx]!;
      for (const d of candidates) {
        if (d === c) continue;
        const di = ctx.store.tuples[d.idx]!;
        if (lessEq(ctx.store, ci.r, di.l) && comparable(ctx.store, ci.r, di.l)) return false;
      }
      return true;
    });
    if (maximal.length === 0) return; // last on empty fails
    for (const c of maximal) fireWithBinding(ctx, a.weight!, c.weight, c.bindings, next);
    return;
  }

  // sum / count: fold all candidates' weights.
  let acc = aggregator.zero;
  for (const c of candidates) {
    try { acc = aggregator.fold(acc, c.weight); }
    catch { /* skip non-foldable */ }
  }
  fireWithBinding(ctx, a.weight!, acc, new Map(), next);
}

function fireWithBinding(
  ctx: Ctx,
  weightTerm: Term,
  weightValue: Term,
  extra: Map<string, Term>,
  next: () => void,
): void {
  const added: string[] = [];
  for (const [k, v] of extra) {
    if (!ctx.subst.has(k)) { ctx.subst.set(k, v); ctx.boundOrder.push(k); added.push(k); }
  }
  if (weightTerm.tag === "Variable" && weightTerm.name !== "_" && !ctx.subst.has(weightTerm.name)) {
    ctx.subst.set(weightTerm.name, weightValue);
    ctx.boundOrder.push(weightTerm.name);
    added.push(weightTerm.name);
  }
  next();
  revert(ctx, added);
}

function diff(after: Map<string, Term>, before: Map<string, Term>): Map<string, Term> {
  const out = new Map<string, Term>();
  for (const [k, v] of after) if (!before.has(k)) out.set(k, v);
  return out;
}

function unifyAtom(pat: Atom, val: Atom, ctx: Ctx, added: string[]): boolean {
  if (pat.terms.length !== val.terms.length) return false;
  for (let i = 0; i < pat.terms.length; i++) {
    if (!unifyOne(pat.terms[i]!, val.terms[i]!, ctx, added)) return false;
  }
  return true;
}

function unifyOne(p: Term, v: Term, ctx: Ctx, added: string[]): boolean {
  const trial = new Map(ctx.subst);
  if (!unifyTerms(p, v, trial, ctx.store)) return false;
  for (const [k, val] of trial) {
    if (!ctx.subst.has(k)) {
      ctx.subst.set(k, val);
      ctx.boundOrder.push(k);
      added.push(k);
    }
  }
  return true;
}

function unifyTerms(a: Term, b: Term, subst: Map<string, Term>, store: Store): boolean {
  a = walk(a, subst);
  b = walk(b, subst);
  if (a.tag === "Variable") {
    if (a.name === "_") return true;
    subst.set(a.name, b);
    return true;
  }
  if (b.tag === "Variable") {
    if (b.name === "_") return true;
    subst.set(b.name, a);
    return true;
  }
  if (a.tag === "Wildcard" || b.tag === "Wildcard") return true;
  if (a.tag === "Symbol" && b.tag === "Symbol") return a.name === b.name;
  // Hashcons-aware Ref/Atom comparison: intern both then compare ids.
  // Variables inside `a` (the pattern) are already walked, so this works
  // for fully-bound patterns. Patterns with unbound vars descend recursively.
  if (a.tag === "Ref" && b.tag === "Ref") return a.id === b.id;
  const aTerms = expandSeq(a, store);
  const bTerms = expandSeq(b, store);
  if (aTerms === null || bTerms === null) return false;
  if (aTerms.length !== bTerms.length) return false;
  for (let i = 0; i < aTerms.length; i++) {
    if (!unifyTerms(aTerms[i]!, bTerms[i]!, subst, store)) return false;
  }
  return true;
}

function expandSeq(t: Term, store: Store): readonly Term[] | null {
  if (t.tag === "Atom" || t.tag === "Id") return t.atom.terms;
  if (t.tag === "Ref") {
    const a = store.hash.refToAtom.get(t.id);
    return a ? a.terms : null;
  }
  return null;
}

function walk(t: Term, subst: Map<string, Term>): Term {
  while (t.tag === "Variable") {
    const next = subst.get(t.name);
    if (next === undefined) return t;
    t = next;
  }
  return t;
}

function instantiate(t: Term, ctx: Ctx): Term {
  t = walk(t, ctx.subst);
  if (t.tag === "Atom" || t.tag === "Id") {
    return { tag: t.tag, atom: { terms: t.atom.terms.map((x) => instantiate(x, ctx)) } };
  }
  return t;
}

// Like `instantiate`, but for terms appearing in *positive* positions
// (asserts and outputs): every unbound Variable gets a fresh atom term
// `(*id ruleName position varName ...boundVarValues)` and is added to the
// substitution so subsequent atoms in the same rule see the same value.
// Wildcards become anonymous fresh ids (no subst entry).
function bindUnbound(t: Term, ctx: Ctx, added: string[]): Term {
  t = walk(t, ctx.subst);
  if (t.tag === "Variable") {
    const fresh = freshIdTerm(ctx, t.name);
    if (t.name !== "_") {
      ctx.subst.set(t.name, fresh);
      ctx.boundOrder.push(t.name);
      added.push(t.name);
    }
    return fresh;
  }
  if (t.tag === "Wildcard") {
    return freshIdTerm(ctx, "_");
  }
  if (t.tag === "Atom" || t.tag === "Id") {
    return { tag: t.tag, atom: { terms: t.atom.terms.map((x) => bindUnbound(x, ctx, added)) } };
  }
  return t;
}

function freshIdTerm(ctx: Ctx, varName: string): Term {
  const terms: Term[] = [
    { tag: "Symbol", name: "*id" },
    { tag: "Symbol", name: ctx.ruleName },
    { tag: "Symbol", name: String(ctx.position) },
    { tag: "Symbol", name: varName },
  ];
  for (const v of ctx.boundOrder) {
    const val = ctx.subst.get(v);
    if (val !== undefined) terms.push(instantiate(val, ctx));
  }
  return { tag: "Atom", atom: { terms } };
}

function freshMoment(ctx: Ctx, side: "l" | "r"): Term {
  const terms: Term[] = [
    { tag: "Symbol", name: "*mom" },
    { tag: "Symbol", name: ctx.ruleName },
    { tag: "Symbol", name: String(ctx.position) },
    { tag: "Symbol", name: side },
  ];
  for (const v of ctx.boundOrder) {
    const val = ctx.subst.get(v);
    if (val !== undefined) terms.push(instantiate(val, ctx));
  }
  return { tag: "Atom", atom: { terms } };
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

function revert(ctx: Ctx, added: string[]): void {
  for (let i = added.length - 1; i >= 0; i--) {
    const k = added[i]!;
    ctx.subst.delete(k);
    // Pop from boundOrder if it was the last.
    const last = ctx.boundOrder[ctx.boundOrder.length - 1];
    if (last === k) ctx.boundOrder.pop();
  }
}
