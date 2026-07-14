// Expand: rule splitting at weighted matches, semi-naive delta variants,
// then anchor decomposition into the post-expand IR.
//
// Pre-expand IR (from parse): each rule body is a list of `Atom`s (with a
// marker), `Sub`s, and `Equal`s.
//
// Post-expand IR (consumed by eval): a flat list of `Match`, `Emit`, `Le`,
// `AssertLt`, `Max`, `Min`, `Equal`. Anchor manipulation that the evaluator
// used to do implicitly is now explicit IR.

import type { Atom, Span, Term } from "./term.js";
import type { JsDef, MatchConstraint, Program, Rule, RuleAtom } from "./types.js";
import { pruneChains } from "./expand-liveness.js";

// The named intermediate rule-lists of the expansion pipeline, in order. The
// CLI's `--stage` flag dumps these; `expand` returns the final `variants`.
export interface ExpandStages {
  decomposed: Rule[];
  split: Rule[];
  filtered: Rule[];
  variants: Rule[];
}

export function expandStages(program: Program): ExpandStages {
  program = applyExceptions(program);
  const decomposed = program.rules.map((r) => {
    const { rule, essential } = decomposeRule(r, program.jsDefs, program.reactive);
    return pruneChains(rule, essential);
  });
  const split: Rule[] = [];
  for (const rule of decomposed) split.push(...splitRule(rule));
  // Drop trailing slices with no observable effect (no Emit and no AssertLt).
  // After universal splitting, every rule but the trailing tail of an
  // emit-chain ends in an Emit; the trailing tail is pure guards/matches.
  const filtered = split.filter((r) =>
    r.body.some((a) => a.tag === "Emit" || a.tag === "AssertLt"),
  );
  const variants: Rule[] = [];
  for (const rule of filtered) variants.push(...generateDeltaVariants(rule));
  return { decomposed, split, filtered, variants };
}

export function expand(program: Program): Program {
  const { variants } = expandStages(program);
  return { rules: variants, schema: program.schema, reactive: program.reactive, jsDefs: program.jsDefs };
}

// ----- Exceptions pass (plans/v2-exceptions.md, amended by
// plans/v2-exception-watchers.md) -----
//
// Source-to-source elimination of `{p t1..tn => e}` Exception atoms, run
// before any other expansion. Maintains a working set `S` of exception-free
// rules; rewrites and generated rules only ever touch `S`, so a pending
// exception's RHS is invisible to earlier exceptions and exposed to later
// ones only after it is spliced into its generated rule (the chaining
// mechanism — see the plan's worked examples).
//
// The host rule never matches `p'` itself (a match would gate `;`
// progression — the stall the watcher amendment removes). It broadcasts its
// context with a plain `anchor p_ctx U..` emit; a generated watcher rule
// joins that episode with `p'` tuples and sets the flag over the
// intersection, which is exactly the interval the old inline recognition
// produced. Exception LHS variables are therefore local to the exception,
// except that prefix-bound ones travel through the ctx payload and re-unify
// in the watcher (preserving their filter meaning).

type AtomRA = Extract<RuleAtom, { tag: "Atom" }>;
type ExceptionRA = Extract<RuleAtom, { tag: "Exception" }>;

export function applyExceptions(program: Program): Program {
  const hasExc = (r: Rule): boolean => findFirstException(r.body) !== null;
  const pending = program.rules.filter(hasExc);
  if (pending.length === 0) return program;
  const S: Rule[] = program.rules.filter((r) => !hasExc(r));
  const usedSyms = collectProgramSymbols(program);
  const usedRuleNames = new Set(program.rules.map((r) => r.name));

  for (const R of pending) {
    // Per-rule numbering for `<name>_exn<j>` / `<name>_default<j>`.
    let j = 1;
    for (;;) {
      const found = findFirstException(R.body);
      if (found === null) break;
      const { container, index } = found;
      const exc = container[index] as ExceptionRA;
      const pTerm = exc.left.terms[0]!;
      if (pTerm.tag !== "Symbol") throw new Error("internal: exception LHS head is not a Symbol");
      const p = pTerm.name;
      const tTerms = exc.left.terms.slice(1);

      // 1. Flag payload Ve = (vars(e) ∩ vars(prefix(R))) \ vars(t1..tn) and
      // ctx payload U = (vars(t1..tn) ∪ vars(e)) ∩ vars(prefix(R)), both in
      // prefix first-seen order. Prefix-bound t-vars (Vt) ride the ctx
      // payload so the watcher re-unifies them with the tuple.
      const prefixVars: string[] = [];
      collectPrefixVars(R.body, exc, new Set<string>(), prefixVars);
      const eVars = new Set<string>();
      collectBodyVars(exc.right, eVars);
      const tVars = new Set<string>();
      for (const t of tTerms) collectVarNames(t, tVars);
      const V = prefixVars.filter((n) => eVars.has(n) && !tVars.has(n));
      const U = prefixVars.filter((n) => eVars.has(n) || tVars.has(n));

      // Fresh symbols `_<p>_prime<k>` / `_<p>_exn<k>` / `_<p>_ctx<k>`.
      let k = 1;
      while (
        usedSyms.has(`_${p}_prime${k}`) ||
        usedSyms.has(`_${p}_exn${k}`) ||
        usedSyms.has(`_${p}_ctx${k}`)
      ) k++;
      const primeName = `_${p}_prime${k}`;
      const exnName = `_${p}_exn${k}`;
      const ctxName = `_${p}_ctx${k}`;
      usedSyms.add(primeName);
      usedSyms.add(exnName);
      usedSyms.add(ctxName);

      // 2. Flag schema.
      program.schema.set(exnName, "bool");

      // 3. Rewrite emitting occurrences of `p` to `p'` across S. Arity is
      // part of the predicate identity for this feature: only emits with
      // exactly the LHS's arity are renamed — a `^p x` is a different
      // predicate from `{p => e}`'s arity-0 `p` and passes through.
      for (const rule of S) rewriteEmitHeads(rule.body, p, tTerms.length, primeName);

      // 4. Replace the Exception atom in R with the single emit
      // `anchor p_ctx U..` — no match, so nothing gates `;` progression.
      // An anchor emit lands exactly on R's running anchor interval at
      // this body position.
      const span = exc.span;
      const sym = (name: string): Term => ({ tag: "Symbol", name });
      const vars = (names: string[]): Term[] => names.map((n) => ({ tag: "Variable", name: n }));
      const ctxEmit: AtomRA = {
        tag: "Atom", marker: "anchor",
        atom: { terms: [sym(ctxName), ...vars(U)] }, span,
      };
      container.splice(index, 1, ctxEmit);

      // Generated rule names, skipping to the next free integer on collision.
      while (
        usedRuleNames.has(`${R.name}_watch${j}`) ||
        usedRuleNames.has(`${R.name}_exn${j}`) ||
        usedRuleNames.has(`${R.name}_default${j}`)
      ) j++;
      const watchRuleName = `${R.name}_watch${j}`;
      const exnRuleName = `${R.name}_exn${j}`;
      const defaultRuleName = `${R.name}_default${j}`;
      j++;
      usedRuleNames.add(watchRuleName);
      usedRuleNames.add(exnRuleName);
      usedRuleNames.add(defaultRuleName);

      // 5. Watcher rule: match p_ctx U.., match p' t.., anchor p_exn V.. -> 1.
      // The two matches intersect, so the flag covers ctx ∩ tuple — the same
      // interval the old inline recognition emitted it over.
      S.push({
        name: watchRuleName,
        span,
        body: [
          { tag: "Atom", marker: "match", atom: { terms: [sym(ctxName), ...vars(U)] }, span },
          { tag: "Atom", marker: "match", atom: { terms: [sym(primeName), ...tTerms] }, span },
          { tag: "Atom", marker: "anchor", atom: { terms: [sym(exnName), ...vars(V)] }, weight: sym("1"), span },
        ],
      });

      // 6. Exception rule: match p' t.., aggregate p_exn V.. -> 1, e.
      S.push({
        name: exnRuleName,
        span,
        body: [
          { tag: "Atom", marker: "match", atom: { terms: [sym(primeName), ...tTerms] }, span },
          { tag: "Atom", marker: "aggregate", atom: { terms: [sym(exnName), ...vars(V)] }, weight: sym("1"), span },
          ...exc.right,
        ],
      });

      // 7. Default rule: match p' W.., aggregate p_exn _.._ -> 0,
      // anchor p W..  (fresh W1..Wn, m wildcards).
      const W: Term[] = tTerms.map((_, i) => ({ tag: "Variable", name: `_w${i + 1}` }));
      const flagWilds: Term[] = V.map(() => ({ tag: "Wildcard" }));
      S.push({
        name: defaultRuleName,
        span,
        body: [
          { tag: "Atom", marker: "match", atom: { terms: [sym(primeName), ...W] }, span },
          { tag: "Atom", marker: "aggregate", atom: { terms: [sym(exnName), ...flagWilds] }, weight: sym("0"), span },
          { tag: "Atom", marker: "anchor", atom: { terms: [sym(p), ...W] }, span },
        ],
      });
    }
    // 8. R is now in normal form.
    S.push(R);
  }
  return { ...program, rules: S };
}

// First remaining Exception atom in pre-order, with a mutable handle on its
// containing array so it can be replaced in place. Exception RHS fragments
// are not descended into (they contain no Exceptions by construction).
function findFirstException(
  body: RuleAtom[],
): { container: RuleAtom[]; index: number } | null {
  for (let i = 0; i < body.length; i++) {
    const a = body[i]!;
    if (a.tag === "Exception") return { container: body, index: i };
    if (a.tag === "Sub") {
      const inner = findFirstException(a.body);
      if (inner !== null) return inner;
    }
  }
  return null;
}

// Collect Variable names appearing in R's body pre-order, stopping at the
// given Exception atom (exclusive). Returns true when the stop atom was hit.
function collectPrefixVars(
  body: RuleAtom[],
  stopAt: RuleAtom,
  seen: Set<string>,
  out: string[],
): boolean {
  for (const a of body) {
    if (a === stopAt) return true;
    if (a.tag === "Sub") {
      if (collectPrefixVars(a.body, stopAt, seen, out)) return true;
      continue;
    }
    collectAtomVarsOrdered(a, seen, out);
  }
  return false;
}

function collectAtomVarsOrdered(a: RuleAtom, seen: Set<string>, out: string[]): void {
  const push = (t: Term): void => {
    if (t.tag === "Variable") {
      if (t.name !== "_" && !seen.has(t.name)) { seen.add(t.name); out.push(t.name); }
    } else if (t.tag === "Atom" || t.tag === "Id") {
      for (const x of t.atom.terms) push(x);
    }
  };
  if (a.tag === "Atom") {
    if (a.subAtoms !== undefined) {
      for (const s of a.subAtoms) for (const t of s.atom.terms) push(t);
    } else {
      for (const t of a.atom.terms) push(t);
    }
    if (a.weight !== undefined) push(a.weight);
    if (a.lLit !== undefined) push(a.lLit);
    if (a.rLit !== undefined) push(a.rLit);
  } else if (a.tag === "Equal") {
    push(a.lhs);
    push(a.rhs);
  } else if (a.tag === "Exception") {
    // An earlier Exception cannot occur (they are processed first-to-last),
    // but keep the walk total: its in-place replacement contributes vars
    // via the Atom arm after processing.
  }
}

// Variable names anywhere in a body fragment (order-insensitive).
function collectBodyVars(body: RuleAtom[], out: Set<string>): void {
  const dummy: string[] = [];
  const push = (a: RuleAtom): void => {
    if (a.tag === "Sub") { collectBodyVars(a.body, out); return; }
    if (a.tag === "Exception") {
      for (const t of a.left.terms) collectVarNames(t, out);
      collectBodyVars(a.right, out);
      return;
    }
    collectAtomVarsOrdered(a, out, dummy);
  };
  for (const a of body) push(a);
}

function collectVarNames(t: Term, out: Set<string>): void {
  if (t.tag === "Variable") {
    if (t.name !== "_") out.add(t.name);
  } else if (t.tag === "Atom" || t.tag === "Id") {
    for (const x of t.atom.terms) collectVarNames(x, out);
  }
}

// Rewrite the head of every emitting (`fact`/`episode`/`anchor`) atom whose
// head Symbol is `p` *and* whose arity matches the exception LHS to
// `primeName`, in place. Matches / aggregates / constrains / asks stay
// untouched, as do emits of `p` at other arities (distinct predicates for
// this feature — the generated match/default rules are arity-exact, so a
// renamed off-arity emit would be orphaned).
function rewriteEmitHeads(body: RuleAtom[], p: string, arity: number, primeName: string): void {
  for (const a of body) {
    if (a.tag === "Sub") { rewriteEmitHeads(a.body, p, arity, primeName); continue; }
    if (a.tag !== "Atom") continue;
    if (a.marker !== "fact" && a.marker !== "episode" && a.marker !== "anchor") continue;
    // Weighted emits (`+p .. -> w`, aggregate-relation assertions) store the
    // weight in a trailing slot — renaming one would orphan it the same way
    // an off-arity emit would. They are not interceptable.
    if (a.weight !== undefined) continue;
    if (a.atom.terms.length !== arity + 1) continue;
    const head = a.atom.terms[0];
    if (head !== undefined && head.tag === "Symbol" && head.name === p) {
      a.atom.terms[0] = { tag: "Symbol", name: primeName };
    }
  }
}

// Every Symbol name occurring in the program (rule bodies, schema keys,
// #js names). Used to mint fresh `_<p>_prime<k>` / `_<p>_exn<k>` names.
function collectProgramSymbols(program: Program): Set<string> {
  const out = new Set<string>();
  const term = (t: Term): void => {
    if (t.tag === "Symbol") out.add(t.name);
    else if (t.tag === "Atom" || t.tag === "Id") {
      for (const x of t.atom.terms) term(x);
    }
  };
  const walk = (body: RuleAtom[]): void => {
    for (const a of body) {
      if (a.tag === "Sub") { walk(a.body); continue; }
      if (a.tag === "Exception") {
        for (const t of a.left.terms) term(t);
        walk(a.right);
        continue;
      }
      if (a.tag === "Equal") { term(a.lhs); term(a.rhs); continue; }
      if (a.tag !== "Atom") continue;
      if (a.subAtoms !== undefined) {
        for (const s of a.subAtoms) for (const t of s.atom.terms) term(t);
      } else {
        for (const t of a.atom.terms) term(t);
      }
      if (a.weight !== undefined) term(a.weight);
      if (a.lLit !== undefined) term(a.lLit);
      if (a.rLit !== undefined) term(a.rLit);
    }
  };
  for (const r of program.rules) walk(r.body);
  for (const key of program.schema.keys()) out.add(key);
  for (const key of program.jsDefs.keys()) out.add(key);
  return out;
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
  // `_xr_<k>`). Independent of lexPos. Minted only by decomposeMatch's
  // anchor intersection; emits and sequence-subs reduce statically.
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
  // for user Variables and endpoint slots (`_l_K` / `_r_K`, which
  // distinguish firings on different stored rows); not populated for
  // anchor SSA (`_xl_K` / `_xr_K`, minted only at matches), which are
  // pure reductions of other entries. Consumed by `pruneChains` in
  // expand-liveness.ts.
  essential: Set<string>;
  // `#js` function table (for `@js(...)` lowering: existence + arity checks).
  jsDefs: Map<string, JsDef>;
  // Counter for fresh `_js_<k>` result Variables.
  jsCounter: number;
  // Relations declared `#reactive`: their `head ... -> weight` reads lower to
  // a plain Match of the `_aggval` value relation instead of the demand
  // `_do-agg`/`_agg-result` pair. See plans/v2-reactive-aggregates.md.
  reactive: Set<string>;
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
const SYM_AGGVAL: Term = { tag: "Symbol", name: "_aggval" };
const SYM_FREE: Term = { tag: "Symbol", name: "_free" };
const SYM_L: Term = { tag: "Symbol", name: "l" };
const SYM_R: Term = { tag: "Symbol", name: "r" };

function decomposeRule(
  rule: Rule,
  jsDefs: Map<string, JsDef>,
  reactive: Set<string>,
): { rule: Rule; essential: Set<string> } {
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
    reactive,
  };
  decomposeBody(rule.body, state, SYM_BOT, SYM_TOP);
  return { rule: { ...rule, body: state.out }, essential: state.essential };
}

function freshAnchorVar(state: DecState, kind: "xl" | "xr"): Term {
  const k = state.anchorCounter++;
  const name = `_${kind}_${k}`;
  const v: Term = { tag: "Variable", name };
  // Push onto chain so atoms in a downstream consumer split-rule
  // (e.g. a later match's intersection `Max XL lVar` / `Min XR rVar`)
  // can recover this anchor SSA from the matched row's trailing idTpl
  // via structural unification. Only decomposeMatch mints these now —
  // a matched tuple's endpoints have no static ordering relationship
  // to the running anchor, so its Max/Min are genuinely dynamic.
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
        // Statically-reduced sequence close — no Max atom. The inner
        // block ran from (XL, XR); by the running-anchor invariant
        // `XL <= inner-final-XL <= inner.XR`, so the `Max(XL, inner.XR)`
        // formerly emitted here always picked `inner.XR`, and its
        // comparability check could never fail (each lessEq link in the
        // chain is an order-graph path or a bot/top sentinel, and
        // `lessThanTok` finds the composition by path concatenation).
        XL = inner.XR;
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
        const head = a.atom.terms[0];
        const isReactive = head !== undefined && head.tag === "Symbol" && state.reactive.has(head.name);
        const next = isReactive
          ? decomposeReactiveRead(a, state, XL, XR)
          : decomposeAggregate(a, state, XL, XR);
        XL = next.XL;
        XR = next.XR;
      } else {
        const next = decomposeEmit(a, state, XL, XR);
        XL = next.XL;
        XR = next.XR;
      }
      continue;
    }
    if (a.tag === "Exception") {
      throw new Error("internal: Exception atom reached decomposition (applyExceptions missing?)");
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

// Reactive read: a `#reactive head pat -> weight` consumer lowers to a plain
// Match of the standing value relation `_aggval head pat... weight`, evaluated
// at the running anchor like any ordinary match (overlap + intersection, then
// semi-naive). There is no producer Emit — the `_aggval` rows are materialized
// eagerly by the scheduler at breakpoints (see scheduler.ts/fixpoint.ts and
// plans/v2-reactive-aggregates.md). A variable in the weight slot binds the
// current value; a literal filters to where the value equals it.
function decomposeReactiveRead(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  XL: Term,
  XR: Term,
): { XL: Term; XR: Term } {
  if (a.weight === undefined) {
    throw new Error("internal: reactive read without weight");
  }
  // `[_aggval, head, key..., value]`. decomposeMatch appends the trailing
  // universal id Wildcard, matching the scheduler-emitted row's id slot.
  const matchAtom: Extract<RuleAtom, { tag: "Atom" }> = {
    tag: "Atom",
    marker: "match",
    atom: { terms: [SYM_AGGVAL, ...a.atom.terms, a.weight] },
    span: a.span,
  };
  return decomposeMatch(matchAtom, state, XL, XR);
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

  // Statically-reduced anchor update — no Max/Min atoms. The running
  // anchor obeys `XL <= XR` on every live trail, with XL non-decreasing
  // and XR non-increasing over the body. The AssertLt atoms above
  // *impose* order edges (`evalAssertLt` calls `addOrder`), so after a
  // fact emit `XL < lVar < XR` and after an episode `XL < lVar < rVar <
  // XR` hold by construction; the `Max(XL, emitL)` / `Min(XR, emitR)`
  // pair formerly emitted here could only ever pick `(lVar, XR)` resp.
  // `(lVar, rVar)` (fact's emitR is `top`, so `Min(XR, top) = XR`).
  // Their comparability check could never fail either: each lessEq fact
  // above is a direct addOrder edge or involves the bot/top sentinels,
  // which `lessThanTok` special-cases as universally comparable. The
  // atoms were pure no-ops — don't re-add them defensively. The anchor
  // (`^`) case emits no asserts and leaves the anchor untouched.
  switch (a.marker) {
    case "episode":
      return { XL: lVar, XR: rVar };
    case "anchor":
      return { XL, XR };
    default: // fact / ask / constrain
      return { XL: lVar, XR };
  }
}
