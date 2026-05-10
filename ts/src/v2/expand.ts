// Expand: rule splitting at weighted matches, semi-naive delta variants,
// then anchor decomposition into the post-expand IR.
//
// Pre-expand IR (from parse): each rule body is a list of `Atom`s (with a
// marker), `Sub`s, and `Equal`s.
//
// Post-expand IR (consumed by eval): a flat list of `Match`, `Emit`, `Le`,
// `AssertLt`, `Max`, `Min`, `Equal`. Anchor manipulation that the evaluator
// used to do implicitly is now explicit IR.

import type { Atom, Span, Term } from "../types.js";
import type { MatchConstraint, Program, Rule, RuleAtom } from "./types.js";

export function expand(program: Program): Program {
  const split: Rule[] = [];
  for (const rule of program.rules) {
    split.push(...splitRule(rule));
  }
  const variants: Rule[] = [];
  for (const rule of split) {
    variants.push(...generateDeltaVariants(rule));
  }
  const rules: Rule[] = variants.map(decomposeRule);
  return { rules, schema: program.schema };
}

// ----- Semi-naive delta variants -----

// For a rule with N pre-expand match atoms (including those nested in Sub
// bodies), emit N copies; in variant j the j-th match (in pre-order) is
// tagged "delta", earlier matches "old", later matches "any". Rules with
// zero match atoms are returned as-is.
//
// Variants share the original rule `name` so identical firings across
// variants produce identical fresh-ids and `addTuple`'s dedup collapses
// duplicate emissions.
export function generateDeltaVariants(rule: Rule): Rule[] {
  const n = countMatches(rule.body);
  if (n === 0) return [rule];
  const out: Rule[] = [];
  for (let j = 0; j < n; j++) {
    const ctr = { i: 0 };
    const body = tagBody(rule.body, j, ctr);
    out.push({
      ...rule,
      body,
      deltaHead: findDeltaHead(body),
      deltaSafeSkip: !positiveBeforeDelta(body),
    });
  }
  return out;
}

function positiveBeforeDelta(body: RuleAtom[]): boolean {
  let sawPositive = false;
  let foundDelta = false;
  function walk(atoms: RuleAtom[]): void {
    for (const a of atoms) {
      if (foundDelta) return;
      if (a.tag === "Sub") { walk(a.body); continue; }
      if (a.tag === "Equal") continue;
      if (a.tag !== "Atom") continue;
      if (a.marker === "match") {
        if ((a as { constraint?: MatchConstraint }).constraint === "delta") { foundDelta = true; return; }
        continue;
      }
      sawPositive = true;
    }
  }
  walk(body);
  return sawPositive;
}

function findDeltaHead(body: RuleAtom[]): string | null {
  const found = findDeltaAtom(body);
  if (found === undefined) throw new Error("internal: variant body lacks a delta atom");
  const head = found.atom.terms[0];
  return head !== undefined && head.tag === "Symbol" ? head.name : null;
}

function findDeltaAtom(body: RuleAtom[]): Extract<RuleAtom, { tag: "Atom" }> | undefined {
  for (const a of body) {
    if (a.tag === "Sub") {
      const inner = findDeltaAtom(a.body);
      if (inner !== undefined) return inner;
      continue;
    }
    if (a.tag === "Atom" && a.marker === "match"
        && (a as { constraint?: MatchConstraint }).constraint === "delta") return a;
  }
  return undefined;
}

function countMatches(body: RuleAtom[]): number {
  let n = 0;
  for (const a of body) {
    if (a.tag === "Sub") n += countMatches(a.body);
    else if (a.tag === "Atom" && a.marker === "match") n++;
  }
  return n;
}

function tagBody(body: RuleAtom[], delta: number, ctr: { i: number }): RuleAtom[] {
  return body.map((a) => {
    if (a.tag === "Sub") {
      return { ...a, body: tagBody(a.body, delta, ctr) };
    }
    if (a.tag === "Atom" && a.marker === "match") {
      const i = ctr.i++;
      const c: MatchConstraint = i < delta ? "old" : i === delta ? "delta" : "any";
      return { ...a, constraint: c } as RuleAtom;
    }
    return a;
  });
}

// ----- Rule splitting at weighted matches (unchanged from prior) -----

function splitRule(rule: Rule): Rule[] {
  const path = findFirstWeightedMatch(rule.body);
  if (path === null) return [rule];
  const wm = atPath(rule.body, path);
  if (wm.tag !== "Atom") throw new Error("unreachable");
  if (wm.weight === undefined) throw new Error("unreachable");

  const aggVarName = `_aggId_${path.join("_")}`;
  const aggIdVar: Term = { tag: "Variable", name: aggVarName };

  const boundByPrefix = new Set<string>();
  collectBoundVarsBeforePath(rule.body, path, boundByPrefix);
  const freeSym: Term = { tag: "Symbol", name: "_free" };
  const freeify = (t: Term): Term => {
    if (t.tag === "Variable") {
      if (t.name !== "_" && boundByPrefix.has(t.name)) return t;
      return freeSym;
    }
    if (t.tag === "Wildcard") return freeSym;
    if (t.tag === "Atom" || t.tag === "Id") {
      return { tag: t.tag, atom: { terms: t.atom.terms.map(freeify) } };
    }
    return t;
  };
  const wrappedFreeTerms: Term[] = [...wm.atom.terms.map(freeify), freeSym];
  const wrappedFreeAtom: Term = { tag: "Atom", atom: { terms: wrappedFreeTerms } };
  const originalPatternAtom: Term = {
    tag: "Atom",
    atom: { terms: [...wm.atom.terms, wm.weight] },
  };

  const symDoAgg: Term = { tag: "Symbol", name: "_do-agg" };
  const symAggResult: Term = { tag: "Symbol", name: "_agg-result" };

  const producerEmit: RuleAtom = {
    tag: "Atom",
    marker: "anchor",
    atom: { terms: [symDoAgg, aggIdVar, wrappedFreeAtom] },
    span: wm.span,
  };

  const consumerDoAgg: RuleAtom = {
    tag: "Atom",
    marker: "match",
    atom: { terms: [symDoAgg, aggIdVar, wrappedFreeAtom] },
    span: wm.span,
  };

  const consumerAggResult: RuleAtom = {
    tag: "Atom",
    marker: "match",
    atom: { terms: [symAggResult, aggIdVar, originalPatternAtom] },
    span: wm.span,
  };

  const producerBody = buildProducerBody(rule.body, path, producerEmit);
  const consumerBody = buildConsumerBody(rule.body, path, consumerDoAgg, consumerAggResult);

  const producerRule: Rule = {
    name: rule.name,
    body: producerBody,
    span: rule.span,
  };
  const consumerRule: Rule = {
    name: rule.name,
    body: consumerBody,
    span: rule.span,
  };

  return [producerRule, ...splitRule(consumerRule)];
}

type WMPath = number[];

function findFirstWeightedMatch(body: RuleAtom[]): WMPath | null {
  for (let i = 0; i < body.length; i++) {
    const a = body[i]!;
    if (a.tag === "Atom" && a.marker === "match" && a.weight !== undefined) return [i];
    if (a.tag === "Sub") {
      const inner = findFirstWeightedMatch(a.body);
      if (inner !== null) return [i, ...inner];
    }
  }
  return null;
}

function atPath(body: RuleAtom[], path: WMPath): RuleAtom {
  const head = body[path[0]!]!;
  if (path.length === 1) return head;
  if (head.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  return atPath(head.body, path.slice(1));
}

function buildProducerBody(body: RuleAtom[], path: WMPath, emit: RuleAtom): RuleAtom[] {
  const i = path[0]!;
  if (path.length === 1) return [...body.slice(0, i), emit];
  const sub = body[i]!;
  if (sub.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  const innerProducer = buildProducerBody(sub.body, path.slice(1), emit);
  const newSub: RuleAtom = { ...sub, body: innerProducer };
  return [...body.slice(0, i), newSub];
}

function buildConsumerBody(
  body: RuleAtom[],
  path: WMPath,
  doAgg: RuleAtom,
  aggResult: RuleAtom,
): RuleAtom[] {
  const i = path[0]!;
  if (path.length === 1) {
    return [...body.slice(0, i), doAgg, aggResult, ...body.slice(i + 1)];
  }
  const sub = body[i]!;
  if (sub.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  const innerConsumer = buildConsumerBody(sub.body, path.slice(1), doAgg, aggResult);
  const newSub: RuleAtom = { ...sub, body: innerConsumer };
  return [...body.slice(0, i), newSub, ...body.slice(i + 1)];
}

function collectBoundVarsBeforePath(body: RuleAtom[], path: WMPath, out: Set<string>): void {
  const i = path[0]!;
  collectBoundVarsInBody(body.slice(0, i), out);
  if (path.length === 1) return;
  const sub = body[i]!;
  if (sub.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  collectBoundVarsBeforePath(sub.body, path.slice(1), out);
}

function collectBoundVarsInBody(body: RuleAtom[], out: Set<string>): void {
  function visitTerm(t: Term): void {
    if (t.tag === "Variable") { if (t.name !== "_") out.add(t.name); return; }
    if (t.tag === "Atom" || t.tag === "Id") for (const x of t.atom.terms) visitTerm(x);
  }
  for (const a of body) {
    if (a.tag === "Sub") { collectBoundVarsInBody(a.body, out); continue; }
    if (a.tag === "Equal") { visitTerm(a.lhs); visitTerm(a.rhs); continue; }
    if (a.tag !== "Atom") continue;
    for (const t of a.atom.terms) visitTerm(t);
    if (a.weight !== undefined) visitTerm(a.weight);
    if (a.lLit !== undefined) visitTerm(a.lLit);
    if (a.rLit !== undefined) visitTerm(a.rLit);
  }
}

// ----- Anchor decomposition pass -----
//
// Walks a rule body, threading SSA running-anchor variables and a chain of
// in-scope Variables. Emits the post-expand IR: Match/Emit/Le/AssertLt/
// Max/Min/Equal. Subs are flattened — they don't survive into the output.

interface DecState {
  ruleName: string;
  out: RuleAtom[];
  // Running counter for `_l_<k>` / `_r_<k>` slot names. One pair per
  // Match/Emit (every kind of emit, including anchor). Drives the
  // template lexPos for fresh-* templates too.
  lexPos: number;
  // Running counter for synthetic anchor SSA variables (`_xl_<k>` /
  // `_xr_<k>`). Independent of lexPos.
  anchorCounter: number;
  // Variables currently in scope (in chain order). Used to materialize
  // fresh-* templates for unbound user vars in Emits.
  chain: Term[];
  // Names already in `chain`, for O(1) dedup.
  seen: Set<string>;
}

const SYM_BOT: Term = { tag: "Symbol", name: "bot" };
const SYM_TOP: Term = { tag: "Symbol", name: "top" };
const SYM_ID: Term = { tag: "Symbol", name: "*id" };
const SYM_MOM: Term = { tag: "Symbol", name: "*mom" };
const SYM_CHOOSE: Term = { tag: "Symbol", name: "*choose" };
const SYM_CHOOSE_ROW: Term = { tag: "Symbol", name: "_choose" };
const SYM_CONSTRAIN_ROW: Term = { tag: "Symbol", name: "_constrain" };
const SYM_L: Term = { tag: "Symbol", name: "l" };
const SYM_R: Term = { tag: "Symbol", name: "r" };

function decomposeRule(rule: Rule): Rule {
  const state: DecState = {
    ruleName: rule.name,
    out: [],
    lexPos: 0,
    anchorCounter: 0,
    chain: [],
    seen: new Set(),
  };
  decomposeBody(rule.body, state, SYM_BOT, SYM_TOP);
  return { ...rule, body: state.out };
}

function freshAnchorVar(state: DecState, kind: "xl" | "xr"): Term {
  const k = state.anchorCounter++;
  return { tag: "Variable", name: `_${kind}_${k}` };
}

// Snapshot of `[head, ruleName, lexPos, ...state.chain, trailing?]` wrapped
// as an `Id` term. Mirrors `assignIds` + `instantiated{Id,Mom,Choose}Terms`
// from the legacy evaluator: every fresh-* template snapshots the chain
// *before* the current atom contributes its own slots, so the template
// is a deterministic per-firing fingerprint of all earlier bindings.
// Templates are `Id`-tagged so unification stays opaque on them per
// notes/v2-design.md.
function chainTemplateWithHead(state: DecState, lexPos: number, head: Term, trailing?: Term): Term {
  const terms: Term[] = [
    head,
    { tag: "Symbol", name: state.ruleName },
    { tag: "Symbol", name: String(lexPos) },
    ...state.chain,
  ];
  if (trailing !== undefined) terms.push(trailing);
  return { tag: "Id", atom: { terms } };
}

// `freshIdTerm(varName)` template: `(*id rule lexPos ...chain <varName>)`
function freshIdTemplate(state: DecState, lexPos: number, varName: string): Term {
  return chainTemplateWithHead(state, lexPos, SYM_ID, { tag: "Symbol", name: varName.toLowerCase() });
}

// `freshChooseId` template: `(*choose rule lexPos ...chain)`
function freshChooseTemplate(state: DecState, lexPos: number): Term {
  return chainTemplateWithHead(state, lexPos, SYM_CHOOSE);
}

// `freshMoment(side)` template: `(*mom rule lexPos ...chain <side>)`
function freshMomTemplate(state: DecState, lexPos: number, side: "l" | "r"): Term {
  return chainTemplateWithHead(state, lexPos, SYM_MOM, side === "l" ? SYM_L : SYM_R);
}

function noteVar(state: DecState, name: string): void {
  if (name === "_") return;
  if (state.seen.has(name)) return;
  state.seen.add(name);
  state.chain.push({ tag: "Variable", name });
}

function collectVarsTerm(t: Term, state: DecState): void {
  if (t.tag === "Variable") { noteVar(state, t.name); return; }
  if (t.tag === "Atom" || t.tag === "Id") {
    for (const x of t.atom.terms) collectVarsTerm(x, state);
  }
}

// Walk `t` and rewrite it so every unbound user Variable / Wildcard is
// replaced by a fresh-id template (so the resulting term is fully ground
// modulo trail-bound chain Variables in the templates). For each Variable
// not yet in scope, also emit an `Equal V <freshIdTemplate(... varName)>`
// before this atom so that V is bound on the trail and downstream atoms
// see the same value. Wildcards become anonymous fresh-id templates with
// no Equal (no name to bind).
//
// Mirrors today's runtime `bindUnbound` in eval.ts. We don't actually walk
// children of Atom/Id containers via term substitution here — instead we
// emit Equals up-front for unbound Variables and let the term keep its
// Variable references; the evaluator will substitute them via the trail
// when it interns the Emit's atom. The exception is Wildcards: they have
// no name, so we substitute them inline.
function emitBindingsAndRewrite(term: Term, state: DecState, lexPos: number, span: Span): Term {
  if (term.tag === "Variable") {
    if (term.name === "_") {
      // Anonymous: substitute inline with an anonymous fresh-id template.
      return freshIdTemplate(state, lexPos, "_");
    }
    if (!state.seen.has(term.name)) {
      // Bind via Equal; subsequent atoms in this rule see the same value.
      const fresh = freshIdTemplate(state, lexPos, term.name);
      state.out.push({ tag: "Equal", lhs: term, rhs: fresh, span });
      state.seen.add(term.name);
      state.chain.push(term);
    }
    return term;
  }
  if (term.tag === "Wildcard") {
    return freshIdTemplate(state, lexPos, "_");
  }
  if (term.tag === "Atom" || term.tag === "Id") {
    const inner = term.atom.terms.map((x) => emitBindingsAndRewrite(x, state, lexPos, span));
    return { tag: term.tag, atom: { terms: inner } };
  }
  return term;
}

function decomposeBody(
  body: RuleAtom[],
  state: DecState,
  XL: Term,
  XR: Term,
): { XL: Term; XR: Term } {
  for (const a of body) {
    if (a.tag === "Equal") {
      collectVarsTerm(a.lhs, state);
      collectVarsTerm(a.rhs, state);
      state.out.push(a);
      continue;
    }
    if (a.tag === "Sub") {
      const inner = decomposeBody(a.body, state, XL, XR);
      if (a.sequence) {
        const XLseq = freshAnchorVar(state, "xl");
        state.out.push({ tag: "Max", a: XL, b: inner.XR, out: XLseq, span: a.span });
        XL = XLseq;
      }
      // Non-sequence: outer XL/XR unchanged. The inner's atoms produced
      // their own SSA running-anchor vars internally; nothing leaks.
      continue;
    }
    if (a.tag === "Atom") {
      state.lexPos++;
      if (a.marker === "match") {
        const next = decomposeMatch(a, state, XL, XR);
        XL = next.XL;
        XR = next.XR;
      } else {
        const next = decomposeEmit(a, state, XL, XR);
        XL = next.XL;
        XR = next.XR;
      }
      continue;
    }
    // Post-expand cases shouldn't occur at this stage, but pass through.
    state.out.push(a);
  }
  return { XL, XR };
}

function decomposeMatch(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  XL: Term,
  XR: Term,
): { XL: Term; XR: Term } {
  const k = state.lexPos;
  const lName = `_l_${k}`;
  const rName = `_r_${k}`;
  const lVar: Term = { tag: "Variable", name: lName };
  const rVar: Term = { tag: "Variable", name: rName };
  // Add slots to chain *before* user vars (matches today's assignIds order).
  state.seen.add(lName);
  state.chain.push(lVar);
  state.seen.add(rName);
  state.chain.push(rVar);

  // Emit the Match itself.
  const constraint = (a as { constraint?: MatchConstraint }).constraint;
  const matchAtom: RuleAtom = constraint === undefined
    ? { tag: "Match", atom: a.atom, l: lVar, r: rVar, span: a.span }
    : { tag: "Match", atom: a.atom, l: lVar, r: rVar, constraint, span: a.span };
  state.out.push(matchAtom);

  // lLit/rLit: constrain endpoints to the literal.
  if (a.lLit !== undefined) {
    state.out.push({ tag: "Equal", lhs: lVar, rhs: a.lLit, span: a.span });
    collectVarsTerm(a.lLit, state);
  }
  if (a.rLit !== undefined) {
    state.out.push({ tag: "Equal", lhs: rVar, rhs: a.rLit, span: a.span });
    collectVarsTerm(a.rLit, state);
  }

  // Overlap check + anchor intersection.
  state.out.push({ tag: "Le", a: XL, b: rVar, span: a.span });
  state.out.push({ tag: "Le", a: lVar, b: XR, span: a.span });
  const XLnext = freshAnchorVar(state, "xl");
  const XRnext = freshAnchorVar(state, "xr");
  state.out.push({ tag: "Max", a: XL, b: lVar, out: XLnext, span: a.span });
  state.out.push({ tag: "Min", a: XR, b: rVar, out: XRnext, span: a.span });

  // Add user vars in the matched atom to chain.
  for (const t of a.atom.terms) collectVarsTerm(t, state);

  return { XL: XLnext, XR: XRnext };
}

function decomposeEmit(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  XL: Term,
  XR: Term,
): { XL: Term; XR: Term } {
  const k = state.lexPos;
  const lName = `_l_${k}`;
  const rName = `_r_${k}`;
  const lVar: Term = { tag: "Variable", name: lName };
  const rVar: Term = { tag: "Variable", name: rName };

  // Determine the actual emitted endpoints + emit the supporting atoms.
  // NOTE: lVar/rVar are NOT yet in the chain — fresh-* templates produced
  // here (and below for the user atom) snapshot the chain *before* this
  // emit contributes its own slots, matching today's assignIds order.
  // We push lVar/rVar onto the chain at the end of this function.
  let emitL: Term, emitR: Term;
  let updateAnchor = true;
  switch (a.marker) {
    case "fact":
    case "ask":
    case "constrain": {
      // l = fresh moment, r = top.
      const momL = freshMomTemplate(state, k, "l");
      state.out.push({ tag: "Equal", lhs: lVar, rhs: momL, span: a.span });
      state.out.push({ tag: "Equal", lhs: rVar, rhs: SYM_TOP, span: a.span });
      state.out.push({ tag: "AssertLt", a: XL, b: lVar, span: a.span });
      state.out.push({ tag: "AssertLt", a: lVar, b: XR, span: a.span });
      emitL = lVar;
      emitR = SYM_TOP;
      break;
    }
    case "episode": {
      const momL = freshMomTemplate(state, k, "l");
      const momR = freshMomTemplate(state, k, "r");
      state.out.push({ tag: "Equal", lhs: lVar, rhs: momL, span: a.span });
      state.out.push({ tag: "Equal", lhs: rVar, rhs: momR, span: a.span });
      state.out.push({ tag: "AssertLt", a: XL, b: lVar, span: a.span });
      state.out.push({ tag: "AssertLt", a: lVar, b: rVar, span: a.span });
      state.out.push({ tag: "AssertLt", a: rVar, b: XR, span: a.span });
      emitL = lVar;
      emitR = rVar;
      break;
    }
    case "anchor": {
      // Bind slot vars to current anchor for chain consistency.
      state.out.push({ tag: "Equal", lhs: lVar, rhs: XL, span: a.span });
      state.out.push({ tag: "Equal", lhs: rVar, rhs: XR, span: a.span });
      emitL = XL;
      emitR = XR;
      // Anchor unchanged after `^` — Max/Min would be no-ops.
      updateAnchor = false;
      break;
    }
    default:
      throw new Error(`internal: unexpected marker ${(a as { marker: string }).marker}`);
  }

  // Now build the atom to emit. Variables in the user atom that aren't yet
  // bound get pre-bound via Equals to fresh-id templates; Wildcards are
  // substituted inline.
  let userAtomTerms: Term[] = [];
  for (const t of a.atom.terms) {
    userAtomTerms.push(emitBindingsAndRewrite(t, state, k, a.span));
  }
  let weight = a.weight;
  if (weight !== undefined) {
    weight = emitBindingsAndRewrite(weight, state, k, a.span);
  }
  const userAtom: Atom = { terms: weight !== undefined ? [...userAtomTerms, weight] : userAtomTerms };

  let rowAtom: Atom;
  if (a.marker === "ask") {
    // (_choose chooseId (userAtom))
    const chooseTpl = freshChooseTemplate(state, k);
    const cidName = `_cid_${k}`;
    const chooseVar: Term = { tag: "Variable", name: cidName };
    state.out.push({ tag: "Equal", lhs: chooseVar, rhs: chooseTpl, span: a.span });
    state.seen.add(cidName);
    // Note: chooseVar is synthetic; we don't add it to chain (it's not a
    // user var, and downstream chain templates don't need it).
    const wrapped: Term = { tag: "Atom", atom: userAtom };
    rowAtom = { terms: [SYM_CHOOSE_ROW, chooseVar, wrapped] };
  } else if (a.marker === "constrain") {
    const wrapped: Term = { tag: "Atom", atom: userAtom };
    rowAtom = { terms: [SYM_CONSTRAIN_ROW, wrapped] };
  } else {
    rowAtom = userAtom;
  }

  state.out.push({ tag: "Emit", atom: rowAtom, l: emitL, r: emitR, span: a.span });

  // Now contribute lVar/rVar to chain for subsequent atoms.
  state.seen.add(lName);
  state.chain.push(lVar);
  state.seen.add(rName);
  state.chain.push(rVar);

  // Anchor update.
  if (updateAnchor) {
    const XLnext = freshAnchorVar(state, "xl");
    const XRnext = freshAnchorVar(state, "xr");
    state.out.push({ tag: "Max", a: XL, b: emitL, out: XLnext, span: a.span });
    state.out.push({ tag: "Min", a: XR, b: emitR, out: XRnext, span: a.span });
    return { XL: XLnext, XR: XRnext };
  }
  return { XL, XR };
}
