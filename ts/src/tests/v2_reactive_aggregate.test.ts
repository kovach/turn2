// Tests for reactive aggregates (eager breakpoint materialization).
// See plans/v2-reactive-aggregates.md.
//
// Two layers:
//   - store-level: build moments directly (incl. incomparable ones the surface
//     syntax can't easily produce) and drive the scheduler's breakpoint
//     finalization, asserting the core "value appears at the join (lub)" claim.
//   - integration: parse + runFixpoint, exercising the `#reactive` declaration,
//     the `_aggval` materialization, and the `foo -> X` consumer lowering.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import {
  addOrder,
  addTuple,
  createStore,
  intern,
  tokenOf,
  type Store,
} from "../v2/store.js";
import {
  collectReactiveFinalizations,
  finalizeReactive,
  selectEarliestTier,
} from "../v2/scheduler.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Atom, Term } from "../v2/term.js";

function sym(name: string): Term { return { tag: "Symbol", name }; }
function num(n: number): Term { return { tag: "Symbol", name: String(n) }; }

function rt(s: Store, term: Term): string {
  const t = term.tag === "Ref" ? expandTerm(term, s.hash) : term;
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${t.id}`;
    case "Atom":
    case "Id": return `(${t.atom.terms.map((x) => rt(s, x)).join(" ")})`;
  }
}
// Render an atom dropping the trailing universal id slot.
function ra(s: Store, atom: Atom): string {
  return atom.terms.slice(0, -1).map((t) => rt(s, t)).join(" ");
}
function tuples(s: Store): string[] { return s.tuples.map((t) => ra(s, t.atom)); }

function ok(src: string) {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

// Drive the reactive scheduler to quiescence directly on a store (mirrors the
// outer loop's reactive handling: finalize the earliest tier of breakpoints,
// repeat). Returns once no breakpoints remain.
function driveReactive(store: Store, reactive: Set<string>, schema: Map<string, string>) {
  for (let guard = 0; guard < 200; guard++) {
    const pending = collectReactiveFinalizations(store, reactive, schema);
    if (pending.length === 0) return;
    const tier = selectEarliestTier(store, pending);
    let progressed = false;
    for (const b of tier) {
      if (b.kind === "reactive" && finalizeReactive(store, b.row, schema)) progressed = true;
    }
    if (!progressed) return;
  }
  throw new Error("driveReactive did not converge");
}

// Find the `_aggval` row(s) for a given value, returning their left-endpoint
// moment tokens. Layout: [_aggval, head, key..., value, id].
function aggvalLefts(store: Store, head: string, value: string): number[] {
  const out: number[] = [];
  for (const t of store.tuples) {
    const ts = t.atom.terms;
    if (ts.length < 4) continue;
    const h = ts[0], rel = ts[1], val = ts[ts.length - 2];
    if (h === undefined || h.tag !== "Symbol" || h.name !== "_aggval") continue;
    if (rel === undefined || rt(store, rel) !== head) continue;
    if (val === undefined || rt(store, val) !== value) continue;
    out.push(tokenOf(store, t.l));
  }
  return out;
}

// ===== 1) Core: the value appears at the JOIN of two incomparable inputs =====
//
//   m1   m2     (incomparable; dmg 3 at [m1,top], dmg 4 at [m2,top])
//     \ /
//      j        (lub; sum = 7 here, where NEITHER input event occurs)
{
  const s = createStore();
  const m1 = intern(s, sym("m1"));
  const m2 = intern(s, sym("m2"));
  const j = intern(s, sym("j"));
  addOrder(s, m1, j);
  addOrder(s, m2, j);
  // dmg contributors: [dmg, weight, id] at [mi, top].
  addTuple(s, { terms: [intern(s, sym("dmg")), intern(s, num(3)), intern(s, sym("id1"))] }, m1, s.top);
  addTuple(s, { terms: [intern(s, sym("dmg")), intern(s, num(4)), intern(s, sym("id2"))] }, m2, s.top);

  const schema = new Map([["dmg", "sum"]]);
  const reactive = new Set(["dmg"]);
  driveReactive(s, reactive, schema);

  const all = tuples(s);
  // The decisive assertion: sum=7 is materialized exactly at the join `j`.
  const sevens = aggvalLefts(s, "dmg", "7");
  assert.equal(sevens.length, 1, `expected one _aggval dmg 7, got ${sevens.length}: ${all.join(" | ")}`);
  assert.equal(sevens[0], tokenOf(s, j), `_aggval dmg 7 should be anchored at the join j`);
  // 7 occurs at neither input moment alone.
  assert.ok(!sevens.includes(tokenOf(s, m1)), "7 must not be at m1");
  assert.ok(!sevens.includes(tokenOf(s, m2)), "7 must not be at m2");
  // The single-contributor values still materialize at their own moments.
  assert.equal(aggvalLefts(s, "dmg", "3").length, 1, `expected _aggval dmg 3: ${all.join(" | ")}`);
  assert.equal(aggvalLefts(s, "dmg", "4").length, 1, `expected _aggval dmg 4: ${all.join(" | ")}`);
  console.log("PASS: sum materializes at the join of two incomparable inputs");
}

// ===== 2) Comparable (sequential) inputs collapse: cumulative sum =====
// Two sequential top-level facts are moment-comparable (m1 < m2), so the join
// collapses to m2 and we get the cumulative steps 3 then 7 — and crucially NO
// spurious `dmg 4` step (4 alone is never current once 3 precedes it).
{
  const { store } = runFixpoint(ok(`
#reactive dmg -> sum

+ dmg -> 3
  + dmg -> 4
`));
  const all = tuples(store);
  assert.equal(aggvalLefts(store, "dmg", "3").length, 1, `expected _aggval dmg 3: ${all.join(" | ")}`);
  assert.equal(aggvalLefts(store, "dmg", "7").length, 1, `expected _aggval dmg 7: ${all.join(" | ")}`);
  assert.equal(aggvalLefts(store, "dmg", "4").length, 0, `comparable collapse: no _aggval dmg 4: ${all.join(" | ")}`);
  console.log("PASS: sequential inputs give cumulative sum (comparable collapse)");
}

// ===== 3) Consumer reaction: literal value filters; threshold fires =====
// `dmg -> 7` matches only the breakpoint where the running sum is 7.
{
  const { store } = runFixpoint(ok(`
#reactive dmg -> sum

+ dmg -> 3
  + dmg -> 4

dmg -> 7
  + lethal x
`));
  const all = tuples(store);
  assert.ok(all.includes("lethal x"), `expected 'lethal' (dmg reached 7): ${all.join(" | ")}`);
  console.log("PASS: reactive consumer reaction fires at the threshold breakpoint");
}

// ===== 3b) Consumer reaction does NOT fire for a value never reached =====
{
  const { store } = runFixpoint(ok(`
#reactive dmg -> sum

+ dmg -> 3
  + dmg -> 4

dmg -> 99
  + impossible x
`));
  const all = tuples(store);
  assert.ok(!all.includes("impossible x"), `'impossible' must not fire (sum never 99): ${all.join(" | ")}`);
  console.log("PASS: reactive consumer does not fire for an unreached value");
}

// ===== 4) Consumer variable binds the value at each breakpoint =====
{
  const { store } = runFixpoint(ok(`
#reactive dmg -> sum

+ dmg -> 3
  + dmg -> 4

dmg -> N
  + seen N
`));
  const all = tuples(store);
  assert.ok(all.includes("seen 3"), `expected 'seen 3': ${all.join(" | ")}`);
  assert.ok(all.includes("seen 7"), `expected 'seen 7': ${all.join(" | ")}`);
  console.log("PASS: reactive consumer variable binds each breakpoint value");
}

// ===== 5) Group-by key: reactive sum per key =====
{
  const { store } = runFixpoint(ok(`
#reactive score -> sum

+ score alice -> 10
  + score alice -> 5
  + score bob -> 20

score X -> N
  + total X N
`));
  const all = tuples(store);
  // alice: cumulative 10 then 15; bob: 20.
  assert.ok(all.includes("total alice 15"), `expected 'total alice 15': ${all.join(" | ")}`);
  assert.ok(all.includes("total bob 20"), `expected 'total bob 20': ${all.join(" | ")}`);
  console.log("PASS: reactive group-by sum per key");
}

// ===== 6) Reactive `last`: current value tracks the latest contributor =====
{
  const { store } = runFixpoint(ok(`
#reactive pos -> last

+ pos a
  + pos b

pos -> P
  + where P
`));
  const all = tuples(store);
  // Sequential: last is `a` then `b`. Both breakpoints surface as reads.
  assert.ok(all.includes("where b"), `expected 'where b' (latest pos): ${all.join(" | ")}`);
  console.log("PASS: reactive last tracks latest contributor");
}

// ===== 7) Coexistence: a non-reactive #agg in the same program is unchanged ==
{
  // No blank line before the legacy `points -> N`: the demand-driven consumer
  // needs the top-level anchor threaded through the points facts. (The reactive
  // consumer in earlier tests doesn't — it fires off the `_aggval` delta.)
  const { store } = runFixpoint(ok(`
#agg points -> sum
#reactive dmg -> sum

+ points -> 3
  + points -> 4
  + dmg -> 5
  points -> N
  + result N
`));
  const all = tuples(store);
  assert.ok(all.includes("result 7"), `legacy #agg still folds to 7: ${all.join(" | ")}`);
  assert.ok(aggvalLefts(store, "dmg", "5").length >= 1, `reactive dmg materialized: ${all.join(" | ")}`);
  console.log("PASS: #agg and #reactive coexist");
}

// ===== 8) End-to-end join through the surface: count reaches 4 only at a lub
// `count` of `p` over episodes a;b;c (sequential) with TWO `p`s asserted under
// `c`. Those two firings produce incomparable moments, so the count only
// reaches 4 = (s (s (s (s z)))) at their join — a moment neither firing names.
// The `p -> (s (s (s (s z)))), ~done` rule fires there, proving the join
// breakpoint materializes end-to-end (and that the run terminates cleanly).
{
  const { store, status } = runFixpoint(ok(`
#reactive p -> count

~go

go
  ~a; ~b; ~c

a, +p -> ()

b, +p -> ()

c, +p -> ()

c, +p -> ()

p -> X, ~hi X

p -> (s (s (s (s z)))), ~done d
`));
  assert.equal(status.kind, "done", `expected clean termination, got ${status.kind}`);
  const all = tuples(store);
  assert.ok(all.includes("done d"), `expected 'done' (count reached 4 at the join): ${all.join(" | ")}`);
  console.log("PASS: count reaches 4 only at the join of two incomparable inputs (end-to-end)");
}

// ===== 9) Single-moment recursion: transitive closure with self-loops =======
// A recursive reactive aggregate whose contributors are derived from reads of
// its OWN `_aggval`, landing entirely at one moment. The closure of the cycle
// a→b→c→a is the complete relation — every pair, including the self-loops
// `p a a`, `p b b`, `p c c` that require two recursion levels. Guards the
// residual-driven re-finalization: a coarse `(relation, moment)` dedup would
// stop after the base edges and never derive the self-loops.
{
  const { store, status } = runFixpoint(ok(`
#reactive p * * -> bool

e A B, ^p A B -> 1

e A B, p B C -> 1, ^p A C -> 1

^e a b
  ^e b c
  ^e c a
`));
  assert.equal(status.kind, "done", `expected clean termination, got ${status.kind}`);
  const all = tuples(store);
  const nodes = ["a", "b", "c"];
  for (const x of nodes) for (const y of nodes) {
    assert.ok(all.includes(`p ${x} ${y} 1`), `closure missing p ${x} ${y}: ${all.join(" | ")}`);
  }
  console.log("PASS: single-moment recursive closure includes all self-loops");
}

// ===== 10) Single-moment consumer stratification ============================
// Add `count` of the closure pairs (relation `q`) at the SAME moment. The count
// must be folded ONCE, against the settled `p` — value 9 (the 9 closure pairs)
// — with no intermediate same-left `_aggval q` (3, 6, ...) that a `last`-read
// could not disambiguate. Guards the `(moment, stratum)` ordering: `q` depends
// on `p`, so `q` is held until `p`'s stratum drains at the moment.
{
  const { store, status } = runFixpoint(ok(`
#reactive p * * -> bool
#reactive q -> count

e A B, ^p A B -> 1

e A B, p B C -> 1, ^p A C -> 1

p X Y -> 1, ^q -> 1

^e a b
  ^e b c
  ^e c a
`));
  assert.equal(status.kind, "done", `expected clean termination, got ${status.kind}`);
  const qRows = tuples(store).filter((s) => s.startsWith("_aggval q "));
  // Exactly one materialized value: no ambiguous same-left intermediates.
  assert.equal(qRows.length, 1, `expected one _aggval q, got ${qRows.length}: ${qRows.join(" | ")}`);
  // count of 9 pairs = (s^9 z).
  const nine = "(s ".repeat(9) + "z" + ")".repeat(9);
  assert.equal(qRows[0], `_aggval q ${nine}`, `expected q = 9: ${qRows[0]}`);
  console.log("PASS: same-moment consumer count folds once at the final value (9)");
}

// ===== Per-group breakpoints: a sibling group's move does not re-stamp ======
// See plans/v2-per-group-breakpoints.md. `at` is `last`-keyed by token. When
// `it` moves (a breakpoint of the `at it` group), the `at me` group must NOT be
// re-materialized at that moment — its value is unchanged there. So each token
// gets exactly one `_aggval at` row per genuine value change, never a sibling
// re-stamp.
{
  const { store, status } = runFixpoint(ok(`
#reactive at * -> last

move It To, +at It -> To

~turn
  ~move me a;
  ~move it a;
  ~move me b;

^turn
`));
  assert.equal(status.kind, "done", `expected done, got ${status.kind}`);
  const atRows = tuples(store).filter((s) => s.startsWith("_aggval at "));
  // Exactly three genuine values: me->a, it->a, me->b. No re-stamp of
  // `at me a` when `it` moved, nor of `at it a` when `me` moved again.
  atRows.sort();
  assert.deepEqual(
    atRows,
    ["_aggval at it a", "_aggval at me a", "_aggval at me b"],
    `expected one row per genuine value, got: ${atRows.join(" | ")}`,
  );
  console.log("PASS: per-group breakpoints — a sibling move does not re-stamp an unchanged group");
}

console.log("ALL v2 reactive aggregate tests passed");
