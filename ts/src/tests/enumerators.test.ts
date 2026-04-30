import assert from "node:assert/strict";
import {
  ancestorsOf,
  descendantsOf,
  emptyRefStore,
  idKey,
  insertRow,
  addParentChild,
  addBeforeAfter,
  successorsOf,
  predecessorsOf,
  overlapsOf,
  priorOf,
  type RefStore,
} from "../refstore.js";
import { sym } from "../types.js";
import { createHashcons, hashconsAtom, hashconsTerm } from "../hashcons.js";
import type { NodeRow } from "../refstore.js";

// Build a small store: parent P containing two children C1, C2, with a
// `before:after(C1, C2)` edge between siblings, plus a sibling root R
// disjoint from P. Used by all the enumerator tests.
function buildFixture() {
  const hc = createHashcons();
  const store = emptyRefStore(hc);
  const P = hashconsTerm(sym("P"), hc);
  const C1 = hashconsTerm(sym("C1"), hc);
  const C2 = hashconsTerm(sym("C2"), hc);
  const R = hashconsTerm(sym("R"), hc);
  const mkRow = (id: typeof P, head: string): NodeRow => ({
    tag: "Assert",
    id,
    atom: hashconsAtom({ terms: [sym(head)] }, hc),
    gen: 0,
  });
  insertRow(store, mkRow(P, "p"), hc);
  insertRow(store, mkRow(C1, "c"), hc);
  insertRow(store, mkRow(C2, "c"), hc);
  insertRow(store, mkRow(R, "r"), hc);
  addParentChild(store, P, C1, hc);
  addParentChild(store, P, C2, hc);
  addBeforeAfter(store, C1, C2, hc);
  return { hc, store, P: idKey(P, hc), C1: idKey(C1, hc), C2: idKey(C2, hc), R: idKey(R, hc) };
}

function asArray(s: Set<number>): number[] {
  return [...s].sort((a, b) => a - b);
}

// --- descendants / ancestors (sanity) ---
{
  const { store, P, C1, C2, R } = buildFixture();
  assert.deepEqual(asArray(descendantsOf(store, P)), asArray(new Set([P, C1, C2])));
  assert.deepEqual(asArray(ancestorsOf(store, C1)), asArray(new Set([C1, P])));
  assert.deepEqual(asArray(descendantsOf(store, R)), [R]);
  console.log("PASS: descendants/ancestors sanity");
}

// --- successorsOf: forward through beforeAfter, lifted by descendants ---
{
  const { store, P, C1, C2 } = buildFixture();
  // C1 has beforeAfter edge to C2; lifting through descendants of C2
  // gives just C2 (no children). C2 has no successors.
  assert.deepEqual(asArray(successorsOf(store, C1)), [C2]);
  assert.deepEqual(asArray(successorsOf(store, C2)), []);
  // P has no direct beforeAfter edges, but C1 (its descendant) does —
  // ancestorsOf(P) is just {P}, and P has no outgoing beforeAfter,
  // so successorsOf(P) is empty. (Lifting only happens on the *b*
  // side, not the *a* side; that matches beforeAfter()'s definition.)
  assert.deepEqual(asArray(successorsOf(store, P)), []);
  console.log("PASS: successorsOf");
}

// --- predecessorsOf: backward through afterBefore, lifted by descendants ---
{
  const { store, C1, C2 } = buildFixture();
  // C2's predecessor is C1 (via the raw edge), lifted by C1's descendants
  // (C1 has none).
  assert.deepEqual(asArray(predecessorsOf(store, C2)), [C1]);
  assert.deepEqual(asArray(predecessorsOf(store, C1)), []);
  console.log("PASS: predecessorsOf");
}

// --- overlapsOf: nodes containing some descendant of the bound side ---
{
  const { store, P, C1, C2, R } = buildFixture();
  // overlaps with P: P, C1, C2 (descendants), and ancestors of any
  // descendant — for the disjoint subtree, none.
  assert.deepEqual(asArray(overlapsOf(store, P)), asArray(new Set([P, C1, C2])));
  // overlaps with C1: ancestors of C1 (P) plus self.
  assert.deepEqual(asArray(overlapsOf(store, C1)), asArray(new Set([C1, P])));
  // overlaps with R: just R (disjoint subtree).
  assert.deepEqual(asArray(overlapsOf(store, R)), [R]);
  console.log("PASS: overlapsOf");
}

// --- priorOf: union of predecessors and strict descendants of b ---
{
  const { store, C2, P, C1 } = buildFixture();
  // priorOf(C2): predecessors {C1} ∪ strict descendants of C2 {} = {C1}.
  assert.deepEqual(asArray(priorOf(store, C2)), [C1]);
  // priorOf(P): predecessors {} ∪ strict descendants {C1, C2}.
  assert.deepEqual(asArray(priorOf(store, P)), asArray(new Set([C1, C2])));
  console.log("PASS: priorOf");
}

console.log("All enumerator tests passed.");
