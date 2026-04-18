import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, formatTree } from "./parse.js";
import type { Tree } from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));

function ok(input: string): Tree {
  const result = parse(input);
  assert(!("message" in result), `unexpected error: ${JSON.stringify(result)}`);
  return result as Tree;
}

// single leaf
{
  const tree = ok("- foo");
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0]!.literal.literalType, "Match");
  assert.deepEqual(tree.children[0]!.literal.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  assert.equal(tree.children[0]!.children.length, 0);
  console.log("PASS: single leaf");
}

// doc example: - foo / ! bar X
{
  const tree = ok("- foo\n  ! bar X");
  assert.equal(tree.children.length, 1);
  const rootNode = tree.children[0]!;
  assert.equal(rootNode.literal.literalType, "Match");
  assert.deepEqual(rootNode.literal.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  assert.equal(rootNode.children.length, 1);
  const child = rootNode.children[0]!;
  assert.equal(child.literal.literalType, "Constrain");
  assert.deepEqual(child.literal.atom.terms, [
    { tag: "Symbol", name: "bar" },
    { tag: "Variable", name: "X" },
  ]);
  console.log("PASS: doc example");
}

// all four prefixes
{
  const tree = ok("- a\n+ b\n? c\n! d");
  assert.equal(tree.children.length, 4);
  assert.equal(tree.children[0]!.literal.literalType, "Match");
  assert.equal(tree.children[1]!.literal.literalType, "Assert");
  assert.equal(tree.children[2]!.literal.literalType, "Ask");
  assert.equal(tree.children[3]!.literal.literalType, "Constrain");
  console.log("PASS: all prefixes");
}

// siblings and nested children
{
  const tree = ok("- a\n  - x\n    - p\n    - q\n  - y\n- b");
  assert.equal(tree.children.length, 2);
  const a = tree.children[0]!;
  assert.deepEqual(a.literal.atom.terms, [{ tag: "Symbol", name: "a" }]);
  assert.equal(a.children.length, 2);
  const x = a.children[0]!;
  assert.equal(x.children.length, 2);
  assert.deepEqual(x.children[0]!.literal.atom.terms, [{ tag: "Symbol", name: "p" }]);
  assert.deepEqual(x.children[1]!.literal.atom.terms, [{ tag: "Symbol", name: "q" }]);
  assert.deepEqual(a.children[1]!.literal.atom.terms, [{ tag: "Symbol", name: "y" }]);
  assert.deepEqual(tree.children[1]!.literal.atom.terms, [{ tag: "Symbol", name: "b" }]);
  console.log("PASS: siblings and nested children");
}

// blank lines are skipped
{
  const tree = ok("\n- a\n\n- b\n");
  assert.equal(tree.children.length, 2);
  console.log("PASS: blank lines skipped");
}

// variable vs symbol
{
  const tree = ok("- foo X bar Y");
  assert.deepEqual(tree.children[0]!.literal.atom.terms, [
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
  assert.deepEqual(tree.children[0]!.id, { tag: "Variable", name: "1" });
  assert.deepEqual(tree.children[1]!.id, { tag: "Variable", name: "2" });
  console.log("PASS: id assignment");
}

// parses example.sl
{
  const input = readFileSync(join(__dir, "../../example.sl"), "utf8");
  const tree = ok(input);
  assert(tree.children.length > 0);
  const first = tree.children[0]!;
  assert.equal(first.literal.literalType, "Match");
  assert.deepEqual(first.literal.atom.terms, [{ tag: "Symbol", name: "turn" }]);
  assert.equal(first.children.length, 3);
  const activate = first.children[0]!;
  assert.deepEqual(activate.literal.atom.terms, [{ tag: "Symbol", name: "activate" }]);
  assert.equal(activate.children.length, 3);
  assert.equal(first.children[1]!.literal.literalType, "Assert");
  assert.equal(first.children[2]!.literal.literalType, "Assert");
  console.log("PASS: parses example.sl");
}

// roundtrip: format → parse → format is stable
{
  const input = readFileSync(join(__dir, "../../example.sl"), "utf8");
  const tree1 = ok(input);
  const formatted = tree1.children.map((t) => formatTree(t)).join("\n");
  const tree2 = ok(formatted);
  const formatted2 = tree2.children.map((t) => formatTree(t)).join("\n");
  assert.equal(formatted, formatted2);
  console.log("PASS: format roundtrip stable");
}

// nested atom term
{
  const tree = ok("- foo (bar Baz) X");
  const terms = tree.children[0]!.literal.atom.terms;
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
  const terms = tree.children[0]!.literal.atom.terms;
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
  const formatted = tree1.children.map((t) => formatTree(t)).join("\n");
  const tree2 = ok(formatted);
  assert.deepEqual(tree1.children[0]!.literal.atom, tree2.children[0]!.literal.atom);
  console.log("PASS: atom roundtrip");
}

// explicit id syntax: -[Id] foo
{
  const tree = ok("-[Id] foo");
  const node = tree.children[0]!;
  assert.deepEqual(node.id, { tag: "Variable", name: "Id" });
  assert.deepEqual(node.literal.atom.terms, [{ tag: "Symbol", name: "foo" }]);
  console.log("PASS: explicit id syntax -[Id] foo");
}

// explicit id as symbol: -[myid] foo
{
  const tree = ok("-[myid] foo");
  assert.deepEqual(tree.children[0]!.id, { tag: "Symbol", name: "myid" });
  console.log("PASS: explicit id as symbol");
}

// explicit id as atom: -[(id r1 X)] foo
{
  const tree = ok("-[(id r1 X)] foo");
  const id = tree.children[0]!.id;
  assert.equal(id.tag, "Atom");
  if (id.tag === "Atom") {
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

console.log("All parse tests passed.");
