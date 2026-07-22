// Bracket aggregation `[ Q | op V ]` (plans/v2-bracket-aggregation.md).
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

function err(input: string): string {
  const p = parse(input);
  if (!("message" in p)) throw new Error(`expected parse error, got program`);
  return p.message;
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

// Render a stored tuple's user-visible part (drop the trailing id slot).
function renderAtom(store: Store, atom: Atom): string {
  const ts = atom.terms.length > 0 ? atom.terms.slice(0, -1) : atom.terms;
  return ts.map((t) => renderTerm(store, t)).join(" ");
}

function rowsWithHead(store: Store, head: string): string[] {
  return store.tuples
    .filter((t) => {
      const h = t.atom.terms[0];
      return h !== undefined && h.tag === "Symbol" && h.name === head;
    })
    .map((t) => renderAtom(store, t.atom))
    .sort();
}

// ----- Parse errors -----

assert.match(err(`\nfoo, [ p X\n`), /unterminated '\['/);
assert.match(err(`\nfoo, p X ]\n`), /stray '\]'/);
assert.match(err(`\nfoo, [ p X ]\n`), /requires '\| <op> <Var>'/);
assert.match(err(`\nfoo, [ p X | count X | sum X ]\n`), /more than one top-level '\|'/);
assert.match(err(`\nfoo, [ p X | frob X ]\n`), /unknown reduction op 'frob'/);
assert.match(err(`\nfoo, [ p X | count _ ]\n`), /reduction variable cannot be '_'/);
assert.match(err(`\nfoo, [ p X | count p ]\n`), /reduction must name a variable/);
assert.match(err(`\nfoo, [ p X | count ]\n`), /reduction must be '<op> <Var>'/);
assert.match(err(`\nfoo, [ +p X | count X ]\n`), /cannot carry a marker/);
assert.match(err(`\nfoo, [ p X -> W | count W ]\n`), /cannot carry '-> weight'/);
assert.match(err(`\nfoo, [ . p X | count X ]\n`), /dot must follow an atom/);
assert.match(err(`\nfoo, [ p X . | count X ]\n`), /trailing '\.' with no right-hand atom/);
assert.match(err(`\nfoo, [ p X . . q Y | count X ]\n`), /consecutive '\.'/);
assert.match(
  err(`\nfoo, [ p X . [ q Y | count Y ] | count X ]\n`),
  /right of '\.' must be a plain atom/,
);
assert.match(err(`\nfoo, [ | count X ]\n`), /empty item|at least one item/);
assert.match(err(`\nfoo [ p X | count X ]\n`), /'\[' must start a query item/);
console.log("PASS: parse errors");

// ----- Decompose errors (reduce var restrictions) -----

assert.throws(
  () => runFixpoint(ok(`\ngo\np X\n[ q X | count X ]\n`)),
  /reduction variable 'X' is bound earlier/,
);
assert.throws(
  () => runFixpoint(ok(`\ngo\n[ q Y | count X ]\n`)),
  /reduction variable 'X' does not occur/,
);
console.log("PASS: decompose errors");

// ----- sum with grouping (the note's example) -----
// {p 2 4, p 1 1, p 1 3} -> {(X:1,Y:4), (X:2,Y:4)}
{
  const src = `
+ p 2 4, + p 1 1, + p 1 3, + go

go
[ p X Y | sum Y ]
^ out X Y
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1 4", "out 2 4"]);
  console.log("PASS: sum with grouping");
}

// ----- count with empty group key; zero rows on empty input -----
{
  const src = `
+ invader i1, + invader i2, + invader i3, + go

go
[ invader X | count X ]
^ num X
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "num"), ["num (s (s (s z)))"]);
  console.log("PASS: count over all rows");
}
{
  // No q tuples at all: count with an empty group key still produces one
  // zero row; sum likewise.
  const src = `
+ go

go
[ q X | count X ]
^ num X

go
[ q Y | sum Y ]
^ total Y
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "num"), ["num z"]);
  assert.deepEqual(rowsWithHead(store, "total"), ["total 0"]);
  console.log("PASS: zero rows on empty input");
}
{
  // Empty `last`: no result rows, run still completes.
  const src = `
+ go

go
[ q X | last X ]
^ got X
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "got"), []);
  console.log("PASS: empty last produces no rows");
}

// ----- prefix-bound parameter + last -----
{
  const src = `
+ monster m1, + monster m2, + it:at m1 a, + it:at m1 b, + it:at m2 c, + go

go
monster X
[ it:at X L | last L ]
^ at-last X L
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "at-last"), ["at-last m1 b", "at-last m2 c"]);
  console.log("PASS: prefix-bound parameter with last");
}

// ----- anchor restriction: tuples not containing the anchor don't count -----
{
  const src = `
+ p 1 3, + go

+ p 2 4

go
[ p X Y | sum Y ]
^ out X Y
`;
  const { store } = runFixpoint(ok(src));
  // `p 2 4` lives on an incomparable branch — its interval does not
  // contain go's anchor, so only `p 1 3` contributes.
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1 3"]);
  console.log("PASS: anchor restriction");
}

// ----- nesting, and its flattened equivalent -----
{
  const inner = `[ [ it:at X L, invader X | last L ] | count X ]`;
  const flat = `[ invader X, [ it:at X L | last L ] | count X ]`;
  const mk = (comp: string) => `
+ invader i1, + invader i2, + it:at i1 h, + it:at i1 a, + it:at i2 a, + go

go
${comp}
^ at-count L X
`;
  for (const comp of [inner, flat]) {
    const { store } = runFixpoint(ok(mk(comp)));
    // i1's last location is `a` (h then a); i2's is `a` — two invaders at
    // `a`, so one row: at-count a (s (s z)).
    assert.deepEqual(rowsWithHead(store, "at-count"), ["at-count a (s (s z))"], comp);
  }
  console.log("PASS: nested aggregation (both formulations)");
}

// ----- per-group sum with a prefix-bound group parameter -----
{
  const src = `
+ score p1 2, + score p1 3, + score p2 5, + player p1, + player p2, + go

go
player P
[ score P X | sum X ]
^ total P X
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "total"), ["total p1 5", "total p2 5"]);
  console.log("PASS: per-player sum via prefix binding");
}

// ----- multi-line expression (incl. blank line and comment inside) -----
{
  const src = `
+ p 2 4, + p 1 1, + p 1 3, + go

go
[ p X Y -- contributes per tuple

  | sum Y ]
^ out X Y
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1 4", "out 2 4"]);
  console.log("PASS: multi-line bracket expression");
}

// ----- set semantics: duplicate derivations collapse before count/sum -----
{
  // `q` matches two distinct tuples that agree on X; `count X` counts
  // distinct bindings, not derivations.
  const src = `
+ tag t1 v, + tag t2 v, + go

go
[ tag _ V | count V ]
^ num V
`;
  const { store } = runFixpoint(ok(src));
  // Bindings over {V}: just {v} — the `_` positions are projected away.
  assert.deepEqual(rowsWithHead(store, "num"), ["num (s z)"]);
  console.log("PASS: set semantics over free variables");
}

// ----- dot notation inside the query -----
{
  // `p X . q Y` links p's id into q's first slot, exactly as in a rule
  // body; the linking var is an ordinary free variable of the query.
  const src = `
+ p 1 . + q 10, + p 2 . + q 5, + p 3, + go

go
[ p X . q Y | sum Y ]
^ out Y
`;
  const { store } = runFixpoint(ok(src));
  // One group per (X, link) pair; `p 3` has no q and contributes nothing.
  assert.deepEqual(rowsWithHead(store, "out"), ["out 10", "out 5"]);
  console.log("PASS: dot notation in aggregate query");
}

{
  // The dot form desugars to the explicit link-variable form.
  const dotted = ok(`\ngo\n[ p X . q Y | sum Y ]\n^ out Y\n`);
  const spelled = ok(`\ngo\n[ p X L, q L Y | sum Y ]\n^ out Y\n`);
  // Alpha-normalize: rename variables to v1, v2, ... in first-occurrence order.
  const alpha = (body: unknown) => {
    const names = new Map<string, string>();
    return JSON.stringify(body).replace(/"tag":"Variable","name":"([^"]+)"/g, (_m, n: string) => {
      if (!names.has(n)) names.set(n, `v${names.size + 1}`);
      return `"tag":"Variable","name":"${names.get(n)}"`;
    });
  };
  assert.equal(alpha(dotted.rules[0]!.body), alpha(spelled.rules[0]!.body));
  console.log("PASS: dot form matches explicit link variable");
}

{
  // Dots inside a nested expression resolve independently.
  const src = `
+ p 1 . + q a, + p 2 . + q b, + go

go
[ [ p X . q L | last L ] | count X ]
^ num X
`;
  const { store } = runFixpoint(ok(src));
  // The dot's linking variable is a free variable of the inner query, so it
  // stays in the outer group key: one group per (link, L) pair, each of size 1.
  assert.deepEqual(rowsWithHead(store, "num"), ["num (s z)", "num (s z)"]);
  console.log("PASS: dot notation inside a nested expression");
}

// ----- separate output variable `[ Q | Out = op V ]` -----
// (plans/v2-agg-output-var.md)

{
  // `S` names the fold's result; `Y` is the reduced query column and is
  // *not* visible outward — the later `q Y` binds a fresh variable.
  const src = `
+ p 1 3, + q 9, + go

go
[ p X Y | S = sum Y ], q Y
^ out X S Y
`;
  const { store } = runFixpoint(ok(src));
  // If `Y` leaked as 3, `q Y` would fail to match (`q 9` is the only row).
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1 3 9"]);
  console.log("PASS: output variable is distinct from the reduced column");
}

{
  // A nested expression contributes its *output* columns to the enclosing
  // query, so the inner reduction variable does not leak outward.
  const src = `
+ p 1 3, + p 1 4, + p 2 5, + go

go
[ [ p X Y | S = sum Y ] | N = count X ]
^ out S N
`;
  const { store } = runFixpoint(ok(src));
  // Inner rows: (X=1,S=7), (X=2,S=5). Grouping the outer query by `S`
  // alone (not by `Y`) gives one X per sum.
  assert.deepEqual(rowsWithHead(store, "out"), ["out 5 (s z)", "out 7 (s z)"]);
  console.log("PASS: nested reduction variable does not leak outward");
}

{
  // A prefix-bound `Out` filters: only the group whose sum unifies survives.
  const src = `
+ p 1 3, + p 2 5, + q 3, + go

go
q S
[ p X Y | S = sum Y ]
^ out X S
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1 3"]);
  console.log("PASS: prefix-bound output pattern filters groups");
}

{
  // A ground `Out` filters the same way.
  const src = `
+ p 1 3, + p 2 5, + go

go
[ p X Y | 3 = sum Y ]
^ out X
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1"]);
  console.log("PASS: ground output pattern filters groups");
}

{
  // A compound `Out` destructures the folded value.
  const src = `
+ q a, + q b, + go

go
[ q X | (s N) = count X ]
^ out N
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "out"), ["out (s z)"]);
  console.log("PASS: compound output pattern");
}

{
  // Empty input, empty group key: the aggregator's zero is unified against
  // `Out`, so a matching pattern fires and a non-matching one does not.
  const src = `
+ go

go
[ q X | 0 = sum X ]
^ hit zero

go
[ q X | 5 = sum X ]
^ hit five
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "hit"), ["hit zero"]);
  console.log("PASS: empty input unifies the zero against Out");
}

{
  // All-filter expression: zero output columns, so the result row is a
  // zero-term Atom. Assert both the nonempty and the empty-input case.
  const src = `
+ q a, + q b, + go

go
[ q X | (s (s z)) = count X ]
^ found two

go
[ q X | (s (s (s z))) = count X ]
^ found three
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "found"), ["found two"]);
}
{
  const src = `
+ go

go
[ q X | z = count X ]
^ found none

go
[ q X | (s z) = count X ]
^ found one
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "found"), ["found none"]);
  console.log("PASS: expression with zero output columns");
}

{
  // Column order round-trips positionally: the layout written by
  // expand.ts's `aggCompOutCols` is read back by comp-aggregate.ts's
  // `compOutCols`.
  const src = `
+ p 1 2 3 4, + p 1 2 3 5, + go

go
[ p A B C D | S = sum D ]
^ out A B C S
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "out"), ["out 1 2 3 9"]);
  console.log("PASS: output column order round-trips");
}

// ----- output-variable errors -----

assert.match(
  err(`\nfoo, [ p X Y | Y = sum Y ]\n`),
  /reduction output cannot mention the reduction variable 'Y'/,
);
assert.match(
  err(`\nfoo, [ p X Y | a b = sum Y ]\n`),
  /left of '=' in a reduction must be a single term/,
);
assert.throws(
  // Disjointness: `X` is both an output variable and a query column.
  () => runFixpoint(ok(`\ngo\n[ p X Y | X = sum Y ]\n`)),
  /output variable 'X' also occurs in the aggregate query/,
);
assert.throws(
  // Disjointness reaches nested levels' reduction variables too.
  () => runFixpoint(ok(`\ngo\n[ [ p X Y | S = sum Y ] | Y = count X ]\n`)),
  /output variable 'Y' also occurs in the aggregate query/,
);
assert.throws(
  () => runFixpoint(ok(`\ngo\nq Y\n[ p X Y | S = sum Y ]\n`)),
  /reduction variable 'Y' is bound earlier/,
);
assert.throws(
  () => runFixpoint(ok(`\ngo\n[ q Y | S = count X ]\n`)),
  /reduction variable 'X' does not occur/,
);
console.log("PASS: output-variable errors");

// ----- an empty aggregate must not stall later ones -----

{
  // `nothing` has no tuples, and grouping by `T` means the empty-input
  // policy yields no result row at all. Its `_do-aggc` producer is closed
  // with the `*agg-empty` sentinel; without that it stays blocked forever
  // at the earliest moment, and since the outer loop only works the
  // earliest tier, every later aggregate goes unclosed and the run still
  // reports `done`.
  const src = `
+ score 1, + score 2, + go

go
[ score X | sum X ]
^ first X

go
[ nothing I T | count I ]
^ never I T

first X
[ score Y | sum Y ]
^ second Y
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "first"), ["first 3"]);
  assert.deepEqual(rowsWithHead(store, "never"), []);
  // The payoff: an aggregate downstream of the empty one still runs.
  assert.deepEqual(rowsWithHead(store, "second"), ["second 3"]);
  console.log("PASS: an empty aggregate does not stall later aggregates");
}

// ----- `some`: existence reduction (plans/v2-bracket-some.md) -----

assert.match(err(`\nfoo, [ p X | frob X ]\n`), /count, sum, last, some, or none/);
assert.match(
  err(`\nfoo, [ p X Y | X = some Y ]\n`),
  /'some' takes no output pattern/,
);
console.log("PASS: some parse errors");

{
  // `[ p X Y | some Y ]` binds only X: one row per X for which some Y exists.
  // Y is eliminated from scope, so the trailing `q Y` binds a fresh Y.
  const src = `
+ p a 1, + p a 2, + p b 3, + q 9, + go

go
[ p X Y | some Y ], q Y
^ out X Y
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  // If Y leaked (as 1/2/3), `q Y` (only `q 9`) would not match.
  assert.deepEqual(rowsWithHead(store, "out"), ["out a 9", "out b 9"]);
  console.log("PASS: some binds the group key and eliminates its variable");
}

{
  // `[ p X | some X ]` binds nothing: a pass/fail guard. Non-empty p passes,
  // so the guarded emit fires exactly once regardless of how many tuples
  // contributed.
  const src = `
+ p a, + p b, + go

go
[ p X | some X ]
^ present yes
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "present"), ["present yes"]);
  console.log("PASS: some as a guard passes on non-empty input");
}

{
  // Empty input: the existence check is false, so no result row — the guard
  // fails and the rule does not fire. (Unlike count/sum, which emit a zero
  // row for an empty group key.)
  const src = `
+ go

go
[ p X | some X ]
^ present yes
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  assert.deepEqual(rowsWithHead(store, "present"), []);
  console.log("PASS: some fails on empty input");
}

{
  // Set semantics: duplicate derivations over the key collapse to one row.
  const src = `
+ p a 1, + p a 1, + p a 2, + go

go
[ p X Y | some Y ]
^ has X
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "has"), ["has a"]);
  console.log("PASS: some collapses duplicate group keys");
}

// ----- `none`: negated existence (plans/v2-bracket-some.md) -----

assert.match(
  err(`\nfoo, [ p X Y | X = none Y ]\n`),
  /'none' takes no output pattern/,
);
assert.throws(
  // `none` cannot carry a group key: X is a free column.
  () => runFixpoint(ok(`\ngo\n[ p X Y | none Y ]\n`)),
  /'none' binds nothing.*free column 'X'/,
);
console.log("PASS: none parse/expand errors");

{
  // `[ p X | none X ]` is the complement of `[ p X | some X ]`: it succeeds
  // (guard passes) exactly when p is empty at the anchor.
  const empty = `\n+ go\n\ngo\n[ p X | none X ]\n^ absent yes\n`;
  const nonempty = `\n+ p a, + go\n\ngo\n[ p X | none X ]\n^ absent yes\n`;
  {
    const { store, status } = runFixpoint(ok(empty));
    assert.equal(status.kind, "done");
    assert.deepEqual(rowsWithHead(store, "absent"), ["absent yes"]);
  }
  {
    const { store, status } = runFixpoint(ok(nonempty));
    assert.equal(status.kind, "done");
    assert.deepEqual(rowsWithHead(store, "absent"), []);
  }
  console.log("PASS: none is the complement of some");
}

{
  // Prefix-bound filter: a monster with no recorded location. X comes from
  // the outer `monster X` (substituted into the query, not a group key), so
  // the bracket binds nothing and X stays bound for the emit.
  const src = `
+ monster m1, + monster m2, + monster m3, + it:at m1 a, + it:at m2 b, + go

go
monster X
[ it:at X L | none L ]
^ homeless X
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done");
  // m1, m2 have locations; only m3 is homeless.
  assert.deepEqual(rowsWithHead(store, "homeless"), ["homeless m3"]);
  console.log("PASS: none as a prefix-bound negation filter");
}

{
  // some and none partition: for each monster, exactly one of the guards
  // fires.
  const src = `
+ monster m1, + monster m2, + it:at m1 a, + go

go
monster X
[ it:at X L | some L ]
^ seen X

go
monster X
[ it:at X L | none L ]
^ unseen X
`;
  const { store } = runFixpoint(ok(src));
  assert.deepEqual(rowsWithHead(store, "seen"), ["seen m1"]);
  assert.deepEqual(rowsWithHead(store, "unseen"), ["unseen m2"]);
  console.log("PASS: some and none partition the prefix bindings");
}

console.log("v2_bracket_agg: all tests passed");
