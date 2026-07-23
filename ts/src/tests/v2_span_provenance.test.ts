// Atom-granular source spans (plans/v2-atom-span-provenance.md): the parser
// stamps startCol/endCol on every atom / equal / exception token, fragment
// re-parses (exception RHS) are re-based onto true source columns, and every
// Emit in an expanded program carries a column-bearing span whose extent
// slices tight (non-padded) text out of its source line.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { expand } from "../v2/expand.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Span } from "../v2/term.js";
import type { Program, Rule, RuleAtom } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function sliceSpan(lines: string[], s: Span): string {
  assert.ok(s.startCol !== undefined && s.endCol !== undefined, `span ${s.line} has no columns`);
  return lines[s.line - 1]!.slice(s.startCol, s.endCol);
}

// 1) Two emitting atoms on one line get distinct, exact column extents;
// the marker char is included.
{
  const src = `~setup\nsetup, ^p a,   +marked a`;
  const lines = src.split("\n");
  const rules = ok(src).rules;
  const atoms: RuleAtom[] = rules.flatMap((r: Rule) => r.body);
  const emitting = atoms.filter((a) => a.tag === "Atom" && a.marker !== "match");
  const texts = emitting.map((a) => sliceSpan(lines, a.span));
  assert.deepEqual(texts, ["~setup", "^p a", "+marked a"], `got ${JSON.stringify(texts)}`);
  console.log("PASS: atom tokens carry exact column extents");
}

// 2) Equal atoms span their whole `= a b` text including the `=`.
{
  const src = `foo X, = X y, ^out X`;
  const rules = ok(src).rules;
  const eq = rules[0]!.body.find((a) => a.tag === "Equal")!;
  assert.equal(sliceSpan(src.split("\n"), eq.span), "= X y");
  console.log("PASS: equal atoms include the '='");
}

// 3) Exception blocks: the item spans the whole `{...}`; RHS atoms are
// re-based from fragment-relative to true source columns (the offset fix —
// without it these columns point at the start of the line).
{
  const src = `~ctx\n\nctx, ^p a\n\n#def r\n  ctx\n  {p X => ~handled X, +logged X}`;
  const lines = src.split("\n");
  const prog = ok(src);
  const exc = prog.rules.flatMap((r) => r.body).find((a) => a.tag === "Exception");
  assert.ok(exc !== undefined, "no Exception item parsed");
  assert.equal(sliceSpan(lines, exc.span), "{p X => ~handled X, +logged X}");
  const rhsTexts = exc.right
    .filter((a): a is Extract<RuleAtom, { tag: "Atom" }> => a.tag === "Atom")
    .map((a) => sliceSpan(lines, a.span));
  assert.deepEqual(rhsTexts, ["~handled X", "+logged X"], `got ${JSON.stringify(rhsTexts)}`);

  // End-to-end: the tuples the exception rule emits carry the RHS atoms'
  // spans through fixpoint into store.tupleSource.
  const { store } = runFixpoint(prog);
  let checked = 0;
  for (let i = 0; i < store.tuples.length; i++) {
    const head = store.tuples[i]!.atom.terms[0];
    if (head?.tag !== "Symbol") continue;
    if (head.name === "handled" || head.name === "logged") {
      const span = store.tupleSource[i];
      assert.ok(span !== undefined, `tuple '${head.name}' has no source span`);
      const want = head.name === "handled" ? "~handled X" : "+logged X";
      assert.equal(sliceSpan(lines, span), want);
      checked++;
    }
  }
  assert.ok(checked >= 2, `expected handled+logged tuples, checked ${checked}`);
  console.log("PASS: exception RHS columns are re-based to source columns");
}

// 4) Invariant: every Emit.span in an expanded program has columns, and the
// extent is tight — the slice is non-empty and unpadded. (Existence alone
// wouldn't catch fragment-relative columns; tightness catches padding bugs.)
{
  const src = [
    "#agg at * -> last",
    "~game",
    "  ( ~step here ); ( ~look )",
    "step L, +at me -> L",
    "look, at me -> L, ^print L, = Z L",
    "who, ?pick a b",
    "guard G, !at G -> 1",
    "~ctx2",
    "ctx2, ^p2 a",
    "#def rx",
    "  ctx2",
    "  {p2 X => ^seen X}",
  ].join("\n");
  const lines = src.split("\n");
  const expanded = expand(ok(src));
  let emits = 0;
  const walk = (body: RuleAtom[]): void => {
    for (const a of body) {
      if (a.tag === "Sub") { walk(a.body); continue; }
      if (a.tag !== "Emit") continue;
      emits++;
      const text = sliceSpan(lines, a.span);
      assert.ok(text.length > 0, `Emit at line ${a.span.line}: empty extent`);
      assert.equal(text, text.trim(), `Emit at line ${a.span.line}: padded extent "${text}"`);
    }
  };
  for (const r of expanded.rules) walk(r.body);
  assert.ok(emits >= 8, `expected a spread of Emits, saw ${emits}`);
  console.log(`PASS: all ${emits} Emit spans carry tight column extents`);
}

console.log("ALL v2 span-provenance tests passed");
