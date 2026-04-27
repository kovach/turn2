import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, formatTree } from "../parse.js";
import type { BodyTree, Tree } from "../types.js";
import { treeAtom, treeAtomTerms, treeChildren, treeId } from "../types.js";

const __dir = dirname(fileURLToPath(import.meta.url));

function ok(input: string): BodyTree {
  const result = parse(input);
  assert(!("message" in result), `unexpected error: ${JSON.stringify(result)}`);
  if (result.tag === "Equal") throw new Error("ok: top-level Equal is impossible");
  return result;
}

// Walk into known body-bearing children. Tests construct Tree literals from
// `parse()` whose top-level wrapper is always Match-tagged. Equal nodes can
// appear as leaves, so descending past one is a test bug — this helper makes
// that explicit.
function kid(t: BodyTree, ...path: number[]): BodyTree {
  let cur: Tree = t;
  for (const i of path) {
    if (cur.tag === "Equal") throw new Error("Equal has no children");
    const next: Tree | undefined = cur.children[i];
    if (next === undefined) throw new Error(`no child at ${i}`);
    cur = next;
  }
  if (cur.tag === "Equal") throw new Error("expected body-bearing node");
  return cur;
}

// single leaf
{
  const tree = ok("- foo");
  assert.equal(treeChildren(tree).length, 1);
  const c = kid(tree, 0);
  assert.equal(c.tag, "Match");
  assert.deepEqual(c.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  assert.equal(c.children.length, 0);
  console.log("PASS: single leaf");
}

// doc example: - foo / ! bar X
{
  const tree = ok("- foo\n  ! bar X");
  assert.equal(treeChildren(tree).length, 1);
  const rootNode = kid(tree, 0);
  assert.equal(rootNode.tag, "Match");
  assert.deepEqual(rootNode.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  assert.equal(rootNode.children.length, 1);
  const child = kid(rootNode, 0);
  assert.equal(child.tag, "Constrain");
  assert.deepEqual(child.atom.terms, [
    { tag: "Symbol", name: "bar" },
    { tag: "Variable", name: "X" },
  ]);
  console.log("PASS: doc example");
}

// all prefixes
{
  const tree = ok("- a\n+ b\n? c\n! d\n< e\n= f g");
  const kids = treeChildren(tree);
  assert.equal(kids.length, 6);
  assert.deepEqual(kids.map(k => k.tag), [
    "Match", "Assert", "Ask", "Constrain", "Before", "Equal",
  ]);
  console.log("PASS: all prefixes");
}

// siblings and nested children
{
  const tree = ok("- a\n  - x\n    - p\n    - q\n  - y\n- b");
  assert.equal(treeChildren(tree).length, 2);
  const a = kid(tree, 0);
  assert.deepEqual(a.atom.terms, [{ tag: "Symbol", name: "a" }]);
  assert.equal(a.children.length, 2);
  const x = kid(a, 0);
  assert.equal(x.children.length, 2);
  assert.deepEqual(treeAtomTerms(x.children[0]!), [{ tag: "Symbol", name: "p" }]);
  assert.deepEqual(treeAtomTerms(x.children[1]!), [{ tag: "Symbol", name: "q" }]);
  assert.deepEqual(treeAtomTerms(a.children[1]!), [{ tag: "Symbol", name: "y" }]);
  assert.deepEqual(treeAtomTerms(tree.children[1]!), [{ tag: "Symbol", name: "b" }]);
  console.log("PASS: siblings and nested children");
}

// blank lines are skipped
{
  const tree = ok("\n- a\n\n- b\n");
  assert.equal(treeChildren(tree).length, 2);
  console.log("PASS: blank lines skipped");
}

// variable vs symbol
{
  const tree = ok("- foo X bar Y");
  assert.deepEqual(treeAtomTerms(tree.children[0]!), [
    { tag: "Symbol", name: "foo" },
    { tag: "Variable", name: "X" },
    { tag: "Symbol", name: "bar" },
    { tag: "Variable", name: "Y" },
  ]);
  console.log("PASS: variable vs symbol");
}

// invalid prefix
{
  const result = parse("@ bad");
  assert("message" in result);
  assert.equal((result as { line: number }).line, 1);
  console.log("PASS: invalid prefix error");
}

// ids are assigned from line numbers
{
  const tree = ok("- a\n- b");
  assert.deepEqual(treeId(tree.children[0]!), { tag: "Variable", name: "1" });
  assert.deepEqual(treeId(tree.children[1]!), { tag: "Variable", name: "2" });
  console.log("PASS: id assignment");
}

// parses example.sl
{
  const input = readFileSync(join(__dir, "../../../example.sl"), "utf8");
  const tree = ok(input);
  assert(treeChildren(tree).length > 0);
  const first = kid(tree, 0);
  assert.equal(first.tag, "Match");
  assert.deepEqual(first.atom.terms, [{ tag: "Symbol", name: "turn" }]);
  assert.equal(first.children.length, 3);
  const activate = kid(first, 0);
  assert.deepEqual(activate.atom.terms, [{ tag: "Symbol", name: "activate" }]);
  assert.equal(activate.children.length, 3);
  assert.equal(first.children[1]!.tag, "Assert");
  assert.equal(first.children[2]!.tag, "Assert");
  console.log("PASS: parses example.sl");
}

// roundtrip: format → parse → format is stable
{
  const input = readFileSync(join(__dir, "../../../example.sl"), "utf8");
  const tree1 = ok(input);
  const formatted = treeChildren(tree1).map((t) => formatTree(t)).join("\n");
  const tree2 = ok(formatted);
  const formatted2 = treeChildren(tree2).map((t) => formatTree(t)).join("\n");
  assert.equal(formatted, formatted2);
  console.log("PASS: format roundtrip stable");
}

// nested atom term
{
  const tree = ok("- foo (bar Baz) X");
  const terms = treeAtomTerms(tree.children[0]!);
  assert.deepEqual(terms[0], { tag: "Symbol", name: "foo" });
  assert.equal(terms[1]!.tag, "Atom");
  if (terms[1]!.tag === "Atom") {
    assert.deepEqual(terms[1]!.atom.terms, [
      { tag: "Symbol", name: "bar" },
      { tag: "Variable", name: "Baz" },
    ]);
  }
  assert.deepEqual(terms[2], { tag: "Variable", name: "X" });
  console.log("PASS: nested atom term");
}

// deeply nested atom
{
  const tree = ok("- (a (b c))");
  const terms = treeAtomTerms(tree.children[0]!);
  assert.equal(terms[0]!.tag, "Atom");
  if (terms[0]!.tag === "Atom") {
    assert.deepEqual(terms[0]!.atom.terms[0], { tag: "Symbol", name: "a" });
    const inner = terms[0]!.atom.terms[1]!;
    assert.equal(inner.tag, "Atom");
    if (inner.tag === "Atom") {
      assert.deepEqual(inner.atom.terms, [
        { tag: "Symbol", name: "b" },
        { tag: "Symbol", name: "c" },
      ]);
    }
  }
  console.log("PASS: deeply nested atom");
}

// atom roundtrip
{
  const tree1 = ok("- foo (bar Baz (qux)) X");
  const formatted = treeChildren(tree1).map((t) => formatTree(t)).join("\n");
  const tree2 = ok(formatted);
  assert.deepEqual(treeAtom(tree1.children[0]!), treeAtom(tree2.children[0]!));
  console.log("PASS: atom roundtrip");
}

// explicit id syntax: -[Id] foo
{
  const tree = ok("-[Id] foo");
  const node = kid(tree, 0);
  assert.deepEqual(node.id, { tag: "Variable", name: "Id" });
  assert.deepEqual(node.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  console.log("PASS: explicit id syntax -[Id] foo");
}

// explicit id syntax with space: - [Id] foo
{
  const tree = ok("- [Id] foo");
  const node = kid(tree, 0);
  assert.deepEqual(node.id, { tag: "Variable", name: "Id" });
  assert.deepEqual(node.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  console.log("PASS: explicit id syntax - [Id] foo");
}

// explicit id as symbol: -[myid] foo
{
  const tree = ok("-[myid] foo");
  assert.deepEqual(treeId(tree.children[0]!), { tag: "Symbol", name: "myid" });
  console.log("PASS: explicit id as symbol");
}

// explicit id as atom: -[(id r1 X)] foo
{
  const tree = ok("-[(id r1 X)] foo");
  const id = treeId(tree.children[0]!);
  assert.equal(id?.tag, "Atom");
  if (id?.tag === "Atom") {
    assert.deepEqual(id.atom.terms, [
      { tag: "Symbol", name: "id" },
      { tag: "Symbol", name: "r1" },
      { tag: "Variable", name: "X" },
    ]);
  }
  console.log("PASS: explicit id as atom");
}

// unclosed bracket is a parse error
{
  const result = parse("-[Id foo");
  assert("message" in result);
  console.log("PASS: unclosed bracket is error");
}

function getAggInfo(node: Tree) {
  return node.tag === "Aggregate" ? node.info : undefined;
}

// aggregate syntax: # sum X -> Total
{
  const tree = ok("# sum X -> Total");
  const node = tree.children[0]!;
  assert.equal(node.tag, "Aggregate");
  const info = getAggInfo(node);
  assert(info);
  assert.equal(info.funcName, "sum");
  assert.deepEqual(info.args, [{ tag: "Variable", name: "X" }]);
  assert.deepEqual(info.out, { tag: "Variable", name: "Total" });
  console.log("PASS: aggregate syntax # sum X -> Total");
}

// aggregate with no args: # count -> N
{
  const tree = ok("# count -> N");
  const node = tree.children[0]!;
  const info = getAggInfo(node);
  assert.equal(info?.funcName, "count");
  assert.deepEqual(info?.args, []);
  assert.deepEqual(info?.out, { tag: "Variable", name: "N" });
  console.log("PASS: aggregate with no args");
}

// aggregate with multiple args: # foo A B -> C
{
  const tree = ok("# foo A B -> C");
  const node = tree.children[0]!;
  const info = getAggInfo(node);
  assert.equal(info?.funcName, "foo");
  assert.equal(info?.args.length, 2);
  console.log("PASS: aggregate with multiple args");
}

// aggregate with local-pattern children
{
  const tree = ok("# sum X -> Total\n  - t X");
  const node = kid(tree, 0);
  assert.equal(node.tag, "Aggregate");
  assert.equal(node.children.length, 1);
  assert.deepEqual(treeAtomTerms(node.children[0]!), [
    { tag: "Symbol", name: "t" },
    { tag: "Variable", name: "X" },
  ]);
  console.log("PASS: aggregate with local-pattern children");
}

// aggregate roundtrip
{
  const tree1 = ok("# sum X -> Total\n  - t X");
  const formatted = formatTree(tree1.children[0]!);
  const tree2 = ok(formatted);
  assert.equal(getAggInfo(tree2.children[0]!)?.funcName, "sum");
  assert.equal(treeChildren(tree2.children[0]!).length, 1);
  console.log("PASS: aggregate roundtrip");
}

// aggregate missing arrow is error
{
  const result = parse("# sum X Total");
  assert("message" in result);
  assert((result as { message: string }).message.includes("->"));
  console.log("PASS: aggregate missing arrow is error");
}

// spans are preserved
{
  const tree = ok("- foo\n  + bar");
  // root has no span (synthetic)
  assert.equal(tree.span, undefined);
  assert.deepEqual(kid(tree, 0).span, { line: 1 });
  assert.deepEqual(kid(tree, 0, 0).span, { line: 2 });
  console.log("PASS: spans are preserved");
}

// spans with blank lines
{
  const tree = ok("\n- foo\n\n  + bar");
  assert.deepEqual(kid(tree, 0).span, { line: 2 });
  assert.deepEqual(kid(tree, 0, 0).span, { line: 4 });
  console.log("PASS: spans with blank lines");
}

// parsePatterns adjusts spans for multi-pattern files
{
  const { parsePatterns } = await import("../parse.js");
  const input = "+ a\n  + b\n\n- a\n  + c";
  const result = parsePatterns(input);
  assert(!("message" in result));
  const patterns = result as Tree[];
  assert.equal(patterns.length, 2);
  const p0 = patterns[0]!;
  const p1 = patterns[1]!;
  if (p0.tag === "Equal" || p1.tag === "Equal") throw new Error("expected body-bearing patterns");
  // First pattern: lines 1-2
  assert.deepEqual(kid(p0, 0).span, { line: 1 });
  assert.deepEqual(kid(p0, 0, 0).span, { line: 2 });
  // Second pattern: lines 4-5
  assert.deepEqual(kid(p1, 0).span, { line: 4 });
  assert.deepEqual(kid(p1, 0, 0).span, { line: 5 });
  console.log("PASS: parsePatterns adjusts spans for multi-pattern files");
}

console.log("All parse tests passed.");
