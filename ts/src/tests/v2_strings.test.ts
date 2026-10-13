// String literals (plans/v2-strings-icon-css.md): parsing, equality, the
// source round trip (renderTerm, saved choice rows), the `#js` boundary,
// highlighting, rename, and the display relations read through
// display-rows.ts (icon:name / icon:css as plain tuples and as `#acc`).

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { renderTerm } from "../v2/print.js";
import { tokenOf, type Store } from "../v2/store.js";
import { quoteString, stringValue, str, type Term } from "../v2/term.js";
import { highlightLine } from "../v2/highlight.js";
import { applyRename, renameOccurrences, renameTargetAt } from "../v2/rename.js";
import { runScenario } from "../v2/scenario.js";
import { displayRows, displayText, iconNames, iconStyles, rowsAbout } from "../v2/display-rows.js";
import type { Program } from "../v2/types.js";

function ok(src: string): Program {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}
function err(src: string): string {
  const p = parse(src);
  assert("message" in p, `expected a parse error: ${src}`);
  return p.message;
}
function rows(store: Store, head: string): string[] {
  return (store.byHead.get(head) ?? [])
    .map((i) => store.tuples[i]!.atom.terms.slice(1, -1).map((t) => renderTerm(store, t)).join(" "))
    .sort();
}

const CSS = `"font-size: 32px; color: red -- not a comment, (really). ok/ ; {x} [y]"`;

// 1) Parse, match, render: punctuation and `--` inside a string mean nothing.
{
  const src = [
    "~go",
    `go, +css a ${CSS}, +css b "", +q "say \\"hi\\" \\\\ x", +sym "a"  -- a "comment with a quote`,
    "go, css a S, +got S",
    `go, css a ${CSS}, +same yes`,
    `go, css b "", +empty yes`,
    `go, sym a, +bare-matches-string yes`,
  ].join("\n");
  const { store, status } = runFixpoint(ok(src), 100, 1000);
  assert.equal(status.kind, "done");
  assert.deepEqual(rows(store, "css"), [`a ${CSS}`, `b ""`].sort());
  assert.deepEqual(rows(store, "got"), [CSS], "a variable binds a string");
  assert.deepEqual(rows(store, "same"), ["yes"], "a string pattern matches the equal string");
  assert.deepEqual(rows(store, "empty"), ["yes"]);
  assert.deepEqual(rows(store, "q"), [`"say \\"hi\\" \\\\ x"`], "escapes render as written");
  assert.deepEqual(rows(store, "bare-matches-string"), [], `"a" and a are different terms`);
  // The rendered row parses back to the same term.
  const again = runFixpoint(ok(`~go\ngo, +css a ${rows(store, "got")[0]}`), 100, 1000);
  assert.deepEqual(rows(again.store, "css"), [`a ${CSS}`]);
  console.log("PASS: strings parse, match and render back as source");
}

// 2) Errors.
{
  assert.equal(err(`~go\ngo, +x "abc`), "unterminated string");
  assert.match(err(`~go\ngo, +x "a\\qb"`), /bad escape '\\q'/);
  assert.match(err(`~go\ngo, +x foo"bar"`), /must be a term of its own/);
  // A quote in a comment is not a string; a `#js` body is JavaScript.
  ok(`~go\ngo, +x a -- it's "quoted\n#js (q) { return '"'; }\n`);
  console.log("PASS: string errors; quotes in comments and #js bodies are not strings");
}

// 3) Columns are true source columns: the atom after a string is linked to
//    its own source text.
{
  const line = `go, +css a "x, y", +after b`;
  const p = ok(`~go\n${line}`);
  const rule = p.rules.find((r) => r.body.some((a) => a.tag === "Atom" && a.span?.line === 2))!;
  const after = rule.body.find((a) => a.tag === "Atom" && a.atom.terms[0]?.tag === "Symbol" && (a.atom.terms[0] as { name: string }).name === "after")!;
  assert.equal(line.slice(after.span!.startCol, after.span!.endCol), "+after b");
  console.log("PASS: spans after a string keep their columns");
}

// 4) term.ts helpers.
{
  assert.equal(quoteString(`a "b" \\ c`), `"a \\"b\\" \\\\ c"`);
  assert.equal(stringValue(str(`a "b" \\ c`)), `a "b" \\ c`);
  assert.equal(stringValue({ tag: "Symbol", name: "a" }), null);
  assert.equal(stringValue({ tag: "Symbol", name: `""` }), "");
  console.log("PASS: quoteString / stringValue");
}

// 5) `#js`: a string decodes to its value; a result that isn't a bare symbol
//    token encodes as a string, one that is stays a Symbol.
{
  const src = [
    "#js (len s) { return s.length; }",
    "#js (shout s) { return s.toUpperCase() + \"!\"; }",
    "#js (word s) { return s.split(\" \")[0]; }",
    "~go",
    `go, +w "hello there"`,
    "go, w S, +n @js(len S), +loud @js(shout S), +first @js(word S)",
  ].join("\n");
  const { store } = runFixpoint(ok(src), 100, 1000);
  assert.deepEqual(rows(store, "n"), ["11"]);
  assert.deepEqual(rows(store, "loud"), [`"HELLO THERE!"`]);
  assert.deepEqual(rows(store, "first"), ["hello"]);
  console.log("PASS: strings across the #js boundary");
}

// 6) A choice whose values are strings: a scenario answers it by rendered
//    value, so the saved `is` rows round-trip through compressRefs.
{
  const game = [
    "~main",
    "  ~setup;",
    "  ~go",
    `setup, +opt "red, dark", +opt "blue (light)"`,
    "go",
    "  ?C",
    "  !(opt C)",
    "  ~picked C",
    "picked C, is C X, ~chose X",
  ].join("\n");
  const scenario = [
    "-- uses: game.t",
    `-- choose: "blue (light)"`,
    `-- expect: chose "blue (light)"`,
    `-- expect-not: chose "red, dark"`,
  ].join("\n");
  const r = runScenario(scenario, new Map([["game.t", game]]));
  assert.deepEqual(r.problems, []);
  console.log("PASS: a string-valued choice round-trips through saved is rows");
}

// 7) Highlighting: a string is one `str` token; a comment after it is still
//    a comment.
{
  const line = `go, +css a "x -- y", +b  -- note "q`;
  const toks = highlightLine(line, { js: 0 });
  const strs = toks.filter((t) => t.cls === "str").map((t) => line.slice(t.start, t.end));
  assert.deepEqual(strs, [`"x -- y"`]);
  const comments = toks.filter((t) => t.cls === "c").map((t) => line.slice(t.start, t.end));
  assert.deepEqual(comments, [`-- note "q`]);
  console.log("PASS: highlight marks strings");
}

// 8) Rename leaves string contents alone.
{
  const src = `~go\ngo, +css a "color a", +label a`;
  const target = renameTargetAt(src, src.indexOf("+css a") + 5)!;
  assert.equal(target.name, "a");
  const out = applyRename(src, renameOccurrences(src, target), "cell");
  assert.equal(out, `~go\ngo, +css cell "color a", +label cell`);
  console.log("PASS: rename skips string contents");
}

// 9) Display relations at a moment (display-rows.ts): plain tuples, and an
//    `#acc` relation no rule reads, computed through the run's accAt.
{
  const src = [
    "~game",
    "  ~a;",
    "  ~b;",
    "  ~pick",
    `a, +icon p, +icon:name p "Piece P", +opt p`,
    `a, +mark p blue`,
    `b, +mark p red`,
    "#acc icon:css : e (@last css)",
    `mark I blue / icon:css I "color: blue"`,
    `mark I red / icon:css I "color: red"`,
    "pick",
    "  ?C",
    "  !(opt C)",
  ].join("\n");
  const run = runFixpoint(ok(src), 200, 5000);
  assert.equal(run.status.kind, "active-choices");
  const { store } = run;
  assert.deepEqual(rows(store, "icon:css"), [], "the run itself computes no icon:css rows");
  const comp = (run.status as { components: { moment: Term }[] }).components[0]!;
  const rowsAt = displayRows(store, comp.moment, run.accAt);
  const p: Term = { tag: "Symbol", name: "p" };
  const key = tokenOf(store, p);
  assert.equal(iconNames(store, rowsAt).get(key), "Piece P", "a string name shows its value");
  assert.equal(iconStyles(store, rowsAt).get(key), "color: red", "the latest style");
  const about = rowsAbout(store, rowsAt, p).map((r) => `${r.head}${r.idx < 0 ? " (acc)" : ""}`).sort();
  assert.deepEqual(about, ["icon", "icon:css (acc)", "icon:name"]);
  assert.equal(displayText(store, p), "p");
  // Without accAt only stored rows are seen: no style.
  assert.equal(iconStyles(store, displayRows(store, comp.moment, undefined)).get(key), undefined);
  console.log("PASS: display rows: names, acc-computed styles, rows about an icon");
}

// 10) The lexer (parse.ts `lex`): a string is one token everywhere, so the
//     structural punctuation inside it means nothing in a `!(...)` block,
//     an exception block or an `#acc` rule; no limit on how many there are.
{
  const game = [
    "~main",
    "  ~setup;",
    "  ~go",
    `setup, +opt "a, b", +opt "c) d", +opt "{x => y}", +tag "a, b" "[1]"`,
    "#acc tagged : e e",
    "tag X Y / tagged X Y",
    "#acc label : e (@last name)",
    `opt O / label O "-> not a weight"`,
    "go",
    "  ?C",
    `  !(opt C, not tagged C "[1]")`,
    "  ~chose C",
  ].join("\n");
  const { store, status } = runFixpoint(ok(game), 100, 1000);
  assert.equal(status.kind, "active-choices");
  const offered = status.kind === "active-choices"
    ? status.components[0]!.options.map((o) => renderTerm(store, o[0]!)).sort()
    : [];
  assert.deepEqual(offered, [`"c) d"`, `"{x => y}"`], "the `!(...)` split ignores commas in strings");

  // An exception block: `=>` and `}` inside strings are text; the block's
  // right-hand side keeps true source columns.
  const line = `go, {tag X "[1]" => +retag X "=> }"}`;
  const p = ok(`~go\n${line}`);
  const exc = p.rules.flatMap((r) => r.body).find((a) => a.tag === "Exception");
  assert.ok(exc !== undefined && exc.tag === "Exception");
  const rhs = exc.right[0]!;
  assert.ok(rhs.tag === "Atom");
  assert.deepEqual(rhs.atom.terms.map((t) => (t.tag === "Symbol" ? t.name : t.tag === "Variable" ? t.name : "?")), ["retag", "X", `"=> }"`]);
  assert.equal(line.slice(rhs.span!.startCol, rhs.span!.endCol), `+retag X "=> }"`);
  assert.equal(line.slice(exc.leftSpan!.startCol, exc.leftSpan!.endCol), `tag X "[1]"`);
  // Glued `=>` still splits; a string glued to a word is an error.
  ok("~go\ngo, +p a\ngo, {p X=>+q X}");
  assert.match(err(`~go\ngo, {p X => +q X"s"}`), /must be a term of its own/);

  // More literals than the old masking's private-use slots (6399).
  const many = ["~go", ...Array.from({ length: 7000 }, (_, i) => `go, +s "v${i}"`)].join("\n");
  assert.equal(runFixpoint(ok(many), 100, 100000).store.byHead.get("s")?.length, 7000);
  console.log("PASS: the lexer keeps strings whole in every construct, with no count limit");
}

console.log("ALL v2 strings tests passed");
