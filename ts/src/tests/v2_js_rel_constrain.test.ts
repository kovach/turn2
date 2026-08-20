// js relations inside `!(...)` constrain blocks
// (plans/v2-js-rel-in-constrain.md): enumeration, dynamic clause
// selection, js-last scheduling, entanglement, and error paths.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Term } from "../v2/term.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Store } from "../v2/store.js";
import type { Program } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
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

function optionSet(store: Store, options: Term[][]): Set<string> {
  return new Set(options.map((opt) => opt.map((t) => renderTerm(store, t)).join(",")));
}

// Run `src`, assert active-choices with one component, return its options.
function oneComponentOptions(src: string, label: string): Set<string> {
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `${label}: status ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.components.length, 1, `${label}: expected one component`);
  return optionSet(store, status.components[0]!.options);
}

const RANGE = `#js-def range +Lo +Hi -I {
  for (let i = Lo; i < Hi; i++) {
    yield [i];
  }
}`;

// 1) Enumeration: a js relation generates the option domain of an active
//    term directly — no store facts involved.
{
  const src = `${RANGE}
+ turn

turn
  ? N
  !(range 1 4 N)
`;
  const opts = oneComponentOptions(src, "enumeration");
  assert.deepEqual([...opts].sort(), ["1", "2", "3"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: js relation enumerates an option domain");
}

// 2) Filter: a bound-only (`+`) clause prunes options produced by a plain
//    sub in the same block — dynamic mode selection sees `X` bound.
{
  const src = `#js-def even +X { if (X % 2 === 0) yield []; }
+ num 1, + num 2, + num 3, + num 4, + turn

turn
  ? X
  !(num X, even X)
`;
  const opts = oneComponentOptions(src, "filter");
  assert.deepEqual([...opts].sort(), ["2", "4"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: bound-only js clause filters plain-sub options");
}

// 3) Join through a block existential: the plain sub binds `Y`, the js sub
//    computes the active term from it.
{
  const src = `#js-def double +X -D { yield [X * 2]; }
+ prop a 5, + turn

turn
  ? B
  !(prop a Y, double Y B)
`;
  const opts = oneComponentOptions(src, "existential join");
  assert.deepEqual([...opts], ["10"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: js sub joins through a block existential");
}

// 4) Ordering robustness: the js sub is written *before* the plain sub
//    that binds its `+` arg. Component-wide js-last scheduling must still
//    find the bound clause.
{
  const src = `#js-def even +X { if (X % 2 === 0) yield []; }
+ num 1, + num 2, + num 3, + turn

turn
  ? X
  !(even X, num X)
`;
  const opts = oneComponentOptions(src, "js-first ordering");
  assert.deepEqual([...opts], ["2"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: js sub written before its binder still works (js-last scheduling)");
}

// 5) Dynamic clause selection: `+ -` clause declared first wins when the
//    first arg is bound; the `- -` fallback serves the all-unbound call.
const SEL = `#js-def sel +A -B { yield [A * 10]; }
#js-def sel -A -B { yield [99, 99]; }`;
{
  const src = `${SEL}
+ num 3, + turn

turn
  ? B
  !(num A, sel A B)
`;
  const opts = oneComponentOptions(src, "clause selection bound");
  assert.deepEqual([...opts], ["30"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: bound call picks the earliest + clause");
}
{
  const src = `${SEL}
+ turn

turn
  ? A
  ? B
  !(sel A B)
`;
  const opts = oneComponentOptions(src, "clause selection unbound");
  assert.deepEqual([...opts], ["99,99"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: unbound call falls back to the - - clause");
}

// 6) Entanglement: a js sub touching two active terms merges them into one
//    component with joint option tuples.
{
  const src = `#js-def addpair -A -B { yield [1, 2]; yield [3, 4]; }
+ turn

turn
  ? A
  ? B
  !(addpair A B)
`;
  const opts = oneComponentOptions(src, "entanglement");
  assert.deepEqual([...opts].sort(), ["1,2", "3,4"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: js sub entangles two active terms into one component");
}

// 7) Errors.

// No clause serves the runtime modes: `even` only has a `+` clause and the
// component has nothing to bind X.
runFails(
  `#js-def even +X { if (X % 2 === 0) yield []; }
+ turn

turn
  ? X
  !(even X)
`,
  /no '#js-def even' clause matches modes \(-\)/,
  "no clause serves the runtime modes",
);

// `-> weight` on a js sub is rejected at expand time.
runFails(
  `${RANGE}
+ turn

turn
  ? N
  !(range 1 4 N -> W)
`,
  /js relation 'range' cannot take '-> weight'/,
  "-> weight on a js sub",
);

// Arity mismatch is rejected at expand time.
runFails(
  `${RANGE}
+ turn

turn
  ? N
  !(range 1 N)
`,
  /js relation 'range' takes 3 argument\(s\), given 2/,
  "arity mismatch inside !(...)",
);

// Yield cap: an infinite generator whose yields never unify (X is bound
// to 1, the generator only yields 0) trips JS_REL_YIELD_CAP.
runFails(
  `#js-def inf -X { for (;;) yield [0]; }
+ num 1, + turn

turn
  ? X
  !(num X, inf X)
`,
  /yield limit exceeded/,
  "runaway generator hits the yield cap",
);

console.log("v2_js_rel_constrain: all tests passed");
