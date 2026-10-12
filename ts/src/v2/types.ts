// v2 IR. See plans/new-semantics.md and plans/v2-explicit-anchor-ir.md.
//
// Pipeline: parse -> Program (rules + acc declarations) -> expand (rule splitting +
// anchor decomposition) -> fixpoint(eval(rule, store)) -> Store. Reuses the
// hashconsed Term/Atom algebra from ../types.ts; v2 adds intervals on
// tuples and a moment-order relation in the Store.
//
// Two phases of RuleAtom:
//   - Pre-expand (parser output): `Atom` (with marker/lLit/rLit),
//     `Sub`, `Equal`. The marker enum drives anchor decomposition.
//   - Post-expand (evaluator input): `Match`, `Emit`, `Le`, `AssertLt`,
//     `Equal` (whose rhs may be a computed `Expr`). Anchor manipulation is now explicit IR; the
//     evaluator is a flat dispatch over these primitives.

import type { Atom, Term, Span } from "./term.js";
import type { AccOp } from "./acc-ops.js";

// Semi-naive evaluation tag on `Match` atoms. Set by the delta-variant pass:
// each rule is cloned once per match position, and within one variant
// exactly one match is `"delta"` (rows added in the previous round),
// positions before it are `"old"` (rows from earlier rounds), positions
// after are `"any"` (no gen filter).
export type MatchConstraint = "any" | "delta" | "old";

// Right-hand side of an `Equal`. A plain `Term` unifies structurally against
// `lhs`; the other forms are computed from their (ground) arguments and the
// result unifies against `lhs`. Pre-expand `Equal`s only carry plain Terms —
// decomposition introduces the computed forms.
//   Max / Min — the larger / smaller of `a`, `b` under the current moment
//               order. Incomparable args fail relationally (the evaluator
//               backtracks past the atom); never throws.
//   JsCall    — call a user-defined `#js` function (lowered from a `@js(...)`
//               term; see plans/v2-user-js-functions.md). `args` are decoded
//               to JS values, the compiled body runs, and its return is
//               encoded.
export type Expr =
  | Term
  | { tag: "Max"; a: Term; b: Term }
  | { tag: "Min"; a: Term; b: Term }
  | { tag: "JsCall"; func: string; args: Term[] };

export const isTermExpr = (e: Expr): e is Term =>
  e.tag !== "Max" && e.tag !== "Min" && e.tag !== "JsCall";

// The Terms an `Expr` mentions: itself for a plain Term, else its arguments.
export function exprTerms(e: Expr): Term[] {
  switch (e.tag) {
    case "Max":
    case "Min": return [e.a, e.b];
    case "JsCall": return e.args;
    default: return [e];
  }
}

export function mapExpr(e: Expr, f: (t: Term) => Term): Expr {
  switch (e.tag) {
    case "Max":
    case "Min": return { ...e, a: f(e.a), b: f(e.b) };
    case "JsCall": return { ...e, args: e.args.map(f) };
    default: return f(e);
  }
}

// Pre-expand source-side marker. Drives the desugaring rules in expand:
//   match     -> Match + Le/Le/Max/Min (overlap with running anchor)
//   episode   -> Equal/Equal + AssertLt*3 + Emit (anchor becomes (l, r)
//                statically; only matches emit Max/Min)
//   fact      -> Equal + AssertLt*2 + Emit at (l, top) (anchor becomes
//                (l, XR) statically)
//   anchor    -> Emit at (XL, XR) (no fresh moments, no anchor update)
//   ask       -> like fact, with wrapped (_choose chooseId atom) row
//   constrain -> like fact, with wrapped (_constrain atom) row
//
// All `!` source — single-atom (`!foo`) and compound (`!(a, b)`) — is
// canonicalized at parse to marker `constrain` with a `subAtoms` list of
// length ≥ 1. See plans/v2-compound-constraints.md.
//
// `#agg`, `#reactive`, `-> weight` reads, bracket aggregation `[ … ]` and
// `#macro` were removed in favour of `#acc` + `not`
// (plans/v2-caret-fresh-left.md §5.4).
export type Marker =
  | "match"
  | "episode"
  | "fact"
  | "anchor"
  | "ask"
  | "constrain";

// A single sub-atom inside a `!(...)` block.
export interface SubConstrain {
  atom: Atom;
  // `not r t̄` inside `!(...)`: no row of the `#acc` relation `r` matches at
  // the component's moment.
  negated?: boolean;
}

export type RuleAtom =
  // ----- Pre-expand only -----
  //
  // Source-form atom emitted by the parser. Carries a marker plus optional
  // lLit/rLit. Consumed by `expand` (splitRule + anchor decomposition);
  // never reaches the evaluator.
  | {
      tag: "Atom";
      marker: Marker;
      atom: Atom;
      // Set iff `marker === "constrain"`. Length ≥ 1. The `atom` field is
      // unused in that case (kept undefined-shape compatible by the parser
      // for type-shape purposes only).
      subAtoms?: SubConstrain[];
      // Literal moment terms threaded by `splitRule`'s prefix-elision into
      // a consumer-side match so it sees only the producer's tuple. The
      // anchor decomposition pass turns these into `Equal` atoms.
      lLit?: Term;
      rLit?: Term;
      // Set iff `marker === "ask"`: the actor responsible for resolving the
      // choice (`?[rng] C` sugar; absent = "you"). See
      // plans/v2-choice-actors.md.
      actor?: Actor;
      // Compiler-internal (`applyExceptions` only; no surface syntax): an
      // `anchor` emit that lands exactly on the running anchor instead of
      // minting a fresh left end (plans/v2-caret-fresh-left.md §5.2).
      exact?: boolean;
      // `not r t̄` on an `#acc` relation: succeeds iff no row matches at the
      // read's moment (plans/v2-caret-fresh-left.md §3).
      negated?: boolean;
      // Compiler-internal (`applyExceptions` default rules): wait until the
      // exception-check handler has decided, after inner-loop quiescence,
      // that no tuple of this (fully bound) flag pattern is alive at the
      // running anchor's start; then continue on the same anchor.
      exnCheck?: boolean;
      // `>p` / `~>p` ("after"): the rule continues after `p` ends. On a match
      // (`>p`), `p` is matched over `[right(p), top]` — the running anchor
      // becomes `(max(XL, r_p), XR)` after checking `r_p ≤ XR`; `p` itself
      // need not overlap the anchor. On an episode (`~>p`), `p` is asserted
      // as usual and the anchor becomes `(r_p, XR)`. Only these two markers
      // take it (the parser rejects the rest).
      after?: boolean;
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
  // Equality / unification atom: `= <lhs> <rhs>`. Unifies `lhs` against
  // `rhs` (computed first when it is not a plain Term) under the current
  // substitution. Carries no marker, no anchor effect.
  | {
      tag: "Equal";
      lhs: Term;
      rhs: Expr;
      span: Span;
    }
  // ----- Post-expand only -----
  //
  // Enumerate a `#js-def` relation (plans/v2-js-relations.md). Produced by
  // decomposition for a match atom whose head names a js relation; carries
  // the user argument terms only (no head symbol, no trailing id slot — js
  // relations have no stored rows) and does not touch the running anchor
  // (js relations are timeless). `defIndex` selects the clause; it is set
  // by `resolveJsModes` (js-rel.ts) and an internal error if still
  // undefined at eval. At eval, `+`-mode args are decoded to JS values, the
  // generator runs, and each yielded array unifies against the `-`-mode
  // arg terms as a backtracking choice point.
  | {
      tag: "JsIterate";
      func: string;
      args: Term[];
      defIndex?: number;
      span: Span;
    }
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
      // Negated point read of an `#acc` relation (`not r t̄`): succeeds,
      // binding nothing, iff no stored row unifies. Never a delta position.
      negated?: boolean;
      span: Span;
    }
  // Emit a stored tuple with the supplied (already ground) endpoints. No
  // marker variants — fact/episode/anchor/ask/constrain distinctions are
  // decomposed by expand into the right combination of Equal / AssertLt
  // around the Emit.
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
  // ----- Acc rules only (plans/v2-acc-relations.md) -----
  //
  // Read a local acc row while the acc handler computes a moment's rows.
  // `atom` is `[Symbol relation, pat...]` (no trailing id slot); `moment` is
  // a fresh Variable bound to the matched row's moment. Only legal inside a
  // lowered acc rule — `evaluateRule` needs an `AccEvalCtx`.
  | {
      tag: "AccMatch";
      relation: string;
      atom: Atom;
      moment: Term;
      // Bound to the matched row's identity `(*acc-row relation terms…)`, so
      // contributions from distinct rows stay distinct (firing identity).
      id?: Term;
      // `not r t̄` in an acc body: no local row of `r` (a strictly lower
      // stratum) unifies.
      negated?: boolean;
      span: Span;
    }
  // The head of a lowered acc rule: one contribution to `relation`. `terms`
  // are the head's columns (agg column included, the unit Atom for count);
  // `moments` are the `_l_k` / AccMatch moment Variables of the body (the
  // contribution's moment is their lub); `ids` are the `_id_k` Variables
  // bound to the matched stored tuples' ids (the firing identity).
  | {
      tag: "AccContribute";
      relation: string;
      terms: Term[];
      moments: Term[];
      ids: Term[];
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
  // Set by `runFixpoint` when the body reads nothing from the store (no
  // match; only term `=` / js calls, emits, order assertions, js
  // relations): its firings are the same every time, so the inner loop runs
  // it once instead of every sweep (a saved choice's `= V… ^ is …` rule).
  runOnce?: boolean;
}

// One column of an `#acc` declaration (plans/v2-acc-relations.md §1.1): a
// key column with a documentary base type, or the relation's single agg
// column naming a registry op (acc-ops.ts) and optionally the type of the
// values it folds.
export type AccColumn =
  | { kind: "key"; type: string }
  | { kind: "agg"; op: AccOp; type?: string };

// `#acc name : col...`. `aggIndex` is the position of the agg column in
// `columns`, or null for a boolean relation (no agg column).
export interface AccDecl {
  relation: string;
  columns: AccColumn[];
  aggIndex: number | null;
  span: Span;
}

// An acc rule `body / head` (plans/v2-acc-relations.md §1.2). `body` is
// pre-expand: match `Atom`s and `Equal`s only (the parser rejects anything
// else). `head` is `[Symbol relation, col1, ..., coln]`; the agg column's
// term is the contribution (already unwrapped from `(@op T)`).
export interface AccRule {
  name: string;
  explicitName?: string;
  body: RuleAtom[];
  head: Atom;
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

// One clause of a js relation, from a `#js-def name ±p1 .. ±pn { body }`
// directive (plans/v2-js-relations.md). `body` is a JS *generator* body: it
// receives the `+` (bound) params as JS parameters and yields arrays of the
// `-` (unbound) argument values, in `-`-position order. A relation may have
// several clauses with distinct mode vectors (same arity); `resolveJsModes`
// picks the earliest clause ≤ each call site's binding modes.
export interface JsRelDef {
  name: string;
  params: { mode: "+" | "-"; name: string }[];
  body: string; // raw JS generator source between the braces
  span: Span;
  // Set on the clauses `builtinJsRels()` (builtins.ts) seeds every program
  // with; they have no source line and are left out of IR dumps.
  builtin?: true;
}

// Static link from an exception default rule's emitted relation back to the
// prime relation it re-emits from (plans/v2-exception-default-provenance.md).
// Derived by `applyExceptions` from the *final* default-rule bodies — after
// all renames, since a later exception on the same relation renames an
// earlier default rule's emit head. Consumed by
// `resolveExceptionProvenance` (fixpoint.ts), which re-attributes
// default-case tuples to the span of the matching stored prime tuple.
export interface ProvLink {
  // Relation the default rule emits: the user relation, or an intermediate
  // `_<p>_prime<k>` when exceptions chain.
  head: string;
  // `_<p>_prime<k>` relation the default rule matches.
  prime: string;
  // User arity (excludes the head symbol and the trailing universal id
  // slot). Two exceptions may share `head` at different arities, so `head`
  // alone does not identify a link.
  arity: number;
}

export interface Program {
  rules: Rule[];
  // `name -> definition` for `#js` functions.
  jsDefs: Map<string, JsDef>;
  // `name -> clauses in declaration order` for `#js-def` relations
  // (plans/v2-js-relations.md). Disjoint from `jsDefs` and `accDecls`
  // (enforced at parse).
  jsRels: Map<string, JsRelDef[]>;
  // `#acc` relations and the `/` rules that compute them
  // (plans/v2-acc-relations.md) — the language's only aggregation. Disjoint
  // from `jsDefs` and `jsRels` (enforced at parse). Not touched by `expand`;
  // compiled separately by acc.ts.
  accDecls: Map<string, AccDecl>;
  accRules: AccRule[];
  // Set by `applyExceptions` when it generates default rules; absent
  // otherwise. Carried through by the pass's early return on a second
  // invocation (no Exception atoms remain).
  provLinks?: ProvLink[];
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
  // `deferredOnly`: the term has constrain rows, but each also mentions a
  // choice asked at a later moment (plans/v2-choice-components-by-moment.md).
  | { kind: "empty-fringe-error"; choice: BlockedChoose; activeTerm: Term; deferredOnly?: boolean }
  // A `_constrain` row that does not sit at the ask moment of the choice
  // terms it mentions (constraint-query.ts `ConstraintPlacementError`).
  // `line` is the `!` atom's source line, when known.
  | {
      kind: "late-constraint-error";
      rowIndex: number;
      activeTerm: Term;
      reason: "late" | "entangled";
      line: number | undefined;
    };

// The finite actor set (plans/v2-choice-actors.md): who resolves a choice.
// `you` = the human (default); `rng` = uniform random, auto-resolved by the
// scheduler. Totally ordered: `you > rng` (choices resolve highest-first).
export type Actor = "you" | "rng";

export const ACTOR_PRIORITY: Record<Actor, number> = { rng: 0, you: 1 };

export function isActor(name: string): name is Actor {
  return name === "you" || name === "rng";
}

export function maxActor(a: Actor, b: Actor): Actor {
  return ACTOR_PRIORITY[a] >= ACTOR_PRIORITY[b] ? a : b;
}

export interface ComponentOptions {
  activeTerms: Term[];
  // Per-active-term actor, parallel to `activeTerms` (each active term has
  // exactly one owning ask atom — enforced statically — and inherits its
  // actor). The component's controlling actor is the max over this array.
  actors: Actor[];
  options: Term[][];
  // Choice component moment: the moment the component's terms were asked
  // at, which is also where its constrain rows sit
  // (plans/v2-choice-components-by-moment.md). The display uses it to
  // restrict `icon`/`at` rows.
  moment: Term;
}

// A choose row whose wrapped atom contains at least one unresolved active
// term (a fresh `*id` term lacking an `is <activeTerm> _` row).
export interface BlockedChoose {
  rowIndex: number;                 // index into store.tuples
  chooseId: Term;                   // hashconsed
  wrappedAtom: Atom;                // the inner atom (terms[2].atom)
  actor: Actor;                     // the ask atom's actor (terms[3])
  activeTerms: Term[];              // unresolved active *id terms
  l: Term;
  r: Term;
}
