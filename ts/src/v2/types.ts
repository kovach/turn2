// v2 IR. See plans/new-semantics.md.
//
// Pipeline: parse -> Program (rules + schema) -> expand (rule splitting) ->
// fixpoint(eval(rule, store)) -> Store. Reuses the hashconsed Term/Atom
// algebra from ../types.ts; v2 adds intervals on tuples and a moment-order
// relation in the Store.

import type { Atom, Term, Span } from "../types.js";

// Atom prefix markers. `match` is the default (no prefix); the other markers
// produce tuples with different interval-construction rules. Weighted
// versions of each are represented by setting `.weight` on the Atom.
//
// `ask` and `constrain` desugar at eval time to compound `+`-style asserts
// (a `choose` row carrying a fresh chooseId + wrapped atom; a `constrain`
// row carrying the wrapped atom). They never appear in stored tuples.
// Semi-naive evaluation tag on `match` atoms. Set by `expand`'s delta-variant
// pass: each rule is cloned once per match position, and within one variant
// exactly one match is `"delta"` (rows added in the previous round), positions
// before it are `"old"` (rows from earlier rounds), positions after are
// `"any"` (no gen filter). Strict `delta` ensures each new derivation is
// reached by exactly one variant per round; loose `any`/`old` preserve v2's
// within-sweep cascade visibility.
export type MatchConstraint = "any" | "delta" | "old";

export type Marker =
  | "match"      // -  default; matches tuples overlapping the anchor
  | "episode"    // ~  fresh (l', r') strictly inside anchor
  | "fact"       // +  fresh l' inside anchor; r' = top
  | "anchor"     // ^  interval == current anchor
  | "ask"        // ?  introduces a choice; desugars to (choose <id> (<atom>))
  | "constrain"; // !  fringe for choice resolution; desugars to (constrain (<atom>))

// One entry in a rule body. `Atom` covers all the marker cases (matches and
// asserts, weighted or not, optionally with literal moment-term bindings on
// the match side as produced by rule splitting). `Sub` is a parenthesised
// sub-rule, with `sequence` set when the closer was `);` rather than `)`.
export type RuleAtom =
  | {
      tag: "Atom";
      marker: Marker;
      atom: Atom;
      // Trailing `-> term` slot. When set on a match, the atom is a weighted
      // *query* that aggregates; on an assert, it's just stored in a trailing
      // slot.
      weight?: Term;
      // Literal moment terms threaded by `expand` into a consumer-side match
      // so the consumer rule sees only the producer's tuple.
      lLit?: Term;
      rLit?: Term;
      // Static identity record assigned by `expand`'s `assignIds` pass.
      //
      //   l, r : `Variable` Terms naming the slots in `subst` that this
      //          atom's left / right moment values are bound to (matches
      //          bind from the matched tuple's endpoints; asserts bind from
      //          the constructed l, r they emit). Synthesized names of the
      //          form `_l_<lexPos>` / `_r_<lexPos>`.
      //   chain: A `(*id <ruleName> <lexPos> V1 V2 ... Vk)` Id-tag Term
      //          where V1..Vk are `Variable` references to every slot in
      //          scope *before* this atom — the l/r slots of earlier atoms
      //          plus user-named vars bound earlier. Used by the evaluator's
      //          fresh-term constructors:
      //            freshIdTerm(varName) = instantiate(chain) ++ [Sym varName]
      //            freshChooseId()      = instantiate(chain) with head *choose
      //            freshMoment(side)    = instantiate(chain) with head *mom,
      //                                   ++ [Sym side]
      //          By baking the prefix at expand time we get a canonical,
      //          deterministic fingerprint of the rule firing's history that
      //          captures matched-tuple identity (via the l/r slot chain),
      //          not just user-variable bindings.
      id?: { l: Term; r: Term; chain: Term };
      // Semi-naive bucket for `match` atoms. Defaults to `"any"` when absent
      // (e.g. ad-hoc rule construction that bypasses `expand`).
      constraint?: MatchConstraint;
      span: Span;
    }
  | {
      tag: "Sub";
      body: RuleAtom[];
      sequence: boolean;
      span: Span;
    }
  // Equality / unification atom: `= <lhs> <rhs>`. Unifies two terms against
  // the current substitution. Carries no marker, no id, no l/r — it doesn't
  // match a stored tuple, emit one, or modify the anchor.
  | {
      tag: "Equal";
      lhs: Term;
      rhs: Term;
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
  // True iff no positive (assert/episode/fact/anchor/ask/constrain) atom
  // appears before the delta atom in the body. When false, the rule may
  // emit tuples earlier in its body that the short-circuit would
  // incorrectly suppress, so we must run it regardless of `prevHeads`.
  // Once prefix expansion lands this is always true.
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

// Re-exported here so ts/src/v2/constraint-query.ts and consumers share the
// same struct definition through a single import path.
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
