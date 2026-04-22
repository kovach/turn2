import assert from "node:assert/strict";
import { collectMatches as unifyTree, unifyTerms, substTerm } from "./unify.js";
import { sym, vari, node, fact, root, before, equal, newTrail } from "./types.js";
import { createHashcons, expandTerm } from "./hashcons.js";
import type { Term, Atom } from "./types.js";

function substStr(s: Map<string, Term>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of s) {
    out[k] = v.tag === "Symbol" ? v.name : v.tag === "Variable" ? v.name : "?";
  }
  return out;
}

// 1. Ground exact match — 1 result, empty substitution
{
  const pattern = root([node(sym("n"), [sym("foo")])]);
  const reference = root([fact(sym("n"), [sym("foo")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.size, 0);
  console.log("PASS 1: ground exact match");
}

// 2. Variable binding in atom terms
{
  const pattern = root([node(vari("N"), [vari("X")])]);
  const reference = root([fact(sym("r"), [sym("foo")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { N: "r", X: "foo" });
  console.log("PASS 2: variable binding");
}

// 3. Same variable used twice → forces equality
{
  const pattern = root([node(sym("n"), [vari("X"), vari("X")])]);
  const ref1 = root([fact(sym("n"), [sym("foo"), sym("foo")])]);
  const ref2 = root([fact(sym("n"), [sym("foo"), sym("bar")])]);
  assert.equal(unifyTree(pattern, ref1).length, 1);
  assert.equal(unifyTree(pattern, ref2).length, 0);
  console.log("PASS 3: same variable used twice");
}

// 4. Variable id → bound to matched reference node's id
{
  const pattern = root([node(vari("N"), [sym("foo")])]);
  const reference = root([fact(sym("ref-id"), [sym("foo")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { N: "ref-id" });
  console.log("PASS 4: variable id binding");
}

// 5. Non-adjacent descendant — pattern child matches ref grandchild
{
  const pattern = root([node(vari("P"), [sym("foo")], [node(vari("C"), [sym("baz")])])]);
  const reference = root([fact(sym("root"), [sym("foo")], [
    fact(sym("mid"), [sym("bar")], [fact(sym("gc"), [sym("baz")])]),
  ])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { P: "root", C: "gc" });
  console.log("PASS 5: non-adjacent descendant");
}

// 6. Multiple results — pattern matches multiple ref nodes
{
  const pattern = root([node(vari("N"), [sym("foo")])]);
  const reference = root([fact(sym("root"), [sym("foo")], [
    fact(sym("c1"), [sym("foo")]),
    fact(sym("c2"), [sym("foo")]),
  ])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 3); // root + 2 children
  console.log("PASS 6: multiple results");
}

// 7. Sibling pattern children match sibling reference nodes
{
  const pattern = root([node(sym("root"), [sym("root")], [
    node(vari("A"), [sym("a")]),
    node(vari("B"), [sym("b")]),
  ])]);
  const reference = root([fact(sym("root"), [sym("root")], [
    fact(sym("s1"), [sym("a")]),
    fact(sym("s2"), [sym("b")]),
  ])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { A: "s1", B: "s2" });
  console.log("PASS 7: sibling pattern children match sibling ref nodes");
}

// 8. Wildcard matches anything without binding
{
  const pattern = root([node(sym("n"), [sym("f"), { tag: "Wildcard" }, { tag: "Wildcard" }])]);
  const reference = root([fact(sym("n"), [sym("f"), sym("x"), sym("y")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.size, 0); // nothing bound
  console.log("PASS 8: wildcard matches without binding");
}

// 9. Two wildcards match two different values
{
  const pattern = root([node(sym("n"), [{ tag: "Wildcard" }, { tag: "Wildcard" }])]);
  const ref1 = root([fact(sym("n"), [sym("a"), sym("b")])]);
  const ref2 = root([fact(sym("n"), [sym("a"), sym("a")])]);
  assert.equal(unifyTree(pattern, ref1).length, 1);
  assert.equal(unifyTree(pattern, ref2).length, 1);
  console.log("PASS 9: two wildcards match distinct or equal values");
}

// 10. Pattern ancestry must map to reference ancestry (not any path direction)
{
  const pattern = root([node(vari("F"), [sym("foo")], [node(vari("B"), [sym("bar")])])]);
  // reference has (bar (foo)) — pattern's child relation is reversed here
  const reference = root([fact(sym("r1"), [sym("bar")], [fact(sym("r2"), [sym("foo")])])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 0);
  console.log("PASS 10: ancestry direction is enforced");
}

// 11. Pattern parent+child cannot both map to the same single reference node
{
  const pattern = root([node(vari("A"), [sym("foo")], [node(vari("B"), [sym("foo")])])]);
  const reference = root([fact(sym("r"), [sym("foo")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 0);
  console.log("PASS 11: strict descendant required between pattern parent and child");
}

// 12. Before: matches temporally-before siblings of the parent image
{
  // pattern:
  //   - turn A
  //     < move X
  const pattern = root([
    node(vari("T"), [sym("turn"), vari("A")], [
      { id: vari("M"), literal: { literalType: before(), atom: { terms: [sym("move"), vari("X")] } }, children: [] },
    ]),
  ]);
  // reference:
  //   + root / + move a / + move b / + turn t
  const reference = root([
    fact(sym("ma"), [sym("move"), sym("a")]),
    fact(sym("mb"), [sym("move"), sym("b")]),
    fact(sym("t"), [sym("turn"), sym("t")]),
  ]);
  const results = unifyTree(pattern, reference);
  // 2 substs: (T=t, A=t, M=ma, X=a) and (T=t, A=t, M=mb, X=b)
  assert.equal(results.length, 2);
  const rows = results.map(substStr).sort((a, b) => (a["M"]! < b["M"]! ? -1 : 1));
  assert.deepEqual(rows[0], { T: "t", A: "t", M: "ma", X: "a" });
  assert.deepEqual(rows[1], { T: "t", A: "t", M: "mb", X: "b" });
  console.log("PASS 12: Before matches temporally-before siblings");
}

// 13. Before: nothing before first sibling
{
  // pattern: - turn A / < move X
  // reference: + turn t  (no preceding siblings)
  const pattern = root([
    node(vari("T"), [sym("turn"), vari("A")], [
      { id: vari("M"), literal: { literalType: before(), atom: { terms: [sym("move"), vari("X")] } }, children: [] },
    ]),
  ]);
  const reference = root([fact(sym("t"), [sym("turn"), sym("t")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 0);
  console.log("PASS 13: Before with nothing before → no match");
}

// 14. Before: descendants of the parent's image are NOT before (ancestor excluded)
{
  // pattern: - turn A / < move X
  // reference: + turn t / + move a   (move is under turn, not before it)
  const pattern = root([
    node(vari("T"), [sym("turn"), vari("A")], [
      { id: vari("M"), literal: { literalType: before(), atom: { terms: [sym("move"), vari("X")] } }, children: [] },
    ]),
  ]);
  const reference = root([
    fact(sym("t"), [sym("turn"), sym("t")], [fact(sym("ma"), [sym("move"), sym("a")])]),
  ]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 0);
  console.log("PASS 14: Before excludes descendants of parent image");
}

// 15. Before at top level of pattern → nothing is before the root, no match
{
  const pattern = root([
    { id: vari("M"), literal: { literalType: before(), atom: { terms: [sym("move"), vari("X")] } }, children: [] },
  ]);
  const reference = root([fact(sym("ma"), [sym("move"), sym("a")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 0);
  console.log("PASS 15: Before at top level has no anchor → no match");
}

// 16. Before uses previous sibling as anchor, not parent
// pattern: - a / - c / < b   (Before should match things before c, not before a)
// reference: + a / + b / + c / + d
// b is before c, so < b should match
{
  const pattern = root([
    node(vari("A"), [sym("a")], [
      node(vari("C"), [sym("c")], []),
      { id: vari("B"), literal: { literalType: before(), atom: { terms: [sym("b")] } }, children: [] },
    ]),
  ]);
  const reference = root([
    fact(sym("ra"), [sym("a")], [
      fact(sym("rb"), [sym("b")]),
      fact(sym("rc"), [sym("c")]),
      fact(sym("rd"), [sym("d")]),
    ]),
  ]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { A: "ra", C: "rc", B: "rb" });
  console.log("PASS 16: Before uses previous sibling as anchor");
}

// 17. Before with no previous sibling falls back to parent
// pattern: - a / < b   (no sibling before <b, so anchor is parent a)
// reference: + a / + b / + c
// b is before a? No. So no match.
{
  const pattern = root([
    node(vari("A"), [sym("a")], [
      { id: vari("B"), literal: { literalType: before(), atom: { terms: [sym("b")] } }, children: [] },
    ]),
  ]);
  const reference = root([
    fact(sym("ra"), [sym("a")]),
    fact(sym("rb"), [sym("b")]),
    fact(sym("rc"), [sym("c")]),
  ]);
  const results = unifyTree(pattern, reference);
  // b is a sibling of a, and b is before a? No, b comes after a in child order
  // So no match
  assert.equal(results.length, 0);
  console.log("PASS 17: Before with no previous sibling falls back to parent anchor");
}

// 18. Before skips positive siblings when finding anchor
// pattern: - a / + x / < b   (+ x is positive, skip it, anchor is parent a)
// reference: + a / + b
{
  const pattern = root([
    node(vari("A"), [sym("a")], [
      fact(sym("x"), [sym("x")]),
      { id: vari("B"), literal: { literalType: before(), atom: { terms: [sym("b")] } }, children: [] },
    ]),
  ]);
  const reference = root([
    fact(sym("rb"), [sym("b")]),
    fact(sym("ra"), [sym("a")]),
  ]);
  const results = unifyTree(pattern, reference);
  // b is before a, so should match
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { A: "ra", B: "rb" });
  console.log("PASS 18: Before skips positive siblings when finding anchor");
}

// 19. Equal: unifies two terms
{
  const pattern = root([
    node(vari("A"), [sym("foo"), vari("X")], [
      { id: sym("eq"), literal: { literalType: equal(), atom: { terms: [vari("X"), sym("bar")] } }, children: [] },
    ]),
  ]);
  const reference = root([fact(sym("r1"), [sym("foo"), sym("bar")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 1);
  assert.deepEqual(substStr(results[0]!), { A: "r1", X: "bar" });
  console.log("PASS 19: Equal unifies two terms");
}

// 20. Equal: fails when terms don't unify
{
  const pattern = root([
    node(vari("A"), [sym("foo"), vari("X")], [
      { id: sym("eq"), literal: { literalType: equal(), atom: { terms: [vari("X"), sym("bar")] } }, children: [] },
    ]),
  ]);
  const reference = root([fact(sym("r1"), [sym("foo"), sym("baz")])]);
  const results = unifyTree(pattern, reference);
  assert.equal(results.length, 0);
  console.log("PASS 20: Equal fails when terms don't unify");
}

// 21. Equal: unifies two variables
{
  const pattern = root([
    node(vari("A"), [sym("pair"), vari("X"), vari("Y")], [
      { id: sym("eq"), literal: { literalType: equal(), atom: { terms: [vari("X"), vari("Y")] } }, children: [] },
    ]),
  ]);
  const ref1 = root([fact(sym("r1"), [sym("pair"), sym("a"), sym("a")])]);
  const ref2 = root([fact(sym("r2"), [sym("pair"), sym("a"), sym("b")])]);
  assert.equal(unifyTree(pattern, ref1).length, 1);
  assert.equal(unifyTree(pattern, ref2).length, 0);
  console.log("PASS 21: Equal unifies two variables");
}

// 22. Trail invariant: binding Variable ← Atom stores a Ref (hashconsed)
{
  const hc = createHashcons();
  const trail = newTrail();
  const a: Atom = { terms: [sym("id"), sym("r1"), sym("id2")] };
  const ok = unifyTerms(vari("V1"), { tag: "Atom", atom: a }, trail, hc);
  assert.equal(ok, true);
  const bound = substTerm(vari("V1"), trail);
  assert.equal(bound.tag, "Ref", "V1 binding must be a Ref, not a raw Atom");
  // Expanding the Ref recovers the original atom
  const expanded = expandTerm(bound, hc);
  assert.deepEqual(expanded, { tag: "Atom", atom: a });
  console.log("PASS 22: trail stores Ref (not raw Atom) for Variable ← Atom");
}

// 23. Trail invariant: inner bound variables are resolved before hashconsing
{
  const hc = createHashcons();
  const trail = newTrail();
  // V1 ← (id r1 id2)
  assert.equal(unifyTerms(vari("V1"), { tag: "Atom", atom: { terms: [sym("id"), sym("r1"), sym("id2")] } }, trail, hc), true);
  // V2 ← (id r2 V1) — V1 is bound, so V2's body must freeze V1's Ref
  assert.equal(unifyTerms(vari("V2"), { tag: "Atom", atom: { terms: [sym("id"), sym("r2"), vari("V1")] } }, trail, hc), true);
  const boundV2 = substTerm(vari("V2"), trail);
  assert.equal(boundV2.tag, "Ref");
  const expanded = expandTerm(boundV2, hc);
  assert.deepEqual(expanded, {
    tag: "Atom",
    atom: { terms: [sym("id"), sym("r2"), { tag: "Atom", atom: { terms: [sym("id"), sym("r1"), sym("id2")] } }] },
  });
  console.log("PASS 23: trail hashconses inner bound variables");
}

// 24. Trail invariant: binding an atom with free variables throws
{
  const hc = createHashcons();
  const trail = newTrail();
  assert.throws(
    () => unifyTerms(vari("V1"), { tag: "Atom", atom: { terms: [sym("f"), vari("Y")] } }, trail, hc),
    /free variable/,
  );
  console.log("PASS 24: binding Atom with free variable throws");
}

console.log("All tests passed.");
