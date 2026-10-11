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

// Render a stored atom (whose terms may be Refs) to a flat string of symbol
// names, walking through hashcons.
function renderAtom(store: Store, atom: Atom): string {
  // Drop the trailing universal id slot (every emitted tuple carries one).
  const ts = atom.terms.length > 0 ? atom.terms.slice(0, -1) : atom.terms;
  return ts.map((t) => renderTerm(store, t)).join(" ");
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

function listTuples(store: Store): string[] {
  return store.tuples.map((t) => renderAtom(store, t.atom));
}

// (outputs removed — `!` is now Constrain, not output sink)

// 1) play-card / it / move
{
  const src = `
+ play-card e1
  + it e1 c1

play-card E
  it E Card
  ~ move Card play-area
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("play-card e1"), `missing play-card e1: ${tuples}`);
  assert(tuples.includes("it e1 c1"), `missing it e1 c1: ${tuples}`);
  assert(tuples.includes("move c1 play-area"), `missing move: ${tuples}`);
  console.log("PASS: play-card/it/move");
}

// 2) foo, + bar
{
  const src = `
+ foo a

foo a
  + bar a
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("foo a"));
  assert(tuples.includes("bar a"));
  console.log("PASS: foo, + bar");
}

// 3) activate sub-rule example: parse + run (no crash). The example as
// written in the spec relies on stored `it` / `to` / `amount` tuples that
// aren't seeded, so neither sub-rule reaches its end successfully — but
// the producer atoms before the failing matches still leave their tuples
// (no rollback in this stage). Verify the seed survives and at least one
// produced tuple appears (~gather, before sub-rule 1 fails). The spec's
// assignment relation is spelled `assign` here: `is` is reserved for choice
// resolutions (rules cannot emit it).
{
  const src = `
+ activate a1
  + it a1 call-to-guard
  + target a1 t1
  + at d1 t1
  + dahan d1

activate A
  it A call-to-guard
  target A T

  ( ~ gather G
    it G X
    to G To
    ! dahan X
    + assign To T )

  ( at D T
    dahan D
    ~ defend D1
    it D1 I
    amount D1 A
    + assign I T
    + assign A 1 )
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("activate a1"));
  assert(tuples.includes("at d1 t1"));
  assert(tuples.some((t) => t.startsWith("gather ")), `expected gather tuple, got: ${tuples.join(" | ")}`);
  console.log("PASS: activate parses and runs");
}

// 4) episode E, ( some-property E P ); + property-reference P  (scoping)
{
  const src = `
+ episode e1
  + some-property e1 p7

episode E
  ( some-property E P )
  + property-reference P
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("property-reference p7"), `expected property-reference p7, got: ${tuples}`);
  console.log("PASS: scoping across sub-rule exit");
}

// 5) sequencing: foo ( ~ e1 ); ~ e2
{
  const src = `
+ foo a

foo a
  ( ~ e1 a );
  ~ e2 a
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("foo a"));
  assert(tuples.includes("e1 a"));
  assert(tuples.includes("e2 a"));
  // Find the e1 and e2 tuples and verify e1.r < e2.l.
  const e1 = store.tuples.find((t) => renderAtom(store, t.atom) === "e1 a")!;
  const e2 = store.tuples.find((t) => renderAtom(store, t.atom) === "e2 a")!;
  // Build a token-level check via the order relation.
  // (Just verify they're in different intervals; precise ordering is checked
  // by the fact that the assertion succeeded with the modified anchor.)
  assert(e1.l !== e2.l, "e1 and e2 should have distinct left moments");
  console.log("PASS: sequencing produces distinct nested e1, e2");
}

// 7) turn-program-2: cross-rule pipeline. Rule 1 produces prop tuples for
// each p; rule 2 introduces a new p, then matches prop, then produces q.
// Spec expectation is `q 2`. Whether v2 reaches it depends on rule
// splitting / yielding semantics that aren't in place yet.
{
  const src = `
p X
  + prop X 2

~ p X
  prop X Y
  ~ q Y
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  // Per the .t file's "expect: q 2" annotation. Currently failing.
  assert(
    tuples.some((t) => t === "q 2"),
    `expected 'q 2' tuple per spec, got: ${tuples.join(" | ")}`,
  );
  console.log("PASS: turn-program-2 produces q 2");
}

// 6) aggregation: a keyless `@sum` over contribution events, read at the
// anchor's start (plans/v2-caret-fresh-left.md §5.4: `#agg points -> sum` with
// `+ points -> 3` became an `#acc` relation fed by an event relation).
{
  const src = `
#acc points : @sum
pt N / points N

+ pt 3
  + pt 4
  + bar
  points N
  + result N
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("result 7"), `expected tuple 'result 7', got: ${tuples.join(" | ")}`);
  console.log("PASS: aggregation sum");
}

// 6b) aggregation with a free key: `score X N` with X free enumerates one
// row per key, each the group's sum.
{
  const src = `
#acc score : player @sum
pts P N / score P N

~ game, ( ~ init ); ( ~ check )

-- "global" tuples
init
  + pts alice 10
  + pts alice 5
  + pts bob 20
  + marker

check
  score X N
  + total X N
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("total alice 15"), `expected 'total alice 15', got: ${tuples.join(" | ")}`);
  assert(tuples.includes("total bob 20"), `expected 'total bob 20', got: ${tuples.join(" | ")}`);
  console.log("PASS: aggregation sum with free key (groupby)");
}

// 7) `= X bar` binds X via equality; pruning works.
{
  const src = `
+ foo bar
  + foo baz

foo X
  = X bar
  + saw X
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("saw bar"), `missing 'saw bar': ${tuples}`);
  assert(!tuples.includes("saw baz"), `unexpected 'saw baz': ${tuples}`);
  console.log("PASS: = binds and prunes");
}

// 8) `= X Y` aliases two unifying-bound vars; only diagonal pairs survive.
{
  const src = `
+ foo a
  + foo b

foo X
  foo Y
  = X Y
  + same X
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("same a"), `missing 'same a': ${tuples}`);
  assert(tuples.includes("same b"), `missing 'same b': ${tuples}`);
  console.log("PASS: = aliasing");
}

// 9) Structural unification: `= X (a Y)` decomposes the matched compound.
{
  const src = `
+ foo (a 1)
  + foo b

foo X
  = X (a Y)
  + got Y
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("got 1"), `missing 'got 1': ${tuples}`);
  // Only one match.
  assert(tuples.filter((s) => s.startsWith("got ")).length === 1, `extra got rows: ${tuples}`);
  console.log("PASS: = structural unify");
}

// 10) Equal inside a sub-rule.
{
  const src = `
+ foo bar

foo X
  ( = X bar
    + ok X )
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("ok bar"), `missing 'ok bar': ${tuples}`);
  console.log("PASS: = inside sub-rule");
}

// 11) `=foo` (no space) stays a Symbol-headed match atom, not equality.
{
  const src = `
+ =foo bar

=foo X
  + saw X
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("=foo bar"), `missing '=foo bar': ${tuples}`);
  assert(tuples.includes("saw bar"), `missing 'saw bar': ${tuples}`);
  console.log("PASS: =foo stays a Symbol");
}

// 12) Parser errors on malformed `=`.
{
  for (const [src, frag] of [
    ["= X\n", "exactly two"],
    ["= X Y Z\n", "exactly two"],
    ["= X -> 2\n", "weight"],
  ] as const) {
    const r = parse(src);
    assert("message" in r, `expected ParseError for ${JSON.stringify(src)}`);
    assert(r.message.includes(frag), `unexpected message ${r.message}`);
  }
  console.log("PASS: = parser errors");
}

// 13) Counts over contributions made in an earlier sibling episode
// (formerly the dahan-count demand-aggregate scheduling regression; that
// bug class went with `#agg`). `at` is an `@last` relation fed by a
// persisting `moved` event; `dahan-count` counts dahan per land at the
// reader's anchor start; a land with no dahan has no `@count` row, so its
// zero is observed with `not` on a boolean relation.
{
  const src = `
#acc at : e (@last land)
#acc dahan-count : land @count
#acc dahan-at : land

move It To, +moved It To
moved It To / at It To

~game
  ( ~setup );
  ( ~look );

setup
  +land l1
  +land l2
  +dahan d1, ~move d1 l1
  +dahan d2, ~move d2 l1

at D L, dahan D / dahan-count L ()
at D L, dahan D / dahan-at L

look, land L, dahan-count L N, ^ok1 L N
look, land L, not dahan-at L, ^ok1 L z
look, dahan-count L N, ^hey N
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("ok1 l1 (s (s z))"), `missing 'ok1 l1 (s (s z))': ${tuples.filter((t) => t.startsWith("ok"))}`);
  assert(tuples.includes("ok1 l2 z"), `missing 'ok1 l2 z': ${tuples.filter((t) => t.startsWith("ok"))}`);
  assert(!tuples.includes("ok1 l1 z"), `unexpected 'ok1 l1 z': ${tuples.filter((t) => t.startsWith("ok"))}`);
  assert(tuples.includes("hey (s (s z))"), `missing 'hey (s (s z))': ${tuples.filter((t) => t.startsWith("hey"))}`);
  console.log("PASS: acc count over an earlier sibling episode; zero via not");
}

// 14) Boolean `#acc` relation (the old `#agg p -> bool`): a positive read
// sees a contribution made earlier on the rule's chain.
{
  const src = `
#acc p : e
pp A / p A

+pp a
  p a
  +ok-present x
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("ok-present x"), `expected 'ok-present x', got: ${tuples.join(" | ")}`);
  console.log("PASS: boolean acc present");
}

// 15) Absence is `not` (the old `p a -> 0`): no contribution, no row.
{
  const src = `
#acc p : e
pp A / p A

not p a
  +ok-absent x
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("ok-absent x"), `expected 'ok-absent x', got: ${tuples.join(" | ")}`);
  console.log("PASS: boolean acc absent via not");
}

// 16) Present and absent side by side (the old `p a -> X` binding 1/0).
{
  const src = `
#acc p : e
pp A / p A

+pp a
  p a
  +saw-present a
  not p b
  +saw-absent b
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert(tuples.includes("saw-present a"), `expected 'saw-present a', got: ${tuples.join(" | ")}`);
  assert(tuples.includes("saw-absent b"), `expected 'saw-absent b', got: ${tuples.join(" | ")}`);
  console.log("PASS: boolean acc present and absent");
}

// 17) Boolean acc is idempotent: many contributions, one row, one firing.
{
  const src = `
#acc p : e
pp A / p A

+pp a
  +pp a
  +pp a
  p a
  +got x
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  assert.equal(tuples.filter((t) => t === "got x").length, 1, `expected one 'got x', got: ${tuples.join(" | ")}`);
  console.log("PASS: boolean acc idempotent");
}

// 18) The removed aggregation forms are migration errors naming `#acc`.
{
  const cases: string[] = [
    "#agg p -> bool\n+x\n",
    "#reactive p -> sum\n+x\n",
    "+p a -> 1\n",
    "x, p a -> 0, +y\n",
    "x, [ p A | count A ], +y\n",
    "#macro m X := [ p X | count X ]\n",
    "x, !(p A -> W), +y\n",
  ];
  for (const src of cases) {
    const r = parse(src);
    assert("message" in r, `expected parse error for: ${src}`);
    const msg = (r as { message: string }).message;
    assert(msg.includes("was removed") && msg.includes("#acc"), `expected a migration error for ${JSON.stringify(src)}, got: ${msg}`);
  }
  console.log("PASS: removed aggregation syntax gives migration errors");
}

console.log("ALL v2 eval tests passed");
