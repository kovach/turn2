import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../v2/parse.js";
import type { Program, Rule, RuleAtom } from "../v2/types.js";

const __dir = dirname(fileURLToPath(import.meta.url));

function ok(input: string): Program {
  const p = parse(input);
  assert(!("message" in p), `parse error: ${JSON.stringify(p)}`);
  return p;
}

function atom(a: RuleAtom): Extract<RuleAtom, { tag: "Atom" }> {
  if (a.tag !== "Atom") throw new Error(`expected Atom, got ${a.tag}`);
  return a;
}

function sub(a: RuleAtom): Extract<RuleAtom, { tag: "Sub" }> {
  if (a.tag !== "Sub") throw new Error(`expected Sub, got ${a.tag}`);
  return a;
}

// 1) basic match-only rule
{
  const p = ok("play-card E\nit E Card\n~ move Card play-area\n");
  assert.equal(p.rules.length, 1);
  const r = p.rules[0]!;
  assert.equal(r.body.length, 3);
  assert.equal(atom(r.body[0]!).marker, "match");
  assert.deepEqual(atom(r.body[0]!).atom.terms, [
    { tag: "Symbol", name: "play-card" },
    { tag: "Variable", name: "E" },
  ]);
  assert.equal(atom(r.body[2]!).marker, "episode");
  console.log("PASS: basic match + episode rule");
}

// 2) comma-separated equivalence
{
  const a = ok("play-card E\nit E Card\n~ move Card play-area\n");
  const b = ok("play-card E, it E Card, ~ move Card play-area\n");
  assert.equal(a.rules.length, b.rules.length);
  assert.equal(a.rules[0]!.body.length, b.rules[0]!.body.length);
  for (let i = 0; i < 3; i++) {
    assert.equal(atom(a.rules[0]!.body[i]!).marker, atom(b.rules[0]!.body[i]!).marker);
  }
  console.log("PASS: newline and comma are equivalent");
}

// 3) blank-line rule separation
{
  const p = ok("foo\n\nbar\n");
  assert.equal(p.rules.length, 2);
  console.log("PASS: blank line separates rules");
}

// 4) sub-rule with sequence
{
  const p = ok("foo\n  ( ~ e1 );\n  ~ e2\n");
  assert.equal(p.rules.length, 1);
  const r = p.rules[0]!;
  assert.equal(r.body.length, 3);
  const s = sub(r.body[1]!);
  assert.equal(s.sequence, true);
  assert.equal(s.body.length, 1);
  assert.equal(atom(s.body[0]!).marker, "episode");
  assert.equal(atom(r.body[2]!).marker, "episode");
  console.log("PASS: sub-rule with sequencing");
}

// 5) sub-rule plain
{
  const p = ok("foo\n  ( bar X )\n  + baz X\n");
  const r = p.rules[0]!;
  const s = sub(r.body[1]!);
  assert.equal(s.sequence, false);
  assert.equal(s.body.length, 1);
  console.log("PASS: plain sub-rule");
}

// 6) weighted assert
{
  const p = ok("+ points -> 3\n");
  const a = atom(p.rules[0]!.body[0]!);
  assert.equal(a.marker, "fact");
  assert.deepEqual(a.atom.terms, [{ tag: "Symbol", name: "points" }]);
  assert.deepEqual(a.weight, { tag: "Symbol", name: "3" });
  console.log("PASS: weighted assert (+)");
}

// 7) weighted match
{
  const p = ok("points -> N\n");
  const a = atom(p.rules[0]!.body[0]!);
  assert.equal(a.marker, "match");
  assert.deepEqual(a.weight, { tag: "Variable", name: "N" });
  console.log("PASS: weighted match");
}

// 8) schema decl
{
  const p = ok("% points -> sum\n+ points -> 3\n");
  assert.equal(p.schema.get("points"), "sum");
  assert.equal(p.rules.length, 1);
  console.log("PASS: schema decl");
}

// 9) compound term
{
  const p = ok("foo (bar X) Y\n");
  const a = atom(p.rules[0]!.body[0]!);
  assert.equal(a.atom.terms.length, 3);
  const inner = a.atom.terms[1]!;
  assert(inner.tag === "Atom");
  assert.deepEqual(inner.atom.terms, [
    { tag: "Symbol", name: "bar" },
    { tag: "Variable", name: "X" },
  ]);
  console.log("PASS: compound term in atom");
}

// 10) wildcard and underscore variable
{
  const p = ok("foo _ _bar\n");
  const a = atom(p.rules[0]!.body[0]!);
  assert.deepEqual(a.atom.terms, [
    { tag: "Symbol", name: "foo" },
    { tag: "Wildcard" },
    { tag: "Variable", name: "_bar" },
  ]);
  console.log("PASS: wildcard and underscore variable");
}

// 11) the activate example with sub-rules — one rule
{
  const src = `
activate A
it A call-to-guard
target A T

  ( ~ gather G
    it G X
    to G To
    ! dahan X
    + is To T )

  ( at D T
    dahan D
    ~ defend D1
    it D1 I
    amount D1 A
    + is I T
    + is A 1 )
`;
  const p = ok(src);
  assert.equal(p.rules.length, 1, `expected 1 rule, got ${p.rules.length}`);
  const r = p.rules[0]!;
  assert.equal(r.body.length, 5);
  assert.equal(sub(r.body[3]!).body.length, 5);
  assert.equal(sub(r.body[4]!).body.length, 7);
  console.log("PASS: activate example as one rule");
}

// 12) tutorial program parses end-to-end
{
  const src = readFileSync(join(__dir, "..", "..", "..", "notes", "turn-program-1.t"), "utf8");
  const p = parse(src);
  if ("message" in p) {
    throw new Error(`tutorial parse error at line ${p.line}: ${p.message}`);
  }
  assert(p.rules.length > 0);
  console.log(`PASS: tutorial program parses (${p.rules.length} rules, ${p.schema.size} schema decls)`);
}

console.log("ALL v2 parse tests passed");
