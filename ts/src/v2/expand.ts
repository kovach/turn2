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
import type { JsDef, MatchConstraint, Program, Rule, RuleAtom } from "./types.js";
import { pruneChains } from "./expand-liveness.js";

export function expand(program: Program): Program {
  const decomposed = program.rules.map((r) => {
    const { rule, essential } = decomposeRule(r, program.jsDefs);
    return pruneChains(rule, essential);
  });
  const split: Rule[] = [];
  for (const rule of decomposed) split.push(...splitRule(rule));
  // Drop trailing slices with no observable effect (no Emit and no AssertLt).
  // After universal splitting, every rule but the trailing tail of an
  // emit-chain ends in an Emit; the trailing tail is pure guards/matches.
  const kept = split.filter((r) =>
    r.body.some((a) => a.tag === "Emit" || a.tag === "AssertLt"),
  );
  const variants: Rule[] = [];
  for (const rule of kept) variants.push(...generateDeltaVariants(rule));
  return { rules: variants, schema: program.schema, jsDefs: program.jsDefs };
}

// ----- Semi-naive delta variants -----
//
// For a rule with N Match atoms in body order, emit N copies; in variant
// j the j-th Match is tagged "delta", earlier Matches "old", later
// Matches "any". Rules with zero Matches are returned as-is.
//
// Variants share the original rule `name` so identical firings across
// variants produce identical fresh-ids and `addTuple`'s dedup collapses
// duplicate emissions.
export function generateDeltaVariants(rule: Rule): Rule[] {
  let n = 0;
  for (const a of rule.body) if (a.tag === "Match") n++;
  if (n === 0) return [rule];
  const out: Rule[] = [];
  for (let j = 0; j < n; j++) {
    const body = tagBody(rule.body, j);
    out.push({
      ...rule,
      body,
      deltaHead: findDeltaHead(body),
      deltaSafeSkip: !positiveBeforeDelta(body),
    });
  }
  return out;
}

function tagBody(body: RuleAtom[], delta: number): RuleAtom[] {
  let i = 0;
  return body.map((a) => {
    if (a.tag !== "Match") return a;
    const idx = i++;
    const c: MatchConstraint = idx < delta ? "old" : idx === delta ? "delta" : "any";
    return { ...a, constraint: c };
  });
}

function findDeltaHead(body: RuleAtom[]): string | null {
  for (const a of body) {
    if (a.tag === "Match" && a.constraint === "delta") {
      const head = a.atom.terms[0];
      return head !== undefined && head.tag === "Symbol" ? head.name : null;
    }
  }
  throw new Error("internal: variant body lacks a delta Match");
}

// True iff some Emit appears before the delta Match. Le/AssertLt/Max/Min/
// Equal are guards/scaffolding and don't count as "positive."
function positiveBeforeDelta(body: RuleAtom[]): boolean {
  for (const a of body) {
    if (a.tag === "Match" && a.constraint === "delta") return false;
    if (a.tag === "Emit") return true;
  }
  return false;
}

// ----- Rule splitting (universal slice on every Emit) -----
//
// Decompose lowers every Emit to a paired (Emit, Match) where the Match
// shares the same atom shape (including the trailing universal id slot).
// splitRule slices the body at every Emit: producer = body up to and
// including the Emit; consumer = everything after (starting with the
// paired Match). Recursion handles multiple Emits per rule.
//
// Aggregate is the one exception to the paired-Match construction: its
// `_do-agg` Emit gets the trailing id slot for store-schema uniformity but
// the existing `_agg-result` Match takes the role of the chain-recovery
// Match. splitRule still slices on `_do-agg` since that's just an Emit.

function splitRule(rule: Rule): Rule[] {
  const eIdx = rule.body.findIndex((a) => a.tag === "Emit");
  if (eIdx < 0) return [rule];
  const producer: Rule = { ...rule, body: rule.body.slice(0, eIdx + 1) };
  const consumer: Rule = { ...rule, body: rule.body.slice(eIdx + 1) };
  return [producer, ...splitRule(consumer)];
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
  // User-written Variable names that were introduced ONLY inside a
  // `!(...)` block (as existentials, replaced by `*var` templates).
  // If a later atom in the same rule references such a name, that's
  // an error — the existential is opaque outside its block, and the
  // user almost certainly intends a binding the engine can't provide.
  existentialNames: Set<string>;
  // Anonymous wildcard counter for existential rewrites. Anonymous
  // wildcards inside `!(...)` get a fresh `*var` template each so
  // multiple `_`s don't collapse into one existential.
  anonExistCounter: number;
  // Names of chain entries whose contribution to a fresh-* template is
  // load-bearing for per-firing uniqueness — i.e., dropping them would
  // let two distinct firings collide on the emitted row's universal id
  // slot (causing dedup to coalesce them). Populated at chain pushes
  // corresponding to user Variables; not populated for endpoint slots
  // (`_l_K` / `_r_K`) or anchor SSA (`_xl_K` / `_xr_K`), which are
  // either downstream-recoverable or pure reductions of other entries.
  // Consumed by `pruneChains` in expand-liveness.ts.
  essential: Set<string>;
  // `#js` function table (for `@js(...)` lowering: existence + arity checks).
  jsDefs: Map<string, JsDef>;
  // Counter for fresh `_js_<k>` result Variables.
  jsCounter: number;
}

const SYM_BOT: Term = { tag: "Symbol", name: "bot" };
const SYM_TOP: Term = { tag: "Symbol", name: "top" };
const SYM_ID: Term = { tag: "Symbol", name: "*id" };
const SYM_VAR: Term = { tag: "Symbol", name: "*var" };
const SYM_MOM: Term = { tag: "Symbol", name: "*mom" };
const SYM_CHOOSE: Term = { tag: "Symbol", name: "*choose" };
const SYM_CHAIN: Term = { tag: "Symbol", name: "*chain" };
const SYM_CONJ: Term = { tag: "Symbol", name: "*conj" };
const SYM_C_PLAIN: Term = { tag: "Symbol", name: "*c-plain" };
const SYM_C_AGG: Term = { tag: "Symbol", name: "*c-agg" };
const SYM_CHOOSE_ROW: Term = { tag: "Symbol", name: "_choose" };
const SYM_CONSTRAIN_ROW: Term = { tag: "Symbol", name: "_constrain" };
const SYM_DO_AGG: Term = { tag: "Symbol", name: "_do-agg" };
const SYM_AGG_RESULT: Term = { tag: "Symbol", name: "_agg-result" };
const SYM_FREE: Term = { tag: "Symbol", name: "_free" };
const SYM_L: Term = { tag: "Symbol", name: "l" };
const SYM_R: Term = { tag: "Symbol", name: "r" };

function decomposeRule(rule: Rule, jsDefs: Map<string, JsDef>): { rule: Rule; essential: Set<string> } {
  const state: DecState = {
    ruleName: rule.name,
    out: [],
    lexPos: 0,
    anchorCounter: 0,
    chain: [],
    seen: new Set(),
    essential: new Set(),
    existentialNames: new Set(),
    anonExistCounter: 0,
    jsDefs,
    jsCounter: 0,
  };
  decomposeBody(rule.body, state, SYM_BOT, SYM_TOP);
  return { rule: { ...rule, body: state.out }, essential: state.essential };
}

function freshAnchorVar(state: DecState, kind: "xl" | "xr"): Term {
  const k = state.anchorCounter++;
  const name = `_${kind}_${k}`;
  const v: Term = { tag: "Variable", name };
  // Push onto chain so atoms in a downstream consumer split-rule
  // (e.g. Sub-closing `Max XL_pre-sub …`) can recover this anchor SSA
  // from the matched row's trailing idTpl via structural unification.
  state.seen.add(name);
  state.chain.push(v);
  return v;
}

// Snapshot of `[head, ruleName, lexPos, (*chain ...state.chain), trailing?]`
// wrapped as an `Id` term. Mirrors `assignIds` +
// `instantiated{Id,Mom,Choose}Terms` from the legacy evaluator: every
// fresh-* template snapshots the chain *before* the current atom
// contributes its own slots, so the template is a deterministic
// per-firing fingerprint of all earlier bindings. Templates are
// `Id`-tagged per notes/v2-design.md; the chain is grouped under a
// `*chain` sub-Atom so the template has fixed arity regardless of chain
// length (makes it trivial to find/rewrite the chain).
function chainTemplateWithHead(state: DecState, lexPos: number, head: Term, trailing?: Term): Term {
  const chainAtom: Term = {
    tag: "Id",
    atom: { terms: [SYM_CHAIN, ...state.chain] },
  };
  const terms: Term[] = [
    head,
    { tag: "Symbol", name: state.ruleName },
    { tag: "Symbol", name: String(lexPos) },
    chainAtom,
  ];
  if (trailing !== undefined) terms.push(trailing);
  return { tag: "Id", atom: { terms } };
}

// Convert a Variable name to a Symbol injectively. Prepending `:` is safe:
// `:` can begin a Symbol token but never begins a Variable (parser only
// recognizes Variables starting with A-Z or `_`). Used to embed a user
// variable's identity as a slot tag inside Id templates without losing the
// Symbol/Variable distinction on round-trip through compressRefs / parse.
function variableToSymbol(v: { tag: "Variable"; name: string }): { tag: "Symbol"; name: string } {
  return { tag: "Symbol", name: ":" + v.name };
}

// `freshIdTerm(varName)` template: `(*id rule lexPos (*chain ...) <:varName>)`
function freshIdTemplate(state: DecState, lexPos: number, varName: string): Term {
  return chainTemplateWithHead(state, lexPos, SYM_ID, variableToSymbol({ tag: "Variable", name: varName }));
}

// `freshVarTerm(varName)` template for an existential inside a `!(...)`
// block: `(*var rule lexPos (*chain ...) <:varName>)`. Same shape as
// `*id` (so it's a stable per-firing-unique hashcons token), with the
// distinguishing head `*var`. The constraint-query evaluator
// recognizes `*var`-headed terms as fresh existentials — they bind
// like active terms within one row's matchTerm threading but never
// surface in the option tuples emitted to the player.
function freshVarTemplate(state: DecState, lexPos: number, varName: string): Term {
  return chainTemplateWithHead(state, lexPos, SYM_VAR, variableToSymbol({ tag: "Variable", name: varName }));
}

// `freshChooseId` template: `(*choose rule lexPos (*chain ...))`
function freshChooseTemplate(state: DecState, lexPos: number): Term {
  return chainTemplateWithHead(state, lexPos, SYM_CHOOSE);
}

// `freshMoment(side)` template: `(*mom rule lexPos (*chain ...) <side>)`
function freshMomTemplate(state: DecState, lexPos: number, side: "l" | "r"): Term {
  return chainTemplateWithHead(state, lexPos, SYM_MOM, side === "l" ? SYM_L : SYM_R);
}

function noteVar(state: DecState, name: string): void {
  if (name === "_") return;
  if (state.seen.has(name)) return;
  if (state.existentialNames.has(name)) {
    throw new Error(
      `rule '${state.ruleName}': variable '${name}' was introduced only inside a '!(...)' block ` +
      `(as an existential) and cannot be referenced outside that block`,
    );
  }
  state.seen.add(name);
  state.chain.push({ tag: "Variable", name });
  state.essential.add(name);
}

// A `*js`-headed Atom/Id is the parser's encoding of a `@js(name args...)`
// call. It is only legal in positive emit atoms (lowered by
// `emitBindingsAndRewrite`); anywhere else it must error.
function isJsHead(t: Term): boolean {
  if (t.tag !== "Atom" && t.tag !== "Id") return false;
  const h = t.atom.terms[0];
  return h !== undefined && h.tag === "Symbol" && h.name === "*js";
}

function jsNotAllowed(state: DecState): never {
  throw new Error(
    `rule '${state.ruleName}': '@js(...)' is only allowed in '+'/'~'/'^'/'?' atoms ` +
    `(not in matches, '=', '!(...)', or aggregate patterns)`,
  );
}

function collectVarsTerm(t: Term, state: DecState): void {
  if (isJsHead(t)) jsNotAllowed(state);
  if (t.tag === "Variable") { noteVar(state, t.name); return; }
  if (t.tag === "Atom" || t.tag === "Id") {
    for (const x of t.atom.terms) collectVarsTerm(x, state);
  }
}

// Lower a `@js(name args...)` term (encoded as `Atom([*js, name, ...args])`)
// to a fresh result Variable `V`, pushing a `JsCall` atom that binds `V`
// (see plans/v2-user-js-functions.md). Args are checked against `state.seen`
// — every variable must already be bound by an earlier term/atom (we refuse
// to invent one, unlike the default Variable path). Nested `@js` recurse,
// so the inner JsCall is pushed (and thus runs) before the outer.
function lowerJsCall(term: Term, state: DecState, lexPos: number, span: Span): Term {
  if (term.tag !== "Atom" && term.tag !== "Id") jsNotAllowed(state);
  const terms = term.atom.terms;
  const nameSym = terms[1];
  if (nameSym === undefined || nameSym.tag !== "Symbol") {
    throw new Error(`rule '${state.ruleName}': '@js(...)' must name a function`);
  }
  const func = nameSym.name;
  const def = state.jsDefs.get(func);
  if (def === undefined) {
    throw new Error(`rule '${state.ruleName}': '@js(${func} ...)' calls undefined #js function`);
  }
  const rawArgs = terms.slice(2);
  if (rawArgs.length !== def.params.length) {
    throw new Error(
      `rule '${state.ruleName}': '@js(${func} ...)' expects ${def.params.length} argument(s), got ${rawArgs.length}`,
    );
  }
  const args = rawArgs.map((a) => lowerJsArg(a, state, lexPos, span, func));
  const V: Term = { tag: "Variable", name: `_js_${state.jsCounter++}` };
  state.out.push({ tag: "JsCall", func, args, out: V, span });
  return V;
}

function lowerJsArg(t: Term, state: DecState, lexPos: number, span: Span, func: string): Term {
  if (isJsHead(t)) return lowerJsCall(t, state, lexPos, span);
  if (t.tag === "Variable") {
    if (t.name === "_" || !state.seen.has(t.name)) {
      throw new Error(
        `rule '${state.ruleName}': '@js(${func} ...)': variable '${t.name}' is not bound before this use`,
      );
    }
    return t;
  }
  if (t.tag === "Wildcard") {
    throw new Error(`rule '${state.ruleName}': '@js(${func} ...)': '_' argument has no value`);
  }
  if (t.tag === "Atom" || t.tag === "Id") {
    return { tag: t.tag, atom: { terms: t.atom.terms.map((x) => lowerJsArg(x, state, lexPos, span, func)) } };
  }
  return t;
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
      state.essential.add(term.name);
    }
    return term;
  }
  if (term.tag === "Wildcard") {
    return freshIdTemplate(state, lexPos, "_");
  }
  if (isJsHead(term)) {
    return lowerJsCall(term, state, lexPos, span);
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
      } else if (a.marker === "aggregate") {
        const next = decomposeAggregate(a, state, XL, XR);
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
  // Endpoint slots are essential: they distinguish matched-tuple identities
  // across firings, so two firings on different stored rows produce
  // distinct idTpls even when user vars coincide.
  state.seen.add(lName);
  state.chain.push(lVar);
  state.essential.add(lName);
  state.seen.add(rName);
  state.chain.push(rVar);
  state.essential.add(rName);

  // Append a trailing Wildcard so the Match unifies against stored tuples
  // that carry the universal id slot (every Emit appends one).
  const userMatchAtom: Atom = { terms: [...a.atom.terms, { tag: "Wildcard" }] };

  // Emit the Match itself.
  const constraint = (a as { constraint?: MatchConstraint }).constraint;
  const matchAtom: RuleAtom = constraint === undefined
    ? { tag: "Match", atom: userMatchAtom, l: lVar, r: rVar, span: a.span }
    : { tag: "Match", atom: userMatchAtom, l: lVar, r: rVar, constraint, span: a.span };
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

// Aggregate: lowers `pat -> weight` into a paired producer `Emit (_do-agg
// wrappedFreePattern idTpl) at (XL, XR)` and consumer `Match (_agg-result
// originalPatternWithWeight idTpl) at (_l_K, _r_K)`. Both sides inline the
// *same* `freshIdTemplate(state, K, "_emitId")` term in the universal
// trailing id slot — substituting it in either context produces the same
// ground value, so closeDoAgg's copied id matches the consumer template
// under structural unification, binding chain Variables in the consumer's
// trail.
//
// No Le/Max/Min scaffolding around the consumer Match: by the closeDoAgg
// invariant the matched `_agg-result.l/r == _do-agg.l/r == (XL, XR)`, so
// those atoms would be no-ops. The new running anchor for the suffix is
// just `(_l_K, _r_K)`.
//
// `splitRule` slices on every Emit; the producer `_do-agg` Emit is just
// one of them.
function decomposeAggregate(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  XL: Term,
  XR: Term,
): { XL: Term; XR: Term } {
  if (a.weight === undefined) {
    throw new Error("internal: aggregate atom without weight");
  }
  const k = state.lexPos;

  // Snapshot the prefix's seen-set for the freeify decision below: a
  // Variable mentioned in the user pattern is "bound by prefix" iff it's
  // in this snapshot.
  const prefixSeen = new Set(state.seen);

  // Single inline idTpl, shared by producer Emit and consumer Match. Sits
  // in the universal trailing id slot of both rows; serves as the
  // _do-agg ↔ _agg-result correlation key for closeDoAgg AND as the
  // chain-recovery anchor for the consumer Match's structural unification.
  const idTpl = freshIdTemplate(state, k, "_emitId");

  // Producer: Emit (_do-agg wrappedFreePattern idTpl) at (XL, XR).
  // Variables not bound by the prefix and Wildcards become `_free`;
  // closeDoAgg matches stored candidates against this pattern and
  // substitutes the aggregated value into the trailing `_free` slot.
  const freeify = (t: Term): Term => {
    if (t.tag === "Variable") {
      if (t.name !== "_" && prefixSeen.has(t.name)) return t;
      return SYM_FREE;
    }
    if (t.tag === "Wildcard") return SYM_FREE;
    if (t.tag === "Atom" || t.tag === "Id") {
      return { tag: t.tag, atom: { terms: t.atom.terms.map(freeify) } };
    }
    return t;
  };
  const wrappedFreeAtom: Term = {
    tag: "Atom",
    atom: { terms: [...a.atom.terms.map(freeify), SYM_FREE] },
  };
  // Producer Emit. Aggregate is exempt from the universal paired Match —
  // chain recovery is supplied by the `_agg-result` Match below, which
  // shares the trailing idTpl.
  const producerRow: Atom = { terms: [SYM_DO_AGG, wrappedFreeAtom, idTpl] };
  state.out.push({ tag: "Emit", atom: producerRow, l: XL, r: XR, span: a.span });

  // Mint slots for the consumer Match. Push to chain so the suffix sees
  // them as bound (the Match binds them via unification with the stored
  // _agg-result row's endpoints).
  const lName = `_l_${k}`;
  const rName = `_r_${k}`;
  const lVar: Term = { tag: "Variable", name: lName };
  const rVar: Term = { tag: "Variable", name: rName };
  state.seen.add(lName);
  state.chain.push(lVar);
  state.essential.add(lName);
  state.seen.add(rName);
  state.chain.push(rVar);
  state.essential.add(rName);

  // Consumer: Match (_agg-result originalPatternWithWeight idTpl) at
  // (_l_K, _r_K). No scaffolding (see header).
  const originalPatternWithWeight: Term = {
    tag: "Atom",
    atom: { terms: [...a.atom.terms, a.weight] },
  };
  // Consumer Match: shares the trailing idTpl with the producer Emit.
  // Structural unification on idTpl against the stored _agg-result row's
  // copied id binds chain Variables in the consumer's trail.
  const consumerRow: Atom = { terms: [SYM_AGG_RESULT, originalPatternWithWeight, idTpl] };
  const constraint = (a as { constraint?: MatchConstraint }).constraint;
  const matchAtom: RuleAtom = constraint === undefined
    ? { tag: "Match", atom: consumerRow, l: lVar, r: rVar, span: a.span }
    : { tag: "Match", atom: consumerRow, l: lVar, r: rVar, constraint, span: a.span };
  state.out.push(matchAtom);

  // Add user vars from the matched pattern (and weight) to the chain —
  // the consumer Match binds them via main-atom unification, same as
  // decomposeMatch does for ordinary matches.
  for (const t of a.atom.terms) collectVarsTerm(t, state);
  collectVarsTerm(a.weight, state);

  // New running anchor: the matched _agg-result row's interval. Equals
  // the producer's prefix anchor (XL, XR) by closeDoAgg invariant.
  return { XL: lVar, XR: rVar };
}

// Build the wrapped row atom for a `!` source-atom. Always shaped as
// `(_constrain (*conj sub1 ... subN))` where each `subi` is
// `(*c-plain (head t1 ...))` or `(*c-agg (head t1 ... weight))`.
// Free user-Variable names (not in `state.seen` at block entry) are
// rewritten to per-block existential `*var` templates. Anonymous
// wildcards get a fresh `*var` template each. Bound variables are
// left as Variables (the trail substitutes them at Emit-intern time).
function buildConstrainRowAtom(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  k: number,
): Atom {
  const subAtoms = a.subAtoms;
  if (subAtoms === undefined || subAtoms.length === 0) {
    throw new Error("internal: constrain RuleAtom missing subAtoms");
  }
  // Snapshot which user-Variable names are already bound at block entry.
  const prefixSeen = new Set(state.seen);
  // One `*var` template per name within this block. Two occurrences of
  // the same free var across sub-atoms share — that's the conjunctive
  // join. Two different `!(...)` blocks in the same rule get distinct
  // templates because they have different `lexPos`.
  const blockExist = new Map<string, Term>();
  const blockNames = new Set<string>(); // names consumed by this block

  function rewrite(t: Term): Term {
    if (isJsHead(t)) jsNotAllowed(state);
    if (t.tag === "Variable") {
      if (t.name === "_") {
        // Anonymous wildcard: one fresh template per occurrence.
        const n = state.anonExistCounter++;
        return freshVarTemplate(state, k, `_w${n}`);
      }
      if (prefixSeen.has(t.name)) return t; // bound by prefix — let trail substitute
      let tpl = blockExist.get(t.name);
      if (tpl === undefined) {
        tpl = freshVarTemplate(state, k, t.name);
        blockExist.set(t.name, tpl);
      }
      blockNames.add(t.name);
      return tpl;
    }
    if (t.tag === "Wildcard") {
      const n = state.anonExistCounter++;
      return freshVarTemplate(state, k, `_w${n}`);
    }
    if (t.tag === "Atom" || t.tag === "Id") {
      return { tag: t.tag, atom: { terms: t.atom.terms.map(rewrite) } };
    }
    return t;
  }

  const subTerms: Term[] = [SYM_CONJ];
  for (const sub of subAtoms) {
    const inner: Atom = { terms: sub.atom.terms.map(rewrite) };
    const wrapHead = sub.kind === "agg" ? SYM_C_AGG : SYM_C_PLAIN;
    subTerms.push({ tag: "Id", atom: { terms: [wrapHead, { tag: "Atom", atom: inner }] } });
  }
  const conj: Term = { tag: "Id", atom: { terms: subTerms } };

  // Mark this block's existential-only names. Later atoms that
  // reference them will throw via `noteVar`. If the name was already
  // in `seen` at block entry, it's an ordinary bound var, not an
  // existential — don't mark it.
  for (const n of blockNames) {
    if (!state.seen.has(n)) state.existentialNames.add(n);
  }

  return { terms: [SYM_CONSTRAIN_ROW, conj] };
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

  let rowAtom: Atom;
  if (a.marker === "constrain") {
    // Compound constrain. `subAtoms` is set by the parser for every
    // `!` form (single-atom shorthand is canonicalized to a one-element
    // list). Free user-Variable names inside the block become per-block
    // existentials (`*var` templates) rather than fresh-id'd via Equal.
    rowAtom = buildConstrainRowAtom(a, state, k);
  } else {
    // Build the atom to emit. Variables in the user atom that aren't yet
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
    } else {
      rowAtom = userAtom;
    }
  }

  // Universal id slot + paired Match. The id slot tags every emitted tuple
  // with a per-firing-unique fingerprint so the consumer split-rule's
  // structural unification on idTpl recovers chain Variables. The paired
  // Match shares the same wrappedAtom (so endpoints, user vars, and
  // chain-Vars-via-idTpl all bind in the consumer's trail). In the producer
  // it's a no-op verification of the just-emitted tuple.
  const emitIdTpl = freshIdTemplate(state, k, "_emitId");
  const wrappedRow: Atom = { terms: [...rowAtom.terms, emitIdTpl] };
  state.out.push({ tag: "Emit", atom: wrappedRow, l: emitL, r: emitR, span: a.span });
  state.out.push({ tag: "Match", atom: wrappedRow, l: lVar, r: rVar, span: a.span });

  // Now contribute lVar/rVar to chain for subsequent atoms.
  state.seen.add(lName);
  state.chain.push(lVar);
  state.essential.add(lName);
  state.seen.add(rName);
  state.chain.push(rVar);
  state.essential.add(rName);

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
