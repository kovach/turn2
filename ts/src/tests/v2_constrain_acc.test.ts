import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../v2/term.js";
import { expandTerm } from "../v2/hashcons.js";
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

// Aggregates inside `!(...)` constraint blocks are `#acc` reads: the rows of
// an acc relation at the component's moment are ordinary point rows, so an
// acc sub-atom is a plain `*c-plain` pattern, and absence is a `not` sub-atom
// (`*c-not`). Ported from v2_constrain_agg.test.ts when `#agg` and
// `-> weight` were removed (plans/v2-caret-fresh-left.md §5.4).

// 1) Row encoding: an acc sub-atom is `*c-plain`, a negated one `*c-not`.
{
  const src = `
#acc score : key @sum
#acc said : key
+ a

a
  ! score X W
  ! not said a
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  const cs = tuples.filter((t) => t.startsWith("_constrain "));
  assert.equal(cs.length, 2, `expected 2 _constrain rows, got: ${tuples.join(" | ")}`);
  assert.ok(cs.some((c) => c.includes("*c-plain") && c.includes("score")), `expected a *c-plain score row: ${cs.join(" | ")}`);
  assert.ok(cs.some((c) => c.includes("*c-not") && c.includes("said")), `expected a *c-not said row: ${cs.join(" | ")}`);
  console.log("PASS: acc sub-atoms are `*c-plain`, negated ones `*c-not`");
}

// 2) Sum: `? N, ? W, !(score N W)` over a `@sum` relation binds the
//    options to the (key, sum) rows.
{
  const src = `
#acc score : key @sum
pts K N / score K N

+ pts a 3
  + pts a 5
  + pts b 4
  + turn

turn
  ? N
  ? W
  ! score N W
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
  console.log("PASS: @sum rows bind active (N, W) to (key, sum)");
}

// 3) Last: one option per (key, latest value) row.
{
  const src = `
#acc score : key (@last num)
pts K N / score K N

+ pts a 1
  + pts b 2
  + turn

turn
  ? N
  ? W
  ! score N W
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  const opts = optionSet(store, status.components[0]!.options);
  assert.deepEqual([...opts].sort(), ["a,1", "b,2"].sort(), `got: ${[...opts].join(" | ")}`);
  console.log("PASS: @last yields one option per (key, value) row");
}

// 4) No contributions: no rows, no options; the choice resolves dead.
{
  const src = `
#acc score : key (@last num)
pts K N / score K N
+ turn

turn
  ? N
  ? W
  ! score N W
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  console.log("PASS: an empty acc relation resolves the choice dead");
}

// 4b) Negation inside a choice (the old `!said Y -> 0`): a plain constraint
//    grounds the key and `not said Y` filters it. With no contributions at
//    all every word is an option; a word said earlier is excluded.
{
  const mk = (extra: string) => `
#acc said : key
sd W / said W

+ word hi, + word there, + word wow${extra}, + turn

turn
  ? Y
  ! word Y
  ! not said Y
`;
  for (const [extra, want] of [["", ["hi", "there", "wow"]], [", + sd there", ["hi", "wow"]]] as const) {
    const { store, status } = runFixpoint(ok(mk(extra)));
    assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
    if (status.kind !== "active-choices") throw new Error("unreachable");
    const opts = optionSet(store, status.components[0]!.options);
    assert.deepEqual([...opts].sort(), [...want], `extra '${extra}': got ${[...opts].join(" | ")}`);
  }
  console.log("PASS: `!word Y, !not said Y` keeps exactly the unsaid words");
}

// 4c) Same shape inside a single `!(...)` block: the positive sub grounds
//    the negated one within one compound row.
{
  const src = `
#acc said : key
sd W / said W

+ word hi, + word there, + word wow, + sd wow, + turn

turn
  ? Y
  !(word Y, not said Y)
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  const opts = optionSet(store, status.components[0]!.options);
  assert.deepEqual([...opts].sort(), ["hi", "there"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: `!(word Y, not said Y)` grounds the negated sub within one compound row");
}

// 4d) A `not` sub whose variable no positive sub (and no prefix) binds is a
//    compile error.
{
  const src = `
#acc said : key
+ turn

turn
  ? Y
  !(not said Z, word Y)
`;
  assert.throws(() => runFixpoint(ok(src)), /needs its variables bound/);
  console.log("PASS: an unbound variable in a `not` sub-atom is rejected");
}

// 5) `@last` across sequential episodes: only the most recent contribution
//    survives (the old `at e -> last` case).
{
  const src = `
#acc at : e (@last loc)
put It L / at It L

~game
  (~a); (~a'); (~b)

a,
  ( +put x here );
  +put x there

a', +put x no

b, at x Loc, +y Loc
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  const tuples = listTuples(store);
  const ys = tuples.filter((t) => t.startsWith("y "));
  assert.deepEqual(ys, ["y no"], `expected only 'y no', got: ${ys.join(" | ")}`);
  console.log("PASS: sequential ~a;~a' contributions collapse under @last to the most recent");
}

console.log("ALL v2 constrain-acc tests passed");
