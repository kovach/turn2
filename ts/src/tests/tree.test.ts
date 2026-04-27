import assert from "node:assert/strict";
import { isTemporallyBefore, fringe, unionFringe, intersectionFringe, collectPositiveNodes } from "../tree.js";
import { sym, fact } from "../types.js";
import { createHashcons } from "../hashcons.js";
import type { Tree } from "../types.js";

const hc = createHashcons();

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

// --- collectPositiveNodes ---
// Pattern: - root / + a / - b / + c
// positives: a and c, parents are root and b respectively, paths [0] and [1, 0].
{
  const patC: Tree = { tag: "Assert", id: sym("c"), atom: { terms: [sym("c")] }, children: [] };
  const patB: Tree = { tag: "Match", constraint: "any", id: sym("b"), atom: { terms: [sym("b")] }, children: [patC] };
  const patA: Tree = { tag: "Assert", id: sym("a"), atom: { terms: [sym("a")] }, children: [] };
  const patRoot: Tree = { tag: "Match", constraint: "any", id: sym("r"), atom: { terms: [] }, children: [patA, patB] };

  const positives = collectPositiveNodes(patRoot);
  assert.equal(positives.length, 2);
  assert.equal(positives[0]!.node, patA);
  assert.equal(positives[0]!.parent, patRoot);
  assert.deepEqual(positives[0]!.path, [0]);
  assert.equal(positives[1]!.node, patC);
  assert.equal(positives[1]!.parent, patB);
  assert.deepEqual(positives[1]!.path, [1, 0]);
  console.log("PASS: collectPositiveNodes");
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
  const fringeC = [...fringe(c, fringeTree, hc)];
  assert.equal(fringeC.length, 2);
  assert.deepEqual(fringeC[0]!.atom.terms, [sym("card"), c]);
  assert.deepEqual(fringeC[1]!.atom.terms, [sym("card:name"), c, n]);
  console.log("PASS: fringe");

  // fringe of n is just (card:name c n)
  const fringeN = [...fringe(n, fringeTree, hc)];
  assert.equal(fringeN.length, 1);
  assert.deepEqual(fringeN[0]!.atom.terms, [sym("card:name"), c, n]);
  console.log("PASS: fringe single match");

  // union-fringe of {c, n} is the union: both nodes with c plus the one with n
  const union = [...unionFringe([c, n], fringeTree, hc)];
  assert.equal(union.length, 2); // (card c) has c, (card:name c n) has both
  console.log("PASS: unionFringe");

  // intersection-fringe of {c, n} is nodes containing BOTH c and n
  const intersection = [...intersectionFringe([c, n], fringeTree, hc)];
  assert.equal(intersection.length, 1);
  assert.deepEqual(intersection[0]!.atom.terms, [sym("card:name"), c, n]);
  console.log("PASS: intersectionFringe");

  // intersection-fringe of {c, c2} is empty (no node contains both)
  const intersectionEmpty = [...intersectionFringe([c, c2], fringeTree, hc)];
  assert.equal(intersectionEmpty.length, 0);
  console.log("PASS: intersectionFringe empty");
}

console.log("All tree tests passed.");
