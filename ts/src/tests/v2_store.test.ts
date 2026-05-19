import assert from "node:assert/strict";
import {
  addOrder,
  addTuple,
  comparable,
  createStore,
  intervalContains,
  intervalsOverlap,
  intern,
  leastUpperBound,
  lessThan,
} from "../v2/store.js";
import type { Term } from "../types.js";

function sym(name: string): Term { return { tag: "Symbol", name }; }

// 1) bot/top sentinels
{
  const s = createStore();
  assert(lessThan(s, s.bot, s.top));
  assert(!lessThan(s, s.top, s.bot));
  assert(comparable(s, s.bot, s.top));
  assert(!lessThan(s, s.bot, s.bot));
  console.log("PASS: bot/top sentinels");
}

// 2) bot < anything, anything < top
{
  const s = createStore();
  const a = intern(s, sym("a"));
  assert(lessThan(s, s.bot, a));
  assert(lessThan(s, a, s.top));
  assert(!lessThan(s, a, s.bot));
  assert(!lessThan(s, s.top, a));
  console.log("PASS: bot/top universal");
}

// 3) explicit order edges + transitivity
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  const c = intern(s, sym("c"));
  addOrder(s, a, b);
  addOrder(s, b, c);
  assert(lessThan(s, a, b));
  assert(lessThan(s, a, c));
  assert(lessThan(s, b, c));
  assert(!lessThan(s, c, a));
  assert(comparable(s, a, c));
  console.log("PASS: explicit order + transitive");
}

// 4) incomparable moments
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  assert(!comparable(s, a, b));
  assert(!lessThan(s, a, b));
  console.log("PASS: incomparable when no edges");
}

// 5) overlap requires comparability
{
  const s = createStore();
  const l1 = intern(s, sym("l1"));
  const r1 = intern(s, sym("r1"));
  const l2 = intern(s, sym("l2"));
  const r2 = intern(s, sym("r2"));
  // No edges — incomparable -> no overlap.
  assert(!intervalsOverlap(s, l1, r1, l2, r2));
  // bot/top are universally comparable
  assert(intervalsOverlap(s, s.bot, s.top, s.bot, s.top));
  console.log("PASS: overlap requires comparability");
}

// 6) overlap geometry (with comparability ensured by chain l1<r1<l2<r2 — disjoint)
{
  const s = createStore();
  const l1 = intern(s, sym("l1"));
  const r1 = intern(s, sym("r1"));
  const l2 = intern(s, sym("l2"));
  const r2 = intern(s, sym("r2"));
  addOrder(s, l1, r1);
  addOrder(s, r1, l2);
  addOrder(s, l2, r2);
  // (l1,r1) is entirely before (l2,r2): does NOT overlap because l2 > r1.
  assert(!intervalsOverlap(s, l1, r1, l2, r2));
  console.log("PASS: disjoint intervals don't overlap");
}

// 7) containment
{
  const s = createStore();
  const ol = intern(s, sym("ol"));
  const orr = intern(s, sym("or"));
  const il = intern(s, sym("il"));
  const ir = intern(s, sym("ir"));
  addOrder(s, ol, il);
  addOrder(s, il, ir);
  addOrder(s, ir, orr);
  assert(intervalContains(s, ol, orr, il, ir));
  assert(!intervalContains(s, il, ir, ol, orr));
  console.log("PASS: containment with chain");
}

// 8) tuple insert + index
{
  const s = createStore();
  const atom = { terms: [intern(s, sym("foo")), intern(s, sym("a"))] };
  const t = addTuple(s, atom, s.bot, s.top);
  assert.equal(s.tuples.length, 1);
  assert.deepEqual(s.byHead.get("foo"), [0]);
  console.log("PASS: tuple insert + index");
}

// 9) leastUpperBound — empty and singleton.
{
  const s = createStore();
  const a = intern(s, sym("a"));
  assert.equal(leastUpperBound(s, []), s.bot);
  assert.equal(leastUpperBound(s, [a]), a);
  console.log("PASS: lub of empty is bot; lub of singleton is itself");
}

// 10) leastUpperBound — comparable pair: returns the upper of the two.
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  addOrder(s, a, b);
  assert.equal(leastUpperBound(s, [a, b]), b);
  assert.equal(leastUpperBound(s, [b, a]), b);
  // Equal terms in the input.
  assert.equal(leastUpperBound(s, [a, a]), a);
  console.log("PASS: lub of comparable pair returns the upper");
}

// 11) leastUpperBound — incomparable pair with one shared descendant.
//      a   b
//       \ /
//        c
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  const c = intern(s, sym("c"));
  addOrder(s, a, c);
  addOrder(s, b, c);
  assert.equal(leastUpperBound(s, [a, b]), c);
  console.log("PASS: lub of incomparable pair with shared descendant returns it");
}

// 12) leastUpperBound — incomparable pair with no shared descendant: top
//      (top is the only moment universally above both).
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  // Touch them with orderFwd so they're recorded as moments.
  addOrder(s, a, intern(s, sym("a-up")));
  addOrder(s, b, intern(s, sym("b-up")));
  assert.equal(leastUpperBound(s, [a, b]), s.top);
  console.log("PASS: lub falls back to top when no in-store common descendant");
}

// 13) leastUpperBound — two incomparable minimal upper bounds → null.
//      a       b
//      |\     /|
//      | \   / |
//      |  \ /  |
//      c   X   d   (c and d both above {a,b}; c, d incomparable)
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  const c = intern(s, sym("c"));
  const d = intern(s, sym("d"));
  addOrder(s, a, c);
  addOrder(s, a, d);
  addOrder(s, b, c);
  addOrder(s, b, d);
  // c and d both upper bounds; neither below the other.
  assert.equal(leastUpperBound(s, [a, b]), null);
  console.log("PASS: lub returns null when ≥2 incomparable minimal upper bounds");
}

// 14) leastUpperBound — triple via fold. a < c, b < c, c < d.
{
  const s = createStore();
  const a = intern(s, sym("a"));
  const b = intern(s, sym("b"));
  const c = intern(s, sym("c"));
  const d = intern(s, sym("d"));
  addOrder(s, a, c);
  addOrder(s, b, c);
  addOrder(s, c, d);
  assert.equal(leastUpperBound(s, [a, b, c]), c);
  assert.equal(leastUpperBound(s, [a, b, d]), d);
  console.log("PASS: lub folds correctly over a triple");
}

// 15) leastUpperBound — bot/top edge cases.
{
  const s = createStore();
  const a = intern(s, sym("a"));
  addOrder(s, a, intern(s, sym("a-up"))); // record `a` as a moment
  assert.equal(leastUpperBound(s, [s.bot, a]), a);
  assert.equal(leastUpperBound(s, [a, s.top]), s.top);
  assert.equal(leastUpperBound(s, [s.bot, s.bot]), s.bot);
  console.log("PASS: lub handles bot/top as identity/absorber");
}

console.log("ALL v2 store tests passed");
