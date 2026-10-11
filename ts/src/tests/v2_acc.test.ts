// Tests for `#acc` relations (plans/v2-acc-relations.md).
//
// An acc relation's rows are computed by `body / head` rules from the state
// alive at a moment and written as point rows when the moment walk resolves
// that moment; ordinary rules read them at their anchor's left endpoint.
// The op registry (acc-ops.ts) is checked against its monoid laws.

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
import { expandTerm } from "../v2/hashcons.js";
import { ACC_OPS, accOp, natValue, type AccOpDef } from "../v2/acc-ops.js";
import { accHandler, compileAcc } from "../v2/acc.js";
import { frontier, markResolved, settleMoments, unresolvedMoments } from "../v2/moment-walk.js";
import type { Atom, Term } from "../v2/term.js";

function sym(name: string): Term { return { tag: "Symbol", name }; }
function atom(...terms: Term[]): Term { return { tag: "Atom", atom: { terms } }; }
function peano(n: number): Term { let t: Term = sym("z"); for (let i = 0; i < n; i++) t = atom(sym("s"), t); return t; }

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
function ra(s: Store, a: Atom): string {
  return a.terms.slice(0, -1).map((t) => rt(s, t)).join(" ");
}
function tuples(s: Store): string[] { return s.tuples.map((t) => ra(s, t.atom)); }
function withHead(s: Store, head: string): string[] {
  return tuples(s).filter((t) => t === head || t.startsWith(head + " ")).sort();
}

function ok(src: string) {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}
function err(src: string): string {
  const p = parse(src);
  if (!("message" in p)) throw new Error(`expected a parse error, got a program`);
  return p.message;
}
function runErr(src: string): string {
  try {
    runFixpoint(ok(src));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a run error");
}

const three = "(s (s (s z)))";
function peanoText(n: number): string { let t = "z"; for (let i = 0; i < n; i++) t = `(s ${t})`; return t; }

// ===== 1) Parse ==============================================================
{
  const p = ok(`
#acc damage : e @sum
#acc at : e (@last location)
#acc occupancy : location @count
#acc crowded : location
#acc distance : location location @min
#acc min-path : location location (@arg-min location)

hit X A / damage X (@sum A)
move A B / at A B
at _ X / occupancy X ()
occupancy X (s (s (s _))) / crowded X

+main-option do/rest
`);
  assert.equal(p.accDecls.size, 6);
  assert.deepEqual(p.accDecls.get("at")!.columns, [{ kind: "key", type: "e" }, { kind: "agg", op: "last", type: "location" }]);
  assert.equal(p.accDecls.get("crowded")!.aggIndex, null);
  assert.equal(p.accRules.length, 4);
  // `(@sum A)` unwraps to `A`; `()` becomes the unit atom.
  assert.deepEqual(p.accRules[0]!.head.terms[2], { tag: "Variable", name: "A" });
  assert.deepEqual(p.accRules[2]!.head.terms[2], { tag: "Atom", atom: { terms: [] } });
  // `do/rest` is one Symbol; the rule is an ordinary rule.
  assert.equal(p.rules.length, 1);
  const first = p.rules[0]!.body[0]!;
  assert.ok(first.tag === "Atom" && first.atom.terms[1]!.tag === "Symbol" && first.atom.terms[1]!.name === "do/rest");
  console.log("PASS: acc declarations and rules parse");
}
{
  assert.match(err(`#acc x : e @median`), /unknown aggregation '@median'/);
  assert.match(err(`#acc x : @sum @count`), /one aggregation column/);
  assert.match(err(`#acc x e`), /standalone ':'/);
  assert.match(err(`foo X / bar X`), /not declared with '#acc'/);
  assert.match(err(`#acc bar : e e\nfoo X / bar X`), /has 1 column\(s\); '#acc bar' declares 2/);
  assert.match(err(`#acc n : @count\nfoo X / n X`), /takes no argument/);
  assert.match(err(`#acc at : e (@last location)\nmove A B / at A (@sum B)`), /declared '@last', not '@sum'/);
  assert.match(err(`#acc bar : e\nfoo X, +baz X / bar X`), /only matches and '='/);
  assert.match(err(`#acc bar : e\nfoo X, (baz X) / bar X`), /only matches and '='/);
  assert.match(err(`#acc bar : e\nfoo X / bar X / bar X`), /exactly one '\/'/);
  assert.match(err(`#acc bar : e\nfoo X / +bar X`), /plain atom/);
  // `#agg` / `-> weight` were removed; their uses are migration errors.
  assert.match(err(`#acc bar : e\n#agg bar -> sum`), /'#agg' was removed/);
  assert.match(err(`#acc bar : e\nfoo X, q X -> N / bar X`), /'-> weight' was removed/);
  console.log("PASS: acc parse errors");
}
{
  // Expand-time errors: asserting into an acc relation, weighted read,
  // unbound head variable.
  const bad = (src: string): string => {
    try { runFixpoint(ok(src)); } catch (e) { return (e as Error).message; }
    throw new Error("expected an error");
  };
  assert.match(bad(`#acc bar : e\nfoo X / bar X\n^foo a, +bar b`), /is an acc relation/);
  assert.match(bad(`#acc bar : e\nfoo X / bar X\nbar X -> N, ^seen N`), /'-> weight' was removed/);
  assert.match(bad(`#acc bar : e\nfoo X / bar Y`), /head variable 'Y' is not bound/);
  // Inside `!(...)` an acc relation is a plain pattern: no weight, full arity.
  assert.match(bad(`#acc bar : e\nfoo X / bar X\n?C, !(bar C -> N)`), /'-> weight' was removed/);
  assert.match(bad(`#acc bar : e\nfoo X / bar X\n?C, !(bar C extra)`), /has 1 column\(s\), pattern has 2 \(inside/);
  console.log("PASS: acc expand errors");
}

// ===== 2) Sum, sampled at the anchor's start ================================
{
  const { store, status } = runFixpoint(ok(`
#acc damage : e @sum

hit X A / damage X (@sum A)

~game
  ~a; ~b; ~c

a, +hit me 3
a, +hit me 4
b, +hit me 5

b, damage X D, ^at-b X D
c, damage X D, ^at-c X D
c, damage you D, ^undamaged D
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "at-b"), ["at-b me 7"]);
  assert.deepEqual(withHead(store, "at-c"), ["at-c me 12"]);
  assert.deepEqual(withHead(store, "undamaged"), [], "no row for an absent key");
  assert.deepEqual(unresolvedMoments(store), []);
  console.log("PASS: @sum sampled at the anchor start; absent keys have no row");
}

// ===== 3) Last, keyed =======================================================
{
  const { store, status } = runFixpoint(ok(`
#acc at : e (@last location)

move A B / at A B

~game
  ~a; ~b; ~c

a, +move me x
b, +move me y

b, at me L, ^at-b L
c, at me L, ^at-c L
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "at-b"), ["at-b x"]);
  assert.deepEqual(withHead(store, "at-c"), ["at-c y"]);
  console.log("PASS: @last gives the latest move at each read");
}
{
  // Two moves from sibling firings are incomparable: both are maximal.
  const { store, status } = runFixpoint(ok(`
#acc at : e (@last location)

move A B / at A B

~game
  ~a; ~c

a, opt L, +move me L
^opt x
^opt y

c, at me L, ^at-c L
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "at-c"), ["at-c x", "at-c y"]);
  console.log("PASS: @last yields every incomparable maximal contribution");
}

// ===== 4) Count and threshold; keyless zero row ==============================
{
  const { store, status } = runFixpoint(ok(`
#acc occupancy : location @count
#acc crowded : location
#acc n : @count

at _ X / occupancy X ()
occupancy X (s (s (s _))) / crowded X
at _ _ / n ()

~game
  ~a; ~c

a, +at me here
a, +at you here
a, +at it here
a, +at other there

c, occupancy L N, ^occ L N
c, crowded L, ^crowded-c L
c, n N, ^total N
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "occ"), [`occ here ${three}`, "occ there (s z)"]);
  assert.deepEqual(withHead(store, "crowded-c"), ["crowded-c here"]);
  assert.deepEqual(withHead(store, "total"), ["total (s (s (s (s z))))"]);
  // The keyless count has its zero row at bot (nothing alive there).
  const nAtBot = store.tuples.filter((t) =>
    rt(store, t.atom.terms[0]!) === "n" && tokenOf(store, t.l) === store.botTok);
  assert.equal(nAtBot.length, 1);
  assert.equal(ra(store, nAtBot[0]!.atom), "n z");
  console.log("PASS: @count under a wildcard, threshold pattern, keyless zero row");
}

// ===== 5) Stratification in one moment ======================================
{
  const { store, status } = runFixpoint(ok(`
#acc at : e (@last location)
#acc occupancy : location @count
#acc crowded : location

move A B / at A B
at _ X / occupancy X ()
occupancy X (s (s _)) / crowded X

~game
  ~a; ~c

a, +move me here
a, +move you here
a, +move it there

c, at X L, ^pos X L
c, occupancy L N, ^occ L N
c, crowded L, ^crowded-c L
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "pos"), ["pos it there", "pos me here", "pos you here"]);
  assert.deepEqual(withHead(store, "occ"), ["occ here (s (s z))", "occ there (s z)"]);
  assert.deepEqual(withHead(store, "crowded-c"), ["crowded-c here"]);
  console.log("PASS: at → occupancy → crowded computed together at one resolution");
}

// ===== 6) Recursion: shortest paths, arg-min, domain errors ==================
{
  const { store, status } = runFixpoint(ok(`
#acc distance : location location @min
#acc min-path : location location (@arg-min location)

edge A B / distance A B (s z)
edge A B, distance B C L / distance A C (s L)

edge A B / min-path A B (pair B (s z))
edge A B, min-path B C (pair _ L) / min-path A C (pair B (s L))

^edge a b
^edge b c
^edge c a
^edge a c
^edge a d
^edge b d

distance a c D, ^d-ac D
distance a a D, ^d-aa D
min-path a d P, ^mp-ad P
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "d-ac"), ["d-ac (s z)"]);
  assert.deepEqual(withHead(store, "d-aa"), ["d-aa (s (s z))"]); // a→c→a
  // a→d directly (1) and a→b→d (2): only the direct hop attains the min.
  assert.deepEqual(withHead(store, "mp-ad"), ["mp-ad (pair d (s z))"]);
  console.log("PASS: shortest paths via @min and @arg-min converge on a cyclic graph");
}
{
  // Two `A`s attaining the minimum → two rows.
  const { store, status } = runFixpoint(ok(`
#acc min-path : location location (@arg-min location)

edge A B / min-path A B (pair B (s z))
edge A B, min-path B C (pair _ L) / min-path A C (pair B (s L))

^edge a b
^edge a c
^edge b d
^edge c d

min-path a d P, ^mp P
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "mp"), ["mp (pair b (s (s z)))", "mp (pair c (s (s z)))"]);
  console.log("PASS: @arg-min yields every argument attaining the minimum");
}
{
  const msg = runErr(`
#acc distance : location location @min
edge A B / distance A B 1
^edge a b
`);
  assert.match(msg, /acc 'distance': @min expects a Peano nat/);
  console.log("PASS: @min rejects a numeric-symbol contribution");
}

// ===== 7) Snapshot: reactions at m do not re-open m =========================
{
  const { store, status } = runFixpoint(ok(`
#acc occupancy : location @count

at _ X / occupancy X ()

~game
  ~a; ~b; ~c

a, +at me here

b, occupancy here N, ^seen-b N
b, occupancy here N, +at extra here

c, occupancy here N, ^seen-c N
`));
  assert.equal(status.kind, "done");
  // At b's start: one occupant; the `+at extra` emitted in reaction starts
  // strictly inside b and is counted from c's start on, not at b's start.
  assert.deepEqual(withHead(store, "seen-b"), ["seen-b (s z)"]);
  assert.deepEqual(withHead(store, "seen-c"), ["seen-c (s (s z))"]);
  // Exactly one occupancy row at b's start.
  const b = store.tuples.find((t) => rt(store, t.atom.terms[0]!) === "b")!;
  const occAtB = store.tuples.filter((t) =>
    rt(store, t.atom.terms[0]!) === "occupancy" && tokenOf(store, t.l) === tokenOf(store, b.l));
  assert.equal(occAtB.length, 1);
  console.log("PASS: acc rows are a snapshot at resolution; reactions land at later moments");
}

// ===== 8) Blocking behind a pending choice ==================================
{
  const src = (actor: string) => `
#acc n : @count

opt _ / n ()

~game
  ~pick;
  ~after

-- The options are derived in the asking rule: under fresh-left \`^\` the
-- anchor moves through each \`^\`, so both are alive where \`?\` asks
-- (plans/v2-caret-fresh-left.md §2.1). Derived in a sibling rule they would
-- start after the ask moment and the choice would have no options.
pick, ^opt x, ^opt y, ?${actor} C, !opt C, ~choice C

after, n N, +seen N
`;
  {
    const { store, status } = runFixpoint(ok(src("")));
    assert.equal(status.kind, "active-choices");
    assert.deepEqual(withHead(store, "seen"), []);
    const after = store.tuples.find((t) => rt(store, t.atom.terms[0]!) === "after")!;
    assert.ok(!store.resolved.has(tokenOf(store, after.l)), "after's start must be unresolved");
  }
  {
    const { store, status } = runFixpoint(ok(src("[rng]")), 200, 5000, { random: () => 0 });
    assert.equal(status.kind, "done");
    // `^opt` lives inside `pick`; at `after`'s start nothing is alive.
    assert.deepEqual(withHead(store, "seen"), ["seen z"]);
    assert.deepEqual(unresolvedMoments(store), []);
  }
  console.log("PASS: an acc read waits for a pending choice below its moment");
}

// ===== 9) js in bodies and heads ============================================
{
  const { store, status } = runFixpoint(ok(`
#js (double x) { return x * 2; }
#js-def small +N { if (N < 10) yield []; }
#acc total : e @sum

score X N, small N / total X (@sum @js(double N))

^score a 3
^score a 4
^score a 50

total a T, ^t T
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "t"), ["t 14"]);
  console.log("PASS: #js-def in an acc body, @js in an acc head");
}

// ===== 10) A computed value read inside another acc body ===================
// (Formerly a `#reactive hp -> sum` read; the value is now itself an acc
// relation, so `low` sits in a stratum above `hp`.)
{
  const { store, status } = runFixpoint(ok(`
#acc hp : @sum
#acc low : e

dmg N / hp N
hp N, small N / low me
#js-def small +N { if (N < 5) yield []; }

~game
  ~a; ~c

a, +dmg 3

c, low X, ^low-c X
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "low-c"), ["low-c me"]);
  console.log("PASS: an acc value can be read inside another acc body");
}

// ===== 11) Non-convergence hits the round cap ===============================
{
  const msg = runErr(`
#acc n : nat

seed X / n X
n X / n (s X)

^seed z
`);
  assert.match(msg, /acc: stratum \{n\} did not converge at moment/);
  console.log("PASS: a diverging recursive stratum reports the round cap");
}

// ===== 12) Op laws ===========================================================
{
  // Per-op samples: value terms in the op's domain, plus out-of-domain
  // terms η must reject. A registry entry without samples fails.
  const s = createStore();
  const m1 = intern(s, sym("m1")), m2 = intern(s, sym("m2")), j = intern(s, sym("j"));
  addOrder(s, m1, j);
  addOrder(s, m2, j);
  const V = (t: Term): Term => intern(s, t);
  const samples: Record<string, { ok: [Term, Term][]; bad: Term[] }> = {
    sum: { ok: [[V(sym("3")), m1], [V(sym("4")), m2], [V(sym("5")), j]], bad: [V(sym("x")), V(peano(2))] },
    count: { ok: [[V(atom()), m1], [V(atom()), m2], [V(atom()), j]], bad: [] },
    min: { ok: [[V(peano(3)), m1], [V(peano(1)), m2], [V(peano(1)), j]], bad: [V(sym("1")), V(sym("x"))] },
    last: { ok: [[V(sym("a")), m1], [V(sym("b")), m2], [V(sym("c")), j]], bad: [] },
    "arg-min": {
      ok: [[V(atom(sym("pair"), sym("p"), peano(2))), m1], [V(atom(sym("pair"), sym("q"), peano(2))), m2], [V(atom(sym("pair"), sym("r"), peano(5))), j]],
      bad: [V(sym("x")), V(atom(sym("pair"), sym("p"), sym("2")))],
    },
    bool: { ok: [[V(atom()), m1], [V(atom()), m2], [V(atom()), j]], bad: [] },
  };
  const sig = (def: AccOpDef<unknown>, x: unknown): string =>
    def.readout(x, s).map((r) => `${tokenOf(s, intern(s, r.value))}@${r.moment === undefined ? "-" : tokenOf(s, r.moment)}`).sort().join(",");
  for (const name of Object.keys(ACC_OPS)) {
    const def = accOp(name, true)!;
    const smp = samples[name];
    assert.ok(smp !== undefined, `op '${name}' has no samples in the law harness`);
    const xs = smp.ok.map(([v, t]) => def.inject(v, t, s, "law"));
    const [x, y, z] = xs as [unknown, unknown, unknown];
    // identity
    assert.equal(sig(def, def.combine(def.identity, x, s)), sig(def, x), `${name}: identity`);
    assert.equal(sig(def, def.combine(x, def.identity, s)), sig(def, x), `${name}: identity (right)`);
    // commutativity, associativity
    assert.equal(sig(def, def.combine(x, y, s)), sig(def, def.combine(y, x, s)), `${name}: commutative`);
    assert.equal(
      sig(def, def.combine(def.combine(x, y, s), z, s)),
      sig(def, def.combine(x, def.combine(y, z, s), s)),
      `${name}: associative`,
    );
    // canonicality under permutation
    const fold = (order: unknown[]) => order.reduce((a, b) => def.combine(a, b, s), def.identity);
    assert.equal(sig(def, fold([x, y, z])), sig(def, fold([z, x, y])), `${name}: canonical`);
    // idempotence flag agrees with combine
    assert.equal(sig(def, def.combine(x, x, s)) === sig(def, x), def.idempotent, `${name}: idempotent flag`);
    // readout of the identity: empty or the documented zero
    const zero = def.readout(def.identity, s);
    if (name === "sum") assert.deepEqual(zero.map((r) => rt(s, r.value)), ["0"]);
    else if (name === "count") assert.deepEqual(zero.map((r) => rt(s, r.value)), ["z"]);
    else assert.deepEqual(zero, []);
    // domain errors
    for (const b of smp.bad) assert.throws(() => def.inject(b, m1, s, "law"), /expects/, `${name}: rejects ${rt(s, b)}`);
  }
  // natValue is Peano-only.
  assert.equal(natValue(V(peano(3)), s), 3);
  assert.equal(natValue(V(sym("3")), s), null);
  console.log(`PASS: monoid laws hold for ${Object.keys(ACC_OPS).length} ops`);
}

// ===== 13) Store-level handler: rows at bot, the inputs, and their join ======
{
  const s = createStore();
  const m1 = intern(s, sym("m1")), m2 = intern(s, sym("m2")), j = intern(s, sym("j"));
  addOrder(s, m1, j);
  addOrder(s, m2, j);
  addTuple(s, { terms: [intern(s, sym("hit")), intern(s, sym("me")), intern(s, sym("3")), intern(s, sym("id1"))] }, m1, s.top);
  addTuple(s, { terms: [intern(s, sym("hit")), intern(s, sym("me")), intern(s, sym("4")), intern(s, sym("id2"))] }, m2, s.top);
  const program = ok(`
#acc damage : e @sum
hit X A / damage X (@sum A)
`);
  const handler = accHandler(compileAcc(program), new Map(), new Map());
  for (let guard = 0; guard < 50; guard++) {
    const U = unresolvedMoments(s);
    if (U.length === 0) break;
    const F = frontier(s, U);
    settleMoments(s, [handler], F);
    markResolved(s, F);
  }
  const dmg = s.tuples
    .filter((t) => rt(s, t.atom.terms[0]!) === "damage")
    .map((t) => `${ra(s, t.atom)} @${rt(s, t.l)}`)
    .sort();
  assert.deepEqual(dmg, ["damage me 3 @m1", "damage me 4 @m2", "damage me 7 @j"]);
  console.log("PASS: store-level handler writes rows at each input moment and their join");
}

// ===== 14) Acc relations inside `!(...)` =====================================
// plans/v2-choice-components-by-moment.md step 6: acc rows at a moment are
// written when it settles, before its choices surface, so a constraint block
// reads them with its ordinary stored-tuple match at the component's moment.
{
  const options = (src: string): string[][] => {
    const { store, status } = runFixpoint(ok(src));
    assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
    if (status.kind !== "active-choices") throw new Error("unreachable");
    assert.equal(status.components.length, 1);
    const comp = status.components[0]!;
    assert.ok(store.settled.has(tokenOf(store, comp.moment)), "the component's moment has settled");
    assert.ok(!store.resolved.has(tokenOf(store, comp.moment)), "…and is not resolved: its choice is pending");
    return comp.options.map((o) => o.map((t) => rt(store, t))).sort();
  };
  const world = `
#acc at : e (@last location)
#acc distance : location location @min
#acc n : @count

move A B / at A B
edge A B / distance A B (s z)
edge A B, distance B C L / distance A C (s L)
nothing _ / n ()

^edge here there
^edge there beyond

~game
  ~a; ~pick

a, +move me here
a, +move you here
a, +move it there
`;
  // Active term in a key position, and in a value position.
  assert.deepEqual(options(world + "pick, ?C, !(at C here)"), [["me"], ["you"]]);
  assert.deepEqual(options(world + "pick, ?L, !(at it L)"), [["there"]]);
  // A recursive relation.
  assert.deepEqual(options(world + "pick, ?C, !(distance here C (s (s z)))"), [["beyond"]]);
  // A joint choice over two acc patterns.
  assert.deepEqual(
    options(world + "pick, ?A, ?B, !(at A L, at B L, distance L there _)"),
    [["me", "me"], ["me", "you"], ["you", "me"], ["you", "you"]],
  );
  // The keyless zero row matches.
  assert.deepEqual(options(world + "pick, ?N, !(n N)"), [["z"]]);
  // A keyed relation has no row for an absent key: zero options, dead choice.
  {
    const { store, status } = runFixpoint(ok(world + "pick, ?L, !(at nobody L), is L V, +went V"));
    assert.equal(status.kind, "done");
    assert.deepEqual(withHead(store, "went"), []);
    assert.deepEqual(withHead(store, "_dead-choice").length, 1);
  }
  // The read is recorded for the timeline, and counts as a rule read.
  {
    const { store } = runFixpoint(ok(world + "pick, ?C, !(at C here)"));
    const pick = store.tuples.find((t) => rt(store, t.atom.terms[0]!) === "pick")!;
    assert.deepEqual([...(store.accConsulted.get("at") ?? [])], [tokenOf(store, pick.l)]);
    assert.equal(store.accRelations.get("at")!.readByRules, true);
    assert.equal(store.accRelations.get("n")!.readByRules, false);
  }
  console.log("PASS: acc relations are readable inside !(...)");
}

// ===== 15) Acc at a moment is the state before its choices resolve ===========
// Under fresh-left `^` (plans/v2-caret-fresh-left.md §2.2) a reaction to a
// choice starts strictly after the ask moment, so the snapshot at a moment
// is also its final state, and a second choice chained after `^took` sits at
// took's own moment and sees it. (Before the change both choices shared one
// moment and the second saw the acc state from before the first.)
{
  const { store, status } = runFixpoint(ok(`
#acc n : @count
took _ / n ()

~game
  ~pick;
  ~after

pick, n N, ^before N

pick, ^opt x, ?[rng] A, !(opt A), is A V, ^took V
  ?[rng] B, !(n B), is B W, +saw W

after, n N, +later N
`), 200, 5000, { random: () => 0 });
  assert.equal(status.kind, "done");
  // An ordinary reader at the start of `pick` sees the state from before
  // any choice.
  assert.deepEqual(withHead(store, "before"), ["before z"]);
  assert.deepEqual(withHead(store, "took"), ["took x"]);
  // The chained choice is asked at took's moment, where `took` is alive and
  // counted.
  assert.deepEqual(withHead(store, "saw"), ["saw (s z)"]);
  // `^took` lives inside `pick`, so a later moment does not see it.
  assert.deepEqual(withHead(store, "later"), ["later z"]);
  // No moment's acc rows disagree with what is alive there: `took x` is not
  // alive at the ask moment of A.
  const took = store.tuples.find((t) => rt(store, t.atom.terms[0]!) === "took")!;
  const askA = store.tuples.find((t) => rt(store, t.atom.terms[0]!) === "_choose")!;
  assert.notEqual(tokenOf(store, took.l), tokenOf(store, askA.l), "took must start after A's ask moment");
  console.log("PASS: acc at a choice's moment is a snapshot; a chained choice after `^` sees it");
}

// ===== 16) Moment walk frontier ==============================================
// (Moved from v2_reactive_aggregate.test.ts with `#reactive`; the walk itself
// stays — acc settling, choices and exception checks run on it.)
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

// ===== 17) A rule-initial read samples at bot =================================
// (Formerly `#reactive`.) The anchor of a rule-initial read is (bot, top), so
// it samples the relation at `bot`: a keyless `@sum` reads its zero row once,
// not every later value.
{
  const { store, status } = runFixpoint(ok(`
#acc total : @sum
pt N / total N

~game
  +pt 3
  +pt 4

total N, +seen N
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "seen"), ["seen 0"]);
  console.log("PASS: a rule-initial acc read samples at bot (zero, not a subscription)");
}

// ===== 18) Recursion at one moment is a stratum fixpoint ======================
// (Formerly same-moment `#reactive` recursion + `computeAggStrata`.) A boolean
// closure over a cyclic graph converges inside its stratum; a relation over
// it, positive or negated, sits in a stratum above and sees the final value.
// (Counting acc rows read in an acc body is covered by test 18b.)
{
  const { store, status } = runFixpoint(ok(`
#acc reach : n n
#acc cyclic : n
#acc acyclic : n

edge A B / reach A B
edge A B, reach B C / reach A C
reach X X / cyclic X
node X, not cyclic X / acyclic X

~game
  ( ~setup ); ( ~check )

setup
  +node a
  +node b
  +node c
  +node d
  +edge a b
  +edge b c
  +edge c a
  +edge c d

check, reach A B, ^r A B
check, cyclic X, ^cyc X
check, acyclic X, ^acyc X
`));
  assert.equal(status.kind, "done");
  const nodes = ["a", "b", "c"];
  const want = [...nodes.flatMap((x) => nodes.map((y) => `r ${x} ${y}`)), ...nodes.map((x) => `r ${x} d`)].sort();
  assert.deepEqual(withHead(store, "r"), want, "closure includes all self-loops");
  assert.deepEqual(withHead(store, "cyc"), ["cyc a", "cyc b", "cyc c"]);
  assert.deepEqual(withHead(store, "acyc"), ["acyc d"]);
  console.log("PASS: a boolean closure converges in its stratum; strata above (positive and `not`) see its final value");
}

// ===== 19) Bracket `some`/`none` and correlation, as acc reads ===============
// (Formerly `[ Q | some V ]` / `[ Q | none V ]` with a prefix-bound key.)
// The correlated variable becomes a key column; `some` is a positive read of
// a boolean relation and `none` is `not`.
{
  const { store, status } = runFixpoint(ok(`
#acc spent-card : card
#acc winner : player

spent C _ / spent-card C
won W / winner W

~game
  ( ~setup ); ( ~check )

setup
  +card c1
  +card c2
  +spent c1 3

check, card C, spent-card C, ^some-spent C
check, card C, not spent-card C, ^none-spent C
check, not winner _, ^nobody-won
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "some-spent"), ["some-spent c1"]);
  assert.deepEqual(withHead(store, "none-spent"), ["none-spent c2"]);
  assert.equal(withHead(store, "nobody-won").length, 1);
  console.log("PASS: some/none become a positive read and `not` on a keyed boolean relation");
}

// ===== 20) `not`: negation over acc relations =================================
// (plans/v2-caret-fresh-left.md §3.) `not r t̄` succeeds iff no row of `r`
// matches at the read's moment: the anchor's start in an ordinary rule, the
// component's moment inside `!(...)`, `m` in an acc body.
{
  // Ordinary rules: a snapshot at each anchor's start. `down a` happens during
  // t1, so at t1's start all three pins stand; at t2's start only b and c.
  const { store, status } = runFixpoint(ok(`
#acc fallen : pin
#acc standing : pin

~game
  ( ~setup ); ( ~t1 ); ( ~t2 )

setup
  +pin a
  +pin b
  +pin c

t1, +down a

down Q / fallen Q
pin Q, not fallen Q / standing Q

t1, pin Q, not fallen Q, ^up-at-t1 Q
t2, pin Q, not fallen Q, ^up-at-t2 Q
t2, standing Q, ^standing-at-t2 Q
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "up-at-t1"), ["up-at-t1 a", "up-at-t1 b", "up-at-t1 c"]);
  assert.deepEqual(withHead(store, "up-at-t2"), ["up-at-t2 b", "up-at-t2 c"]);
  // In an acc body, over a strictly lower stratum.
  assert.deepEqual(withHead(store, "standing-at-t2"), ["standing-at-t2 b", "standing-at-t2 c"]);
  console.log("PASS: `not` in ordinary rules is a snapshot at the anchor start; in acc bodies it reads a lower stratum");
}
{
  // Inside `!(...)`: the options are the pins with no `fallen` row at the
  // component's moment.
  const { store, status } = runFixpoint(ok(`
#acc fallen : pin
down Q / fallen Q

~game
  ( ~setup ); ( ~t )

setup
  +pin a
  +pin b
  +down a

t, ?C, !(pin C, not fallen C), ~pick C
`));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  const opts = status.components[0]!.options.map((o) => o.map((t) => rt(store, t)).join(",")).sort();
  assert.deepEqual(opts, ["b"]);
  console.log("PASS: `not` inside `!(...)` filters a choice's options");
}
{
  // Errors.
  const bad = (src: string): string => {
    const p = parse(src);
    if ("message" in p) return p.message;
    try { runFixpoint(p); } catch (e) { return (e as Error).message; }
    throw new Error(`expected an error for: ${src}`);
  };
  // On an ordinary relation: declare a boolean acc relation instead.
  assert.match(bad(`+pin a\nx, not pin a, ^y`), /'not' reads an '#acc' relation; 'pin' is not one/);
  // Range restriction.
  assert.match(bad(`#acc f : e\n+e a\nx, not f X, ^y`), /needs its variables bound before it \(unbound: X\)/);
  // Negation within an SCC.
  assert.match(bad(`#acc f : e\n#acc g : e\ne X / f X\ne X, not g X / f X\nf X / g X`), /stratified negation/);
  // With a marker.
  assert.match(bad(`#acc f : e\n+e a\nx, +not f a`), /'not' only prefixes a plain read/);
  // Negated acc head.
  assert.match(bad(`#acc f : e\nf X / not f X`), /acc rule head cannot be negated/);
  // `not` is reserved: it cannot name a relation.
  assert.match(bad(`+not\n`), /'not' is reserved/);
  assert.match(bad(`x, not, ^y\n`), /'not' is reserved/);
  // Inside `!(...)`: acc relations only, variables bound by a positive sub.
  assert.match(bad(`+pin a\nx, ?C, !(pin C, not pin C)`), /'not' inside '!\(\.\.\.\)' reads an '#acc' relation/);
  console.log("PASS: `not` errors");
}

// ===== 18b) Counting acc rows read in an acc body ============================
// Each matched acc row is part of a contribution's identity, so rows that
// share a moment are not collapsed: three `k` rows count as three, both for a
// direct count of the tuples and for a count over the acc rows; a count over a
// cyclic closure's rows counts every pair.
{
  const { store, status } = runFixpoint(ok(`
#acc k : e
#acc n : @count
#acc m : @count
#acc reach : n n
#acc pairs : @count

item X / k X
k _ / n ()
item _ / m ()
edge A B / reach A B
edge A B, reach B C / reach A C
reach _ _ / pairs ()

^item a
^item b
^item c
^edge x y
^edge y z
^edge z x
~check

check, n N, ^via-acc-rows N
check, m N, ^via-tuples N
check, pairs N, ^closure-pairs N
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "via-acc-rows"), [`via-acc-rows ${peanoText(3)}`]);
  assert.deepEqual(withHead(store, "via-tuples"), [`via-tuples ${peanoText(3)}`]);
  assert.deepEqual(withHead(store, "closure-pairs"), [`closure-pairs ${peanoText(9)}`]);
  console.log("PASS: counting acc rows read in an acc body");
}

console.log("ALL v2 acc tests passed");
