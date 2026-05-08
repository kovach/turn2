import assert from "node:assert/strict";
import {
  addOrder,
  addTuple,
  comparable,
  createStore,
  intervalContains,
  intervalsOverlap,
  intern,
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

console.log("ALL v2 store tests passed");
