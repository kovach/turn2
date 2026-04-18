import assert from "node:assert/strict";
import { fixpoint, fixpoint0 } from "./fixpoint.js";
import { parse, parsePatterns } from "./parse.js";
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

function collect(tree: Tree, type: string): Tree[] {
  const self = tree.literal.literalType === type ? [tree] : [];
  return self.concat(tree.children.flatMap((c) => collect(c, type)));
}

// canonical root (empty atom) with a foo fact
const ref = parseOne(
`-
  + foo`
);

// match foo, assert bar
const rules = parseRules(`- foo
  + bar`);

// basic: bar is asserted under foo
{
  const { result } = fixpoint(rules, ref);
  const inserted = collect(result, "Assert").filter((n) => n.id.tag === "Atom");
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0]!.literal.atom.terms, [{ tag: "Symbol", name: "bar" }]);
  console.log("PASS: fixpoint asserts bar under foo");
}

// idempotent: second run produces no new nodes
{
  const { result: r1 } = fixpoint(rules, ref);
  const { result: r2 } = fixpoint(rules, r1);
  const inserted = collect(r2, "Assert").filter((n) => n.id.tag === "Atom");
  assert.equal(inserted.length, 1);
  console.log("PASS: fixpoint is idempotent");
}

// gas limit: a gas of 0 returns the initial tree immediately (no iterations)
{
  const { result, steps } = fixpoint(rules, ref, 0);
  assert.deepEqual(result, ref);
  assert.equal(steps, 0);
  console.log("PASS: gas=0 returns initial tree");
}

// empty patterns: returns initial tree unchanged
{
  const { result, steps } = fixpoint([], ref);
  assert.deepEqual(result, ref);
  assert.equal(steps, 0);
  console.log("PASS: empty patterns returns initial tree");
}

// flat all-assert: +foo / +bar / +baz should all appear in the output
{
  const patterns = parseRules("+foo\n+bar\n+baz");
  const { result } = fixpoint0(patterns);
  const names = result.children.map((c) =>
    c.literal.atom.terms.map((t) => ("name" in t ? t.name : "?")).join(" ")
  );
  assert.ok(names.includes("foo"), `expected "foo" in ${JSON.stringify(names)}`);
  assert.ok(names.includes("bar"), `expected "bar" in ${JSON.stringify(names)}`);
  assert.ok(names.includes("baz"), `expected "baz" in ${JSON.stringify(names)}`);
  console.log("PASS: flat all-assert: foo, bar, baz all appear");
}

// explicit id binding: -[Id] foo / + bar Id — bar's atom contains the id of the matched foo node
{
  const ref = parseOne("-\n  + foo");
  const fooId = ref.children[0]!.children[0]!.id; // the "+ foo" assert node
  const rules = parseRules("-[Id] foo\n  + bar Id");
  const { result } = fixpoint(rules, ref);
  const bar = collect(result, "Assert").find((c) => {
    const t = c.literal.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "bar";
  });
  assert.ok(bar, "bar node not found");
  // bar's second term should be bound to foo's id via the Id variable
  assert.deepEqual(bar!.literal.atom.terms[1], fooId);
  console.log("PASS: explicit id binding captures matched node id");
}

// self-referential id: +[I] card I — the atom should contain the node's own generated id
{
  const patterns = parseRules("+[I] card I");
  const { result } = fixpoint0(patterns);
  assert.equal(result.children.length, 1);
  const node = result.children[0]!;
  assert.equal(node.literal.literalType, "Assert");
  assert.deepEqual(node.literal.atom.terms[0], { tag: "Symbol", name: "card" });
  assert.deepEqual(node.literal.atom.terms[1], node.id);
  console.log("PASS: self-referential id: +[I] card I resolves to + card <id>");
}

console.log("All fixpoint tests passed.");
