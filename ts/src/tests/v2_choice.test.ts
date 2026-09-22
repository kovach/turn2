import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { describeErrorStatus, runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../v2/term.js";
import { tokenOf, type Store } from "../v2/store.js";
import { expandTerm } from "../v2/hashcons.js";

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

// Choice components are located at their ask moment
// (plans/v2-choice-components-by-moment.md): `?` and `!` emit at the running
// anchor without minting a moment, a component holds terms asked at one
// moment, and choices are resolved in temporal order.

// 5) Two independent chooses at one moment surface together, as two
//    components. With an anchor-advancing atom between them, only the
//    earlier one surfaces; the later stays blocked until the walk reaches it.
{
  const same = `
+ cell c1
  + cell c2
  + turn

turn
  ? A
  ! cell A
  ? B
  ! cell B
`;
  const r = runFixpoint(ok(same));
  assert.equal(r.status.kind, "active-choices", `status: ${r.status.kind}`);
  if (r.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r.status.choices.length, 2);
  assert.equal(r.status.components.length, 2, "no shared row -> two components");
  assert.equal(
    tokenOf(r.store, r.status.components[0]!.moment),
    tokenOf(r.store, r.status.components[1]!.moment),
    "both asked at the same moment",
  );

  const apart = `
+ cell c1
  + cell c2
  + turn

turn
  ? A
  ! cell A
  + step
  ? B
  ! cell B
`;
  const { status } = runFixpoint(ok(apart));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 1, `expected only earliest choose to surface, got ${status.choices.length}`);
  assert.equal(status.components.length, 1);
  assert.equal(status.components[0]!.activeTerms.length, 1);
  console.log("PASS: independent later choose stays blocked while earliest surfaces");
}

// 6) A shared `_constrain` row makes a joint component — when both terms
//    were asked at the same moment.
{
  const src = `
+ pair c1 c1
  + turn

turn
  ? A
  ? B
  ! pair A B
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 2);
  assert.equal(status.components.length, 1, "shared row -> one joint component");
  assert.equal(status.components[0]!.activeTerms.length, 2);
  // The component's moment is a settled frontier moment: everything below it
  // is resolved, and it is blocked only by its own choice.
  const m = tokenOf(store, status.components[0]!.moment);
  assert.ok(store.settled.has(m) && !store.resolved.has(m));
  for (const p of store.orderBwd.get(m) ?? []) assert.ok(store.resolved.has(p), "predecessors are resolved");
  console.log("PASS: a shared _constrain row joins two choices asked at one moment");
}

// 6b) The same shared row across moments does NOT join: the earlier choice
//     is resolved first, on its own constraints, and the later one then sees
//     the earlier one's value. The earlier component is the same with and
//     without the later tail (monotonicity).
{
  const head = `
+ opt c1
  + opt c2
  + pair c1 d1
  + pair c2 d2
  + turn

`;
  const alone = head + `turn
  ? X
  ! opt X
`;
  const both = head + `turn
  ? X
  ! opt X
  + mark
  ? Y
  ! pair X Y
  ^ got X.is Y.is
`;
  const describe = (src: string) => {
    const { store, status } = runFixpoint(ok(src));
    assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
    if (status.kind !== "active-choices") throw new Error("unreachable");
    assert.equal(status.components.length, 1);
    const c = status.components[0]!;
    return {
      store,
      comp: c,
      terms: c.activeTerms.length,
      options: c.options.map((o) => o.map((t) => renderTerm(store, t)).join(",")).sort(),
    };
  };
  const a = describe(alone), b = describe(both);
  assert.equal(b.terms, 1, "only X surfaces first");
  assert.deepEqual(b.options, ["c1", "c2"]);
  assert.deepEqual(b.options, a.options, "X's options do not depend on the later ask");
  assert.equal(renderTerm(a.store, a.comp.activeTerms[0]!), renderTerm(b.store, b.comp.activeTerms[0]!));

  const xText = renderTerm(b.store, b.comp.activeTerms[0]!);
  const next = describe(both + `\n^ is ${xText} c2\n`);
  assert.equal(next.terms, 1, "then Y surfaces on its own");
  assert.deepEqual(next.options, ["d2"], "its constraint sees X's value");
  assert.notEqual(tokenOf(next.store, next.comp.moment), tokenOf(b.store, b.comp.moment));
  console.log("PASS: choices asked at different moments are resolved in temporal order");
}

// 6c) A term whose only constraint also mentions a later ask has an empty
//     fringe, and the status says why.
{
  const { store, status } = runFixpoint(ok(`
+ pair c1 d1
  + turn

turn
  ? X
  + mark
  ? Y
  ! pair X Y
`));
  assert.equal(status.kind, "empty-fringe-error", `status: ${status.kind}`);
  if (status.kind !== "empty-fringe-error") throw new Error("unreachable");
  assert.equal(status.deferredOnly, true);
  assert.match(describeErrorStatus(store, status)!, /asked at a later moment/);
  console.log("PASS: a choice constrained only jointly with a later ask is an empty fringe");
}

// 6d) A constraint must sit at the moment its choice was asked. An
//     anchor-advancing atom between the `?` and the `!` is an error naming
//     the line; moving the `!` next to the `?` fixes it. A constraint in
//     another rule is fine as long as that rule reaches the same moment
//     (a parenthesized match does not narrow the anchor).
{
  const late = runFixpoint(ok(`
+ opt c1
  + turn

turn
  ? C
  ~ choice C
  ! opt C
`));
  assert.equal(late.status.kind, "late-constraint-error", `status: ${late.status.kind}`);
  if (late.status.kind !== "late-constraint-error") throw new Error("unreachable");
  assert.equal(late.status.reason, "late");
  assert.equal(late.status.line, 8);
  assert.match(describeErrorStatus(late.store, late.status)!, /line 8.*Move the '!' next to its '\?'/);

  const fixed = runFixpoint(ok(`
+ opt c1
  + turn

turn
  ? C
  ! opt C
  ~ choice C
`));
  assert.equal(fixed.status.kind, "active-choices");

  const crossRule = runFixpoint(ok(`
+ opt c1
  + opt c2
  + good c2
  + turn

turn
  ? C
  ! opt C
  ~ choice C

turn, (choice C), ! good C
`));
  assert.equal(crossRule.status.kind, "active-choices", `status: ${crossRule.status.kind}`);
  if (crossRule.status.kind !== "active-choices") throw new Error("unreachable");
  assert.deepEqual(
    crossRule.status.components[0]!.options.map((o) => renderTerm(crossRule.store, o[0]!)),
    ["c2"],
  );

  // The placement check also runs when the choice never surfaces because a
  // saved `is` row resolved it up front.
  const lateTerm = late.status.activeTerm;
  const saved = runFixpoint(ok(`
+ opt c1
  + turn

turn
  ? C
  ~ choice C
  ! opt C

^ is ${renderTerm(late.store, lateTerm)} c1
`));
  assert.equal(saved.status.kind, "late-constraint-error", `status: ${saved.status.kind}`);
  console.log("PASS: a constraint away from its ask moment is reported");
}

// 7) Mixed: A and B joined via `! pair A B`; D is independent. All asked at
//    one moment, so all surface: two components.
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
  assert.equal(status.choices.length, 3);
  assert.equal(status.components.length, 2);
  assert.deepEqual(status.components.map((c) => c.activeTerms.length).sort(), [1, 2]);
}
console.log("PASS: mixed joint + independent choices at one moment");

// 8) Sequential c1 episodes with a `! at C -> here` constrain-agg that
//    narrows after the first choice. After picking t1, t1's last `at`
//    becomes `there`, so only t2 satisfies `at C -> here` in the second
//    c1. Exercises canonical-moment evaluation across the two
//    constrain rows in one component (! thing + ! at) and the agg row
//    seeing the post-resolution `+at t1 there`.
{
  const src = `
~game

#agg at * -> last

game, +thing t1, +thing t2, +thing bad
  +at t1 -> here
  +at t2 -> here
  +monster t1
  ( ~c1 );
  ( ~c1 );

c1
  ?C
  !thing C
  ~it C

c1, (it C), !at C -> here

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

// 9) Constraints emitted from later episodes. This program asks `C` in `t`
//    and constrains it from inside the later episodes `a` and `b` — the
//    shape the lub-located component was built for. Components now sit at
//    their ask moment (plans/v2-choice-components-by-moment.md), so those
//    rows are reported as misplaced; the constraint that can be stated at the
//    ask moment is written next to the `?`.
{
  const spread = `
#agg at * -> last

(~setup); ~t

setup, +thing it

t, ?C, ~it C

t, it _, ~a

t, it _, ~b

a, it C, +at it -> a
  !thing C

b, it C, !at C -> a
`;
  const r1 = runFixpoint(ok(spread));
  assert.equal(r1.status.kind, "late-constraint-error", `spread status: ${r1.status.kind}`);
  console.log("PASS: a constraint emitted from a later episode is reported as late");

  const local = `
#agg at * -> last

(~setup); ~t

setup, +thing it, +thing other, +at it -> a

t, ?C, !thing C, !at C -> a, ~it C
`;
  const r2 = runFixpoint(ok(local));
  assert.equal(r2.status.kind, "active-choices", `local status: ${r2.status.kind}`);
  if (r2.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r2.status.components.length, 1);
  const opts2 = r2.status.components[0]!.options.map((opt) => renderTerm(r2.store, opt[0]!)).sort();
  assert.deepEqual(opts2, ["it"], `local options: ${opts2.join(",")}`);
  console.log("PASS: the same constraints at the ask moment give one option (it)");
}

// 10) Partial bind in a two-active-term component. After committing one
//     slot via `is`, the surviving slot's options should be filtered
//     against the bound value (engine substitutes `idA -> c1` into the
//     `(pair idA idB)` wrapped atom before querying).
{
  const src = `
+ pair c1 c2
  + pair c1 c3
  + pair c2 c4
  + turn

turn
  ? A
  ? B
  ! pair A B
`;
  const r1 = runFixpoint(ok(src));
  assert.equal(r1.status.kind, "active-choices", `phase1 status: ${r1.status.kind}`);
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r1.status.components.length, 1, "phase1: 1 entangled component");
  const comp1 = r1.status.components[0]!;
  assert.equal(comp1.activeTerms.length, 2, "phase1: 2 active terms");
  const opts1 = comp1.options
    .map((opt) => `${renderTerm(r1.store, opt[0]!)},${renderTerm(r1.store, opt[1]!)}`)
    .sort();
  assert.deepEqual(opts1, ["c1,c2", "c1,c3", "c2,c4"], `phase1 options: ${opts1.join(" | ")}`);

  // Identify which active term is A vs B by inspecting their `:varName`
  // tail symbol (see freshIdTemplate / variableToSymbol — last term is
  // `:A` or `:B`).
  function varNameOf(term: Term, store: Store): string {
    const t = expandTerm(term, store.hash);
    if (t.tag !== "Atom" && t.tag !== "Id") return "?";
    const last = t.atom.terms[t.atom.terms.length - 1];
    if (last?.tag !== "Symbol") return "?";
    return last.name.startsWith(":") ? last.name.slice(1) : last.name;
  }
  const aTerm = comp1.activeTerms.find((t) => varNameOf(t, r1.store) === "A");
  assert(aTerm !== undefined, "phase1: expected an active term tagged :A");

  // Bind A=c1. Surviving slot B should see options {c2, c3} (the two
  // pair tuples whose first arg is c1).
  const aText = renderTerm(r1.store, aTerm);
  const src2 = src + `\n^ is ${aText} c1\n`;
  const r2 = runFixpoint(ok(src2));
  assert.equal(r2.status.kind, "active-choices", `phase2 status: ${r2.status.kind}`);
  if (r2.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r2.status.components.length, 1, "phase2: 1 component remains");
  const comp2 = r2.status.components[0]!;
  assert.equal(comp2.activeTerms.length, 1, "phase2: 1 active term (B)");
  assert.equal(varNameOf(comp2.activeTerms[0]!, r2.store), "B", "phase2: surviving slot is B");
  const opts2 = comp2.options.map((opt) => renderTerm(r2.store, opt[0]!)).sort();
  assert.deepEqual(opts2, ["c2", "c3"], `phase2 options: ${opts2.join(",")}`);
  console.log("PASS: partial bind substitutes resolved active term into surviving slot's query");
}

console.log("ALL v2 choice tests passed");
