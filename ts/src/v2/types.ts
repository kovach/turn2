// v2 IR. See plans/new-semantics.md.
//
// Pipeline: parse -> Program (rules + schema) -> expand (rule splitting) ->
// fixpoint(eval(rule, store)) -> Store. Reuses the hashconsed Term/Atom
// algebra from ../types.ts; v2 adds intervals on tuples and a moment-order
// relation in the Store.

import type { Atom, Term, Span } from "../types.js";

// Atom prefix markers. `match` is the default (no prefix); the other four
// produce tuples with different interval-construction rules. Weighted
// versions of each are represented by setting `.weight` on the Atom.
export type Marker =
  | "match"     // -  default; matches tuples overlapping the anchor
  | "episode"   // ~  fresh (l', r') strictly inside anchor
  | "fact"      // +  fresh l' inside anchor; r' = top
  | "anchor"    // ^  interval == current anchor
  | "output";   // !  output sink; no interval; never matched

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
      span: Span;
    }
  | {
      tag: "Sub";
      body: RuleAtom[];
      sequence: boolean;
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

export interface OutputTuple {
  atom: Atom;
}

export const isMatchAtom = (a: RuleAtom): a is Extract<RuleAtom, { tag: "Atom" }> & { marker: "match" } =>
  a.tag === "Atom" && a.marker === "match";

export const isAssertAtom = (a: RuleAtom): a is Extract<RuleAtom, { tag: "Atom" }> =>
  a.tag === "Atom" && a.marker !== "match";
