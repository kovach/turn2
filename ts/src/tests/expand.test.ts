import assert from "node:assert/strict";
import { idExpand, expand, expandAll, rewriteUnboundAssertVars } from "../expand.js";
import { parse, parsePatterns } from "../parse.js";
import { fixpoint } from "../fixpoint.js";
import type { Term, Tree } from "../types.js";

function parseOne(input: string): Tree {
  const result = parse(input);
  if ("message" in result) throw new Error(`parse error: ${result.message}`);
  return result;
}

function parseRules(input: string): Tree[] {
  const result = parsePatterns(input);
  if ("message" in result) throw new Error(`parse error: ${result.message}`);
  return result;
}

function literalTypes(tree: Tree): string[] {
  const prefix = tree.literal.literalType.tag[0]!.toLowerCase();
  return [prefix, ...tree.children.flatMap(literalTypes)];
}

// --- idExpand ---

// Example from overview: - f / + g / - h / + i
{
  const tree = parseOne("- f\n  + g\n    - h\n      + i");
  const expanded = idExpand(tree, "r1");

  // root wrapper unchanged
  assert.deepEqual(expanded.id, tree.id);

  const f = expanded.children[0]!;
  const g = f.children[0]!;
  const h = g.children[0]!;
  const i = h.children[0]!;

  // match nodes get Variable ids X1, X3 (counter is shared with positive nodes)
  assert.deepEqual(f.id, { tag: "Variable", name: "X1" });
  assert.deepEqual(h.id, { tag: "Variable", name: "X3" });

  // + g id = Atom([id, r1, sym("id2"), X1])
  assert.equal(g.id.tag, "Atom");
  if (g.id.tag === "Atom") {
    assert.deepEqual(g.id.atom.terms[0], { tag: "Symbol", name: "id" });
    assert.deepEqual(g.id.atom.terms[1], { tag: "Symbol", name: "r1" });
    assert.deepEqual(g.id.atom.terms[2], { tag: "Symbol", name: "id2" });
    assert.deepEqual(g.id.atom.terms[3], { tag: "Variable", name: "X1" });
    assert.equal(g.id.atom.terms.length, 4);
  }

  // + i id = Atom([id, r1, sym("id4"), X1, X3])
  // positive nodes don't push to previousVars, so g.id does not appear
  assert.equal(i.id.tag, "Atom");
  if (i.id.tag === "Atom") {
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
  assert.deepEqual(e1.children[0]!.id, { tag: "Variable", name: "X1" });
  assert.deepEqual(e2.children[0]!.id, { tag: "Variable", name: "X1" });
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
  const f1 = r1.children[0]!;
  assert.equal(f1.children.length, 2); // x, g
  assert.equal(f1.children[0]!.literal.literalType.tag, "Match");   // x stays match
  assert.equal(f1.children[1]!.literal.literalType.tag, "Assert");  // g is the tip
  assert.equal(f1.children[1]!.children.length, 0);             // g has no children
  console.log("PASS: expand rule 1 ends at +g with no children");

  // Rule 2: prefix ending at + i, g converted to match
  // Structure: root → f[x, g(match)[h[i]]]
  const r2 = rules[1]!;
  const f2 = r2.children[0]!;
  assert.equal(f2.children.length, 2); // x, g
  assert.equal(f2.children[1]!.literal.literalType.tag, "Match");   // g converted to match
  const h2 = f2.children[1]!.children[0]!;
  assert.equal(h2.literal.literalType.tag, "Match");
  assert.equal(h2.children[0]!.literal.literalType.tag, "Assert");  // i is the tip
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
  const ref = parseOne("-\n  + foo");
  const rules = parseRules("- foo\n  + bar\n\n- bar\n  + baz");
  const { result } = fixpoint(rules, ref);

  function collect(tree: Tree, type: string): Tree[] {
    const self = tree.literal.literalType.tag === type ? [tree] : [];
    return self.concat(tree.children.flatMap((c) => collect(c, type)));
  }

  const inserted = collect(result, "Assert").filter((n) => n.id.tag === "Ref");
  const atoms = inserted.map((n) => n.literal.atom.terms.map((t) => ("name" in t ? t.name : "?")).join(" "));
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
  const agg1 = r1.children[0]!.children[0]!;
  assert.equal(agg1.literal.literalType.tag, "Assert");
  assert.equal(agg1.literal.atom.terms[0]?.tag, "Symbol");
  if (agg1.literal.atom.terms[0]?.tag === "Symbol") {
    assert.equal(agg1.literal.atom.terms[0].name, "agg-instance");
  }
  console.log("PASS: aggregate rule 1 has + agg-instance");

  // Rule 2: -[Id] agg-instance with local-pattern + agg-binding as children
  const r2 = rules[1]!;
  const foo2 = r2.children[0]!;
  const agg2 = foo2.children[0]!;
  assert.equal(agg2.literal.literalType.tag, "Match");
  assert.equal(agg2.literal.atom.terms[0]?.tag, "Symbol");
  if (agg2.literal.atom.terms[0]?.tag === "Symbol") {
    assert.equal(agg2.literal.atom.terms[0].name, "agg-instance");
  }

  // Local-pattern (- t X) is a child of agg-instance
  const tNode = agg2.children[0];
  assert.ok(tNode, "expected local-pattern as child of agg-instance");
  assert.equal(tNode.literal.literalType.tag, "Match");

  // agg-binding is also a child of agg-instance
  const binding = agg2.children[1];
  assert.ok(binding, "expected agg-binding as child");
  assert.equal(binding.literal.literalType.tag, "Assert");
  if (binding.literal.atom.terms[0]?.tag === "Symbol") {
    assert.equal(binding.literal.atom.terms[0].name, "agg-binding");
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
  const foo3 = r3.children[0]!;
  // First child should be - agg-result (converted from aggregate)
  const aggResult = foo3.children[0]!;
  assert.equal(aggResult.literal.literalType.tag, "Match");
  if (aggResult.literal.atom.terms[0]?.tag === "Symbol") {
    assert.equal(aggResult.literal.atom.terms[0].name, "agg-result");
  }
  // Second child should be + note Total
  const note = foo3.children[1]!;
  assert.equal(note.literal.literalType.tag, "Assert");
  console.log("PASS: suffix rule has - agg-result");
}

// --- rewriteUnboundAssertVars ---

function isIdAtomFor(t: Term, ruleName: string, expectedPreviousVars: string[]): boolean {
  if (t.tag !== "Atom") return false;
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
  const assertNode = rules[0]!.children[0]!.children[0]!;
  assert.equal(assertNode.literal.literalType.tag, "Assert");
  const rewritten = assertNode.literal.atom.terms[1]!;
  assert.ok(isIdAtomFor(rewritten, "r1", ["X1"]),
    `expected fresh id atom with tail [X1], got ${JSON.stringify(rewritten)}`);
  console.log("PASS: rewriteUnboundAssertVars baseline (+ b Y)");
}

// Multiple unbound vars get distinct fresh lineSyms
{
  const rules = expandAll([idExpand(parseOne("- a X\n  + b V W"), "r1")]);
  const assertNode = rules[0]!.children[0]!.children[0]!;
  const vSub = assertNode.literal.atom.terms[1]!;
  const wSub = assertNode.literal.atom.terms[2]!;
  assert.ok(vSub.tag === "Atom" && wSub.tag === "Atom");
  if (vSub.tag === "Atom" && wSub.tag === "Atom") {
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
  const assertNode = rules[0]!.children[0]!.children[0]!;
  assert.deepEqual(assertNode.literal.atom.terms[1], assertNode.literal.atom.terms[2]);
  console.log("PASS: rewriteUnboundAssertVars repeated occurrence → same atom");
}

// Already bound: + b X where X is bound by preceding Match's atom (unified
// against the reference at match time) should be untouched.
{
  const rules = expandAll([idExpand(parseOne("- a X\n  + b X"), "r1")]);
  const assertNode = rules[0]!.children[0]!.children[0]!;
  assert.deepEqual(assertNode.literal.atom.terms[1], { tag: "Variable", name: "X" });
  console.log("PASS: rewriteUnboundAssertVars leaves already-bound vars alone");
}

// Aggregate arg: aggBinding references variable from preceding localPattern Match
// → already in `seen` → no rewrite.
{
  const rules = expandAll([idExpand(parseOne("- foo\n  # sum X -> Total\n    - t X\n  + note Total"), "r1")]);
  // Rule 2 is the buildAggRule2-style binding rule; its aggBinding child under
  // the agg-instance Match references X which is bound by the - t X sibling.
  const r2 = rules[1]!;
  const foo2 = r2.children[0]!;
  const aggInstance = foo2.children[0]!;
  const aggBinding = aggInstance.children[1]!;
  assert.equal(aggBinding.literal.literalType.tag, "Assert");
  // agg-binding atom: [sym("agg-binding"), lexId, nodeId, X]. X must remain
  // a Variable (bound by the - t X sibling at match time) — not rewritten.
  const xTerm = aggBinding.literal.atom.terms[3]!;
  assert.deepEqual(xTerm, { tag: "Variable", name: "X" },
    `expected X to remain unsubstituted, got ${JSON.stringify(xTerm)}`);
  console.log("PASS: rewriteUnboundAssertVars leaves aggBinding args alone");
}

// Ask node: same treatment as Assert
{
  const rules = expandAll([idExpand(parseOne("- a X\n  ? b Y"), "r1")]);
  const askNode = rules[0]!.children[0]!.children[0]!;
  assert.equal(askNode.literal.literalType.tag, "Ask");
  const rewritten = askNode.literal.atom.terms[1]!;
  assert.ok(isIdAtomFor(rewritten, "r1", ["X1"]),
    `expected fresh id atom, got ${JSON.stringify(rewritten)}`);
  console.log("PASS: rewriteUnboundAssertVars covers Ask");
}

// End-to-end: no Variable terms survive into the reference tree
{
  const rules = parseRules("- a X\n  + b Y");
  const initial = parseOne("-\n  + a foo");
  const { result } = fixpoint(rules, initial);
  function hasVariable(node: Tree): boolean {
    function termHas(t: Term): boolean {
      if (t.tag === "Variable") return true;
      if (t.tag === "Atom") return t.atom.terms.some(termHas);
      return false;
    }
    if (node.literal.atom.terms.some(termHas)) return true;
    return node.children.some(hasVariable);
  }
  assert.ok(!hasVariable(result),
    "expected no Variable terms in reference tree after fixpoint");
  console.log("PASS: rewriteUnboundAssertVars end-to-end (no Variables in output)");
}

console.log("All expand tests passed.");
