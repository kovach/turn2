// v2 IR. See plans/new-semantics.md and plans/v2-explicit-anchor-ir.md.
//
// Pipeline: parse -> Program (rules + schema) -> expand (rule splitting +
// anchor decomposition) -> fixpoint(eval(rule, store)) -> Store. Reuses the
// hashconsed Term/Atom algebra from ../types.ts; v2 adds intervals on
// tuples and a moment-order relation in the Store.
//
// Two phases of RuleAtom:
//   - Pre-expand (parser output): `Atom` (with marker/weight/lLit/rLit),
//     `Sub`, `Equal`. The marker enum drives anchor decomposition.
//   - Post-expand (evaluator input): `Match`, `Emit`, `Le`, `AssertLt`,
//     `Max`, `Min`, `Equal`. Anchor manipulation is now explicit IR; the
//     evaluator is a flat dispatch over these primitives.

import type { Atom, Term, Span } from "./term.js";

// Semi-naive evaluation tag on `Match` atoms. Set by the delta-variant pass:
// each rule is cloned once per match position, and within one variant
// exactly one match is `"delta"` (rows added in the previous round),
// positions before it are `"old"` (rows from earlier rounds), positions
// after are `"any"` (no gen filter).
export type MatchConstraint = "any" | "delta" | "old";

// Pre-expand source-side marker. Drives the desugaring rules in expand:
//   match     -> Match + Le/Le/Max/Min (overlap with running anchor)
//   episode   -> Equal/Equal + AssertLt*3 + Emit (anchor becomes (l, r)
//                statically; only matches emit Max/Min)
//   fact      -> Equal + AssertLt*2 + Emit at (l, top) (anchor becomes
//                (l, XR) statically)
//   anchor    -> Emit at (XL, XR) (no fresh moments, no anchor update)
//   ask       -> like fact, with wrapped (_choose chooseId atom) row
//   constrain -> like fact, with wrapped (_constrain atom) row
//   aggregate -> paired Emit (_do-agg ...) + Match (_agg-result ...). Set
//                by the parser when a default-marker atom carries a
//                trailing `-> weight`. splitRule slices the body at the
//                producer Emit's position.
//
// All `!` source — single-atom (`!foo` / `!foo -> Z`) and compound
// (`!(a, b -> Y)`) — is canonicalized at parse to marker `constrain`
// with a `subAtoms` list of length ≥ 1. There is no separate
// `constrain-aggregate` marker; per-sub-atom kind lives inside
// `subAtoms[i].kind`. See plans/v2-compound-constraints.md.
export type Marker =
  | "match"
  | "episode"
  | "fact"
  | "anchor"
  | "ask"
  | "constrain"
  | "aggregate";

// A single sub-atom inside a `!(...)` block. `kind: "agg"` means the
// user wrote `head t1 ... -> weight`; the weight Term is folded into
// the last position of `atom.terms` (matching `_do-agg`'s layout) so
// downstream code can treat the trailing slot as the weight position.
export interface SubConstrain {
  kind: "plain" | "agg";
  atom: Atom;
}

export type RuleAtom =
  // ----- Pre-expand only -----
  //
  // Source-form atom emitted by the parser. Carries a marker plus optional
  // weight/lLit/rLit. Consumed by `expand` (splitRule + anchor decomposition);
  // never reaches the evaluator.
  | {
      tag: "Atom";
      marker: Marker;
      atom: Atom;
      // Trailing `-> term` slot. On a match, the atom is a weighted *query*
      // that aggregates; consumed by `splitRule`. On an assert it's stored
      // in a trailing slot.
      weight?: Term;
      // Set iff `marker === "constrain"`. Length ≥ 1. The `atom` field is
      // unused in that case (kept undefined-shape compatible by the parser
      // for type-shape purposes only).
      subAtoms?: SubConstrain[];
      // Literal moment terms threaded by `splitRule`'s prefix-elision into
      // a consumer-side match so it sees only the producer's tuple. The
      // anchor decomposition pass turns these into `Equal` atoms.
      lLit?: Term;
      rLit?: Term;
      span: Span;
    }
  // Parenthesised sub-rule. `sequence` is true when the closer was `);`.
  // Anchor decomposition flattens Subs entirely — no Sub survives into
  // the post-expand IR.
  | {
      tag: "Sub";
      body: RuleAtom[];
      sequence: boolean;
      span: Span;
    }
  // Bracket aggregation `[ Q | Out = op V ]` (plans/v2-agg-output-var.md,
  // refining plans/v2-bracket-aggregation.md). `body` items are plain match
  // Atoms (marker "match", no weight) or nested AggComps. The expression
  // joins `Q` restricted to tuples containing the running anchor, groups by
  // its output columns minus `V`, folds each group's `V` values with `op`,
  // and unifies the folded value against the pattern `Out` — which may bind
  // (fresh variables become output columns), filter (a prefix-bound
  // variable or ground term), or both. `varName` is internal to the query
  // and invisible outward.
  //
  // `bare` records that the source was the sugar `[ Q | op V ]`, which the
  // parser desugars by freshening the query-side occurrences of `V`, so
  // `out` is the Variable `V` and `varName` is compiler-fresh. It only
  // affects diagnostics and IR printing.
  // Lowered by `decomposeAggComp` into a paired `Emit (_do-aggc ...)` /
  // `Match (_agg-resultc ...)`; never reaches the evaluator.
  | {
      tag: "AggComp";
      body: RuleAtom[];
      reduce: { op: string; varName: string; out: Term; bare?: boolean };
      span: Span;
    }
  // Exception expression `{p t1..tn => e}` (plans/v2-exceptions.md).
  // `left` is the single unmarked LHS atom (Symbol head, no aggregate);
  // `right` is the RHS body fragment (no nested Exception). Eliminated by
  // `applyExceptions` before decomposition — never reaches splitRule or
  // the evaluator.
  | {
      tag: "Exception";
      left: Atom;
      right: RuleAtom[];
      span: Span;
    }
  // ----- Both phases -----
  //
  // Equality / unification atom: `= <lhs> <rhs>`. Unifies two terms against
  // the current substitution. Carries no marker, no anchor effect.
  | {
      tag: "Equal";
      lhs: Term;
      rhs: Term;
      span: Span;
    }
  // Call a user-defined `#js` function. Produced by the anchor-decomposition
  // pass when it lowers a `@js(...)` term (see plans/v2-user-js-functions.md).
  // At eval, `args` are substituted (must be ground), decoded to JS values,
  // the compiled body runs, and its return is encoded and unified with `out`
  // (a fresh Variable). Treated like `Equal` by the remaining expand passes.
  | {
      tag: "JsCall";
      func: string;
      args: Term[];
      out: Term;
      span: Span;
    }
  // ----- Post-expand only -----
  //
  // Stored-tuple lookup. The matched tuple's atom unifies against `atom`,
  // and its endpoints unify with `l` / `r` (typically fresh `_l_<k>` /
  // `_r_<k>` Variables that downstream atoms reference).
  | {
      tag: "Match";
      atom: Atom;
      l: Term;
      r: Term;
      constraint?: MatchConstraint;
      span: Span;
    }
  // Emit a stored tuple with the supplied (already ground) endpoints. No
  // marker variants — fact/episode/anchor/ask/constrain distinctions are
  // decomposed by expand into the right combination of Equal / AssertLt /
  // Max / Min around the Emit.
  | {
      tag: "Emit";
      atom: Atom;
      l: Term;
      r: Term;
      span: Span;
    }
  // Moment-order *check*. Succeeds iff `a ≤ b` in the current closure.
  // Both ground.
  | {
      tag: "Le";
      a: Term;
      b: Term;
      span: Span;
    }
  // Moment-order *insert*. Records the edge `a < b` (calls `addOrder`).
  // Both ground.
  | {
      tag: "AssertLt";
      a: Term;
      b: Term;
      span: Span;
    }
  // Bind `out` to the larger / smaller of `a` and `b` under the current
  // moment order. `a`, `b` ground; `out` an unbound `Variable` (or `_`).
  // Incomparable args fail relationally — the evaluator backtracks past
  // the atom. Never throws.
  | {
      tag: "Max";
      a: Term;
      b: Term;
      out: Term;
      span: Span;
    }
  | {
      tag: "Min";
      a: Term;
      b: Term;
      out: Term;
      span: Span;
    };

export interface Rule {
  name: string;
  // Set when source carried `#def <name>`. Auto-named rules leave this
  // undefined; the post-parse name-resolution pass fills `name` either
  // way.
  explicitName?: string;
  body: RuleAtom[];
  span: Span;
  // Set by `generateDeltaVariants`: head symbol of the variant's `"delta"`
  // match atom. Used by the inner loop to skip the entire variant when no
  // tuple under that head was inserted in the previous round (empty-delta
  // short-circuit). `null` means: head is not a Symbol (can't index — must
  // run conservatively). `undefined` means: rule has no `"delta"` match
  // (rules with zero matches; always run).
  deltaHead?: string | null;
  // True iff no positive-emitting atom appears before the delta atom in
  // the body. When false, the rule may emit tuples earlier in its body
  // that the short-circuit would incorrectly suppress.
  deltaSafeSkip?: boolean;
}

export interface SchemaDecl {
  relation: string;
  aggregator: string; // "sum" | "count" | "last"
  // True when declared with `#reactive` (eager breakpoint materialization)
  // rather than `#agg` (demand-driven). See plans/v2-reactive-aggregates.md.
  reactive?: boolean;
  span: Span;
}

// A user-defined JS function from a `#js (name p1 ..) { body }` directive.
// See plans/v2-user-js-functions.md.
export interface JsDef {
  name: string;
  params: string[];
  body: string; // raw JS source between the braces
  span: Span;
}

export interface Program {
  rules: Rule[];
  // `relation -> aggregator` for weighted-query dispatch. Holds entries for
  // both `#agg` (demand-driven) and `#reactive` relations.
  schema: Map<string, string>;
  // Relations declared `#reactive`: materialized eagerly into `_aggval` rows
  // at breakpoints rather than via demand `_do-agg`/`_agg-result`. A subset
  // of `schema`'s keys. See plans/v2-reactive-aggregates.md.
  reactive: Set<string>;
  // `name -> definition` for `#js` functions.
  jsDefs: Map<string, JsDef>;
  // `name -> definition` for `head P1..Pn := [ ... ]` aggregation synonyms.
  // Eliminated by `expandMacros` before any other expand pass, which leaves
  // this map empty (plans/v2-aggregation-synonyms.md).
  macros: Map<string, MacroDef>;
}

// An aggregation synonym: a name + parameters standing for one bracket
// aggregation expression (plans/v2-aggregation-synonyms.md). A use
// `head A1..An` in a rule body is replaced by `body` with each `Ai`
// substituted for `Pi` and every other body variable freshened. Parameters
// must be the body's *outward* variables — its top-level output columns —
// which is what makes substitution a plain rewrite.
export interface MacroDef {
  name: string;
  params: string[]; // distinct variable names, arity-many
  body: Extract<RuleAtom, { tag: "AggComp" }>;
  span: Span;
}

// Stored data. Intervals carry hashconsed Term endpoints; their order in the
// DB is the moment-order relation (see store.ts).
export interface Tuple {
  atom: Atom;
  l: Term;
  r: Term;
}

export const isMatchAtom = (a: RuleAtom): a is Extract<RuleAtom, { tag: "Atom" }> & { marker: "match" } =>
  a.tag === "Atom" && a.marker === "match";

export const isAssertAtom = (a: RuleAtom): a is Extract<RuleAtom, { tag: "Atom" }> =>
  a.tag === "Atom" && a.marker !== "match";

// Outcome of a fixpoint run.
export type FixpointStatus =
  | { kind: "done" }
  | { kind: "gas"; iterations: number; tuples: number }
  | {
      kind: "active-choices";
      choices: BlockedChoose[];
      // Per-component option enumeration produced by computeComponents.
      // Aligned 1:1 with the `members` partition of `choices`' active terms;
      // the public ordering is by hashcons token id of the active term.
      components: ComponentOptions[];
    }
  | { kind: "empty-fringe-error"; choice: BlockedChoose; activeTerm: Term };

export interface ComponentOptions {
  activeTerms: Term[];
  options: Term[][];
  // Choice component moment: the lub of all the constrain rows' left
  // endpoints. The display uses it to restrict `icon`/`at` rows.
  moment: Term;
}

// A choose row whose wrapped atom contains at least one unresolved active
// term (a fresh `*id` term lacking an `is <activeTerm> _` row).
export interface BlockedChoose {
  rowIndex: number;                 // index into store.tuples
  chooseId: Term;                   // hashconsed
  wrappedAtom: Atom;                // the inner atom (terms[2].atom)
  activeTerms: Term[];              // unresolved active *id terms
  l: Term;
  r: Term;
}
