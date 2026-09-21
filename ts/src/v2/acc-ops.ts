// The `#acc` op registry (plans/v2-acc-relations.md §2.2, §5.5).
//
// Every aggregation op is a commutative monoid `(M, ⊕, e)` with two maps:
//
//   contributions ──η──▶ M  ──⊕ (fold)──▶ M  ──ρ──▶ set of value terms
//
// η (`inject`) places one contribution into the carrier — it is the unit of
// the free commutative monoid on values, so the set of contributions is a
// *bag*, and ⊕ applied to η-images is the unique monoid homomorphism out of
// it. ρ (`readout`) reads the carrier back out as zero or more value terms:
// that is the one coercion from "a value per key" to "rows of a relation".
//
//   | stage        | @sum | @count | @min      | @last                   | @arg-min           | boolean          |
//   |--------------|------|--------|-----------|-------------------------|--------------------|------------------|
//   | η inject     | a    | 1      | a         | {(t, a)}                | {(a, n)}           | true             |
//   | ⊕ combine    | +    | +      | min       | ∪, keep temporal maxima | ∪, keep minimal n  | ∨                |
//   | e identity   | 0    | 0      | ∞         | ∅                       | ∅                  | false            |
//   | ρ readout    | {s}  | {n}    | {v}; ∞↦∅  | the set                 | the set            | true↦{()}; f↦∅   |
//   | idempotent   | no   | no     | yes       | yes                     | yes                | yes              |
//
// Single- vs multi-valued is a property of ρ, not of the op: `@last` and
// `@arg-min` are monoids on sets whose ρ is the identity, so a key gets zero
// or more rows. Identities without a term (`∞`, `false`) read out as ∅. A
// keyless relation's zero row is `ρ(e)`. Recursion through an op has a least
// fixpoint iff ⊕ is idempotent (the carrier is then a semilattice).
//
// ADDING AN OP
//
// 1. Fill in a column of the table above for it: what η injects, what ⊕
//    does, what e is, what ρ reads out, whether ⊕ is idempotent. If ⊕ is
//    not a commutative associative operation it is not an acc op — it is
//    probably a *relation* computed by an acc rule instead. Pick ONE term
//    representation for the op's domain and reject the rest in η; never
//    accept two spellings of one value (`1` and `(s z)`).
// 2. Add the entry to `ACC_OPS` below. `AccOp` widens automatically, and
//    parse.ts / expand.ts read `arity` and `column`, so no parser change.
//    `inject` must throw on out-of-domain terms with a message naming the
//    term. If the carrier could hold several spellings of one value,
//    `combine` must keep a canonical one (smaller hashcons token is the
//    convention); `readout` must not depend on combination order. Set
//    `idempotent` truthfully — it decides whether recursion through the op
//    is meaningful.
// 3. Add sample contributions (and out-of-domain samples) for it to the law
//    harness in ts/src/tests/v2_acc.test.ts. A registry entry without
//    samples fails that test.
// 4. Add the op to the tutorial's op list (discussions/turn-tutorial.md).

import type { Term } from "./term.js";
import { sym } from "./term.js";
import { hashconsTerm, refTagOf } from "./hashcons.js";
import { getAggregator } from "./aggregators.js";
import { leastUpperBound, lessEq, tokenOf, type Store } from "./store.js";

// One readout entry: a value term for a row, and — when the op *selects*
// among contributions — the lub of the selected contributions' moments.
// `moment` omitted means "the lub of the whole group" (acc.ts fills it in).
export interface AccReadout {
  value: Term;
  moment?: Term;
}

export interface AccOpDef<M> {
  // The `@name` used in declarations and head wrappers.
  name: string;
  // Head arity: 1 if η takes the agg-column term, 0 if the head writes `()`
  // (count) or the relation has no agg column at all (boolean).
  arity: 0 | 1;
  // Whether rows carry a value column. False only for boolean.
  column: boolean;
  // η. `value` is the head's agg-column term (hashconsed; the unit Atom for
  // arity 0), `moment` the contribution's moment. Throws on a term outside
  // the op's domain; `where` names the relation for the message.
  inject(value: Term, moment: Term, store: Store, where: string): M;
  // e.
  identity: M;
  // ⊕: associative and commutative; canonical on ties.
  combine(a: M, b: M, store: Store): M;
  // ρ.
  readout(a: M, store: Store): AccReadout[];
  // a ⊕ a = a.
  idempotent: boolean;
  // Not nameable as `@name` in source (boolean).
  internal?: boolean;
}

// The unit Atom `()` — what an arity-0 head writes and what boolean's ρ
// yields (acc.ts drops the column for boolean relations).
export const UNIT: Term = { tag: "Atom", atom: { terms: [] } };

// ----- term helpers -----

function kids(store: Store, t: Term): readonly Term[] | null {
  if (t.tag === "Atom") return t.atom.terms;
  if (t.tag === "Ref") {
    if (refTagOf(store.hash, t.id) !== "Atom") return null;
    const a = store.hash.refToAtom.get(t.id);
    return a ? a.terms : null;
  }
  return null;
}

// Peano nat value of a term: `z` → 0, `(s X)` → 1 + natValue(X), anything
// else (numeric Symbols included — one representation per op) → null.
export function natValue(t: Term, store: Store): number | null {
  let n = 0;
  let cur = t;
  for (;;) {
    if (cur.tag === "Symbol") return cur.name === "z" ? n : null;
    const k = kids(store, cur);
    if (k === null || k.length !== 2) return null;
    const h = k[0]!;
    if (h.tag !== "Symbol" || h.name !== "s") return null;
    n++;
    cur = k[1]!;
  }
}

function peano(n: number): Term {
  const count = getAggregator("count");
  let acc = count.zero;
  for (let i = 0; i < n; i++) acc = count.fold(acc);
  return acc;
}

function domainError(where: string, op: string, expected: string, got: Term, store: Store): Error {
  return new Error(
    `acc '${where}': @${op} expects ${expected}, got '${renderShallow(got, store)}'`,
  );
}

function renderShallow(t: Term, store: Store): string {
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Atom":
    case "Id": return `(${t.atom.terms.map((x) => renderShallow(x, store)).join(" ")})`;
    case "Ref": {
      const k = store.hash.refToAtom.get(t.id);
      return k ? `(${k.terms.map((x) => renderShallow(x, store)).join(" ")})` : `*${t.id}`;
    }
  }
}

function lubOr(store: Store, moments: readonly Term[], fallback: Term): Term {
  if (moments.length === 0) return fallback;
  return leastUpperBound(store, [...moments]) ?? fallback;
}

// ----- carriers -----

interface NumCarrier { n: number; }

// `@min`: ∞ is `null`. Equal `n` means token-equal Peano terms, so no
// spelling tie-break is needed; moments union.
type MinCarrier = { n: number; term: Term; moments: Term[] } | null;

interface LastEntry { moment: Term; value: Term; }

interface ArgMinCarrier {
  n: number; // Infinity for ∅
  byA: Map<number, { pair: Term; moments: Term[] }>;
}

// Drop every entry whose moment is strictly below another's; dedup by
// (moment, value) tokens. Mirrors `aggregateOver`'s `last`.
function antichain(store: Store, entries: LastEntry[]): LastEntry[] {
  const seen = new Set<string>();
  const uniq: LastEntry[] = [];
  for (const e of entries) {
    const k = `${tokenOf(store, e.moment)}|${tokenOf(store, e.value)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }
  return uniq.filter((c) =>
    !uniq.some((d) => d !== c && lessEq(store, c.moment, d.moment) && !lessEq(store, d.moment, c.moment)),
  );
}

const sumOp: AccOpDef<NumCarrier> = {
  name: "sum",
  arity: 1,
  column: true,
  inject(value, _moment, store, where) {
    if (value.tag !== "Symbol") throw domainError(where, "sum", "a numeric symbol", value, store);
    const n = parseInt(value.name, 10);
    if (isNaN(n)) throw domainError(where, "sum", "a numeric symbol", value, store);
    return { n };
  },
  identity: { n: 0 },
  combine(a, b) { return { n: a.n + b.n }; },
  readout(a) { return [{ value: sym(String(a.n)) }]; },
  idempotent: false,
};

const countOp: AccOpDef<NumCarrier> = {
  name: "count",
  arity: 0,
  column: true,
  inject() { return { n: 1 }; },
  identity: { n: 0 },
  combine(a, b) { return { n: a.n + b.n }; },
  readout(a) { return [{ value: peano(a.n) }]; },
  idempotent: false,
};

const minOp: AccOpDef<MinCarrier> = {
  name: "min",
  arity: 1,
  column: true,
  inject(value, moment, store, where) {
    const n = natValue(value, store);
    if (n === null) throw domainError(where, "min", "a Peano nat (z / (s X))", value, store);
    return { n, term: value, moments: [moment] };
  },
  identity: null,
  combine(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    if (a.n < b.n) return a;
    if (b.n < a.n) return b;
    return { n: a.n, term: a.term, moments: [...a.moments, ...b.moments] };
  },
  readout(a, store) {
    if (a === null) return [];
    return [{ value: a.term, moment: lubOr(store, a.moments, store.bot) }];
  },
  idempotent: true,
};

const lastOp: AccOpDef<LastEntry[]> = {
  name: "last",
  arity: 1,
  column: true,
  inject(value, moment) { return [{ moment, value }]; },
  identity: [],
  combine(a, b, store) { return antichain(store, [...a, ...b]); },
  readout(a) { return a.map((e) => ({ value: e.value, moment: e.moment })); },
  idempotent: true,
};

const argMinOp: AccOpDef<ArgMinCarrier> = {
  name: "arg-min",
  arity: 1,
  column: true,
  inject(value, moment, store, where) {
    const k = kids(store, value);
    const bad = () => domainError(where, "arg-min", "a (pair A N) with N a Peano nat", value, store);
    if (k === null || k.length !== 3) throw bad();
    const h = k[0]!;
    if (h.tag !== "Symbol" || h.name !== "pair") throw bad();
    const n = natValue(k[2]!, store);
    if (n === null) throw bad();
    const byA = new Map<number, { pair: Term; moments: Term[] }>();
    byA.set(tokenOf(store, k[1]!), { pair: value, moments: [moment] });
    return { n, byA };
  },
  identity: { n: Infinity, byA: new Map() },
  combine(a, b) {
    if (a.n < b.n) return a;
    if (b.n < a.n) return b;
    if (a.n === Infinity) return a;
    const byA = new Map(a.byA);
    for (const [tok, e] of b.byA) {
      const cur = byA.get(tok);
      // Equal `n` and equal `A` means token-equal pairs; union the moments.
      byA.set(tok, cur === undefined ? e : { pair: cur.pair, moments: [...cur.moments, ...e.moments] });
    }
    return { n: a.n, byA };
  },
  readout(a, store) {
    const out: AccReadout[] = [];
    for (const e of a.byA.values()) out.push({ value: e.pair, moment: lubOr(store, e.moments, store.bot) });
    return out;
  },
  idempotent: true,
};

const boolOp: AccOpDef<boolean> = {
  name: "bool",
  arity: 0,
  column: false,
  inject() { return true; },
  identity: false,
  combine(a, b) { return a || b; },
  readout(a) { return a ? [{ value: UNIT }] : []; },
  idempotent: true,
  internal: true,
};

export const ACC_OPS = {
  sum: sumOp,
  count: countOp,
  min: minOp,
  last: lastOp,
  "arg-min": argMinOp,
  bool: boolOp,
} as const;

export type AccOp = keyof typeof ACC_OPS;

// Look up an op by its `@name`. `internal` entries are not nameable in
// source unless `allowInternal` is set (acc.ts uses it for boolean).
export function accOp(name: string, allowInternal = false): AccOpDef<unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(ACC_OPS, name)) return undefined;
  const def = (ACC_OPS as Record<string, AccOpDef<unknown>>)[name]!;
  if (def.internal === true && !allowInternal) return undefined;
  return def;
}

// Hashcons a readout value so rows dedup by token.
export function internValue(store: Store, t: Term): Term {
  return hashconsTerm(t, store.hash);
}
