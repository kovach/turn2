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

import type { Atom, Term, Span } from "../types.js";

// Semi-naive evaluation tag on `Match` atoms. Set by the delta-variant pass:
// each rule is cloned once per match position, and within one variant
// exactly one match is `"delta"` (rows added in the previous round),
// positions before it are `"old"` (rows from earlier rounds), positions
// after are `"any"` (no gen filter).
export type MatchConstraint = "any" | "delta" | "old";

// Pre-expand source-side marker. Drives the desugaring rules in expand:
//   match    -> Match + Le/Le/Max/Min (overlap with running anchor)
//   episode  -> Equal/Equal + AssertLt*3 + Emit + Max/Min
//   fact     -> Equal + AssertLt*2 + Emit at (l, top) + Max/Min
//   anchor   -> Emit at (XL, XR) (no fresh moments, no anchor update)
//   ask      -> like fact, with wrapped (_choose chooseId atom) row
//   constrain-> like fact, with wrapped (_constrain atom) row
export type Marker =
  | "match"
  | "episode"
  | "fact"
  | "anchor"
  | "ask"
  | "constrain";

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
  span: Span;
}

export interface Program {
  rules: Rule[];
  // `relation -> aggregator` for weighted-query dispatch.
  schema: Map<string, string>;
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
