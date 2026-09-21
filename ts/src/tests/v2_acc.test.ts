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
import { frontier, markResolved, resolveMoments, unresolvedMoments } from "../v2/moment-walk.js";
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
  assert.match(err(`#acc bar : e\n#agg bar -> sum`), /already has a '#agg'/);
  assert.match(err(`#agg q -> sum\n#acc bar : e\nfoo X, q X -> N / bar X`), /cannot read '#agg q'/);
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
  assert.match(bad(`#acc bar : e\nfoo X / bar X\nbar X -> N, ^seen N`), /is an acc relation/);
  assert.match(bad(`#acc bar : e\nfoo X / bar Y`), /head variable 'Y' is not bound/);
  assert.match(bad(`#acc bar : e\nfoo X / bar X\n?C, !(bar C)`), /inside a '!\(...\)' block/);
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

pick, ^opt x, ^opt y

pick, ?${actor} C, ~choice C, !opt C

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

// ===== 10) Reactive read inside an acc body =================================
{
  const { store, status } = runFixpoint(ok(`
#reactive hp -> sum
#acc low : e

hp -> N, small N / low me
#js-def small +N { if (N < 5) yield []; }

~game
  ~a; ~c

a, +hp -> 3

c, low X, ^low-c X
`));
  assert.equal(status.kind, "done");
  assert.deepEqual(withHead(store, "low-c"), ["low-c me"]);
  console.log("PASS: a #reactive value can be read inside an acc body");
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
  const handler = accHandler(compileAcc(program), program.schema, new Map(), new Map());
  for (let guard = 0; guard < 50; guard++) {
    const U = unresolvedMoments(s);
    if (U.length === 0) break;
    const F = frontier(s, U);
    markResolved(s, F);
    resolveMoments(s, [handler], F);
  }
  const dmg = s.tuples
    .filter((t) => rt(s, t.atom.terms[0]!) === "damage")
    .map((t) => `${ra(s, t.atom)} @${rt(s, t.l)}`)
    .sort();
  assert.deepEqual(dmg, ["damage me 3 @m1", "damage me 4 @m2", "damage me 7 @j"]);
  console.log("PASS: store-level handler writes rows at each input moment and their join");
}

console.log("ALL v2 acc tests passed");
