import assert from "node:assert/strict";
import { unifyTree } from "./unify.js";
import { sym, vari, node, fact, root } from "./types.js";
import type { Substitution } from "./types.js";

function substStr(s: Substitution): Record<string, string> {
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

console.log("All tests passed.");
