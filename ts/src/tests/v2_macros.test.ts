// Aggregation synonyms `#macro head P1..Pn := [ ... ]`
// (plans/v2-aggregation-synonyms.md).
import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { expandStages } from "../v2/expand.js";
import { renderRuleAtom } from "../v2/print-ir.js";
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
  if (!("message" in p)) throw new Error("expected parse error, got program");
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

// A stored tuple's user-visible part (drop the trailing id slot).
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

function rows(src: string, head: string): string[] {
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `run did not complete: ${JSON.stringify(status)}`);
  return rowsWithHead(store, head);
}

// The macro-expanded body of rule `idx`, alpha-normalized so the specific
// fresh names minted don't matter.
function shape(src: string, idx: number): string {
  const body = expandStages(ok(src)).macroExpanded[idx]!.body;
  const text = body.map(renderRuleAtom).join("\n");
  const names = new Map<string, string>();
  return text.replace(/\?([A-Za-z_][\w:-]*)/g, (_m, n: string) => {
    if (!names.has(n)) names.set(n, `v${names.size + 1}`);
    return `?${names.get(n)}`;
  });
}

// ----- the source note's example, end to end -----

const LAND = `#macro land:count B A := [[at A B | last B] | count A]`;
const DATA = `+ at i1 h, + at i1 a, + at i2 a, + go`;

{
  // A use agrees with the hand-written expansion, both in rewritten shape
  // and in what it derives.
  const used = `
${LAND}

${DATA}

go
  land:count L X
  ^ found L X
`;
  // The hand-written expansion, written with explicit output patterns so it
  // is the same IR shape the macro produces.
  const inlined = `
${DATA}

go
  [[at A B | L = last B] | X = count A]
  ^ found L X
`;
  assert.deepEqual(rows(used, "found"), rows(inlined, "found"));
  // Both invaders' last location is `a`, so one row with a count of 2.
  assert.deepEqual(rows(used, "found"), ["found a (s (s z))"]);
  assert.equal(shape(used, 1), shape(inlined, 1));
  assert.equal(
    shape(used, 1).split("\n")[1],
    "AggComp [AggComp [Atom[match] at ?v1 ?v2 | ?v3 = last ?v2] | ?v4 = count ?v1]",
  );
  console.log("PASS: macro use matches the hand-written expansion");
}

{
  // Repeated argument: the two body positions stay distinct and the
  // relationship is imposed by unification, not by collapsing them.
  // `at i1 (s z)` — one invader at location `(s z)`, so location = count.
  const src = `
${LAND}

+ at i1 (s z), + at i2 b, + at i3 b, + go

go
  land:count X X
  ^ same X
`;
  // The collapsing reading would need a tuple `at X X`, of which there is
  // none; the unifying reading finds the location whose name is its count.
  assert.deepEqual(rows(src, "same"), ["same (s z)"]);
  console.log("PASS: repeated argument unifies rather than collapses");
}

{
  // A non-Variable argument filters.
  const src = `
${LAND}

${DATA}

go
  land:count a X
  ^ at-a X

go
  land:count h X
  ^ at-h X
`;
  assert.deepEqual(rows(src, "at-a"), ["at-a (s (s z))"]);
  // `h` is nobody's *last* location, so the query is empty. Substituting the
  // group column away leaves an empty group key, and the empty-key policy
  // then yields count's zero rather than no row at all. This is the
  // divergence plans/v2-aggregation-synonyms.md defers to the empty-group
  // policy in plans/v2-bracket-aggregation.md — pinned here as *current*
  // behavior, not as a decision.
  assert.deepEqual(rows(src, "at-h"), ["at-h z"]);
  console.log("PASS: ground argument filters");
}

{
  // `_` leaves the parameter unconstrained: the count is simply discarded.
  const src = `
${LAND}

${DATA}

go
  land:count L _
  ^ some L
`;
  assert.deepEqual(rows(src, "some"), ["some a"]);
  console.log("PASS: '_' argument leaves a parameter unconstrained");
}

// ----- scoping, freshness, capture -----

{
  // Use before definition (definitions are file-scoped, order-independent).
  const src = `
${DATA}

go
  land:count L X
  ^ found L X

${LAND}
`;
  assert.deepEqual(rows(src, "found"), ["found a (s (s z))"]);
  console.log("PASS: a use may precede its definition");
}

{
  // Two uses in one rule get independent fresh names, and a host-rule
  // variable sharing a name with a body variable stays distinct. `A` and
  // `B` are the macro body's own variable names.
  const src = `
${LAND}

${DATA}
  + tag t

go
  tag A
  land:count L X
  land:count L2 X2
  ^ pair A L L2
`;
  assert.deepEqual(rows(src, "pair"), ["pair t a a"]);
  console.log("PASS: two uses in one rule, no capture of host names");
}

{
  // An argument variable sharing a name with an internal body variable
  // (`A` is the macro's outer reduction variable) is not captured.
  const src = `
${LAND}

${DATA}

go
  land:count A B
  ^ got A B
`;
  assert.deepEqual(rows(src, "got"), ["got a (s (s z))"]);
  console.log("PASS: argument names may shadow internal body names");
}

// ----- macros over plain group columns -----

const FSUM = `#macro f:sum X Y := [p X Y Z | sum Z]`;
const PDATA = `+ p 1 1 5, + p 1 2 7, + p 2 2 3, + go`;

{
  const src = `
${FSUM}

${PDATA}

go
  f:sum 1 Y
  ^ with-1 Y
`;
  assert.deepEqual(rows(src, "with-1"), ["with-1 1", "with-1 2"]);
}
{
  // Repeated argument over two group columns: keeps the rows where the two
  // columns agree.
  const src = `
${FSUM}

${PDATA}

go
  f:sum W W
  ^ diag W
`;
  assert.deepEqual(rows(src, "diag"), ["diag 1", "diag 2"]);
  console.log("PASS: parameters that are plain group columns");
}

// ----- composition -----

{
  // Macro calling a macro: `pop:at L N` counts the invaders whose last
  // location is `L`, and `busy L` re-aggregates over that to keep the
  // locations holding two or more.
  const src = `
#macro pop:at L N := [[at A B | L = last B] | N = count A]
#macro busy L := [pop:at L N | (s (s _)) = last N]

${DATA}

go
  busy L
  ^ crowded L
`;
  assert.deepEqual(rows(src, "crowded"), ["crowded a"]);
  console.log("PASS: a macro may call another macro");
}

{
  // A macro used inside another bracket expression's query.
  const src = `
#macro pop:at L N := [[at A B | L = last B] | N = count A]

${DATA}

go
  [ pop:at L N | K = count L ]
  ^ places K
`;
  assert.deepEqual(rows(src, "places"), ["places (s z)"]);
  console.log("PASS: a macro may be used inside a bracket query");
}

// ----- tokenizer -----

{
  // A multi-line definition (bracket spanning lines, with a comment and a
  // blank line inside) parses identically to the one-line form, as does an
  // RHS starting on the line after `:=`.
  const oneLine = ok(`${LAND}\n`);
  const multiLine = ok(`
#macro land:count B A :=
  [[at A B | last B]   -- inner: each invader's last location

   | count A]
`);
  const shapeOf = (p: ReturnType<typeof ok>) =>
    renderRuleAtom(p.macros.get("land:count")!.body).replace(
      /\?([A-Za-z_][\w:-]*)/g,
      (() => {
        const names = new Map<string, string>();
        return (_m: string, n: string) => {
          if (!names.has(n)) names.set(n, `v${names.size + 1}`);
          return `?${names.get(n)}`;
        };
      })(),
    );
  assert.equal(shapeOf(multiLine), shapeOf(oneLine));
  assert.equal(oneLine.macros.get("land:count")!.params.join(","), "B,A");
  console.log("PASS: multi-line macro definitions");
}

{
  // Without `#macro`, `:=` has no special meaning anywhere — it stays part
  // of the atom and defines nothing.
  const p = ok(`\ngo\n  foo X := bar\n`);
  assert.equal(p.macros.size, 0);
  assert.equal(p.rules.length, 1);
  // `#macro` is a command, so definitions need no blank line between them
  // and a use may sit directly beneath one.
  const adjacent = ok(`
#macro one:x A B := [ p A B | count B ]
#macro two:x A B := [ q A B | count B ]
go
  one:x L N
  ^ got L N
`);
  assert.deepEqual([...adjacent.macros.keys()], ["one:x", "two:x"]);
  assert.equal(adjacent.rules.length, 1);
  // A definition cannot hide behind a `#def`.
  assert.match(err(`\n#def r\n#macro foo X := [ p X | count X ]\n`), /'#macro' must begin its own definition/);
  // `#macro` without a `:=`.
  assert.match(err(`\n#macro foo X [ p X | count X ]\n`), /'#macro' definition requires ':='/);
  console.log("PASS: '#macro' is a command, not positional syntax");
}

// ----- errors -----

assert.match(err(`\n#macro land:count B A := [[at A B | last B] | count A]\n#macro land:count B A := [ at A B | count B ]\n`), /duplicate macro definition for 'land:count'/);
assert.match(err(`\n#macro foo:bar X := [ p X | count X ]\n`), /parameter\(s\) but its name implies arity 2/);
assert.match(err(`\n#macro foo X Y := [ p X Y | count X ]\n`), /parameter\(s\) but its name implies arity 1/);
assert.match(err(`\n#macro foo:bar X a := [ p X | count X ]\n`), /macro parameters must be variables/);
assert.match(err(`\n#macro foo:bar X _ := [ p X | count X ]\n`), /macro parameter cannot be '_'/);
assert.match(err(`\n#macro foo:bar X X := [ p X | count X ]\n`), /duplicate macro parameter 'X'/);
assert.match(err(`\n#macro X := [ p X | count X ]\n`), /macro name must be a symbol/);
assert.match(err(`\n#macro foo X := p X\n`), /body must be a '\[ \.\.\. \]' aggregate expression/);
assert.match(err(`\n#macro foo X :=\n`), /body must be a '\[ \.\.\. \]' aggregate expression/);
assert.match(err(`\n#macro foo X := [ p X Y | count Y ], q X\n`), /definition must end after its body/);
console.log("PASS: macro definition errors");

{
  const M = `#macro pop:at L N := [[at A B | L = last B] | N = count A]`;
  // Recursion, direct and mutual.
  assert.throws(
    () => runFixpoint(ok(`\n#macro r:x A B := [ r:x A B | count B ]\n\ngo\nr:x Z W\n`)),
    /macros cannot recurse \(r:x -> r:x\)/,
  );
  assert.throws(
    () => runFixpoint(ok(`\n#macro a:x A B := [ b:x A B | count B ]\n#macro b:x A B := [ a:x A B | count B ]\n\ngo\na:x Z W\n`)),
    /macros cannot recurse/,
  );
  // A parameter with no outward meaning: `A` is the reduction variable.
  assert.throws(
    () => runFixpoint(ok(`\n#macro m:x A C := [ p A B C | S = sum C ]\n\ngo\nm:x Z W\n`)),
    /parameter 'C' is not an output variable/,
  );
  // Non-match markers, weights, exception LHS, constrain blocks, over-arity.
  assert.throws(() => runFixpoint(ok(`\n${M}\n\ngo\n~pop:at L N\n`)), /a macro name is not a relation/);
  assert.throws(() => runFixpoint(ok(`\n${M}\n\ngo\npop:at L N -> 3\n`)), /a macro name is not a relation/);
  assert.throws(
    () => runFixpoint(ok(`\n${M}\n\ngo\n{pop:at L N => ^ e L}\n`)),
    /a macro name is not a relation/,
  );
  assert.throws(
    () => runFixpoint(ok(`\n${M}\n\ngo\n!(pop:at L N)\n`)),
    /a macro name is not a relation/,
  );
  assert.throws(
    () => runFixpoint(ok(`\n${M}\n\ngo\npop:at L N Q\n`)),
    /takes 2 argument\(s\), given 3/,
  );
  console.log("PASS: macro use errors");
}

console.log("v2_macros: all tests passed");
