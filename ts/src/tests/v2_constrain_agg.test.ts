import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../types.js";
import { expandTerm } from "../hashcons.js";
import type { Store } from "../v2/store.js";

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
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

function renderAtom(store: Store, atom: Atom): string {
  const ts = atom.terms.length > 0 ? atom.terms.slice(0, -1) : atom.terms;
  return ts.map((t) => renderTerm(store, t)).join(" ");
}

function listTuples(store: Store): string[] {
  return store.tuples.map((t) => renderAtom(store, t.atom));
}

function optionSet(store: Store, options: Term[][]): Set<string> {
  return new Set(options.map((opt) => opt.map((t) => renderTerm(store, t)).join(",")));
}

// 1) `! foo C -> w` lowers to a single-element compound `_constrain` row
//    whose inner sub is wrapped as `(*c-agg ...)`. There's no separate
//    `_constrain-agg` row head anymore (see plans/v2-compound-constraints.md).
{
  const src = `
#acc score key -> sum
+ a

a
! score X -> W
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  const cs = tuples.filter((t) => t.startsWith("_constrain "));
  assert.equal(cs.length, 1, `expected 1 _constrain row, got: ${tuples.join(" | ")}`);
  assert.ok(cs[0]!.includes("*c-agg"), `expected '*c-agg' inside row, got: ${cs[0]}`);
  assert.ok(!cs[0]!.includes("*c-plain"), `did not expect '*c-plain' for an aggregate sub: ${cs[0]}`);
  console.log("PASS: `! ... -> ...` emits a `(*conj (*c-agg ...))`-wrapped _constrain row");
}

// 2) Sum aggregation: ? N, ? W, ! score N -> W with grouped sums binds the
//    options to the (key, sum) pairs.
{
  const src = `
#acc score key -> sum
+ score a 3
+ score a 5
+ score b 4
+ turn

turn
? N
? W
! score N -> W
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  // Exactly one component spanning both active terms.
  assert.equal(status.components.length, 1, `expected 1 component, got ${status.components.length}`);
  const comp = status.components[0]!;
  assert.equal(comp.activeTerms.length, 2, "expected 2 active terms");
  const opts = optionSet(store, comp.options);
  // Expected groups: a -> 8, b -> 4.
  assert.deepEqual([...opts].sort(), ["a,8", "b,4"].sort(), `got: ${[...opts].join(" | ")}`);
  console.log("PASS: sum aggregation binds active (N, W) to group (key, sum)");
}

// 3) Last aggregation: a group with multiple maximal candidates multiplies
//    options. With score-key only and `last`, the aggregator's group is
//    keyed by the key position and the maximal candidate's weight wins.
{
  // Two distinct keys with one weight each; the active vars get bound to
  // each (key, weight) pair.
  const src = `
#acc score key -> last
+ score a 1
+ score b 2
+ turn

turn
? N
? W
! score N -> W
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  const opts = optionSet(store, status.components[0]!.options);
  assert.deepEqual([...opts].sort(), ["a,1", "b,2"].sort(), `got: ${[...opts].join(" | ")}`);
  console.log("PASS: last aggregation yields one option per (key, weight) pair");
}

// 4) Empty contribution set with `last` and free key: no options.
{
  const src = `
#acc score key -> last
+ turn

turn
? N
? W
! score N -> W
`;
  const { status } = runFixpoint(ok(src));
  // No candidates -> last produces no agg results -> component has 0
  // options. Still active-choices (the choice is reached, options just
  // come back empty).
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.components[0]!.options.length, 0, "expected 0 options");
  console.log("PASS: last on empty contribution set yields no options");
}

// 5) User-supplied case: `at e -> last` with sequential ~game subrules.
{
  const src = `
#acc at e -> last

~game
  (~a); (~a'); (~b)

a,
( +at x -> here );
  +at x -> there

a', +at x -> no

b, at x -> Loc, +y Loc
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  const tuples = listTuples(store);
  const aggResults = tuples.filter((t) => t.startsWith("_agg-result"));
  assert.deepEqual(aggResults, ["_agg-result (at x no)"],
    `expected only the last contribution to survive, got: ${aggResults.join(" | ")}`);
  const ys = tuples.filter((t) => t.startsWith("y "));
  assert.deepEqual(ys, ["y no"], `expected only 'y no', got: ${ys.join(" | ")}`);
  console.log("PASS: sequential ~a;~a' emissions collapse under `last` to most-recent");
}

console.log("ALL v2 constrain-agg tests passed");
