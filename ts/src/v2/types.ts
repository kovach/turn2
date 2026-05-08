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

// Reserved head syms — produced by lowering `?` / `!` and by rule splitting.
// User rules cannot emit them as the outermost head of an atom. Nested
// occurrences (e.g., as the wrapped-atom argument inside a constrain) are
// fine; only the *outer* head is reserved.
//
// Note: `is` is *not* reserved. It's the resolution relation — but it's
// just a regular fact relation with a privileged name. User emission of
// `is` rows is fine and participates in resolution lookup.
export const RESERVED_HEAD_SYMS = new Set<string>([
  "choose", "constrain", "do-agg", "agg-result",
]);

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
