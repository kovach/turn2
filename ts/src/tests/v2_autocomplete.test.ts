import assert from "node:assert/strict";
import { isSymbolToken, isVariableToken } from "../v2/parse.js";
import {
  collectProgramSymbols,
  collectRuleVariables,
  completions,
  partialTokenAt,
  suggestionsFor,
} from "../v2/autocomplete.js";

// --- completions() ranking (spec table) -------------------------------------
{
  // Document order: foo, fbar, foo-b-ar.
  const syms = ["foo", "fbar", "foo-b-ar"];
  assert.deepEqual(completions("fo", syms), ["foo", "foo-b-ar"]);
  assert.deepEqual(completions("fb", syms), ["fbar", "foo-b-ar"]);
  assert.deepEqual(completions("ba", syms), ["fbar", "foo-b-ar"]);
  assert.deepEqual(completions("foo", syms), []); // exact match suppresses
  console.log("PASS: completions spec table");
}

// strict-prefix matches rank before subsequence matches
{
  // `ab` is a strict prefix of "abc" and a subsequence of "axb".
  assert.deepEqual(completions("ab", ["axb", "abc"]), ["abc", "axb"]);
  console.log("PASS: strict before subsequence");
}

// dedup + 5-item cap
{
  const many = ["fa", "fb", "fc", "fd", "fe", "ff", "fg"];
  assert.deepEqual(completions("f", [...many, "fa"]).length, 5);
  assert.deepEqual(completions("f", [...many, "fa"]), ["fa", "fb", "fc", "fd", "fe"]);
  console.log("PASS: dedup + cap");
}

// empty prefix -> nothing
{
  assert.deepEqual(completions("", ["foo"]), []);
  console.log("PASS: empty prefix");
}

// --- token predicates -------------------------------------------------------
{
  assert.equal(isSymbolToken("foo"), true);
  assert.equal(isSymbolToken("foo-bar"), true);
  assert.equal(isSymbolToken("Foo"), false);
  assert.equal(isSymbolToken("_"), false);
  assert.equal(isSymbolToken("_X"), false);
  assert.equal(isSymbolToken(""), false);

  assert.equal(isVariableToken("Foo"), true);
  assert.equal(isVariableToken("_X"), true);
  assert.equal(isVariableToken("_"), false); // bare _ is a Wildcard
  assert.equal(isVariableToken("foo"), false);
  assert.equal(isVariableToken(""), false);
  console.log("PASS: token predicates");
}

// --- symbol extraction (incl. parse-failure) --------------------------------
{
  const text = "+ play-card C\n- card C\n+ note foo-bar X";
  const syms = collectProgramSymbols(text);
  for (const s of ["play-card", "card", "note", "foo-bar"]) {
    assert.ok(syms.has(s), `expected symbol ${s}`);
  }
  assert.ok(!syms.has("C"), "variables excluded");
  assert.ok(!syms.has("X"), "variables excluded");
  console.log("PASS: symbol extraction");
}

{
  // Does not parse as a program (dangling `(`), but symbols still extracted.
  const text = "+ foo (bar baz";
  const syms = collectProgramSymbols(text);
  for (const s of ["foo", "bar", "baz"]) assert.ok(syms.has(s), `expected ${s}`);
  console.log("PASS: symbols survive parse failure");
}

{
  // `*`-headed compiler-internal symbols excluded; commands not offered.
  const text = "#acc p : e @count\n+ q (a b)";
  const syms = collectProgramSymbols(text);
  assert.ok(syms.has("p"));
  assert.ok(syms.has("q"));
  assert.ok(syms.has("a"));
  for (const s of [...syms]) assert.ok(!s.startsWith("*"), `unexpected internal ${s}`);
  console.log("PASS: internal/command symbols excluded");
}

{
  // `#acc` contributes its head relation name even when the relation is never
  // otherwise written; its column types and `#def`/`#js` names are not mined.
  const text = "#acc lonely : place @count\n#def helper\n#js (jsfn x) { return x }";
  const syms = collectProgramSymbols(text);
  assert.ok(syms.has("lonely"), "acc head relation collected");
  assert.ok(!syms.has("count"), "op not collected");
  assert.ok(!syms.has("place"), "column type not collected");
  assert.ok(!syms.has("helper"), "#def name not collected");
  assert.ok(!syms.has("jsfn"), "#js name not collected");
  console.log("PASS: acc head relation collected");
}

// --- variable extraction scoped to the rule ---------------------------------
{
  // Two whitespace-separated rules; X is in rule 1, Y in rule 2.
  const text = "+ foo X\n  + bar X\n\n+ baz Y\n  + qux Y\n";
  const r1 = collectRuleVariables(text, 1);
  assert.ok(r1 && r1.has("X"), "rule 1 has X");
  assert.ok(r1 && !r1.has("Y"), "rule 1 excludes Y");

  const r2 = collectRuleVariables(text, 4);
  assert.ok(r2 && r2.has("Y"), "rule 2 has Y");
  assert.ok(r2 && !r2.has("X"), "rule 2 excludes X");
  console.log("PASS: rule-scoped variables");
}

{
  // Variable completion disabled when the program does not parse.
  assert.equal(collectRuleVariables("+ foo (bar", 1), null);
  console.log("PASS: variables null on parse failure");
}

// --- suggestionsFor dispatch ------------------------------------------------
{
  const text = "+ play-card C\n- card C\n";
  // symbol token -> program symbols
  assert.deepEqual(suggestionsFor(text, "pl", 1), ["play-card"]);
  // variable token -> rule variables (C present, so `C` is exact -> none;
  // use a partial that is a subsequence)
  assert.deepEqual(suggestionsFor(text, "C", 1), []); // exact
  console.log("PASS: suggestionsFor dispatch");
}

// --- masking the in-progress token (mirrors Editor.updateAutocomplete) ------
// The token being typed is part of the text; the editor blanks it out (same
// length) before collecting candidates so it doesn't exact-match itself.
function maskedSuggest(text: string, start: number, end: number, line: number): string[] {
  const token = text.slice(start, end);
  const masked = text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
  return suggestionsFor(masked, token, line);
}
{
  // A symbol appears once elsewhere; user is mid-typing `pl` on line 2.
  const text = "+ play-card e1\n+ pl";
  const start = text.length - 2, end = text.length; // the `pl`
  assert.deepEqual(maskedSuggest(text, start, end, 2), ["play-card"]);

  // Without masking, the bug: `pl` collects itself and self-suppresses.
  assert.deepEqual(suggestionsFor(text, "pl", 2), []);

  // Variable being typed toward an existing one in the same rule.
  const vtext = "+ foo Xyz\n  + bar Xy";
  const vstart = vtext.length - 2, vend = vtext.length; // the `Xy`
  assert.deepEqual(maskedSuggest(vtext, vstart, vend, 2), ["Xyz"]);

  // A fully-typed token matching another occurrence stays suppressed.
  const ctext = "+ play-card e1\n+ play-card";
  assert.deepEqual(maskedSuggest(ctext, ctext.length - 9, ctext.length, 2), []);
  console.log("PASS: token masking");
}

// --- partialTokenAt: the token under the cursor -----------------------------
{
  // Marker glued to the token at the line start is stripped.
  assert.deepEqual(partialTokenAt("+fo", 3), { text: "fo", start: 1, end: 3 });
  // ...and equally when the atom is not the first on its line (the bug: the
  // strip used to apply only at the line's first column, so `+fo` was looked
  // up verbatim and matched nothing).
  const t = "+item sceptre, +fo";
  assert.deepEqual(partialTokenAt(t, t.length), { text: "fo", start: t.length - 2, end: t.length });
  const u = "  a X, ^fo";
  assert.deepEqual(partialTokenAt(u, u.length), { text: "fo", start: u.length - 2, end: u.length });
  // Every marker char is stripped; a bare marker alone is no token.
  for (const m of ["-", "~", "+", "^", "!", "?"]) {
    assert.deepEqual(partialTokenAt(`x, ${m}ab`, 6), { text: "ab", start: 4, end: 6 });
    assert.equal(partialTokenAt(`x, ${m}`, 4), null);
  }
  // A `-` inside a token is not a marker.
  assert.deepEqual(partialTokenAt("x, foo-b", 8), { text: "foo-b", start: 3, end: 8 });
  // Separators end the run; parens count as separators.
  assert.deepEqual(partialTokenAt("p (ab", 5), { text: "ab", start: 3, end: 5 });
  // Not at a token's right edge, or nothing to the left: no token.
  assert.equal(partialTokenAt("foo", 1), null);
  assert.equal(partialTokenAt("foo ", 4), null);
  assert.equal(partialTokenAt("", 0), null);
  // End-to-end through the masked lookup the editor performs.
  const text = "+item sceptre, +fo";
  const tok = partialTokenAt(text, text.length)!;
  assert.deepEqual(maskedSuggest(text, tok.start, tok.end, 1), []); // no `fo…` symbol yet
  const text2 = "+item foo\n+item sceptre, +fo";
  const tok2 = partialTokenAt(text2, text2.length)!;
  assert.deepEqual(maskedSuggest(text2, tok2.start, tok2.end, 2), ["foo"]);
  console.log("PASS: partialTokenAt");
}

console.log("ALL v2 autocomplete tests passed");
