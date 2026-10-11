// Built-in numeric comparisons `lt` / `gt` / `le` / `ge` (builtins.ts): they
// are js relations seeded into every program, so this covers their truth
// table, their use as a `!(...)` filter, the mode/type errors, that user
// declarations cannot take their names, and that IR dumps leave them out.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { renderProgram } from "../v2/print-ir.js";
import { builtinJsRels, isBuiltinRel } from "../v2/builtins.js";
import type { Term } from "../v2/term.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Store } from "../v2/store.js";
import type { Program } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function parseFails(src: string, re: RegExp, label: string, line?: number): void {
  const p = parse(src);
  assert("message" in p, `${label}: expected a parse error`);
  assert.match(p.message, re, label);
  if (line !== undefined) assert.equal(p.line, line, `${label}: error line`);
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

// User-visible tuples of relation `head`, sorted.
function tuplesOf(store: Store, head: string): string[] {
  return store.tuples
    .map((t) => t.atom.terms.slice(0, -1).map((x) => renderTerm(store, x)).join(" "))
    .filter((s) => s.startsWith(head + " "))
    .sort();
}

// 1) Every program carries the four builtins as `+A +B` js relations.
{
  const p = ok(`+ x`);
  for (const name of ["lt", "gt", "le", "ge"]) {
    assert(isBuiltinRel(name), `${name} is builtin`);
    const clauses = p.jsRels.get(name);
    assert(clauses !== undefined && clauses.length === 1, `${name} seeded`);
    assert.deepEqual(clauses[0]!.params.map((q) => q.mode), ["+", "+"]);
    assert.equal(clauses[0]!.builtin, true);
  }
  assert(!isBuiltinRel("range"));
  // Each parse gets its own arrays (user clauses are pushed into them).
  assert.notEqual(builtinJsRels().get("lt"), builtinJsRels().get("lt"));
  console.log("PASS: builtins seeded");
}

// 2) Truth table over the pairs of {3, 4, 5} (parenthesized matches: the
//    facts come from sibling rules, so a plain join would only self-pair).
{
  const { store } = runFixpoint(ok(`
+ a 3
+ a 4
+ a 5

(a X), (a Y), lt X Y, ^lt-out X Y
(a X), (a Y), gt X Y, ^gt-out X Y
(a X), (a Y), le X Y, ^le-out X Y
(a X), (a Y), ge X Y, ^ge-out X Y
`));
  assert.deepEqual(tuplesOf(store, "lt-out"), ["lt-out 3 4", "lt-out 3 5", "lt-out 4 5"]);
  assert.deepEqual(tuplesOf(store, "gt-out"), ["gt-out 4 3", "gt-out 5 3", "gt-out 5 4"]);
  assert.deepEqual(tuplesOf(store, "le-out"), [
    "le-out 3 3", "le-out 3 4", "le-out 3 5", "le-out 4 4", "le-out 4 5", "le-out 5 5",
  ]);
  assert.deepEqual(tuplesOf(store, "ge-out"), [
    "ge-out 3 3", "ge-out 4 3", "ge-out 4 4", "ge-out 5 3", "ge-out 5 4", "ge-out 5 5",
  ]);
  console.log("PASS: comparison truth table");
}

// 3) Negative numbers and literals compare numerically, not lexically.
{
  const { store } = runFixpoint(ok(`
+ v -2
+ v 10
+ v 9

(v X), lt X 9, ^small X
(v X), gt X -3, ^big X
`));
  assert.deepEqual(tuplesOf(store, "small"), ["small -2"]);
  assert.deepEqual(tuplesOf(store, "big"), ["big -2", "big 10", "big 9"]);
  console.log("PASS: numeric (not lexical) order");
}

// 4) Inside `!(...)`: a comparison filters the option domain of a choice.
{
  const { store, status } = runFixpoint(ok(`
+ num 1, + num 2, + num 3, + num 4, + turn

turn
  ? N
  !(num N, ge N 3)
`));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.components.length, 1);
  const opts = status.components[0]!.options.map((o) => o.map((t) => renderTerm(store, t)).join(",")).sort();
  assert.deepEqual(opts, ["3", "4"]);
  console.log("PASS: comparison filters a choice");
}

// 5) An unbound argument is a mode error at compile time, naming the rule.
runFails(`+ a 3\n\n#def cmp\na X, lt X Y, ^out Y`, /rule 'cmp': no '#js-def lt' clause matches modes \(\+ -\)/, "unbound argument");

// 6) Non-numeric arguments are a runtime error naming the relation.
runFails(`+ a foo\n\na X, lt X 3, ^out X`, /#js-def lt threw: arguments must be numbers \(got "foo" and 3\)/, "symbol argument");
runFails(`+ a (s z)\n\na X, ge X 0, ^out X`, /#js-def ge threw: arguments must be numbers/, "Peano argument");

// 7) The names are reserved: no user declaration may take them.
parseFails(`#js-def lt +A +B { yield []; }`, /'lt' is a built-in relation and cannot be redefined/, "#js-def", 1);
parseFails(`#js (gt x y) { return x > y; }`, /'gt' is a built-in relation/, "#js", 1);
parseFails(`+ x\n#acc le : e @sum`, /'le' is a built-in relation/, "#acc", 2);
// (`#agg` / `#reactive` / `#macro` were removed; they fail as migration errors
// before any name check — covered in v2_parse.)

// 8) Like any js relation, a builtin cannot be emitted or intercepted.
runFails(`+ lt 1 2`, /js relation 'lt'/, "emit into a builtin");
runFails(`+ a 1\n\na X, { lt X _ => }`, /js relation 'lt' cannot be an exception's left-hand side/, "exception on a builtin");

// 9) IR dumps show only user declarations.
{
  const text = renderProgram(ok(`#js-def range +Lo +Hi -I { for (let i = Lo; i < Hi; i++) yield [i]; }\n+ x`));
  assert.match(text, /#js-def range/);
  assert.doesNotMatch(text, /#js-def (lt|gt|le|ge)/);
  console.log("PASS: builtins hidden from IR dump");
}

console.log("ALL v2 builtins tests passed");
