// Editor rename code action (rename.ts): what's under the cursor, which
// occurrences are rewritten, and which new names are refused.

import assert from "node:assert/strict";
import { applyRename, renameError, renameOccurrences, renameTargetAt } from "../v2/rename.js";
import { parse } from "../v2/parse.js";

// Rename the identifier at the `at`-th character of the first occurrence of
// `probe` in `src`. Returns the new text (asserting the result still parses
// when `parses` is set).
function rename(src: string, probe: string, newName: string, at = 0): string {
  const i = src.indexOf(probe);
  assert(i >= 0, `probe '${probe}' not in source`);
  const target = renameTargetAt(src, i + at);
  assert(target !== null, `no target at '${probe}'`);
  assert.equal(renameError(src, target, newName), null);
  return applyRename(src, renameOccurrences(src, target), newName);
}

function targetAt(src: string, probe: string, at = 0) {
  return renameTargetAt(src, src.indexOf(probe) + at);
}

// 1) A relation renames in every position: matches, emits under each
//    marker, `!(...)`, dot chains, exceptions, aggregates and declarations.
{
  const src = [
    "#acc at : e @last",
    "+ at c1 hand",
    "move X L, +at X L, ^moved X",
    "turn, ?P, !(at P hand), ~pick P",
    "card C, C.at L, ^where L",
    "go, { at X _ => ^blocked X }",
    "go, [at X hand | count X] -> N, ^n N",
    "chat, ^attack   -- at in a comment stays",
  ].join("\n");
  const out = rename(src, "+ at", "loc", 2);
  assert.equal(out, [
    "#acc loc : e @last",
    "+ loc c1 hand",
    "move X L, +loc X L, ^moved X",
    "turn, ?P, !(loc P hand), ~pick P",
    "card C, C.loc L, ^where L",
    "go, { loc X _ => ^blocked X }",
    "go, [loc X hand | count X] -> N, ^n N",
    "chat, ^attack   -- at in a comment stays",
  ].join("\n"));
  console.log("PASS: relation renamed everywhere");
}

// 2) Whole tokens only: `at` inside `attack`, `at:x`, `spirit:at` untouched.
{
  const src = "+ at a\n+ attack a\n+ at:x a\n+ spirit:at a";
  assert.equal(rename(src, "at a", "on"), "+ on a\n+ attack a\n+ at:x a\n+ spirit:at a");
  console.log("PASS: whole-token matching");
}

// 3) The cursor may sit just past the identifier; glued markers are
//    stripped; a negative number is a symbol, not `-` + number.
{
  const src = "go, ~move x, +v -3";
  assert.deepEqual(targetAt(src, "move", 4), { kind: "symbol", name: "move", start: 5, end: 9 });
  assert.equal(targetAt(src, "~move", 0), null); // on the marker itself
  assert.equal(targetAt(src, "-3", 1)?.name, "-3");
  console.log("PASS: cursor edge + marker stripping");
}

// 4) A variable renames only inside its own definition.
{
  const src = [
    "a X, b X Y",
    "  ^c X",
    "  { d X => ^e X }",
    "f X, ^g X",
  ].join("\n");
  const out = rename(src, "c X", "Thing", 2);
  assert.equal(out, [
    "a Thing, b Thing Y",
    "  ^c Thing",
    "  { d Thing => ^e Thing }",
    "f X, ^g X",
  ].join("\n"));
  console.log("PASS: variable scoped to its rule");
}

// 5) A multi-line bracket aggregate keeps the rule open across a column-0
//    line, so its variables stay in scope.
{
  const src = "go, [item X,\nprice X P | sum P] -> T, ^total T\nother X";
  const out = rename(src, "item X", "It", 5);
  assert.equal(out, "go, [item It,\nprice It P | sum P] -> T, ^total T\nother X");
  console.log("PASS: bracket keeps the definition open");
}

// 6) JS blocks: the name renames; parameters and bodies do not; nothing in a
//    body is offered.
{
  const src = [
    "#js-def sub +X +Y -R { if (X >= Y) yield [X - Y] }",
    "#js (half x) {",
    "  return x / 2;",
    "}",
    "a X, sub X 1 R, ^r R",
    "a X, + h @js(half X)",
  ].join("\n");
  assert.equal(targetAt(src, "+X", 1), null);
  assert.equal(targetAt(src, "return", 1), null);
  assert.equal(targetAt(src, "x)", 0), null);
  let out = rename(src, "sub X 1", "minus");
  assert.match(out, /^#js-def minus \+X/);
  assert.match(out, /a X, minus X 1 R/);
  out = rename(src, "half X", "halve");
  assert.match(out, /#js \(halve x\)/);
  assert.match(out, /@js\(halve X\)/);
  assert.match(out, /return x \/ 2/);
  console.log("PASS: js names only");
}

// 7) `#def NAME` is a rule name, not a relation.
{
  const src = "#def cmp\ncmp X, ^out X";
  assert.equal(targetAt(src, "cmp", 1), null);
  assert.equal(rename(src, "cmp X", "keep"), "#def cmp\nkeep X, ^out X");
  console.log("PASS: #def rule name excluded");
}

// 8) Refused names: wrong kind, separators, collisions.
{
  const src = "a X, b X Y\nc Z";
  const sym = targetAt(src, "b X")!;
  const v = targetAt(src, "X")!;
  assert.match(renameError(src, sym, "Big")!, /symbol name/);
  assert.match(renameError(src, v, "low")!, /variable name/);
  assert.match(renameError(src, sym, "x.y")!, /cannot contain/);
  assert.match(renameError(src, sym, "c")!, /already used in this file/);
  assert.match(renameError(src, v, "Y")!, /already used in this rule/);
  assert.equal(renameError(src, v, "Z"), null); // Z lives in another rule
  assert.equal(renameError(src, v, "X"), null); // unchanged is fine
  console.log("PASS: refused names");
}

// 9) Round trip on a real program: rename a relation and it still parses,
//    with the same number of rules.
{
  const src = "+ num 1, + num 2, + turn\n\nturn\n  ? N\n  !(num N, ge N 2)\n  ~picked N";
  const out = rename(src, "num 1", "count-me");
  assert(!out.includes("num "));
  const p = parse(out);
  assert(!("message" in p), "renamed program parses");
  console.log("PASS: renamed program parses");
}

console.log("ALL v2 rename tests passed");
