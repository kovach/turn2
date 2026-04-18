import assert from "node:assert/strict";
import { idExpand, expand, expandAll } from "./expand.js";
import { parse, parsePatterns } from "./parse.js";
import { fixpoint } from "./fixpoint.js";
import type { Tree } from "./types.js";

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
  const prefix = tree.literal.literalType[0]!.toLowerCase();
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

  // match nodes get Variable ids X1, X2
  assert.deepEqual(f.id, { tag: "Variable", name: "X1" });
  assert.deepEqual(h.id, { tag: "Variable", name: "X2" });

  // + g id = Atom([id, r1, X1])
  assert.equal(g.id.tag, "Atom");
  if (g.id.tag === "Atom") {
    assert.deepEqual(g.id.atom.terms[0], { tag: "Symbol", name: "id" });
    assert.deepEqual(g.id.atom.terms[1], { tag: "Symbol", name: "r1" });
    assert.deepEqual(g.id.atom.terms[2], { tag: "Variable", name: "X1" });
    assert.equal(g.id.atom.terms.length, 3);
  }

  // + i id = Atom([id, r1, X1, g.id, X2])
  assert.equal(i.id.tag, "Atom");
  if (i.id.tag === "Atom") {
    assert.deepEqual(i.id.atom.terms[0], { tag: "Symbol", name: "id" });
    assert.deepEqual(i.id.atom.terms[1], { tag: "Symbol", name: "r1" });
    assert.deepEqual(i.id.atom.terms[2], { tag: "Variable", name: "X1" });
    assert.deepEqual(i.id.atom.terms[3], g.id);
    assert.deepEqual(i.id.atom.terms[4], { tag: "Variable", name: "X2" });
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
  assert.equal(f1.children[0]!.literal.literalType, "Match");   // x stays match
  assert.equal(f1.children[1]!.literal.literalType, "Assert");  // g is the tip
  assert.equal(f1.children[1]!.children.length, 0);             // g has no children
  console.log("PASS: expand rule 1 ends at +g with no children");

  // Rule 2: prefix ending at + i, g converted to match
  // Structure: root → f[x, g(match)[h[i]]]
  const r2 = rules[1]!;
  const f2 = r2.children[0]!;
  assert.equal(f2.children.length, 2); // x, g
  assert.equal(f2.children[1]!.literal.literalType, "Match");   // g converted to match
  const h2 = f2.children[1]!.children[0]!;
  assert.equal(h2.literal.literalType, "Match");
  assert.equal(h2.children[0]!.literal.literalType, "Assert");  // i is the tip
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
    const self = tree.literal.literalType === type ? [tree] : [];
    return self.concat(tree.children.flatMap((c) => collect(c, type)));
  }

  const inserted = collect(result, "Assert").filter((n) => n.id.tag === "Atom");
  const atoms = inserted.map((n) => n.literal.atom.terms.map((t) => ("name" in t ? t.name : "?")).join(" "));
  assert.ok(atoms.includes("bar"), `expected "bar" in ${JSON.stringify(atoms)}`);
  assert.ok(atoms.includes("baz"), `expected "baz" in ${JSON.stringify(atoms)}`);
  console.log("PASS: two-level integration derives bar and baz");
}

console.log("All expand tests passed.");
