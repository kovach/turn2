// Moment-lattice mode (store.ts "Moment lattice"): max/min of incomparable
// moments build canonical, wired lattice-node moments instead of failing.
import assert from "node:assert/strict";
import {
  addOrder,
  comparable,
  createStore,
  intern,
  latticeMax,
  latticeMin,
  lessEq,
  lessThan,
  tokenOf,
  type Store,
} from "../v2/store.js";
import type { Term } from "../v2/term.js";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { renderTermShallow } from "../v2/print.js";
import { frontier, unresolvedMoments } from "../v2/moment-walk.js";

function moments(s: Store, ...names: string[]): Term[] {
  return names.map((n) => intern(s, { tag: "Symbol", name: n }));
}
const tok = (s: Store, t: Term) => tokenOf(s, t);

// 1) comparable args collapse; units and absorbing sentinels
{
  const s = createStore({ lattice: true });
  const [a, b] = moments(s, "a", "b");
  addOrder(s, a!, b!);
  assert.equal(tok(s, latticeMax(s, a!, b!)), tok(s, b!));
  assert.equal(tok(s, latticeMin(s, a!, b!)), tok(s, a!));
  assert.equal(tok(s, latticeMax(s, s.bot, a!)), tok(s, a!));
  assert.equal(tok(s, latticeMin(s, s.top, a!)), tok(s, a!));
  assert.equal(tok(s, latticeMax(s, s.top, a!)), s.topTok);
  assert.equal(tok(s, latticeMin(s, s.bot, a!)), s.botTok);
  assert.equal(s.latticeNodes.size, 0);
  console.log("PASS: comparable max/min collapse; bot/top units");
}

// 2) a join of incomparable moments: canonical, flattened, ordered exactly
{
  const s = createStore({ lattice: true });
  const [a, b, c, d] = moments(s, "a", "b", "c", "d");
  addOrder(s, a!, c!);
  addOrder(s, b!, c!);
  const j = latticeMax(s, a!, b!);
  assert.equal(tok(s, latticeMax(s, b!, a!)), tok(s, j), "argument order does not matter");
  assert.equal(tok(s, latticeMax(s, j, a!)), tok(s, j), "absorbs its own element");
  assert(lessThan(s, a!, j) && lessThan(s, b!, j), "elements strictly below");
  assert(lessThan(s, j, c!), "below the common upper bound c");
  assert(!comparable(s, j, d!), "unrelated to d");
  // Wired: the walk sees a, b as predecessors and c as a successor.
  assert.deepEqual([...s.orderBwd.get(tok(s, j))!].sort(), [tok(s, a!), tok(s, b!)].sort());
  assert(s.orderFwd.get(tok(s, j))!.has(tok(s, c!)));
  // Flattening: max(max(a, b), d) is the three-element join, above j.
  const j3 = latticeMax(s, j, d!);
  assert.equal(s.latticeNodes.get(tok(s, j3))!.elems.length, 3);
  assert(lessThan(s, j, j3), "older join is wired below the wider one");
  assert(s.orderBwd.get(tok(s, j3))!.has(tok(s, j)));
  console.log("PASS: join is canonical, flattened, and wired");
}

// 3) a meet: below each element, above their common lower bounds; asserting
// after it stays conjunctive (it does not order anything after an element)
{
  const s = createStore({ lattice: true });
  const [x, r1, r2] = moments(s, "x", "r1", "r2");
  addOrder(s, x!, r1!);
  addOrder(s, x!, r2!);
  const m = latticeMin(s, r1!, r2!);
  assert(lessThan(s, m, r1!) && lessThan(s, m, r2!));
  assert(lessThan(s, x!, m), "common lower bound x is below the meet");
  assert(s.orderBwd.get(tok(s, m))!.has(tok(s, x!)));
  const [l] = moments(s, "l");
  addOrder(s, m, l!);
  assert(lessThan(s, x!, l!));
  assert(!comparable(s, r1!, l!) && !comparable(s, r2!, l!), "no disjunction: l unrelated to r1, r2");
  // A moment placed below the meet is below both elements.
  const [y] = moments(s, "y");
  addOrder(s, y!, m);
  assert(lessEq(s, y!, r1!) && lessEq(s, y!, r2!));
  console.log("PASS: meet is wired between common lower bounds and its elements");
}

// 4) the walk frontier treats a join as resolvable after its elements
{
  const s = createStore({ lattice: true });
  const [a, b] = moments(s, "a", "b");
  addOrder(s, s.bot, a!); // registers a, b as moments (bot edges are implicit)
  addOrder(s, s.bot, b!);
  const j = latticeMax(s, a!, b!);
  s.resolved.add(s.botTok);
  const f = frontier(s, unresolvedMoments(s));
  assert(f.includes(tok(s, a!)) && f.includes(tok(s, b!)));
  assert(!f.includes(tok(s, j)), "join waits for its elements");
  s.resolved.add(tok(s, a!));
  s.resolved.add(tok(s, b!));
  assert(frontier(s, unresolvedMoments(s)).includes(tok(s, j)));
  console.log("PASS: moment walk orders a join after its elements");
}

// 5) end to end: facts from sibling firings join only in lattice mode
{
  const src = `~setup
setup, +n a
setup, +n b
n X, +pin X
pin A, pin B, +pair A B
`;
  const pairs = (lattice: boolean): string[] => {
    const p = parse(src);
    if ("message" in p) throw new Error(p.message);
    const { store, status } = runFixpoint(p, 200, 5000, { lattice });
    assert.equal(status.kind, "done");
    return store.tuples
      .filter((t) => renderTermShallow(store, t.atom.terms[0]!) === "pair")
      .map((t) => t.atom.terms.slice(1, 3).map((x) => renderTermShallow(store, x)).join(" "))
      .sort();
  };
  assert.deepEqual(pairs(false), ["a a", "b b"]);
  assert.deepEqual(pairs(true), ["a a", "a b", "b a", "b b"]);
  console.log("PASS: sibling-fact join fires only in lattice mode");
}

console.log("ALL v2 lattice tests passed");
