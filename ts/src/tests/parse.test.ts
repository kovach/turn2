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
  if (result.tag === "Equal" || result.tag === "Ask") throw new Error("ok: top-level Equal/Ask is impossible");
  return result;
}

// Walk into known body-bearing children. Tests construct Tree literals from
// `parse()` whose top-level wrapper is always Match-tagged. Equal/Ask nodes
// can appear as leaves, so descending past one is a test bug — this helper
// makes that explicit.
function kid(t: BodyTree, ...path: number[]): BodyTree {
  let cur: Tree = t;
  for (const i of path) {
    if (cur.tag === "Equal" || cur.tag === "Ask") throw new Error(`${cur.tag} has no children`);
    const next: Tree | undefined = cur.children[i];
    if (next === undefined) throw new Error(`no child at ${i}`);
    cur = next;
  }
  if (cur.tag === "Equal" || cur.tag === "Ask") throw new Error("expected body-bearing node");
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
  const tree = ok("- a\n+ b\n? C\n! d\n< e\n= f g");
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

// `?` line with a non-Variable term (head symbol) is rejected
{
  const result = parse("? foo X");
  assert("message" in result);
  const msg = (result as { message: string }).message;
  assert.ok(msg.includes("variable"), `expected variable-only error, got: ${msg}`);
  console.log("PASS: `? <symbol>` rejected");
}

// `?` line with no variables (just symbols) is also rejected
{
  const result = parse("? ask");
  assert("message" in result);
  console.log("PASS: `? ask` (single symbol) rejected");
}

// `?` line cannot have indented children
{
  const result = parse("? A\n  + bar");
  assert("message" in result);
  const msg = (result as { message: string }).message;
  assert.ok(msg.includes("?"), `expected '?' error, got: ${msg}`);
  console.log("PASS: `?` line cannot have child nodes");
}

// `?` line with only variables is fine
{
  const tree = ok("? A B");
  const ask = tree.children[0]!;
  assert.equal(ask.tag, "Ask");
  console.log("PASS: `? A B` parses");
}

// Tokens starting with `_` are reserved (rejected at parse time)
{
  const result = parse("+ _foo");
  assert("message" in result);
  const msg = (result as { message: string }).message;
  assert.ok(msg.includes("reserved"), `expected reserved-token error, got: ${msg}`);
  console.log("PASS: `_`-prefixed token rejected in atom");
}

// Bare wildcard `_` still works
{
  const tree = ok("- foo _");
  console.log("PASS: bare `_` wildcard still parses");
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
  const formatted = formatTree(tree1);
  const tree2 = ok(formatted);
  const formatted2 = formatTree(tree2);
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
  const formatted = formatTree(tree1);
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

// `(@id …)` produces an `Id`-tagged term; round-trips through formatTree.
{
  const tree = ok("+ is X (@id r1 id1 X)");
  const assertNode = tree.children[0]!;
  assert.equal(assertNode.tag, "Assert");
  const idTerm = treeAtomTerms(assertNode)[2];
  assert.equal(idTerm?.tag, "Id", "third term should be Id-tagged");
  if (idTerm?.tag === "Id") {
    assert.deepEqual(idTerm.atom.terms, [
      { tag: "Symbol", name: "r1" },
      { tag: "Symbol", name: "id1" },
      { tag: "Variable", name: "X" },
    ]);
  }
  // Format and reparse — should still be Id-tagged with same body.
  const formatted = formatTree(tree);
  assert.match(formatted, /\(@id /, "formatTree should emit @id notation");
  const reparsed = parse(formatted);
  assert("tag" in reparsed);
  if ("tag" in reparsed) {
    const reTerm = treeAtomTerms(treeChildren(reparsed)[0]!)[2];
    assert.equal(reTerm?.tag, "Id", "round-trip should preserve Id tag");
  }
  console.log("PASS: (@id …) parses to Id-tagged term and round-trips");
}

// Plain `(id …)` (no `@`) stays Atom-tagged — only `@id` flips the tag.
{
  const tree = ok("+ is X (id r1 X)");
  const assertNode = tree.children[0]!;
  const inner = treeAtomTerms(assertNode)[2];
  assert.equal(inner?.tag, "Atom");
  console.log("PASS: plain `(id …)` stays Atom-tagged");
}

// Round-trip property: parse(formatTree(parse(s))) = parse(s).
// Holds for inputs without comments or blank lines (which would shift line
// numbers and thus the auto-Variable ids the parser assigns to nodes
// without an explicit `[Id]` binder).
{
  const inputs: string[] = [
    "- foo",
    "- foo\n  + bar",
    "+ a\n+ b\n+ c",
    "-[X] foo X\n  + bar X",
    "- foo (bar Baz (qux)) X",
    "+ is X (@id r1 id1 X)",
    "= X Y",
    "?\n+ done",
    "- trigger\n  ? A B\n  + got A B",
    "# sum X -> Total\n  - t X",
    "- (a (b c))",
    "-[Cell] cell R C\n  -[T] turn\n    + eligible T Cell",
  ];
  for (const s of inputs) {
    const tree1 = ok(s);
    const tree2 = ok(formatTree(tree1));
    assert.deepEqual(tree2, tree1, `round-trip failed for input:\n${s}`);
  }
  console.log(`PASS: parse(formatTree(parse(s))) = parse(s) for ${inputs.length} inputs`);
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
  const formatted = formatTree(tree1);
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
  if (p0.tag === "Equal" || p0.tag === "Ask" || p1.tag === "Equal" || p1.tag === "Ask") throw new Error("expected body-bearing patterns");
  // First pattern: lines 1-2
  assert.deepEqual(kid(p0, 0).span, { line: 1 });
  assert.deepEqual(kid(p0, 0, 0).span, { line: 2 });
  // Second pattern: lines 4-5
  assert.deepEqual(kid(p1, 0).span, { line: 4 });
  assert.deepEqual(kid(p1, 0, 0).span, { line: 5 });
  console.log("PASS: parsePatterns adjusts spans for multi-pattern files");
}

// rule names: ': foo' bakes 'foo' into positive id atoms
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(": foo\n+ bar");
  assert(!("message" in result));
  const patterns = result as Tree[];
  assert.equal(patterns.length, 1);
  const p = patterns[0]!;
  if (p.tag === "Equal" || p.tag === "Ask") throw new Error("expected body-bearing");
  assert.equal(p.ruleName, "foo");
  const child = kid(p, 0);
  assert.equal(child.tag, "Assert");
  // After idExpand: positive id is `(id <fullName> id1)` with no prev vars.
  // fullName = "_r#foo" (default nameSegments ["_r"] + base "foo").
  assert.equal(child.id.tag, "Id");
  if (child.id.tag !== "Id") throw new Error("expected Id");
  const idTerms = child.id.atom.terms;
  assert.deepEqual(idTerms[0], { tag: "Symbol", name: "id" });
  assert.deepEqual(idTerms[1], { tag: "Symbol", name: "_r#foo" });
  console.log("PASS: ': foo' bakes name into id atom");
}

// rule names: unnamed rules still get auto names (auto counter independent)
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(": foo\n+ a\n\n+ b\n\n: bar\n+ c\n\n+ d");
  assert(!("message" in result));
  const patterns = result as Tree[];
  assert.equal(patterns.length, 4);
  const names = patterns.map((p) => {
    if (p.tag === "Equal" || p.tag === "Ask") throw new Error("nope");
    const c = kid(p, 0);
    if (c.id.tag !== "Id") throw new Error("expected Id");
    return (c.id.atom.terms[1] as { tag: "Symbol"; name: string }).name;
  });
  // foo, _r#1, bar, _r#2 — explicit names don't consume auto counter slots.
  assert.deepEqual(names, ["_r#foo", "_r#1", "_r#bar", "_r#2"]);
  console.log("PASS: explicit names don't consume auto counter");
}

// rule names: duplicate explicit name is an error
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(": foo\n+ a\n\n: foo\n+ b");
  assert("message" in result);
  assert.match(result.message, /duplicate rule name 'foo'/);
  assert.equal(result.line, 4);
  console.log("PASS: duplicate rule name is error");
}

// rule names: ':' not first content line is an error
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns("+ a\n: foo");
  assert("message" in result);
  console.log("PASS: ':' after content is error");
}

// rule names: ':' with no token
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(":\n+ a");
  assert("message" in result);
  assert.match(result.message, /requires a name token/);
  console.log("PASS: ':' with no token is error");
}

// rule names: ':' with multiple tokens
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(": foo bar\n+ a");
  assert("message" in result);
  assert.match(result.message, /exactly one name token/);
  console.log("PASS: ':' with multiple tokens is error");
}

// rule names: reserved-shape names rejected
{
  const { parsePatterns } = await import("../parse.js");
  for (const [src, pat] of [
    [": _foo\n+ a", /reserved/],
    [": 42\n+ a", /all digits/],
    [": foo#bar\n+ a", /'#'/],
  ] as const) {
    const result = parsePatterns(src);
    assert("message" in result, `expected error for ${src}`);
    assert.match(result.message, pat);
  }
  console.log("PASS: reserved-shape rule names rejected");
}

// rule names: indented child under ':' is an error
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(": foo\n  + a");
  assert("message" in result);
  assert.match(result.message, /cannot have child nodes/);
  console.log("PASS: indented child under ':' is error");
}

// rule names: round-trip via formatTree
{
  const { parsePatterns, formatTree } = await import("../parse.js");
  const src = ": foo\n+ a\n";
  const result = parsePatterns(src);
  assert(!("message" in result));
  const patterns = result as Tree[];
  // formatTree on the chunk root re-emits the `: foo` line plus children.
  // patterns are post-idExpand, so positive ids are spelled out — but the
  // `: foo` header must be present on the chunk root.
  const formatted = formatTree(patterns[0]!);
  assert(formatted.startsWith(": foo\n"), `expected ': foo' header, got ${JSON.stringify(formatted)}`);
  console.log("PASS: ': name' round-trips via formatTree");
}

// rule names: comments around ':' are skipped
{
  const { parsePatterns } = await import("../parse.js");
  // Comments before, between, and after ':' should not interfere.
  const result = parsePatterns("/ leading comment\n: foo\n/ between\n- bar");
  assert(!("message" in result));
  const patterns = result as Tree[];
  assert.equal(patterns.length, 1);
  const p = patterns[0]!;
  if (p.tag === "Equal" || p.tag === "Ask") throw new Error("nope");
  assert.equal(p.ruleName, "foo");
  const c = kid(p, 0);
  assert.deepEqual(c.atom.terms, [{ tag: "Symbol", name: "bar" }]);
  console.log("PASS: comments around ':' are transparent");
}

// rule names: nameSegments parameter joins with '#'
{
  const { parsePatterns } = await import("../parse.js");
  const result = parsePatterns(": foo\n+ a", ["ns1", "ns2"]);
  assert(!("message" in result));
  const patterns = result as Tree[];
  const p = patterns[0]!;
  if (p.tag === "Equal" || p.tag === "Ask") throw new Error("nope");
  const c = kid(p, 0);
  if (c.id.tag !== "Id") throw new Error("expected Id");
  assert.deepEqual(c.id.atom.terms[1], { tag: "Symbol", name: "ns1#ns2#foo" });
  console.log("PASS: nameSegments joined with '#'");
}

console.log("All parse tests passed.");
