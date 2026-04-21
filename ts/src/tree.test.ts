import assert from "node:assert/strict";
import { findPath, nodeAt, insertAt, nodesBefore, isTemporallyBefore, fringe, unionFringe, intersectionFringe } from "./tree.js";
import { sym, vari, node, fact } from "./types.js";

//   root (id "r")
//     a  (id "a")
//       p (id "p")
//       q (id "q")
//     b  (id "b")
const tree = node(sym("r"), [sym("root")], [
  node(sym("a"), [sym("a")], [
    node(sym("p"), [sym("p")]),
    node(sym("q"), [sym("q")]),
  ]),
  node(sym("b"), [sym("b")]),
]);

// --- findPath ---

assert.deepEqual(findPath(sym("r"), tree), []);
assert.deepEqual(findPath(sym("a"), tree), [0]);
assert.deepEqual(findPath(sym("b"), tree), [1]);
assert.deepEqual(findPath(sym("p"), tree), [0, 0]);
assert.deepEqual(findPath(sym("q"), tree), [0, 1]);
assert.equal(findPath(sym("missing"), tree), null);
console.log("PASS: findPath");

// variable id
const vTree = node(vari("X"), [sym("x")]);
assert.deepEqual(findPath(vari("X"), vTree), []);
assert.equal(findPath(sym("X"), vTree), null);
console.log("PASS: findPath variable id");

// --- nodeAt ---

assert.equal(nodeAt(tree, [])?.id, tree.id);
assert.deepEqual(nodeAt(tree, [0])?.id, sym("a"));
assert.deepEqual(nodeAt(tree, [1])?.id, sym("b"));
assert.deepEqual(nodeAt(tree, [0, 0])?.id, sym("p"));
assert.deepEqual(nodeAt(tree, [0, 1])?.id, sym("q"));
assert.equal(nodeAt(tree, [2]), null);
assert.equal(nodeAt(tree, [0, 5]), null);
console.log("PASS: nodeAt");

// --- insertAt ---

const fresh = node(sym("r"), [sym("root")], [
  node(sym("a"), [sym("a")]),
]);

const newChild = node(sym("c"), [sym("c")]);
insertAt(fresh, [0], newChild);
assert.equal(fresh.children[0]!.children.length, 1);
assert.deepEqual(fresh.children[0]!.children[0]!.id, sym("c"));
console.log("PASS: insertAt child");

insertAt(fresh, [], node(sym("b"), [sym("b")]));
assert.equal(fresh.children.length, 2);
assert.deepEqual(fresh.children[1]!.id, sym("b"));
console.log("PASS: insertAt root level");

assert.throws(() => insertAt(fresh, [99], node(sym("x"), [])), /no node at path/);
console.log("PASS: insertAt bad path throws");

// --- nodesBefore ---
// Matches the example in overview.md:
//   root
//     a
//       b
//     c
//     d
//       e
{
  const nb = node(sym("b"), [sym("b")]);
  const na = node(sym("a"), [sym("a")], [nb]);
  const nc = node(sym("c"), [sym("c")]);
  const ne = node(sym("e"), [sym("e")]);
  const nd = node(sym("d"), [sym("d")], [ne]);
  const nroot = node(sym("root"), [sym("root")], [na, nc, nd]);

  assert.deepEqual(nodesBefore(nroot, na).map((n) => n.id), []);
  assert.deepEqual(nodesBefore(nroot, nb).map((n) => n.id), []);
  assert.deepEqual(nodesBefore(nroot, nc).map((n) => n.id), [sym("a"), sym("b")]);
  assert.deepEqual(nodesBefore(nroot, nd).map((n) => n.id), [sym("a"), sym("b"), sym("c")]);
  assert.deepEqual(nodesBefore(nroot, ne).map((n) => n.id), [sym("a"), sym("b"), sym("c")]);
  console.log("PASS: nodesBefore");
}

// --- isTemporallyBefore ---
// Matches overview tree:  root / a{b} / c / d{e}
// Paths: a=[0] b=[0,0] c=[1] d=[2] e=[2,0]
// Expected < relation (transitive closure of a<c, b<c, c<d, c<e)
{
  const a = [0], b = [0, 0], c = [1], d = [2], e = [2, 0];
  // positive cases
  assert.equal(isTemporallyBefore(a, c), true);
  assert.equal(isTemporallyBefore(b, c), true);
  assert.equal(isTemporallyBefore(c, d), true);
  assert.equal(isTemporallyBefore(c, e), true);
  assert.equal(isTemporallyBefore(a, d), true);
  assert.equal(isTemporallyBefore(b, e), true);
  // ancestor/descendant excluded
  assert.equal(isTemporallyBefore(a, b), false); // a is ancestor of b
  assert.equal(isTemporallyBefore(d, e), false); // d is ancestor of e
  assert.equal(isTemporallyBefore(b, a), false);
  // after cases
  assert.equal(isTemporallyBefore(c, a), false);
  assert.equal(isTemporallyBefore(d, c), false);
  // equal
  assert.equal(isTemporallyBefore(a, a), false);
  // root
  assert.equal(isTemporallyBefore(a, []), false);
  assert.equal(isTemporallyBefore([], a), false);
  console.log("PASS: isTemporallyBefore");
}

// --- fringe tests ---
// Tree from overview.md:
//   + root
//     + card c
//     + card:name c n
//     + card c2
{
  const c = sym("c");
  const n = sym("n");
  const c2 = sym("c2");
  const fringeTree = fact(sym("root"), [sym("root")], [
    fact(sym("id1"), [sym("card"), c]),
    fact(sym("id2"), [sym("card:name"), c, n]),
    fact(sym("id3"), [sym("card"), c2]),
  ]);

  // fringe of c is nodes containing c: (card c) and (card:name c n)
  const fringeC = [...fringe(c, fringeTree)];
  assert.equal(fringeC.length, 2);
  assert.deepEqual(fringeC[0]!.literal.atom.terms, [sym("card"), c]);
  assert.deepEqual(fringeC[1]!.literal.atom.terms, [sym("card:name"), c, n]);
  console.log("PASS: fringe");

  // fringe of n is just (card:name c n)
  const fringeN = [...fringe(n, fringeTree)];
  assert.equal(fringeN.length, 1);
  assert.deepEqual(fringeN[0]!.literal.atom.terms, [sym("card:name"), c, n]);
  console.log("PASS: fringe single match");

  // union-fringe of {c, n} is the union: both nodes with c plus the one with n
  const union = [...unionFringe([c, n], fringeTree)];
  assert.equal(union.length, 2); // (card c) has c, (card:name c n) has both
  console.log("PASS: unionFringe");

  // intersection-fringe of {c, n} is nodes containing BOTH c and n
  const intersection = [...intersectionFringe([c, n], fringeTree)];
  assert.equal(intersection.length, 1);
  assert.deepEqual(intersection[0]!.literal.atom.terms, [sym("card:name"), c, n]);
  console.log("PASS: intersectionFringe");

  // intersection-fringe of {c, c2} is empty (no node contains both)
  const intersectionEmpty = [...intersectionFringe([c, c2], fringeTree)];
  assert.equal(intersectionEmpty.length, 0);
  console.log("PASS: intersectionFringe empty");
}

console.log("All tree tests passed.");
