import assert from "node:assert/strict";
import { findPath, nodeAt, insertAt, nodesBefore, isTemporallyBefore } from "./tree.js";
import { sym, vari, node } from "./types.js";

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

console.log("All tree tests passed.");
