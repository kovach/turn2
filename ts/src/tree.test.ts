import assert from "node:assert/strict";
import { findPath, nodeAt, insertAt, deepestAncestorImage } from "./tree.js";
import { sym, vari, node } from "./types.js";
import type { Substitution } from "./types.js";

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

// --- deepestAncestorImage ---

// Pattern:  R -> C -> N  (linear chain, all variable ids)
// Reference: r1 -> r2 -> r3 -> r4  (linear chain, symbol ids)
// Subst: R=r1, C=r3, N=r4
// For node N: ancestors are R(→r1,[]), C(→r3,[0,0]), N(→r4,[0,0,0])
// Deepest is r4.
{
  const pattern = node(vari("R"), [sym("root")], [
    node(vari("C"), [sym("c")], [
      node(vari("N"), [sym("n")]),
    ]),
  ]);
  const reference = node(sym("r1"), [sym("root")], [
    node(sym("r2"), [sym("r2")], [
      node(sym("r3"), [sym("r3")], [
        node(sym("r4"), [sym("r4")]),
      ]),
    ]),
  ]);
  const subst: Substitution = new Map([
    ["R", sym("r1")],
    ["C", sym("r3")],
    ["N", sym("r4")],
  ]);

  const result = deepestAncestorImage(vari("N"), pattern, reference, subst);
  assert.deepEqual(result?.id, sym("r4"));
  console.log("PASS: deepestAncestorImage — deepest of chain");
}

// If only the root maps, return the root image.
{
  const pattern = node(vari("R"), [sym("root")], [
    node(sym("fixed"), [sym("c")], [   // symbol id, won't be in reference
      node(vari("N"), [sym("n")]),
    ]),
  ]);
  const reference = node(sym("r1"), [sym("root")], [
    node(sym("r2"), [sym("r2")]),
  ]);
  const subst: Substitution = new Map([
    ["R", sym("r1")],
    ["N", sym("r2")],  // N maps to r2 but its parent "fixed" doesn't exist in ref
  ]);

  // Ancestors of N: R→r1([]), fixed→no match, N→r2([0])
  // Deepest found: r2 at depth 1
  const result = deepestAncestorImage(vari("N"), pattern, reference, subst);
  assert.deepEqual(result?.id, sym("r2"));
  console.log("PASS: deepestAncestorImage — skips unmapped ancestors");
}

// Node not in pattern → null.
{
  const pattern = node(sym("r"), [sym("root")]);
  const reference = node(sym("r"), [sym("root")]);
  const result = deepestAncestorImage(sym("missing"), pattern, reference, new Map());
  assert.equal(result, null);
  console.log("PASS: deepestAncestorImage — node not in pattern returns null");
}

console.log("All tree tests passed.");
