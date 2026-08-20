// js relations (`#js-def`, plans/v2-js-relations.md): parsing, mode
// selection, evaluation, and rejection of non-match uses.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { expandStages } from "../v2/expand.js";
import type { Term } from "../v2/term.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Store } from "../v2/store.js";
import type { Program } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function parseFails(src: string, re: RegExp, label: string): void {
  const p = parse(src);
  assert("message" in p, `${label}: expected a parse error`);
  assert.match(p.message, re, label);
  console.log(`PASS: parse error - ${label}`);
}

function runFails(src: string, re: RegExp, label: string): void {
  assert.throws(() => runFixpoint(ok(src)), re, label);
  console.log(`PASS: error - ${label}`);
}

function renderTerm(store: Store, term: Term): string {
  const t = term.tag === "Ref" ? expandTerm(term, store.hash) : term;
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${t.id}`;
    case "Atom":
    case "Id":
      return `(${t.atom.terms.map((x) => renderTerm(store, x)).join(" ")})`;
  }
}

// User-visible tuple text (head + args, trailing id slot dropped).
function listTuples(store: Store): string[] {
  return store.tuples.map((t) => {
    const ts = t.atom.terms.length > 0 ? t.atom.terms.slice(0, -1) : t.atom.terms;
    return ts.map((x) => renderTerm(store, x)).join(" ");
  });
}

const RANGE = `#js-def range +Lo +Hi -I {
  for (let i = Lo; i < Hi; i++) {
    yield [i];
  }
}`;

// 1) Parsing: multi-line and one-liner clauses land in Program.jsRels.
{
  const p = ok(`${RANGE}
#js-def range -Lo -Hi -I { yield [0, 1, 0]; }
`);
  const clauses = p.jsRels.get("range")!;
  assert.equal(clauses.length, 2);
  assert.deepEqual(clauses[0]!.params, [
    { mode: "+", name: "Lo" },
    { mode: "+", name: "Hi" },
    { mode: "-", name: "I" },
  ]);
  assert.match(clauses[0]!.body, /yield \[i\]/);
  assert.deepEqual(clauses[1]!.params.map((q) => q.mode), ["-", "-", "-"]);
  console.log("PASS: #js-def parses into jsRels");
}

// 2) Parse errors.
parseFails(`#js-def range +Lo Hi -I { yield []; }`, /marked '\+' \(bound\) or '-'/, "unmarked param");
parseFails(`#js-def range +Lo +9x -I { yield []; }`, /valid JS identifier/, "bad identifier");
parseFails(`#js-def range +X +X -I { yield []; }`, /duplicate '#js-def' parameter/, "duplicate param name");
parseFails(`${RANGE}\n#js-def range +Lo +Hi -I { yield [0]; }`, /duplicate '#js-def range' mode signature/, "duplicate mode vector");
parseFails(`${RANGE}\n#js-def range +Lo -I { yield [0]; }`, /agree on arity/, "arity mismatch across clauses");
parseFails(`${RANGE}\n#js (range x) { return x; }`, /already a '#js-def' relation/, "#js after #js-def");
parseFails(`#js (range x) { return x; }\n${RANGE}`, /already a '#js' function/, "#js-def after #js");
parseFails(`${RANGE}\n#agg range -> sum`, /cannot have a schema declaration/, "#agg on a js relation");
parseFails(`${RANGE}\n#macro range X := [foo X W | count W]`, /already a macro/, "#macro on a js relation");
parseFails(`#js-def bad +X`, /must be followed by '\{'/, "missing body brace");

// 3) Enumeration: two generators join; emits land per binding.
{
  const { store } = runFixpoint(ok(`${RANGE}

range 0 2 I, range 0 2 J, ^cell I J
`));
  const tuples = listTuples(store);
  for (const t of ["cell 0 0", "cell 0 1", "cell 1 0", "cell 1 1"]) {
    assert(tuples.includes(t), `expected '${t}': ${tuples}`);
  }
  assert.equal(tuples.filter((t) => t.startsWith("cell ")).length, 4);
  console.log("PASS: enumeration join");
}

// 4) Filtering: a bound arg at a '-' clause position unifies against yields.
{
  const { store } = runFixpoint(ok(`${RANGE}

+ n 1

n X, range 0 5 X, ^hit X
`));
  const tuples = listTuples(store);
  assert(tuples.includes("hit 1"), `expected 'hit 1': ${tuples}`);
  assert.equal(tuples.filter((t) => t.startsWith("hit ")).length, 1);
  console.log("PASS: bound '-' position filters");
}

// 5) Mode selection picks the earliest clause ≤ the call modes, and clause
//    choice is visible in the resolved stage dump.
{
  const p = ok(`#js-def gen +X -Y {
  yield [X + 1];
}
#js-def gen -X -Y {
  yield [7, 8];
}

+ n 4

n X, gen X Y, ^plus X Y

gen A B, ^pair A B
`);
  const resolved = expandStages(p).resolved;
  const iterates = resolved.flatMap((r) =>
    r.body.flatMap((a) => (a.tag === "JsIterate" ? [a] : [])),
  );
  assert(iterates.length >= 2, "expected JsIterate atoms in resolved stage");
  const byRule = new Map<number, number>();
  for (const it of iterates) byRule.set(it.defIndex!, (byRule.get(it.defIndex!) ?? 0) + 1);
  assert(byRule.has(0) && byRule.has(1), `expected both clauses selected: ${[...byRule.keys()]}`);

  const { store } = runFixpoint(p);
  const tuples = listTuples(store);
  assert(tuples.includes("plus 4 5"), `expected 'plus 4 5' (clause 0): ${tuples}`);
  assert(tuples.includes("pair 7 8"), `expected 'pair 7 8' (clause 1): ${tuples}`);
  console.log("PASS: earliest-clause mode selection");
}

// 6) Literal args count as '+'; an all-'+' clause acts as a test.
{
  const { store } = runFixpoint(ok(`#js-def even +X {
  if (X % 2 === 0) yield [];
}

+ n 3
+ n 6

n X, even X, ^ok X
`));
  const tuples = listTuples(store);
  assert(tuples.includes("ok 6"), `expected 'ok 6': ${tuples}`);
  assert(!tuples.some((t) => t === "ok 3"), `unexpected 'ok 3': ${tuples}`);
  console.log("PASS: pure-test clause (no '-' params)");
}

// 7) Binding across an emit split: I is bound before the emit; the js atom
//    lands in the consumer slice and still sees I as '+'.
{
  const { store } = runFixpoint(ok(`#js-def dbl +X -Y {
  yield [X * 2];
}

+ n 3

n I
  ~ step I
  dbl I Y, ^out Y
`));
  const tuples = listTuples(store);
  assert(tuples.includes("out 6"), `expected 'out 6': ${tuples}`);
  console.log("PASS: '+' binding across an emit split");
}

// 8) No matching clause: unbound arg at a '+'-only position.
runFails(
  `#js-def sq +X -Y {\n  yield [X * X];\n}\n\nsq X Y, ^out X Y`,
  /no '#js-def sq' clause matches modes \(- -\)/,
  "unresolvable modes",
);

// 9) Rejected uses.
runFails(`${RANGE}\n\n+ range 1 2 3`, /can only be used as a plain match atom/, "fact emit");
runFails(`${RANGE}\n\n~ range 1 2 3`, /can only be used as a plain match atom/, "episode emit");
runFails(`${RANGE}\n\n^ range 1 2`, /can only be used as a plain match atom/, "anchor emit (off-arity too)");
// An ask atom rejects any non-variable term at parse time (vars-only shape,
// plans/v2-choice-actors.md), so a js-relation ask never reaches expand.
runFails(`${RANGE}\n\n? range 1 2 3`, /'\?' accepts only variables/, "ask");
runFails(
  `${RANGE}\n\n+ go\n\ngo, range 1 2 X -> 1, ^out X`,
  /can only be used as a plain match atom/,
  "weighted match",
);
// A js relation inside `!(...)` is now allowed
// (plans/v2-js-rel-in-constrain.md) — behavior is covered by
// v2_js_rel_constrain.test.ts; here just check expand accepts it.
{
  const { status } = runFixpoint(ok(`${RANGE}\n\n+ go\n\ngo, !(range 0 2 X), ^out`));
  assert.equal(status.kind, "done");
  console.log("PASS: js relation accepted inside !(...)");
}
runFails(
  `${RANGE}\n\n+ go\n\ngo, [range 0 2 X | count X], ^out`,
  /'\[ \.\.\. \]' aggregate query/,
  "inside bracket aggregation",
);
runFails(`${RANGE}\n\n+ go\n\ngo, {range A B C => ~z}, ^out`, /exception's left-hand side/, "exception LHS");
runFails(`${RANGE}\n\ngo, range 0 2, ^out`, /takes 3 argument\(s\), given 2/, "arity mismatch at use");

// 10) Runtime errors.
runFails(
  `#js-def boom -X {\n  throw new Error("kaboom");\n}\n\nboom X, ^out X`,
  /#js-def boom threw: kaboom/,
  "body throws",
);
runFails(
  `#js-def bad -X {\n  yield [1, 2];\n}\n\nbad X, ^out X`,
  /yield must be an array of 1 value/,
  "wrong yield shape",
);
runFails(
  `#js-def broken -X {\n  yield [1 +++ ;\n}\n\nbroken X, ^out X`,
  /#js-def broken:/,
  "malformed body",
);

// 11) Compound values round-trip through yields.
{
  const { store } = runFixpoint(ok(`#js-def pairs -P {
  yield [["pair", 1, 2]];
  yield [["pair", 3, 4]];
}

pairs P, ^got P
`));
  const tuples = listTuples(store);
  assert(tuples.includes("got (pair 1 2)"), `expected 'got (pair 1 2)': ${tuples}`);
  assert(tuples.includes("got (pair 3 4)"), `expected 'got (pair 3 4)': ${tuples}`);
  console.log("PASS: compound yields");
}

console.log("all v2_js_rel tests passed");
