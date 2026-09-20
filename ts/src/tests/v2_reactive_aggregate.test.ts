// Tests for reactive aggregates under the moment walk
// (plans/v2-moment-walk.md; the `#reactive` declaration is from
// plans/v2-reactive-aggregates.md).
//
// A `#reactive` relation's value is materialized at every moment the walk
// resolves, as a point row `_aggval head key... value` at `[m, m]`. A read
// `head k -> V` samples the value at the running anchor's *left endpoint*
// and cannot fire before that moment is resolved.
//
// Two layers:
//   - store-level: build moments directly (incl. incomparable ones the surface
//     syntax can't easily produce) and drive the walk with the reactive
//     handler alone, asserting the core "value at the join (lub)" claim.
//   - integration: parse + runFixpoint, exercising the `#reactive`
//     declaration, the per-moment materialization, sampling at an anchor's
//     start, same-moment recursion and stratification, and blocking.

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
import { reactiveHandler } from "../v2/scheduler.js";
import {
  frontier,
  markResolved,
  runWalkRound,
  unresolvedMoments,
  type MomentHandler,
} from "../v2/moment-walk.js";
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

// Drive the walk to exhaustion on a store with no rules (mirrors the outer
// loop's walk without the inner loop: rounds that progress are simply
// re-run; rounds that don't resolve their frontier).
function driveWalk(store: Store, handlers: MomentHandler[]): void {
  for (let guard = 0; guard < 500; guard++) {
    const round = runWalkRound(store, handlers);
    if (round.exhausted) return;
    if (round.progress) continue;
    const toMark = round.frontier.filter((t) => !round.blocked.has(t));
    if (toMark.length === 0) throw new Error("driveWalk: frontier blocked");
    markResolved(store, toMark);
  }
  throw new Error("driveWalk did not converge");
}

// Left-endpoint tokens of the `_aggval` row(s) for a given relation + value.
// Layout: [_aggval, head, key..., value, id].
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

// ===== 0) Frontier: diamond, then a cycle =====================================
{
  const s = createStore();
  const a = intern(s, sym("a")), b = intern(s, sym("b")), j = intern(s, sym("j"));
  addOrder(s, a, j);
  addOrder(s, b, j);
  const step = (): string[] => {
    const F = frontier(s, unresolvedMoments(s));
    markResolved(s, F);
    return F.map((tok) => rt(s, s.momentTerms.get(tok)!)).sort();
  };
  assert.deepEqual(step(), ["bot"]);
  assert.deepEqual(step(), ["a", "b"]);
  assert.deepEqual(step(), ["j"]);
  assert.deepEqual(step(), []);
  console.log("PASS: frontier walks a diamond bot → {a, b} → j");
}
{
  // `x < y < x`: the edge test excludes both forever; the strict-order
  // fallback resolves the cycle as a unit.
  const s = createStore();
  const x = intern(s, sym("x")), y = intern(s, sym("y")), z = intern(s, sym("z"));
  addOrder(s, x, y);
  addOrder(s, y, x);
  addOrder(s, y, z);
  const step = (): string[] => {
    const F = frontier(s, unresolvedMoments(s));
    markResolved(s, F);
    return F.map((tok) => rt(s, s.momentTerms.get(tok)!)).sort();
  };
  assert.deepEqual(step(), ["bot"]);
  assert.deepEqual(step(), ["x", "y"]);
  assert.deepEqual(step(), ["z"]);
  console.log("PASS: frontier falls back to strict minimality on an order cycle");
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
  driveWalk(s, [reactiveHandler(new Set(["dmg"]), schema, new Map())]);

  const all = tuples(s);
  // The decisive assertion: sum=7 is materialized exactly at the join `j`.
  const sevens = aggvalLefts(s, "dmg", "7");
  assert.deepEqual(sevens, [tokenOf(s, j)], `_aggval dmg 7 should be at j only: ${all.join(" | ")}`);
  // Each single-contributor value at its own moment only; zero at bot.
  assert.deepEqual(aggvalLefts(s, "dmg", "3"), [tokenOf(s, m1)], `dmg 3 at m1 only: ${all.join(" | ")}`);
  assert.deepEqual(aggvalLefts(s, "dmg", "4"), [tokenOf(s, m2)], `dmg 4 at m2 only: ${all.join(" | ")}`);
  assert.deepEqual(aggvalLefts(s, "dmg", "0"), [tokenOf(s, s.bot)], `dmg 0 at bot: ${all.join(" | ")}`);
  // Every moment got resolved.
  assert.deepEqual(unresolvedMoments(s), []);
  console.log("PASS: sum materializes at the join of two incomparable inputs");
}

// ===== 2) Comparable (sequential) inputs: cumulative sum, no spurious 4 =====
{
  const { store, status } = runFixpoint(ok(`
#reactive dmg -> sum

+ dmg -> 3
  + dmg -> 4
`));
  assert.equal(status.kind, "done");
  const all = tuples(store);
  assert.equal(aggvalLefts(store, "dmg", "0").length, 1, `zero at bot: ${all.join(" | ")}`);
  assert.equal(aggvalLefts(store, "dmg", "3").length, 1, `expected _aggval dmg 3 once: ${all.join(" | ")}`);
  assert.equal(aggvalLefts(store, "dmg", "7").length, 1, `expected _aggval dmg 7 once: ${all.join(" | ")}`);
  assert.equal(aggvalLefts(store, "dmg", "4").length, 0, `comparable collapse: no _aggval dmg 4: ${all.join(" | ")}`);
  console.log("PASS: sequential inputs give cumulative sum, one row per moment");
}

// ===== 3) Reads sample at the anchor's START =================================
// `b` starts after the first contribution and before the second; `c` after
// both. A literal filters, a variable binds — both at the anchor start.
{
  const { store, status } = runFixpoint(ok(`
#reactive dmg -> sum

~a
  + dmg -> 3
  ~b
    + dmg -> 4
    ~c

c, dmg -> 7, + lethal x

c, dmg -> 99, + impossible x

b, dmg -> N, + seen-b N

c, dmg -> N, + seen-c N
`));
  assert.equal(status.kind, "done");
  const all = tuples(store);
  assert.ok(all.includes("lethal x"), `expected 'lethal' (dmg is 7 at c's start): ${all.join(" | ")}`);
  assert.ok(!all.includes("impossible x"), `'impossible' must not fire: ${all.join(" | ")}`);
  assert.deepEqual(all.filter((t) => t.startsWith("seen-b ")), ["seen-b 3"], `b samples 3: ${all.join(" | ")}`);
  assert.deepEqual(all.filter((t) => t.startsWith("seen-c ")), ["seen-c 7"], `c samples 7: ${all.join(" | ")}`);
  console.log("PASS: reactive reads sample the value at the anchor's left endpoint");
}

// ===== 3b) A rule-initial read samples at bot ================================
{
  const { store, status } = runFixpoint(ok(`
#reactive dmg -> sum

+ dmg -> 3

dmg -> N, + at-start N
`));
  assert.equal(status.kind, "done");
  const all = tuples(store);
  assert.deepEqual(all.filter((t) => t.startsWith("at-start ")), ["at-start 0"], `rule-initial read is at bot: ${all.join(" | ")}`);
  console.log("PASS: a rule-initial reactive read samples at bot (zero, not a subscription)");
}

// ===== 4) Group-by key: per-key sum sampled after all contributions =========
{
  const { store, status } = runFixpoint(ok(`
#reactive score -> sum

~setup
  + score alice -> 10
  + score alice -> 5
  + score bob -> 20
  ~report

report, score X -> N, + total X N
`));
  assert.equal(status.kind, "done");
  const totals = tuples(store).filter((t) => t.startsWith("total ")).sort();
  assert.deepEqual(totals, ["total alice 15", "total bob 20"], `got: ${totals.join(" | ")}`);
  console.log("PASS: reactive group-by sum per key");
}

// ===== 5) Reactive `last`: current value at the read point ===================
{
  const { store, status } = runFixpoint(ok(`
#reactive pos -> last

~setup
  + pos a
  ~mid
    + pos b
    ~check

mid, pos -> P, + where-mid P

check, pos -> P, + where P
`));
  assert.equal(status.kind, "done");
  const all = tuples(store);
  assert.deepEqual(all.filter((t) => t.startsWith("where-mid ")), ["where-mid a"], `mid sees a: ${all.join(" | ")}`);
  assert.deepEqual(all.filter((t) => t.startsWith("where ")), ["where b"], `check sees b: ${all.join(" | ")}`);
  console.log("PASS: reactive last gives the latest contributor at the read point");
}

// ===== 6) Coexistence: a non-reactive #agg in the same program is unchanged ==
{
  const { store, status } = runFixpoint(ok(`
#agg points -> sum
#reactive dmg -> sum

+ points -> 3
  + points -> 4
  + dmg -> 5
  points -> N
  + result N
`));
  assert.equal(status.kind, "done");
  const all = tuples(store);
  assert.ok(all.includes("result 7"), `legacy #agg still folds to 7: ${all.join(" | ")}`);
  assert.ok(aggvalLefts(store, "dmg", "5").length >= 1, `reactive dmg materialized: ${all.join(" | ")}`);
  console.log("PASS: #agg and #reactive coexist under one scheduler");
}

// ===== 7) End-to-end join through the surface ===============================
// `count` of `p` over episodes a;b;c;d. Under `c` two rules each assert a
// `p`, at incomparable moments. `d` is sequenced after `c`, so its start is
// above both; the count there is 4.
{
  const { store, status } = runFixpoint(ok(`
#reactive p -> count

~go

go
  ~a; ~b; ~c; ~d

a, +p -> ()

b, +p -> ()

c, +p -> ()

c, +p -> ()

d, p -> X, ~hi X

d, p -> (s (s (s (s z)))), ~done d
`));
  assert.equal(status.kind, "done", `expected clean termination, got ${status.kind}`);
  const all = tuples(store);
  assert.ok(all.includes("done d"), `expected 'done' (count is 4 at d's start): ${all.join(" | ")}`);
  assert.deepEqual(all.filter((t) => t.startsWith("hi ")), ["hi (s (s (s (s z))))"], `one hi at d: ${all.join(" | ")}`);
  console.log("PASS: count is 4 at an episode starting above two incomparable inputs");
}

// ===== 8) Single-moment recursion: transitive closure with self-loops =======
// A recursive reactive aggregate whose contributors are derived from reads of
// its OWN `_aggval`, landing entirely at `bot`. Each round at `bot` adds the
// groups derived in the previous round (rows dedup by id), so the closure of
// a→b→c→a is complete including the self-loops.
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

// ===== 9) Same-moment consumer stratification ===============================
// `count` the closure pairs (relation `q`) at the same moment, and read it.
// `q` depends on `p` through a `^` edge, so the reactive handler folds `q`
// only in a round where `p` has settled at `bot`: exactly one `_aggval q`
// row, value 9, and the reader sees only 9.
{
  const { store, status } = runFixpoint(ok(`
#reactive p * * -> bool
#reactive q -> count

e A B, ^p A B -> 1

e A B, p B C -> 1, ^p A C -> 1

p X Y -> 1, ^q -> 1

q -> N, ^total N

^e a b
  ^e b c
  ^e c a
`));
  assert.equal(status.kind, "done", `expected clean termination, got ${status.kind}`);
  const all = tuples(store);
  const qRows = all.filter((s) => s.startsWith("_aggval q "));
  const nine = "(s ".repeat(9) + "z" + ")".repeat(9);
  assert.deepEqual(qRows, [`_aggval q ${nine}`], `expected one _aggval q = 9: ${qRows.join(" | ")}`);
  assert.deepEqual(all.filter((t) => t.startsWith("total ")), [`total ${nine}`], `reader sees 9 only: ${all.join(" | ")}`);
  console.log("PASS: same-moment consumer count folds once at the final value (9)");
}

// ===== 10) Values read at successive checks (per-group `last`) ==============
{
  const { store, status } = runFixpoint(ok(`
#reactive at * -> last

move It To, +at It -> To

~turn
  ~move me a;
  ~move it a;
  ~check;
  ~move me b;
  ~check;

check, at X -> L, ^seen X L
`));
  assert.equal(status.kind, "done", `expected done, got ${status.kind}`);
  const seen = tuples(store).filter((s) => s.startsWith("seen ")).sort();
  // First check: me a, it a. Second: me b, it a (a second tuple — the two
  // checks are distinct intervals).
  assert.deepEqual(seen, ["seen it a", "seen it a", "seen me a", "seen me b"], `got: ${seen.join(" | ")}`);
  console.log("PASS: per-group last read at each check");
}

// ===== 11) Blocking: a read above a pending choice does not fire ============
{
  const src = (actor: string) => `
#reactive dmg -> sum

~game
  ~pick;
  ~after

pick, ^opt x, ^opt y

pick, ?${actor} C, ~choice C, !opt C

after, dmg -> N, +seen N
`;
  // `you`: the choice moment blocks everything above it, including the read
  // at `after`'s start. No `_aggval` row exists at or above the choice.
  {
    const { store, status } = runFixpoint(ok(src("")));
    assert.equal(status.kind, "active-choices", `expected active-choices, got ${status.kind}`);
    const all = tuples(store);
    assert.ok(!all.some((t) => t.startsWith("seen ")), `read must not fire before the choice: ${all.join(" | ")}`);
    // The `after` episode's start is unresolved.
    const after = store.tuples.find((t) => rt(store, t.atom.terms[0]!) === "after")!;
    assert.ok(!store.resolved.has(tokenOf(store, after.l)), "after's start must be unresolved");
  }
  // `rng`: the scheduler resolves it and the walk continues to `after`.
  {
    const { store, status } = runFixpoint(ok(src("[rng]")), 200, 5000, { random: () => 0 });
    assert.equal(status.kind, "done", `expected done, got ${status.kind}`);
    const all = tuples(store);
    assert.deepEqual(all.filter((t) => t.startsWith("seen ")), ["seen 0"], `read fires after the choice: ${all.join(" | ")}`);
    assert.deepEqual(unresolvedMoments(store), [], "every moment resolved");
  }
  console.log("PASS: a reactive read waits for a pending choice below its moment");
}

// ===== 12) Same-moment chain: reactive read → ^ → #agg read =================
// The `#agg` request row appears at `bot` only after the reactive read at
// `bot` fired; the walk keeps running rounds at `bot` until nothing changes,
// so the request closes before `bot` is marked.
{
  const { store, status } = runFixpoint(ok(`
#agg cnt -> count
#reactive dmg -> sum

^go

go, dmg -> N, ^stage N

stage N, cnt -> C, ^got N C
`));
  assert.equal(status.kind, "done", `expected done, got ${status.kind}`);
  const all = tuples(store);
  assert.deepEqual(all.filter((t) => t.startsWith("got ")), ["got 0 z"], `chain resolves at one moment: ${all.join(" | ")}`);
  console.log("PASS: a same-moment chain of reactive and demand reads resolves");
}

console.log("ALL v2 reactive aggregate tests passed");
