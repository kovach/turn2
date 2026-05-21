import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../types.js";
import type { Store } from "../v2/store.js";
import { expandTerm } from "../hashcons.js";

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

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

// 1) `?` lowers to a choose row; reaching it produces exactly one row.
{
  const src = `
+ turn

turn
? C
+ cell-choice C
`;
  const { store, status } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  const chooseRows = tuples.filter((t) => t.startsWith("_choose "));
  assert.equal(chooseRows.length, 1, `expected 1 _choose row, got: ${chooseRows.join(" | ")}`);
  // Without a constrain row this fails the empty-fringe check; the
  // cell-choice row is still emitted by the inner loop before the scheduler
  // surfaces the error.
  const cc = tuples.filter((t) => t.startsWith("cell-choice"));
  assert.equal(cc.length, 1, `expected 1 cell-choice, got: ${cc.join(" | ")}`);
  assert.equal(status.kind, "empty-fringe-error", `status: ${status.kind}`);
  console.log("PASS: ? without ! reports empty-fringe-error");
}

// 2) `!` lowers to a constrain row.
{
  const src = `
+ a
a
! foo bar
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  const cs = tuples.filter((t) => t.startsWith("_constrain"));
  assert.equal(cs.length, 1, `expected 1 _constrain row, got: ${cs.join(" | ")}`);
  // Shape: "_constrain (foo bar)"
  assert(cs[0]!.includes("(foo bar)"), `expected wrapped (foo bar), got: ${cs[0]}`);
  console.log("PASS: ! emits one _constrain row");
}

// 3) Choice + constraint surfaces an active-choices status.
{
  const src = `
+ cell c1
+ cell c2
+ turn

turn
? C
! cell C
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 1, "expected 1 active choose");
  console.log("PASS: ? + ! surfaces active-choices");
}

// 4) Resolution: a downstream rule that explicitly matches `is C V` blocks
//    until the harness writes `+ is <freshId> <value>`, then unblocks and
//    produces a tuple containing the resolved value.
{
  // Phase 1: run once to discover the active fresh-id for C.
  const phase1 = `
+ cell c1
+ turn

turn
? C
! cell C
+ cell-choice C

cell-choice C
is C V
+ resolved V
`;
  const r1 = runFixpoint(ok(phase1));
  assert.equal(r1.status.kind, "active-choices");
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");
  const choice = r1.status.choices[0]!;
  assert.equal(choice.activeTerms.length, 1);
  // Pre-resolution: cell-choice exists with the fresh-id as its arg, but
  // `resolved` does not yet exist (the second rule is blocked at `is C V`).
  const r1tuples = listTuples(r1.store);
  assert(
    r1tuples.some((t) => t.startsWith("cell-choice ")),
    `expected cell-choice <freshId>, got: ${r1tuples.join(" | ")}`,
  );
  assert(
    !r1tuples.some((t) => t === "resolved c1"),
    "did not expect 'resolved c1' before is-row",
  );

  // Phase 2: append the harness's resolution row and re-run. The `^` marker
  // makes the row's interval = the rule's initial anchor (bot, top), so it
  // is moment-comparable to every other tuple — `is` is conceptually a
  // timeless meta-relation.
  const activeText = renderTerm(r1.store, choice.activeTerms[0]!);
  const phase2 = phase1 + `\n^ is ${activeText} c1\n`;
  const r2 = runFixpoint(ok(phase2));
  assert.equal(r2.status.kind, "done", `phase2 status: ${r2.status.kind}`);
  const tuples = listTuples(r2.store);
  assert(
    tuples.some((t) => t === "resolved c1"),
    `expected 'resolved c1', got: ${tuples.filter((t) => t.startsWith("resolved")).join(" | ")}`,
  );
  console.log("PASS: is-resolution unblocks downstream rule");
}

// 5) Two independent chooses at different moments — only the earliest tier
//    surfaces. The later one stays blocked and would re-surface after the
//    earlier is resolved.
{
  const src = `
+ cell c1
+ cell c2
+ turn

turn
? A
! cell A
? B
! cell B
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 1, `expected only earliest choose to surface, got ${status.choices.length}`);
  assert.equal(status.components.length, 1);
  assert.equal(status.components[0]!.activeTerms.length, 1);
  console.log("PASS: independent later choose stays blocked while earliest surfaces");
}

// 6) Entanglement via a shared `_constrain` row: two chooses sharing one
//    constraint surface together even though only one is in the earliest
//    tier.
{
  const src = `
+ pair c1 c1
+ turn

turn
? A
? B
! pair A B
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 2, "both chooses should be pulled in by shared constrain row");
  assert.equal(status.components.length, 1, "shared row -> one entangled component");
  assert.equal(status.components[0]!.activeTerms.length, 2);
  console.log("PASS: shared _constrain row entangles seed with later choose");
}

// 7) Mixed: A and B entangled via `! pair A B`; D is independent. Earliest
//    tier seed = {A}; closure pulls in B; D stays blocked.
{
  const src = `
+ pair c1 c2
+ cell c1
+ turn

turn
? A
? B
! pair A B
? D
! cell D
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 2, `independent later choose should stay blocked, got ${status.choices.length}`);
  assert.equal(status.components.length, 1);
  assert.equal(status.components[0]!.activeTerms.length, 2);
}
console.log("PASS: mixed entangled + independent — only entangled batch surfaces");

// 8) Sequential c1 episodes with a `! at C -> here` constrain-agg that
//    narrows after the first choice. After picking t1, t1's last `at`
//    becomes `there`, so only t2 satisfies `at C -> here` in the second
//    c1. Exercises canonical-moment evaluation across the two
//    constrain rows in one component (! thing + ! at) and the agg row
//    seeing the post-resolution `+at t1 there`.
{
  const src = `
~game

#acc at * -> last

game, +thing t1, +thing t2, +thing bad
+at t1 -> here
+at t2 -> here
+monster t1
  ( ~c1 );
  ( ~c1 );

c1
?C
~it C
!thing C

c1, it C, !at C -> here

c1
( it C, is C V ); +at V there
`;
  // Phase 1: first c1 surfaces. Options should be {t1, t2} — `bad` is
  // excluded by `! at C -> here` (no `at bad` contribution).
  const r1 = runFixpoint(ok(src));
  assert.equal(r1.status.kind, "active-choices", `phase1 status: ${r1.status.kind}`);
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r1.status.components.length, 1, "phase1: expected 1 component");
  const comp1 = r1.status.components[0]!;
  assert.equal(comp1.activeTerms.length, 1, "phase1: expected 1 active term");
  const opts1 = comp1.options.map((opt) => renderTerm(r1.store, opt[0]!)).sort();
  assert.deepEqual(opts1, ["t1", "t2"], `phase1 options: ${opts1.join(",")}`);

  // Resolve first c1's choice to t1.
  const activeText = renderTerm(r1.store, comp1.activeTerms[0]!);
  const src2 = src + `\n^ is ${activeText} t1\n`;

  // Phase 2: second c1 surfaces; t1 now has `at t1 -> there` from the
  // sub-rule (`( it C, is C V ); +at V there`), so under `last` it no
  // longer satisfies `at C -> here`. Only t2 remains.
  const r2 = runFixpoint(ok(src2));
  assert.equal(r2.status.kind, "active-choices", `phase2 status: ${r2.status.kind}`);
  if (r2.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r2.status.components.length, 1, "phase2: expected 1 component");
  const comp2 = r2.status.components[0]!;
  const opts2 = comp2.options.map((opt) => renderTerm(r2.store, opt[0]!)).sort();
  assert.deepEqual(opts2, ["t2"], `phase2 options: ${opts2.join(",")}`);
  console.log("PASS: sequential c1's narrow {t1,t2} → {t2} after resolving t1");
}

// 9) The `!thing C` constraint is what gives the choice component a
//    plain-row anchor; without it the choice has no satisfiable option
//    even though `!at C -> a` could in principle match (timing /
//    contribution-visibility differences).
{
  const baseWithThing = `
#acc at * -> last

(~setup); ~t

setup, +thing it

t, ?C, ~it C

t, it _, ~a

t, it _, ~b

a, it C, +at it -> a
!thing C

b, it C, !at C -> a
`;
  const r1 = runFixpoint(ok(baseWithThing));
  assert.equal(r1.status.kind, "active-choices", `with-thing status: ${r1.status.kind}`);
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r1.status.components.length, 1, `with-thing components: ${r1.status.components.length}`);
  const opts1 = r1.status.components[0]!.options.map((opt) => renderTerm(r1.store, opt[0]!)).sort();
  assert.deepEqual(opts1, ["it"], `with-thing options: ${opts1.join(",")}`);
  console.log("PASS: with `!thing C` the choice has one option (it)");

  // Same program with `!thing C` removed — expect no active choice
  // surfaces (the choice's only remaining constraint network can't bind
  // a valid option).
  const baseWithoutThing = baseWithThing.replace("\n!thing C\n", "\n");
  const r2 = runFixpoint(ok(baseWithoutThing));
  if (r2.status.kind === "active-choices") {
    const opts2 = r2.status.components[0]!.options.map((opt) =>
      opt.map((t) => renderTerm(r2.store, t)).join(","),
    );
    assert.equal(opts2.length, 0,
      `without-thing expected 0 options, got: ${opts2.join(" | ")}`);
  }
  // Either kind ≠ active-choices (no choice surfaced) or options.length === 0.
  console.log("PASS: without `!thing C` the choice has no options");
}

console.log("ALL v2 choice tests passed");
