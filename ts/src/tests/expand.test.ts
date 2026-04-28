import assert from "node:assert/strict";
import { idExpand, expand, expandAll, rewriteUnboundAssertVars } from "../expand.js";
import { parse, parsePatterns } from "../parse.js";
import { fixpoint } from "../fixpoint.js";
import type { BodyTree, Term, Tree } from "../types.js";
import { treeAtomTerms, treeChildren } from "../types.js";

function parseOne(input: string): BodyTree {
  const result = parse(input);
  if ("message" in result) throw new Error(`parse error: ${result.message}`);
  if (result.tag === "Equal" || result.tag === "Ask") throw new Error("parseOne: top-level Equal/Ask is impossible");
  return result;
}

function asBody(t: Tree): BodyTree {
  if (t.tag === "Equal" || t.tag === "Ask") throw new Error(`expected body-bearing tree, got ${t.tag}`);
  return t;
}

// Recursive child access for tests that walk known-body-bearing structures.
function kid(t: BodyTree, ...path: number[]): BodyTree {
  let cur: Tree = t;
  for (const i of path) {
    if (cur.tag === "Equal" || cur.tag === "Ask") throw new Error(`${cur.tag} has no children`);
    const next: Tree | undefined = cur.children[i];
    if (next === undefined) throw new Error(`no child at ${i}`);
    cur = next;
  }
  return asBody(cur);
}

function parseRules(input: string, prefix = "r"): Tree[] {
  const result = parsePatterns(input, prefix);
  if ("message" in result) throw new Error(`parse error: ${result.message}`);
  return result;
}

function literalTypes(tree: Tree): string[] {
  const prefix = tree.tag[0]!.toLowerCase();
  if (tree.tag === "Equal" || tree.tag === "Ask") return [prefix];
  return [prefix, ...tree.children.flatMap(literalTypes)];
}

// --- idExpand ---

// Example from overview: - f / + g / - h / + i
{
  const tree = parseOne("- f\n  + g\n    - h\n      + i");
  const expanded = idExpand(tree, "r1");

  // root wrapper unchanged
  assert.deepEqual(expanded.id, tree.id);

  const f = kid(expanded, 0);
  const g = kid(f, 0);
  const h = kid(g, 0);
  const i = kid(h, 0);

  // match nodes get Variable ids X1, X3 (counter is shared with positive nodes)
  assert.deepEqual(f.id, { tag: "Variable", name: "X1" });
  assert.deepEqual(h.id, { tag: "Variable", name: "X3" });

  // + g id = Id([id, r1, sym("id2"), X1])
  assert.equal(g.id.tag, "Id");
  if (g.id.tag === "Id") {
    assert.deepEqual(g.id.atom.terms[0], { tag: "Symbol", name: "id" });
    assert.deepEqual(g.id.atom.terms[1], { tag: "Symbol", name: "r1" });
    assert.deepEqual(g.id.atom.terms[2], { tag: "Symbol", name: "id2" });
    assert.deepEqual(g.id.atom.terms[3], { tag: "Variable", name: "X1" });
    assert.equal(g.id.atom.terms.length, 4);
  }

  // + i id = Id([id, r1, sym("id4"), X1, X3])
  // positive nodes don't push to previousVars, so g.id does not appear
  assert.equal(i.id.tag, "Id");
  if (i.id.tag === "Id") {
    assert.deepEqual(i.id.atom.terms[0], { tag: "Symbol", name: "id" });
    assert.deepEqual(i.id.atom.terms[1], { tag: "Symbol", name: "r1" });
    assert.deepEqual(i.id.atom.terms[2], { tag: "Symbol", name: "id4" });
    assert.deepEqual(i.id.atom.terms[3], { tag: "Variable", name: "X1" });
    assert.deepEqual(i.id.atom.terms[4], { tag: "Variable", name: "X3" });
    assert.equal(i.id.atom.terms.length, 5);
  }
  console.log("PASS: idExpand assigns correct ids");
}

// counter is per-call, not shared across idExpand calls
{
  const tree = parseOne("- a\n  + b");
  const e1 = idExpand(tree, "r1");
  const e2 = idExpand(tree, "r2");
  assert.deepEqual(kid(e1, 0).id, { tag: "Variable", name: "X1" });
  assert.deepEqual(kid(e2, 0).id, { tag: "Variable", name: "X1" });
  console.log("PASS: idExpand counter resets per call");
}

// --- expand ---

// Single positive node → one rule, unchanged structure
{
  const tree = idExpand(parseOne("- foo\n  + bar"), "r1");
  const rules = expand(tree);
  assert.equal(rules.length, 1);
  assert.deepEqual(literalTypes(rules[0]!), ["m", "m", "a"]);
  console.log("PASS: expand single positive node → one rule");
}

// Two positive nodes → two rules
// Pattern: - f / - x / + g / - h / + i  (x and g are siblings under f)
{
  const tree = idExpand(parseOne("- f\n  - x\n  + g\n    - h\n      + i"), "r1");
  const rules = expand(tree);
  assert.equal(rules.length, 2);

  // Rule 1: prefix ending at + g
  // Structure: root → f[x, g(no children)]
  const r1 = rules[0]!;
  assert.equal(r1.children.length, 1); // f
  const f1 = kid(r1, 0);
  assert.equal(f1.children.length, 2); // x, g
  assert.equal(f1.children[0]!.tag, "Match");   // x stays match
  assert.equal(f1.children[1]!.tag, "Assert");  // g is the tip
  assert.equal(kid(f1, 1).children.length, 0);             // g has no children
  console.log("PASS: expand rule 1 ends at +g with no children");

  // Rule 2: prefix ending at + i, g converted to match
  // Structure: root → f[x, g(match)[h[i]]]
  const r2 = rules[1]!;
  const f2 = kid(r2, 0);
  assert.equal(f2.children.length, 2); // x, g
  assert.equal(f2.children[1]!.tag, "Match");   // g converted to match
  const h2 = kid(f2, 1, 0);
  assert.equal(h2.tag, "Match");
  assert.equal(h2.children[0]!.tag, "Assert");  // i is the tip
  console.log("PASS: expand rule 2 ends at +i, earlier +g converted to match");
}

// Pattern with no positive nodes → no rules
{
  const tree = idExpand(parseOne("- foo\n  - bar"), "r1");
  const rules = expand(tree);
  assert.equal(rules.length, 0);
  console.log("PASS: expand all-match pattern → no rules");
}

// expandAll flattens
{
  const t1 = idExpand(parseOne("- a\n  + b"), "r1");
  const t2 = idExpand(parseOne("- c\n  + d\n    + e"), "r2");
  const rules = expandAll([t1, t2]);
  assert.equal(rules.length, 3); // 1 from t1, 2 from t2
  console.log("PASS: expandAll flattens correctly");
}

// --- integration: two-level pattern ---

// Pattern: - foo / + bar / - bar / + baz
// Should derive: baz under bar under foo (via two fixpoint steps)
{
  const facts = parseRules("+ foo", "f");
  const rules = parseRules("- foo\n  + bar\n\n- bar\n  + baz");
  const { result } = fixpoint([...facts, ...rules]);

  function collect(tree: Tree, type: string): BodyTree[] {
    if (tree.tag === "Equal" || tree.tag === "Ask") return [];
    const self: BodyTree[] = tree.tag === type ? [tree] : [];
    return self.concat(tree.children.flatMap((c: Tree) => collect(c, type)));
  }

  const inserted = collect(result, "Assert").filter((n) => n.id.tag === "Ref");
  const atoms = inserted.map((n) => n.atom.terms.map((t) => ("name" in t ? t.name : "?")).join(" "));
  assert.ok(atoms.includes("bar"), `expected "bar" in ${JSON.stringify(atoms)}`);
  assert.ok(atoms.includes("baz"), `expected "baz" in ${JSON.stringify(atoms)}`);
  console.log("PASS: two-level integration derives bar and baz");
}

// --- aggregate expansion ---

// Aggregate node generates 2 rules (emitter + query)
{
  const tree = idExpand(parseOne("- foo\n  # sum X -> Total\n    - t X"), "r1");
  const rules = expand(tree);
  assert.equal(rules.length, 2, `expected 2 rules, got ${rules.length}`);

  // Rule 1: +[Id] agg-instance lexId
  const r1 = rules[0]!;
  const agg1 = kid(r1, 0, 0);
  assert.equal(agg1.tag, "Assert");
  assert.equal(agg1.atom.terms[0]?.tag, "Symbol");
  if (agg1.atom.terms[0]?.tag === "Symbol") {
    assert.equal(agg1.atom.terms[0].name, "_agg-instance");
  }
  console.log("PASS: aggregate rule 1 has + agg-instance");

  // Rule 2: -[Id] agg-instance with local-pattern + agg-binding as children
  const r2 = rules[1]!;
  const foo2 = kid(r2, 0);
  const agg2 = kid(foo2, 0);
  assert.equal(agg2.tag, "Match");
  assert.equal(agg2.atom.terms[0]?.tag, "Symbol");
  if (agg2.atom.terms[0]?.tag === "Symbol") {
    assert.equal(agg2.atom.terms[0].name, "_agg-instance");
  }

  // Local-pattern (- t X) is a child of agg-instance
  const tNode = agg2.children[0];
  assert.ok(tNode, "expected local-pattern as child of agg-instance");
  assert.equal(tNode.tag, "Match");

  // agg-binding is also a child of agg-instance
  const binding = agg2.children[1];
  assert.ok(binding, "expected agg-binding as child");
  assert.equal(binding.tag, "Assert");
  if (binding.tag === "Assert" && binding.atom.terms[0]?.tag === "Symbol") {
    assert.equal(binding.atom.terms[0].name, "_agg-binding");
  }
  console.log("PASS: aggregate rule 2 has - agg-instance with local-pattern + agg-binding children");
}

// Aggregate + subsequent positive generates 3 rules
{
  const tree = idExpand(parseOne("- foo\n  # sum X -> Total\n    - t X\n  + note Total"), "r1");
  const rules = expand(tree);
  assert.equal(rules.length, 3, `expected 3 rules, got ${rules.length}`);

  // Rule 3: suffix with - agg-result
  const r3 = rules[2]!;
  const foo3 = kid(r3, 0);
  // First child should be - agg-result (converted from aggregate)
  const aggResult = kid(foo3, 0);
  assert.equal(aggResult.tag, "Match");
  if (aggResult.atom.terms[0]?.tag === "Symbol") {
    assert.equal(aggResult.atom.terms[0].name, "_agg-result");
  }
  // Second child should be + note Total
  const note = kid(foo3, 1);
  assert.equal(note.tag, "Assert");
  console.log("PASS: suffix rule has - agg-result");
}

// --- rewriteUnboundAssertVars ---

function isIdAtomFor(t: Term, ruleName: string, expectedPreviousVars: string[]): boolean {
  if (t.tag !== "Id") return false;
  const terms = t.atom.terms;
  if (terms.length !== 3 + expectedPreviousVars.length) return false;
  if (terms[0]?.tag !== "Symbol" || terms[0].name !== "id") return false;
  if (terms[1]?.tag !== "Symbol" || terms[1].name !== ruleName) return false;
  if (terms[2]?.tag !== "Symbol" || !/^id\d+$/.test(terms[2].name)) return false;
  for (let i = 0; i < expectedPreviousVars.length; i++) {
    const got = terms[3 + i];
    const want = expectedPreviousVars[i]!;
    if (got?.tag !== "Variable" || got.name !== want) return false;
  }
  return true;
}

// Baseline rewrite: + b Y where Y has no prior binder → Y becomes (id r1 idN X1)
{
  const rules = expandAll([idExpand(parseOne("- a X\n  + b Y"), "r1")]);
  assert.equal(rules.length, 1);
  const assertNode = kid(rules[0]!, 0, 0);
  assert.equal(assertNode.tag, "Assert");
  const rewritten = assertNode.atom.terms[1]!;
  assert.ok(isIdAtomFor(rewritten, "r1", ["X1"]),
    `expected fresh id atom with tail [X1], got ${JSON.stringify(rewritten)}`);
  console.log("PASS: rewriteUnboundAssertVars baseline (+ b Y)");
}

// Multiple unbound vars get distinct fresh lineSyms
{
  const rules = expandAll([idExpand(parseOne("- a X\n  + b V W"), "r1")]);
  const assertNode = kid(rules[0]!, 0, 0);
  const vSub = assertNode.atom.terms[1]!;
  const wSub = assertNode.atom.terms[2]!;
  assert.ok(vSub.tag === "Id" && wSub.tag === "Id");
  if (vSub.tag === "Id" && wSub.tag === "Id") {
    const vLine = vSub.atom.terms[2]!;
    const wLine = wSub.atom.terms[2]!;
    assert.ok(vLine.tag === "Symbol" && wLine.tag === "Symbol");
    if (vLine.tag === "Symbol" && wLine.tag === "Symbol") {
      assert.notEqual(vLine.name, wLine.name, "expected distinct lineSyms");
    }
  }
  console.log("PASS: rewriteUnboundAssertVars distinct vars → distinct lineSyms");
}

// Repeated occurrence of the same var → same id atom
{
  const rules = expandAll([idExpand(parseOne("- a X\n  + b V V"), "r1")]);
  const assertNode = kid(rules[0]!, 0, 0);
  assert.deepEqual(assertNode.atom.terms[1], assertNode.atom.terms[2]);
  console.log("PASS: rewriteUnboundAssertVars repeated occurrence → same atom");
}

// Already bound: + b X where X is bound by preceding Match's atom (unified
// against the reference at match time) should be untouched.
{
  const rules = expandAll([idExpand(parseOne("- a X\n  + b X"), "r1")]);
  const assertNode = kid(rules[0]!, 0, 0);
  assert.deepEqual(assertNode.atom.terms[1], { tag: "Variable", name: "X" });
  console.log("PASS: rewriteUnboundAssertVars leaves already-bound vars alone");
}

// Aggregate arg: aggBinding references variable from preceding localPattern Match
// → already in `seen` → no rewrite.
{
  const rules = expandAll([idExpand(parseOne("- foo\n  # sum X -> Total\n    - t X\n  + note Total"), "r1")]);
  // Rule 2 is the buildAggRule2-style binding rule; its aggBinding child under
  // the agg-instance Match references X which is bound by the - t X sibling.
  const r2 = rules[1]!;
  const aggBinding = kid(r2, 0, 0, 1);
  assert.equal(aggBinding.tag, "Assert");
  // agg-binding atom: [sym("_agg-binding"), lexId, nodeId, X]. X must remain
  // a Variable (bound by the - t X sibling at match time) — not rewritten.
  const xTerm = aggBinding.atom.terms[3]!;
  assert.deepEqual(xTerm, { tag: "Variable", name: "X" },
    `expected X to remain unsubstituted, got ${JSON.stringify(xTerm)}`);
  console.log("PASS: rewriteUnboundAssertVars leaves aggBinding args alone");
}

// Ask node: rewritten to Assert(`_choose`) before rewriteUnboundAssertVars
// runs, so it shows up as Assert with `_choose` head. The Ask's variable
// receives the same id-atom rewrite an Assert would.
{
  const rules = expandAll([idExpand(parseOne("- a X\n  ? Y"), "r1")]);
  const chooseNode = kid(rules[0]!, 0, 0);
  assert.equal(chooseNode.tag, "Assert");
  const head = chooseNode.atom.terms[0]!;
  assert.ok(head.tag === "Symbol" && head.name === "_choose",
    `expected '_choose' head, got ${JSON.stringify(head)}`);
  const rewritten = chooseNode.atom.terms[1]!;
  assert.ok(isIdAtomFor(rewritten, "r1", ["X1"]),
    `expected fresh id atom, got ${JSON.stringify(rewritten)}`);
  console.log("PASS: rewriteUnboundAssertVars covers Ask (now Assert(_choose))");
}

// End-to-end: no Variable terms survive into the reference tree
{
  const facts = parseRules("+ a foo", "f");
  const rules = parseRules("- a X\n  + b Y");
  const { result } = fixpoint([...facts, ...rules]);
  function hasVariable(node: Tree): boolean {
    function termHas(t: Term): boolean {
      if (t.tag === "Variable") return true;
      if (t.tag === "Atom" || t.tag === "Id") return t.atom.terms.some(termHas);
      return false;
    }
    if (treeAtomTerms(node).some(termHas)) return true;
    return treeChildren(node).some(hasVariable);
  }
  assert.ok(!hasVariable(result),
    "expected no Variable terms in reference tree after fixpoint");
  console.log("PASS: rewriteUnboundAssertVars end-to-end (no Variables in output)");
}

console.log("All expand tests passed.");
