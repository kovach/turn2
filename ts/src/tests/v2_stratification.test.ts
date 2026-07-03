// Tests for the time-marked stratification analysis (computeAggStrata).
// See plans/v2-stratification-analysis.md.
//
// The dependency graph marks an edge `=` when the produced atom is `^` (anchor,
// same moment) and `<` when it is `+`/`~`/`?` (fresh, strictly-later moment).
// Only `=` edges constrain the within-moment stratum; `<` edges are the moment
// scheduler's job. So:
//   - an all-`=` path (incl. through plain relations) raises the consumer's
//     stratum above its source;
//   - a `<` cycle is NOT collapsed into a same-moment SCC.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { computeAggStrata } from "../v2/scheduler.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Store } from "../v2/store.js";
import type { Atom, Term } from "../v2/term.js";

function ok(src: string) {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}
function strata(src: string): Record<string, number> {
  const p = ok(src);
  return Object.fromEntries(computeAggStrata(p.rules, p.reactive));
}
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
function ra(s: Store, atom: Atom): string {
  return atom.terms.slice(0, -1).map((t) => rt(s, t)).join(" ");
}
function aggvalRows(store: Store, head: string): string[] {
  return store.tuples
    .filter((t) => {
      const h = t.atom.terms[0];
      const rel = t.atom.terms[1];
      return h?.tag === "Symbol" && h.name === "_aggval"
        && rel !== undefined && rt(store, rel) === head;
    })
    .map((t) => ra(store, t.atom));
}

// ===== 1) `=` self-loop: transitive closure — one SCC, stratum 0 ===========
{
  const s = strata(`
#reactive p * * -> bool
e A B, ^p A B -> 1
e A B, p B C -> 1, ^p A C -> 1
`);
  assert.deepEqual(s, { p: 0 }, `TC self-loop (=) should be stratum 0: ${JSON.stringify(s)}`);
  console.log("PASS: transitive closure `=` self-loop is stratum 0");
}

// ===== 2) all-`=` chain THROUGH a plain relation raises the consumer =======
// p =→ c =→ q  (both via `^`), c is a plain relation, so q must be stratum > p.
{
  const s = strata(`
#reactive p * * -> bool
#reactive q -> count
e A B, ^p A B -> 1
e A B, p B C -> 1, ^p A C -> 1
p X Y -> 1, ^c X Y
c X Y, ^q -> 1
`);
  assert.deepEqual(s, { p: 0, q: 1 }, `=-chain through plain c: q above p: ${JSON.stringify(s)}`);
  console.log("PASS: all-`=` chain through a plain relation raises the consumer's stratum");
}

// Runtime: that chain folds q ONCE at the final value (no ambiguous same-left).
{
  const { store, status } = runFixpoint(ok(`
#reactive p * * -> bool
#reactive q -> count

e A B, ^p A B -> 1

e A B, p B C -> 1, ^p A C -> 1

p X Y -> 1, ^c X Y

c X Y, ^q -> 1

^e a b
^e b c
^e c a
`));
  assert.equal(status.kind, "done", `expected done, got ${status.kind}`);
  const q = aggvalRows(store, "q");
  assert.equal(q.length, 1, `expected one _aggval q (no same-left intermediates): ${q.join(" | ")}`);
  const nine = "(s ".repeat(9) + "z" + ")".repeat(9);
  assert.equal(q[0], `_aggval q ${nine}`, `q should be 9 (closure has 9 pairs): ${q[0]}`);
  console.log("PASS: through-plain `=` consumer folds once at the final value");
}

// ===== 3) `<` cycle is NOT collapsed into a same-moment SCC =================
// Mutual recursion via `+` (fresh moments): a <→ b and b <→ a. No `=` edges,
// so a and b stay independent stratum-0 nodes (a future `=`-cycle check must
// not flag this safe, time-stratified loop).
{
  const s = strata(`
#reactive a -> last
#reactive b -> last
go, +a -> 1
a -> X, go, +b -> 2
b -> Y, go, +a -> 3
`);
  assert.deepEqual(s, { a: 0, b: 0 }, `<-cycle must not be collapsed: ${JSON.stringify(s)}`);
  console.log("PASS: `<` cycle stays two independent stratum-0 nodes");
}

// Runtime: a bounded `<` ping-pong terminates cleanly (it is NOT a stuck
// same-moment recursion) with the expected forward-in-time values.
{
  const { store, status } = runFixpoint(ok(`
#reactive a -> last
#reactive b -> last

^go

go, +a -> 1

a -> 1, go, +b -> 2

b -> 2, go, +a -> 3
`));
  assert.equal(status.kind, "done", `bounded <-cycle should terminate, got ${status.kind}`);
  assert.ok(aggvalRows(store, "a").includes("_aggval a 3"), `a should reach 3: ${aggvalRows(store, "a").join(" | ")}`);
  assert.ok(aggvalRows(store, "b").includes("_aggval b 2"), `b should reach 2: ${aggvalRows(store, "b").join(" | ")}`);
  console.log("PASS: bounded `<` ping-pong terminates with forward-in-time values");
}

// ===== 4) mixed cycle A =→ B <→ A: the `<` edge breaks the recurrence ======
// A =→ B (via ^), B <→ A (via +). The `=`-subgraph keeps only A→B, so it is
// acyclic and stratum(B) > stratum(A) — the within-moment order is enforced
// while time separates the back-edge.
{
  const s = strata(`
#reactive a -> last
#reactive b -> last
a -> X, ^b -> X
b -> Y, +a -> Y
`);
  assert.deepEqual(s, { a: 0, b: 1 }, `mixed cycle: a < b in stratum: ${JSON.stringify(s)}`);
  console.log("PASS: mixed cycle — `=` edge orders, `<` back-edge breaks the loop");
}

// ===== 5) marker classification: `^`=`=`, `+`/`~`/`?` = `<` =================
{
  // `^y` (anchor) → `=` edge → y above x.
  assert.deepEqual(strata(`
#reactive x -> last
#reactive y -> last
x, ^y -> 1
`), { x: 0, y: 1 }, "`^` is an `=` edge");
  // `+y` (fact) → `<` → dropped → independent.
  assert.deepEqual(strata(`
#reactive x -> last
#reactive y -> last
x, +y -> 1
`), { x: 0, y: 0 }, "`+` is a `<` edge (dropped)");
  // `~y` (episode) → `<` → dropped.
  assert.deepEqual(strata(`
#reactive x -> last
#reactive y -> last
x, ~y -> 1
`), { x: 0, y: 0 }, "`~` is a `<` edge (dropped)");
  console.log("PASS: marker classification — `^` is `=`, `+`/`~` are `<`");
}

console.log("ALL v2 stratification tests passed");
