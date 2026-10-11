// Expand: exceptions, anchor decomposition into the post-expand IR, rule
// splitting at every emit, js-mode resolution, semi-naive delta variants.
//
// Pre-expand IR (from parse): each rule body is a list of `Atom`s (with a
// marker), `Sub`s, and `Equal`s.
//
// Post-expand IR (consumed by eval): a flat list of `Match`, `Emit`, `Le`,
// `AssertLt`, `Max`, `Min`, `Equal`. Anchor manipulation that the evaluator
// used to do implicitly is now explicit IR.

import type { Atom, Span, Term } from "./term.js";
import type { AccDecl, AccRule, JsDef, JsRelDef, MatchConstraint, Program, ProvLink, Rule, RuleAtom } from "./types.js";
import { exprTerms } from "./types.js";
import { pruneChains } from "./expand-liveness.js";
import { resolveJsModes } from "./js-rel.js";
import { accOp, UNIT } from "./acc-ops.js";
import { ACC_AT_HEAD, ACC_MOMENT_VAR } from "./eval.js";

// `_is-input` (scheduler.ts) — defined here to keep expand free of scheduler imports.
const SYM_IS_INPUT: Term = { tag: "Symbol", name: "_is-input" };

// The named intermediate rule-lists of the expansion pipeline, in order. The
// CLI's `--stage` flag dumps these; `expand` returns the final `variants`.
export interface ExpandStages {
  decomposed: Rule[];
  split: Rule[];
  filtered: Rule[];
  resolved: Rule[];
  variants: Rule[];
}

export function expandStages(program: Program): ExpandStages {
  program = applyExceptions(program);
  const decomposed = program.rules.map((r) => {
    const { rule, essential } = decomposeRule(r, program.jsDefs, program.jsRels, program.accDecls);
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
  // Resolve `#js-def` clause selection (plans/v2-js-relations.md). Needs the
  // post-split flat bodies (a consumer slice's leading Match makes the
  // cross-split chain variables visible as bound); runs before the delta
  // variants since those only re-tag Match constraints.
  const resolved = resolveJsModes(filtered, program.jsRels);
  const variants: Rule[] = [];
  for (const rule of resolved) variants.push(...generateDeltaVariants(rule));
  return { decomposed, split, filtered, resolved, variants };
}

export function expand(program: Program): Program {
  const { variants } = expandStages(program);
  return {
    rules: variants,
    jsDefs: program.jsDefs,
    jsRels: program.jsRels,
    accDecls: program.accDecls,
    accRules: program.accRules,
  };
}

// ----- Exceptions pass (plans/v2-exceptions.md, amended by
// plans/v2-exception-watchers.md and plans/v2-exception-tuple-keyed-flags.md) -----
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
//
// The flag `p_exn` is keyed by the intercepted tuple itself (the LHS terms
// with wildcards freshened), never by transported context: the default rule
// reads the flag for *its own* tuple, so two `p'` tuples sharing one moment
// are intercepted independently, and the read always has every key column
// bound (a free key column with no contributions yields no zero row, so a
// wildcard-keyed default read silently never fires — the tuple-keyed-flags
// plan). Context vars needed by the RHS are recovered in the exception rule
// by re-joining the ctx tuple.

type AtomRA = Extract<RuleAtom, { tag: "Atom" }>;
type ExceptionRA = Extract<RuleAtom, { tag: "Exception" }>;

export function applyExceptions(program: Program): Program {
  const hasExc = (r: Rule): boolean => findFirstException(r.body) !== null;
  const pending = program.rules.filter(hasExc);
  if (pending.length === 0) return program;
  const S: Rule[] = program.rules.filter((r) => !hasExc(r));
  const usedSyms = collectProgramSymbols(program);
  const usedRuleNames = new Set([...program.rules, ...program.accRules].map((r) => r.name));
  // Generated default rules, kept for provenance-link derivation below.
  const defaultRules: Rule[] = [];


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
      // A js relation is never emitted, so there is nothing to intercept.
      if (program.jsRels.has(p)) {
        throw new Error(`rule '${R.name}': js relation '${p}' cannot be an exception's left-hand side`);
      }
      // Nor is an acc relation (computed by `/` rules at resolution).
      if (program.accDecls.has(p)) {
        throw new Error(`rule '${R.name}': acc relation '${p}' cannot be an exception's left-hand side`);
      }
      const tTerms = exc.left.terms.slice(1);

      // 1. Flag key t° = t1..tn with each wildcard replaced by a fresh
      // `_t<i>` variable (one running counter, pre-order), so the watcher
      // can bind and re-emit the whole tuple. Ctx payload
      // U = (vars(t1..tn) ∪ vars(e)) ∩ vars(prefix(R)) in prefix first-seen
      // order: prefix-bound t-vars (Vt) ride it so the watcher re-unifies
      // them with the tuple; prefix vars used by `e` ride it so the
      // exception rule can recover them.
      const prefixVars: string[] = [];
      collectPrefixVars(R.body, exc, new Set<string>(), prefixVars);
      const eVars = new Set<string>();
      collectBodyVars(exc.right, eVars);
      const tVars = new Set<string>();
      for (const t of tTerms) collectVarNames(t, tVars);
      const U = prefixVars.filter((n) => eVars.has(n) || tVars.has(n));
      let wildN = 0;
      const tFresh: Term[] = tTerms.map((t) => freshenWildcards(t, () => `_t${++wildN}`));

      // Fresh symbols `_<p>_prime<k>` / `_<p>_exn<k>` (the interception
      // flag) / `_<p>_ctx<k>`.
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
        tag: "Atom", marker: "anchor", exact: true,
        atom: { terms: [sym(ctxName), ...vars(U)] }, span,
      } as AtomRA;
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

      // 5. Watcher rule: match p' t°.., (p_ctx U..), exact p_exn t°.. .
      // The context is peeked, not intersected: the flag sits exactly on the
      // intercepted tuple's interval whenever the context overlaps it, so
      // the flag read at the tuple's start always sees it. (Requiring the
      // context to be alive at the tuple's start was considered and
      // rejected: under fresh-left `^` a context read from a sibling `^`
      // fact starts at a moment incomparable to the tuple's —
      // plans/v2-caret-fresh-left.md §5.2.)
      S.push({
        name: watchRuleName,
        span,
        body: [
          { tag: "Atom", marker: "match", atom: { terms: [sym(primeName), ...tFresh] }, span },
          { tag: "Sub", sequence: false, span, body: [
            { tag: "Atom", marker: "match", atom: { terms: [sym(ctxName), ...vars(U)] }, span },
          ] },
          { tag: "Atom", marker: "anchor", exact: true, atom: { terms: [sym(exnName), ...tFresh] }, span } as AtomRA,
        ],
      });

      // 6. Exception rule: match p' t°.., p_exn t°.. (the flag is a plain
      // tuple on the tuple's own interval, so this match is monotone),
      // (p_ctx U..), e. The peeked ctx re-join binds the prefix vars `e`
      // needs and re-checks Vt against the tuple. `e` runs on the tuple's
      // interval. An empty RHS means bare suppression — the flag still
      // gates the default rule, but there is no exception case to run.
      if (exc.right.length > 0) {
        S.push({
          name: exnRuleName,
          span,
          body: [
            { tag: "Atom", marker: "match", atom: { terms: [sym(primeName), ...tFresh] }, span },
            { tag: "Atom", marker: "match", atom: { terms: [sym(exnName), ...tFresh] }, span },
            { tag: "Sub", sequence: false, span, body: [
              { tag: "Atom", marker: "match", atom: { terms: [sym(ctxName), ...vars(U)] }, span },
            ] },
            ...exc.right,
          ],
        });
      }

      // 7. Default rule: match p' W.., <exnCheck p_exn W..>, exact p W..
      // (fresh W1..Wn). W is bound by the match. The check is answered by
      // the exception-check handler (scheduler.ts) only after the inner
      // loop is quiet — so every watcher that can flag this tuple has run,
      // including for a tuple re-emitted at an already-settled moment by an
      // earlier exception's default (chained exceptions on one `p`). It
      // succeeds exactly when the tuple was not intercepted; the
      // re-emission keeps the tuple's endpoints. Internal flags are not
      // `#acc` rows: acc rows at a settled moment are frozen, which a chain
      // would race (plans/v2-caret-fresh-left.md §5.2).
      const W: Term[] = tTerms.map((_, i) => ({ tag: "Variable", name: `_w${i + 1}` }));
      const defaultRule: Rule = {
        name: defaultRuleName,
        span,
        body: [
          { tag: "Atom", marker: "match", atom: { terms: [sym(primeName), ...W] }, span },
          { tag: "Atom", marker: "match", exnCheck: true, atom: { terms: [sym(exnName), ...W] }, span },
          { tag: "Atom", marker: "anchor", exact: true, atom: { terms: [sym(p), ...W] }, span } as AtomRA,
        ],
      };
      S.push(defaultRule);
      defaultRules.push(defaultRule);
    }
    // 8. R is now in normal form.
    S.push(R);
  }
  return { ...program, rules: S, provLinks: deriveProvLinks(defaultRules) };
}

// One ProvLink per generated default rule, read from its *final* body: a
// later exception on the same relation renames an earlier default rule's
// emit head (`rewriteEmitHeads` covers `anchor`), so links recorded at
// generation time would go stale. The match atom identifies the prime side
// (match heads are never renamed); the anchor atom identifies the emitted
// head as of the end of the pass.
function deriveProvLinks(defaultRules: Rule[]): ProvLink[] {
  const out: ProvLink[] = [];
  for (const dr of defaultRules) {
    let prime: string | undefined;
    let head: string | undefined;
    let arity = 0;
    for (const a of dr.body) {
      if (a.tag !== "Atom") continue;
      const h = a.atom.terms[0];
      if (h === undefined || h.tag !== "Symbol") continue;
      if (a.marker === "match" && !a.exnCheck) prime = h.name;
      else if (a.marker === "anchor") {
        head = h.name;
        arity = a.atom.terms.length - 1;
      }
    }
    if (prime === undefined || head === undefined) {
      throw new Error("internal: malformed exception default rule");
    }
    out.push({ head, prime, arity });
  }
  return out;
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
    if (a.lLit !== undefined) push(a.lLit);
    if (a.rLit !== undefined) push(a.rLit);
  } else if (a.tag === "Equal") {
    push(a.lhs);
    for (const t of exprTerms(a.rhs)) push(t);
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

// Copy `t` with every wildcard (a `Wildcard` term or a `_` Variable)
// replaced by a fresh Variable named by `next()`, pre-order.
function freshenWildcards(t: Term, next: () => string): Term {
  if (t.tag === "Wildcard" || (t.tag === "Variable" && t.name === "_")) {
    return { tag: "Variable", name: next() };
  }
  if (t.tag === "Atom" || t.tag === "Id") {
    return { ...t, atom: { ...t.atom, terms: t.atom.terms.map((x) => freshenWildcards(x, next)) } };
  }
  return t;
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
    if (a.atom.terms.length !== arity + 1) continue;
    const head = a.atom.terms[0];
    if (head !== undefined && head.tag === "Symbol" && head.name === p) {
      a.atom.terms[0] = { tag: "Symbol", name: primeName };
    }
  }
}

// Every Symbol name occurring in the program (rule bodies, acc and #js
// names). Used to mint fresh `_<p>_prime<k>` / `_<p>_exn<k>` names.
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
      if (a.tag === "Equal") { term(a.lhs); exprTerms(a.rhs).forEach(term); continue; }
      if (a.tag !== "Atom") continue;
      if (a.subAtoms !== undefined) {
        for (const s of a.subAtoms) for (const t of s.atom.terms) term(t);
      } else {
        for (const t of a.atom.terms) term(t);
      }
      if (a.lLit !== undefined) term(a.lLit);
      if (a.rLit !== undefined) term(a.rLit);
    }
  };
  for (const r of program.rules) walk(r.body);
  for (const r of program.accRules) {
    walk(r.body);
    for (const t of r.head.terms) term(t);
  }
  for (const key of program.jsDefs.keys()) out.add(key);
  for (const key of program.jsRels.keys()) out.add(key);
  for (const key of program.accDecls.keys()) out.add(key);
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
  for (const a of rule.body) if (a.tag === "Match" && !a.negated) n++;
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
    if (a.tag !== "Match" || a.negated) return a;
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
// The exception check (`decomposeExnCheck`) is the one exception to the
// paired-Match construction: its `_exn-wait` Emit is followed by the
// `_exn-clear` Match, which shares the trailing id and takes the role of the
// chain-recovery Match.

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
  // `#js-def` relation table (plans/v2-js-relations.md): match atoms whose
  // head is a key lower to `JsIterate`; any other appearance is an error.
  jsRels: Map<string, JsRelDef[]>;
  // Counter for fresh `_js_<k>` result Variables.
  jsCounter: number;
  // Relations declared `#acc` (plans/v2-acc-relations.md): a plain match
  // lowers to a point read at the anchor's left endpoint
  // (`decomposeAccRead`); every other appearance is an error.
  accDecls: Map<string, AccDecl>;
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
const SYM_C_JS: Term = { tag: "Symbol", name: "*c-js" };
const SYM_CHOOSE_ROW: Term = { tag: "Symbol", name: "_choose" };
const SYM_CONSTRAIN_ROW: Term = { tag: "Symbol", name: "_constrain" };
// Written by the acc handler at a moment when it computes the acc rows there,
// if the program has a negated read (acc.ts); a `not` read waits on it, and
// reading it demands the rows at that moment (eval.ts `evalMatch`).
export const SYM_ACC_AT: Term = { tag: "Symbol", name: ACC_AT_HEAD };
// Exception default checks (decomposeExnCheck; answered in scheduler.ts).
export const SYM_EXN_WAIT: Term = { tag: "Symbol", name: "_exn-wait" };
export const SYM_EXN_CLEAR: Term = { tag: "Symbol", name: "_exn-clear" };
export const SYM_EXN_HELD: Term = { tag: "Symbol", name: "_exn-held" };
const SYM_C_NOT: Term = { tag: "Symbol", name: "*c-not" };

// User variable names (not `_`) occurring anywhere in `ts`.
function termsVars(ts: Term[]): string[] {
  const out: string[] = [];
  const walk = (t: Term): void => {
    if (t.tag === "Variable") { if (t.name !== "_" && !out.includes(t.name)) out.push(t.name); return; }
    if (t.tag === "Atom" || t.tag === "Id") t.atom.terms.forEach(walk);
  };
  ts.forEach(walk);
  return out;
}
const SYM_L: Term = { tag: "Symbol", name: "l" };
const SYM_R: Term = { tag: "Symbol", name: "r" };

function freshDecState(
  ruleName: string,
  jsDefs: Map<string, JsDef>,
  jsRels: Map<string, JsRelDef[]>,
  accDecls: Map<string, AccDecl>,
): DecState {
  return {
    ruleName,
    out: [],
    lexPos: 0,
    anchorCounter: 0,
    chain: [],
    seen: new Set(),
    essential: new Set(),
    existentialNames: new Set(),
    anonExistCounter: 0,
    jsDefs,
    jsRels,
    jsCounter: 0,
    accDecls,
  };
}

function decomposeRule(
  rule: Rule,
  jsDefs: Map<string, JsDef>,
  jsRels: Map<string, JsRelDef[]>,
  accDecls: Map<string, AccDecl>,
): { rule: Rule; essential: Set<string> } {
  const state = freshDecState(rule.name, jsDefs, jsRels, accDecls);
  decomposeBody(rule.body, state, SYM_BOT, SYM_TOP);
  return { rule: { ...rule, body: state.out }, essential: state.essential };
}

// ----- Acc rules (plans/v2-acc-relations.md §4.1) -----
//
// Lower `body / head` into a flat body the evaluator runs at one moment.
// The anchor is the single Variable `_acc_m` (ACC_MOMENT_VAR); acc.ts
// prepends `Equal _acc_m <m>` per moment. Every stored-tuple read is a
// point-containment check (`Le l m`, `Le m r`), never a Max/Min — the anchor
// is the point and never moves. Reads of other acc relations become
// `AccMatch` against the handler's local rows; the head becomes one
// `AccContribute`. No split, no chain pruning, no delta variants: acc rules
// run naively to a local fixpoint inside the handler.
export function decomposeAccRule(rule: AccRule, program: Program): Rule {
  const state = freshDecState(rule.name, program.jsDefs, program.jsRels, program.accDecls);
  const M: Term = { tag: "Variable", name: ACC_MOMENT_VAR };
  state.seen.add(ACC_MOMENT_VAR);
  state.chain.push(M);
  const moments: Term[] = [];
  const ids: Term[] = [];
  for (const a of rule.body) {
    if (a.tag === "Equal") {
      collectVarsTerm(a.lhs, state);
      for (const t of exprTerms(a.rhs)) collectVarsTerm(t, state);
      state.out.push(a);
      continue;
    }
    if (a.tag !== "Atom") {
      throw new Error(`internal: acc rule '${rule.name}': unexpected body atom '${a.tag}'`);
    }
    state.lexPos++;
    if (decomposeJsRel(a, state)) continue;
    const h = a.atom.terms[0];
    const hn = h !== undefined && h.tag === "Symbol" ? h.name : undefined;
    if (a.lLit !== undefined || a.rLit !== undefined) {
      throw new Error(`acc rule '${rule.name}': endpoint literals are not supported in acc bodies`);
    }
    const k = state.lexPos;
    if (hn !== undefined && state.accDecls.has(hn)) {
      // Read of another acc relation, at this same moment.
      const decl = state.accDecls.get(hn)!;
      if (a.atom.terms.length - 1 !== decl.columns.length) {
        throw new Error(
          `acc rule '${rule.name}': '${hn}' has ${decl.columns.length} column(s), pattern has ${a.atom.terms.length - 1}`,
        );
      }
      if (a.negated) {
        const unbound = termsVars(a.atom.terms).filter((n) => !state.seen.has(n));
        if (unbound.length > 0) {
          throw new Error(
            `acc rule '${rule.name}': 'not ${hn} …' needs its variables bound before it (unbound: ${unbound.join(", ")})`,
          );
        }
        state.out.push({ tag: "AccMatch", relation: hn, atom: a.atom, moment: { tag: "Wildcard" }, negated: true, span: a.span });
        continue;
      }
      const mv: Term = { tag: "Variable", name: `_am_${k}` };
      const rowId: Term = { tag: "Variable", name: `_aid_${k}` };
      for (const v of [mv, rowId]) {
        if (v.tag !== "Variable") continue;
        state.seen.add(v.name);
        state.chain.push(v);
        state.essential.add(v.name);
      }
      state.out.push({ tag: "AccMatch", relation: hn, atom: a.atom, moment: mv, id: rowId, span: a.span });
      ids.push(rowId);
      for (const t of a.atom.terms) collectVarsTerm(t, state);
      moments.push(mv);
      continue;
    }
    if (a.negated) {
      throw new Error(
        `acc rule '${rule.name}': 'not' reads an '#acc' relation; '${hn ?? "?"}' is not one`,
      );
    }
    // Ordinary stored relation: Match at (l, r) with the tuple's id bound
    // (firing identity), then point containment of `_acc_m`.
    const lVar: Term = { tag: "Variable", name: `_l_${k}` };
    const rVar: Term = { tag: "Variable", name: `_r_${k}` };
    const idVar: Term = { tag: "Variable", name: `_id_${k}` };
    for (const v of [lVar, rVar, idVar]) {
      if (v.tag !== "Variable") continue;
      state.seen.add(v.name);
      state.chain.push(v);
      state.essential.add(v.name);
    }
    const matchAtom: Atom = { terms: [...a.atom.terms, idVar] };
    state.out.push({ tag: "Match", atom: matchAtom, l: lVar, r: rVar, span: a.span });
    state.out.push({ tag: "Le", a: lVar, b: M, span: a.span });
    state.out.push({ tag: "Le", a: M, b: rVar, span: a.span });
    for (const t of a.atom.terms) collectVarsTerm(t, state);
    moments.push(lVar);
    ids.push(idVar);
  }
  // Head: every column term must be ground given the body (range
  // restriction); `@js(...)` lowers to JsCall atoms pushed before the
  // contribution; the agg column of an arity-0 op is the unit.
  const headSym = rule.head.terms[0];
  if (headSym === undefined || headSym.tag !== "Symbol") {
    throw new Error(`internal: acc rule '${rule.name}': head is not a Symbol`);
  }
  const decl = program.accDecls.get(headSym.name);
  if (decl === undefined) {
    throw new Error(`acc rule '${rule.name}': head '${headSym.name}' is not declared with '#acc'`);
  }
  const aggCol = decl.aggIndex === null ? null : decl.columns[decl.aggIndex]!;
  const op = aggCol !== null && aggCol.kind === "agg" ? accOp(aggCol.op) : undefined;
  const lexPos = state.lexPos + 1;
  const terms: Term[] = rule.head.terms.slice(1).map((t, i) => {
    if (decl.aggIndex === i && op !== undefined && op.arity === 0) return UNIT;
    return accHeadTerm(t, state, lexPos, rule.span);
  });
  state.out.push({ tag: "AccContribute", relation: headSym.name, terms, moments, ids, span: rule.span });
  return { name: rule.name, body: state.out, span: rule.span };
}

// Head terms of an acc rule: bound Variables and ground terms pass through,
// `@js(...)` lowers, anything unbound is a range-restriction error.
function accHeadTerm(t: Term, state: DecState, lexPos: number, span: Span): Term {
  if (t.tag === "Variable") {
    if (t.name === "_" || !state.seen.has(t.name)) {
      throw new Error(
        `acc rule '${state.ruleName}': head variable '${t.name}' is not bound by the body`,
      );
    }
    return t;
  }
  if (t.tag === "Wildcard") {
    throw new Error(`acc rule '${state.ruleName}': '_' in the head has no value`);
  }
  if (isJsHead(t)) return lowerJsCall(t, state, lexPos, span);
  if (t.tag === "Atom" || t.tag === "Id") {
    return { tag: t.tag, atom: { terms: t.atom.terms.map((x) => accHeadTerm(x, state, lexPos, span)) } };
  }
  return t;
}

// An acc relation read in an ordinary rule (plans/v2-acc-relations.md
// §4.3): `Match [name, pat…, _] at (XL, XL)`, anchor unchanged — the same
// shape as a reactive read. Samples the relation at the anchor's start and
// cannot fire before the walk has resolved that moment. Returns true when
// the atom was consumed; any non-match use of an acc relation throws.
function decomposeAccRead(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  XL: Term,
): boolean {
  if (a.subAtoms !== undefined) return false; // `!(...)`: checked in buildConstrainRowAtom
  const h = a.atom.terms[0];
  if (a.negated && (h === undefined || h.tag !== "Symbol" || !state.accDecls.has(h.name))) {
    throw new Error(
      `rule '${state.ruleName}': 'not' reads an '#acc' relation; '${h !== undefined && h.tag === "Symbol" ? h.name : "?"}' ` +
      `is not one — declare a boolean acc relation (e.g. '#acc fallen : pin' with 'down Q / fallen Q') and negate that`,
    );
  }
  if (h === undefined || h.tag !== "Symbol" || !state.accDecls.has(h.name)) return false;
  if (a.marker !== "match") {
    throw new Error(
      `rule '${state.ruleName}': '${h.name}' is an acc relation — computed by '/' rules, never asserted; ` +
      `read it with a plain match (no marker)`,
    );
  }
  const decl = state.accDecls.get(h.name)!;
  if (a.atom.terms.length - 1 !== decl.columns.length) {
    throw new Error(
      `rule '${state.ruleName}': '${h.name}' has ${decl.columns.length} column(s), pattern has ${a.atom.terms.length - 1}`,
    );
  }
  const matchAtom: Atom = { terms: [...a.atom.terms, { tag: "Wildcard" }] };
  if (a.negated) {
    // `not r t̄`: range-restricted, binds nothing, anchor unchanged. The
    // positive `_acc-at` point read demands the acc rows at XL and blocks
    // the rule until they are computed (at XL's settle snapshot, so they are
    // final — plans/v2-caret-fresh-left.md §2.2); the marker, written with
    // the rows, is what wakes it then: an absent row produces no delta.
    const unbound = termsVars(a.atom.terms).filter((n) => !state.seen.has(n));
    if (unbound.length > 0) {
      throw new Error(
        `rule '${state.ruleName}': 'not ${h.name} …' needs its variables bound before it (unbound: ${unbound.join(", ")})`,
      );
    }
    state.out.push({ tag: "Match", atom: { terms: [SYM_ACC_AT, { tag: "Wildcard" }] }, l: XL, r: XL, span: a.span });
    state.out.push({ tag: "Match", atom: matchAtom, l: XL, r: XL, negated: true, span: a.span });
    return true;
  }
  const constraint = (a as { constraint?: MatchConstraint }).constraint;
  state.out.push(
    constraint === undefined
      ? { tag: "Match", atom: matchAtom, l: XL, r: XL, span: a.span }
      : { tag: "Match", atom: matchAtom, l: XL, r: XL, constraint, span: a.span },
  );
  for (const t of a.atom.terms) collectVarsTerm(t, state);
  return true;
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
    `rule '${state.ruleName}': '@js(...)' is only allowed in '+'/'~'/'^' atoms ` +
    `(not in matches, '?', '=', '!(...)', or aggregate patterns)`,
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
  state.out.push({ tag: "Equal", lhs: V, rhs: { tag: "JsCall", func, args }, span });
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
      for (const t of exprTerms(a.rhs)) collectVarsTerm(t, state);
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
      if (a.exnCheck) {
        const next = decomposeExnCheck(a, state, XL, XR);
        XL = next.XL;
        XR = next.XR;
        continue;
      }
      // js relations (plans/v2-js-relations.md): a plain match atom whose
      // head names a `#js-def` relation lowers to a JsIterate and leaves
      // the running anchor untouched (js relations are timeless). Any
      // other appearance throws inside decomposeJsRel.
      if (decomposeJsRel(a, state)) continue;
      // acc relations (plans/v2-acc-relations.md): a point read at the
      // anchor's left; anchor unchanged.
      if (decomposeAccRead(a, state, XL)) continue;
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
    if (a.tag === "Exception") {
      throw new Error("internal: Exception atom reached decomposition (applyExceptions missing?)");
    }
    // Post-expand cases shouldn't occur at this stage, but pass through.
    state.out.push(a);
  }
  return { XL, XR };
}

// Handle an `Atom` whose head names a `#js-def` relation
// (plans/v2-js-relations.md). Returns true when the atom was consumed (a
// `JsIterate` was pushed); false to continue the normal marker dispatch.
// Non-match uses throw: a js relation's match sites never read the store, so
// an emitted/ask row under the name would be silently invisible to every
// match — the exact bug this rejects. The check is deliberately arity-blind
// (unlike exceptions, where arity is part of predicate identity): an
// off-arity emit is almost certainly the same conceptual relation, misused.
// Exception: a `!(...)` sub-atom naming a js relation is legitimate — it is
// tagged `*c-js` in buildConstrainRowAtom and enumerated by constraint-query
// (plans/v2-js-rel-in-constrain.md).
function decomposeJsRel(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
): boolean {
  // `!(...)` sub-atoms may name js relations; they are validated and
  // tagged `*c-js` in buildConstrainRowAtom, then enumerated by the
  // constraint-query evaluator (plans/v2-js-rel-in-constrain.md).
  if (a.subAtoms !== undefined) return false;
  const h = a.atom.terms[0];
  if (h === undefined || h.tag !== "Symbol" || !state.jsRels.has(h.name)) return false;
  if (a.marker !== "match" || a.negated) {
    throw new Error(
      `rule '${state.ruleName}': js relation '${h.name}' can only be used as a plain match atom ` +
      `(no '~'/'+'/'^'/'?'/'!' marker, no 'not')`,
    );
  }
  const arity = state.jsRels.get(h.name)![0]!.params.length;
  const args = a.atom.terms.slice(1);
  if (args.length !== arity) {
    throw new Error(
      `rule '${state.ruleName}': js relation '${h.name}' takes ${arity} argument(s), given ${args.length}`,
    );
  }
  state.out.push({ tag: "JsIterate", func: h.name, args, span: a.span });
  // Args enter the chain like a match's user vars: enumerated bindings are
  // per-firing identity, so downstream fresh-id templates must fingerprint
  // them (dedup correctness). collectVarsTerm also rejects `@js(...)` here.
  for (const t of args) collectVarsTerm(t, state);
  return true;
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

  // `>p`: intersect the anchor with `[r_p, top]` instead of `[l_p, r_p]`.
  // The `XL ≤ top` half of the overlap check is trivial and the right end
  // stays `XR` (= min(XR, top)), so only the left end moves.
  if (a.after) {
    state.out.push({ tag: "Le", a: rVar, b: XR, span: a.span });
    const XLafter = freshAnchorVar(state, "xl");
    state.out.push({ tag: "Equal", lhs: XLafter, rhs: { tag: "Max", a: XL, b: rVar }, span: a.span });
    for (const t of a.atom.terms) collectVarsTerm(t, state);
    return { XL: XLafter, XR };
  }

  // Overlap check + anchor intersection.
  state.out.push({ tag: "Le", a: XL, b: rVar, span: a.span });
  state.out.push({ tag: "Le", a: lVar, b: XR, span: a.span });
  const XLnext = freshAnchorVar(state, "xl");
  const XRnext = freshAnchorVar(state, "xr");
  state.out.push({ tag: "Equal", lhs: XLnext, rhs: { tag: "Max", a: XL, b: lVar }, span: a.span });
  state.out.push({ tag: "Equal", lhs: XRnext, rhs: { tag: "Min", a: XR, b: rVar }, span: a.span });

  // Add user vars in the matched atom to chain.
  for (const t of a.atom.terms) collectVarsTerm(t, state);

  return { XL: XLnext, XR: XRnext };
}


// Exception default check (applyExceptions step 7): a producer
// `Emit (_exn-wait (flag pat) idTpl) at (XL, XR)` and a consumer
// `Match (_exn-clear (flag pat) idTpl) at (_l_K, _r_K)` sharing the per-firing
// id, like an aggregate's demand pair. The exception-check handler answers
// each wait row with `_exn-clear` (no flag alive at XL) or `_exn-held`, after
// inner-loop quiescence. The answer copies the wait row's endpoints, so the
// running anchor is unchanged.
function decomposeExnCheck(
  a: Extract<RuleAtom, { tag: "Atom" }>,
  state: DecState,
  XL: Term,
  XR: Term,
): { XL: Term; XR: Term } {
  const k = state.lexPos;
  const idTpl = freshIdTemplate(state, k, "_emitId");
  const pattern: Term = { tag: "Atom", atom: { terms: [...a.atom.terms] } };
  state.out.push({ tag: "Emit", atom: { terms: [SYM_EXN_WAIT, pattern, idTpl] }, l: XL, r: XR, span: a.span });
  const lName = `_l_${k}`;
  const rName = `_r_${k}`;
  const lVar: Term = { tag: "Variable", name: lName };
  const rVar: Term = { tag: "Variable", name: rName };
  for (const n of [lName, rName]) {
    state.seen.add(n);
    state.chain.push({ tag: "Variable", name: n });
    state.essential.add(n);
  }
  state.out.push({ tag: "Match", atom: { terms: [SYM_EXN_CLEAR, pattern, idTpl] }, l: lVar, r: rVar, span: a.span });
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
    // An acc relation inside `!(...)` is an ordinary `*c-plain` sub-atom
    // (plans/v2-choice-components-by-moment.md step 6): the component is
    // evaluated at its ask moment `m`, the acc rows at `m` are written when
    // `m` settles — before its choices surface — and constraint-query's
    // stored-tuple match admits a point row at `[m, m]`. Only the shape is
    // checked here.
    const sh = sub.atom.terms[0];
    const accDecl = sh !== undefined && sh.tag === "Symbol" ? state.accDecls.get(sh.name) : undefined;
    if (accDecl !== undefined) {
      if (sub.atom.terms.length - 1 !== accDecl.columns.length) {
        throw new Error(
          `rule '${state.ruleName}': '${accDecl.relation}' has ${accDecl.columns.length} column(s), ` +
          `pattern has ${sub.atom.terms.length - 1} (inside '!(...)')`,
        );
      }
    }
    // A sub-atom naming a `#js-def` relation is tagged `*c-js` so the
    // constraint-query evaluator enumerates its generator instead of
    // reading the store (plans/v2-js-rel-in-constrain.md). Arity checked
    // eagerly.
    const h = sub.atom.terms[0];
    const jsClauses =
      h !== undefined && h.tag === "Symbol" ? state.jsRels.get(h.name) : undefined;
    if (jsClauses !== undefined) {
      const arity = jsClauses[0]!.params.length;
      const given = sub.atom.terms.length - 1;
      if (given !== arity) {
        throw new Error(
          `rule '${state.ruleName}': js relation '${(h as { name: string }).name}' takes ` +
          `${arity} argument(s), given ${given} (inside '!(...)')`,
        );
      }
    }
    if (sub.negated) {
      if (accDecl === undefined) {
        throw new Error(
          `rule '${state.ruleName}': 'not' inside '!(...)' reads an '#acc' relation; ` +
          `'${sh !== undefined && sh.tag === "Symbol" ? sh.name : "?"}' is not one`,
        );
      }
      // Range restriction within the block: every variable is bound by the
      // rule's prefix or by a positive sub-atom of the same block.
      const positive = new Set(termsVars(subAtoms.filter((x) => !x.negated).flatMap((x) => x.atom.terms)));
      const unbound = termsVars(sub.atom.terms).filter((n) => !prefixSeen.has(n) && !positive.has(n));
      if (unbound.length > 0) {
        throw new Error(
          `rule '${state.ruleName}': 'not ${accDecl.relation} …' inside '!(...)' needs its variables bound ` +
          `by the rule or by a positive sub-atom of the block (unbound: ${unbound.join(", ")})`,
        );
      }
    }
    const inner: Atom = { terms: sub.atom.terms.map(rewrite) };
    const wrapHead =
      sub.negated ? SYM_C_NOT :
      jsClauses !== undefined ? SYM_C_JS : SYM_C_PLAIN;
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
  // `is` rows resolve choices and are anchored at their choice by the engine
  // (scheduler.ts installIs). The only source form is the harness's
  // rule-initial `^ is T V`, which becomes the input row `_is-input T V`.
  const head0 = a.atom.terms[0];
  let isInput = false;
  if (head0 !== undefined && head0.tag === "Symbol" && head0.name === "is" && a.marker !== "ask" && a.marker !== "constrain") {
    if (a.marker !== "anchor" || !(XL.tag === "Symbol" && XL.name === "bot")) {
      throw new Error(
        `rule '${state.ruleName}': 'is' rows resolve choices and are written only as a top-level '^ is C V' ` +
        `(the choice harness's form); a rule cannot emit 'is'`,
      );
    }
    isInput = true;
  }
  let emitL: Term, emitR: Term;
  let caretFresh = false;
  switch (a.marker) {
    case "fact": {
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
    case "anchor":
      // `^p` mints a fresh left end like `+` (XL < l < XR) and keeps the
      // anchor's right end: `p` lives on [l, XR] and the rule continues
      // there (plans/v2-caret-fresh-left.md §2). So a `^` reacting to state
      // at XL (acc rows, a choice asked at XL) starts strictly after XL, and
      // the state at a settled moment is final. Two exceptions keep the
      // exact-anchor emit: a rule-initial `^` (anchor still statically
      // (bot, top) — a premise-free fact, e.g. harness `^ is` rows), and
      // compiler-internal `exact` emits (applyExceptions).
      if (!a.exact && !(XL.tag === "Symbol" && XL.name === "bot")) {
        const momL = freshMomTemplate(state, k, "l");
        state.out.push({ tag: "Equal", lhs: lVar, rhs: momL, span: a.span });
        state.out.push({ tag: "Equal", lhs: rVar, rhs: XR, span: a.span });
        state.out.push({ tag: "AssertLt", a: XL, b: lVar, span: a.span });
        state.out.push({ tag: "AssertLt", a: lVar, b: XR, span: a.span });
        emitL = lVar;
        emitR = XR;
        caretFresh = true;
        break;
      }
    // falls through
    case "ask":
    case "constrain": {
      // `^`, and the `_choose` / `_constrain` rows of `?` / `!`
      // (plans/v2-choice-components-by-moment.md): emitted at the running
      // anchor, no fresh moment, anchor unchanged. A choice is asked at the
      // moment its rule has reached, and a constraint written next to its
      // `?` sits at that same moment — which is what locates a choice
      // component at one (frontier) moment.
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
    // Static ask check (plans/v2-choice-actors.md): an ask atom introduces
    // choices — it never re-asks or inspects existing values. Vars-only
    // shape is enforced by the parser; here reject asking a variable that an
    // earlier match, emit, `=`, or previous ask already bound. `state.seen`
    // is exactly the bound-so-far set in SSA order.
    if (a.marker === "ask") {
      for (const t of a.atom.terms) {
        if (t.tag === "Variable" && state.seen.has(t.name)) {
          throw new Error(
            `rule '${state.ruleName}': variable '${t.name}' is already bound at '?' ` +
            `(line ${a.span.line}); '?' accepts only fresh variables`,
          );
        }
      }
    }
    // Build the atom to emit. Variables in the user atom that aren't yet
    // bound get pre-bound via Equals to fresh-id templates; Wildcards are
    // substituted inline.
    let userAtomTerms: Term[] = [];
    for (const t of a.atom.terms) {
      userAtomTerms.push(emitBindingsAndRewrite(t, state, k, a.span));
    }
    if (isInput) userAtomTerms[0] = SYM_IS_INPUT;
    const userAtom: Atom = { terms: userAtomTerms };

    if (a.marker === "ask") {
      // (_choose chooseId (userAtom) actor)
      const chooseTpl = freshChooseTemplate(state, k);
      const cidName = `_cid_${k}`;
      const chooseVar: Term = { tag: "Variable", name: cidName };
      state.out.push({ tag: "Equal", lhs: chooseVar, rhs: chooseTpl, span: a.span });
      state.seen.add(cidName);
      // Note: chooseVar is synthetic; we don't add it to chain (it's not a
      // user var, and downstream chain templates don't need it).
      const wrapped: Term = { tag: "Atom", atom: userAtom };
      const actorSym: Term = { tag: "Symbol", name: a.actor ?? "you" };
      rowAtom = { terms: [SYM_CHOOSE_ROW, chooseVar, wrapped, actorSym] };
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
      // `~>p` continues after the episode: `max(XL, r)` is statically `r`
      // (XL < l < r was just asserted), and the right end stays `XR`.
      return a.after ? { XL: rVar, XR } : { XL: lVar, XR: rVar };
    case "anchor":
      if (caretFresh) return { XL: lVar, XR };
      return { XL, XR };
    case "ask":
    case "constrain":
      return { XL, XR };
    default: // fact
      return { XL: lVar, XR };
  }
}
