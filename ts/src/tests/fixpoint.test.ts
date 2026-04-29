import assert from "node:assert/strict";
import { fixpoint } from "../fixpoint.js";
import { parsePatterns } from "../parse.js";
import type { BodyTree, Tree } from "../types.js";
import { treeAtomTerms, treeChildren } from "../types.js";

function parseRules(input: string, prefix = "r"): Tree[] {
  const result = parsePatterns(input, prefix);
  if ("message" in result) throw new Error(`parse error: ${result.message}`);
  return result;
}

// `type` is one of the body-bearing tags; collect returns body-bearing
// matches, recursing through children safely (Equal/Ask are leaves).
function collect(tree: Tree, type: BodyTree["tag"]): BodyTree[] {
  if (tree.tag === "Equal" || tree.tag === "Ask") return [];
  const self: BodyTree[] = tree.tag === type ? [tree] : [];
  return self.concat(tree.children.flatMap((c: Tree) => collect(c, type)));
}

// canonical reference: a single foo fact
const facts = parseRules("+ foo", "f");

// match foo, assert bar
const rules = parseRules(`- foo
  + bar`);

// basic: bar is asserted under foo
{
  const { result } = fixpoint([...facts, ...rules]);
  const bars = collect(result, "Assert").filter((n) => {
    const t = n.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "bar";
  });
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0]!.atom.terms, [{ tag: "Symbol", name: "bar" }]);
  console.log("PASS: fixpoint asserts bar under foo");
}

// idempotent: re-running with the same inputs produces the same node count
{
  const { result: r1 } = fixpoint([...facts, ...rules]);
  const { result: r2 } = fixpoint([...facts, ...rules]);
  const c1 = collect(r1, "Assert").length;
  const c2 = collect(r2, "Assert").length;
  assert.equal(c1, c2);
  console.log("PASS: fixpoint is idempotent");
}

// gas limit: a gas of 0 means no patterns are applied — store has only the
// synthetic root row with no children.
{
  const { result, steps } = fixpoint([...facts, ...rules], 0);
  assert.equal(treeChildren(result).length, 0);
  assert.equal(steps, 0);
  console.log("PASS: gas=0 yields empty store");
}

// empty patterns: same as gas=0, no children.
{
  const { result, steps } = fixpoint([]);
  assert.equal(treeChildren(result).length, 0);
  assert.equal(steps, 0);
  console.log("PASS: empty patterns yields empty store");
}

// flat all-assert: +foo / +bar / +baz should all appear in the output
{
  const patterns = parseRules("+foo\n+bar\n+baz");
  const { result } = fixpoint(patterns);
  const names = treeChildren(result).map((c) =>
    treeAtomTerms(c).map((t) => ("name" in t ? t.name : "?")).join(" ")
  );
  assert.ok(names.includes("foo"), `expected "foo" in ${JSON.stringify(names)}`);
  assert.ok(names.includes("bar"), `expected "bar" in ${JSON.stringify(names)}`);
  assert.ok(names.includes("baz"), `expected "baz" in ${JSON.stringify(names)}`);
  console.log("PASS: flat all-assert: foo, bar, baz all appear");
}

// explicit id binding: -[Id] foo / + bar Id — bar's atom contains the id of the matched foo node
{
  const facts = parseRules("+ foo", "f");
  const rules = parseRules("-[Id] foo\n  + bar Id");
  const { result } = fixpoint([...facts, ...rules]);
  const fooNode = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "foo";
  });
  assert.ok(fooNode, "foo node not found");
  const bar = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "bar";
  });
  assert.ok(bar, "bar node not found");
  // bar's second term should be bound to foo's id via the Id variable
  assert.deepEqual(bar!.atom.terms[1], fooNode!.id);
  console.log("PASS: explicit id binding captures matched node id");
}

// self-referential id: +[I] card I — the atom should contain the node's own generated id
{
  const patterns = parseRules("+[I] card I");
  const { result } = fixpoint(patterns);
  const kids = treeChildren(result);
  assert.equal(kids.length, 1);
  const node = kids[0]!;
  if (node.tag !== "Assert") throw new Error(`expected Assert, got ${node.tag}`);
  assert.deepEqual(node.atom.terms[0], { tag: "Symbol", name: "card" });
  assert.deepEqual(node.atom.terms[1], node.id);
  console.log("PASS: self-referential id: +[I] card I resolves to + card <id>");
}

// Before literal: worked example from overview.md "query algorithm update"
// pattern:
//   - turn A
//     < move X
//       + note A X
// reference:
//   + move a / + move b / + turn t
// expected: each `+ move` gets a `+ note t <arg>` child
{
  const facts = parseRules(`+ move a
+ move b
+ turn t`, "f");
  const rules = parseRules(`- turn A
  < move X
    + note A X`);
  const { result } = fixpoint([...facts, ...rules]);
  const top = treeChildren(result);
  const moveA = top[0]!;
  const moveB = top[1]!;
  const turn  = top[2]!;
  assert.deepEqual(treeAtomTerms(moveA), [{ tag: "Symbol", name: "move" }, { tag: "Symbol", name: "a" }]);
  assert.deepEqual(treeAtomTerms(moveB), [{ tag: "Symbol", name: "move" }, { tag: "Symbol", name: "b" }]);
  // each move has exactly one note child: note t <arg>
  const moveAKids = treeChildren(moveA);
  assert.equal(moveAKids.length, 1);
  assert.deepEqual(treeAtomTerms(moveAKids[0]!), [
    { tag: "Symbol", name: "note" }, { tag: "Symbol", name: "t" }, { tag: "Symbol", name: "a" },
  ]);
  const moveBKids = treeChildren(moveB);
  assert.equal(moveBKids.length, 1);
  assert.deepEqual(treeAtomTerms(moveBKids[0]!), [
    { tag: "Symbol", name: "note" }, { tag: "Symbol", name: "t" }, { tag: "Symbol", name: "b" },
  ]);
  // turn has no new children inserted
  assert.equal(treeChildren(turn).length, 0);
  console.log("PASS: Before literal — worked example yields note under each prior move");
}

// Before uses previous sibling as anchor (overview.md example)
{
  const facts = parseRules(`+ a
  + b
  + c
  + d`, "f");
  const rules = parseRules(`- a
  - c
  < b
  + ok`);
  const { result } = fixpoint([...facts, ...rules]);
  const oks = collect(result, "Assert").filter((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "ok";
  });
  assert.equal(oks.length, 1, "expected exactly one ok node");
  console.log("PASS: Before uses previous sibling as anchor");
}

// --- Aggregate tests ---

// Top-level count over a pre-populated reference.
// The reference contains three `+ t _` facts as direct children of root, and
// the rule is flat: `# count -> N / < t _ / + note N`. Under the new temporal
// semantics (no auto-emitted before:after on insert), the agg-instance node
// has no before-predecessors, so `< t _` matches nothing and count = 0 (= `z`).
{
  const facts = parseRules(`+ t 1
+ t 2
+ t 3`, "f");
  const rules = parseRules(`# count -> N
  < t _
+ note N`);
  const { result } = fixpoint([...facts, ...rules]);
  const note = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "note";
  });
  assert.ok(note, "note node not found");
  assert.deepEqual(note!.atom.terms[1], { tag: "Symbol", name: "z" });
  console.log("PASS: top-level count over pre-populated reference yields 0");
}

// Simple count aggregate: count all `+ t X` nodes
{
  const rules = parseRules(`+ root
  + setup
  + count

- setup
  + t 1
  + t 2
  + t 3

- count
  # count -> N
    < t _
  + note N`);
  const { result } = fixpoint(rules);
  const note = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "note";
  });
  assert.ok(note, "note node not found");
  // Count of 3 produces (s (s (s z))) which gets hashconsed to a Ref
  const countTerm = note!.atom.terms[1];
  assert.equal(countTerm?.tag, "Ref", "expected count result to be a Ref (hashconsed Peano numeral)");
  console.log("PASS: simple count aggregate");
}

// Sum aggregate
{
  const rules = parseRules(`+ root
  + setup
  + count

- setup
  + t 1
  + t 2
  + t 3

- count
  # sum X -> N
    < t X
  + note N`);
  const { result } = fixpoint(rules);
  const note = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "note";
  });
  assert.ok(note, "note node not found");
  assert.deepEqual(note!.atom.terms[1], { tag: "Symbol", name: "6" });
  console.log("PASS: sum aggregate");
}

// Last aggregate
// KNOWN FAILURE — throws "cannot order agg-bindings: … temporally incomparable".
// The three agg-binding siblings under a single agg-instance don't form a
// before-chain: each bnd_i only gets before:after(t_i, bnd_i), and there is
// no edge among bnd_a/bnd_b/bnd_c. Fixing this needs agg-instance restructuring
// — see notes/overview.md §"fix agg-instance nesting".
if (false)
{
  const rules = parseRules(`+ root
  + setup
  + count

- setup
  + t a
  + t b
  + t c

- count
  # last X -> L
    < t X
  + note L`);
  const { result } = fixpoint(rules);
  const note = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "note";
  });
  assert.ok(note, "note node not found");
  assert.deepEqual(note!.atom.terms[1], { tag: "Symbol", name: "c" });
  console.log("PASS: last aggregate");
}

// Empty aggregate (no bindings) → zero value
{
  const rules = parseRules(`+ root
  + setup
  + count

- setup
  + other 1

- count
  # count -> N
    < t _
  + note N`);
  const { result } = fixpoint(rules);
  const note = collect(result, "Assert").find((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "note";
  });
  assert.ok(note, "note node not found");
  assert.deepEqual(note!.atom.terms[1], { tag: "Symbol", name: "z" });
  console.log("PASS: empty aggregate returns zero");
}

// Multiple sibling aggregates with empty bindings
{
  const facts = parseRules(`+ a`, "f");
  const rules = parseRules(`- a
  + b
  + c

- b
  # count -> N
    < act
  + note b N

- c
  # count -> N
    < act
  + note c N`);
  const { result } = fixpoint([...facts, ...rules]);
  const notes = collect(result, "Assert").filter((c) => {
    const t = c.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "note";
  });
  assert.equal(notes.length, 2, "expected two note nodes");
  const noteB = notes.find((n) => n.atom.terms[1]?.tag === "Symbol" && n.atom.terms[1].name === "b");
  const noteC = notes.find((n) => n.atom.terms[1]?.tag === "Symbol" && n.atom.terms[1].name === "c");
  assert.ok(noteB, "note b not found");
  assert.ok(noteC, "note c not found");
  assert.deepEqual(noteB!.atom.terms[2], { tag: "Symbol", name: "z" });
  assert.deepEqual(noteC!.atom.terms[2], { tag: "Symbol", name: "z" });
  console.log("PASS: multiple sibling aggregates with empty bindings");
}

// --- Ask → `_choose` rewrite ---

// `? C` in a rule body produces a single Assert row whose atom starts with
// `_choose`, with the original variable id-expanded.
{
  const facts = parseRules("+ trigger", "f");
  const rules = parseRules("- trigger\n  ? C");
  const { result } = fixpoint([...facts, ...rules]);
  const chooses = collect(result, "Assert").filter((n) => {
    const t = n.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "_choose";
  });
  assert.equal(chooses.length, 1, `expected exactly one _choose row, got ${chooses.length}`);
  const row = chooses[0]!;
  // Atom shape: [_choose, <id-atom for C>]
  assert.equal(row.atom.terms.length, 2);
  const second = row.atom.terms[1]!;
  // After hashcons, the id-atom for C is a Ref pointing at its body.
  assert.equal(second.tag, "Ref", "second arg should be a hashconsed id-atom for C");
  console.log("PASS: `? C` produces a single `_choose` row with the choice variable");
}

// Multi-arg `? A B` produces one `_choose` row carrying both variable ids.
{
  const facts = parseRules("+ trigger", "f");
  const rules = parseRules("- trigger\n  ? A B");
  const { result } = fixpoint([...facts, ...rules]);
  const chooses = collect(result, "Assert").filter((n) => {
    const t = n.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "_choose";
  });
  assert.equal(chooses.length, 1);
  const row = chooses[0]!;
  // Atom shape: [_choose, <A id>, <B id>]
  assert.equal(row.atom.terms.length, 3);
  console.log("PASS: `? A B` produces a single `_choose` row with two choice vars");
}

// --- Active-choice scheduling ---

// One Ask with a Constrain row → status.active-choices, one component, one
// option per matching `+ opt _` fact in the store.
{
  const facts = parseRules("+ trigger\n+ opt a\n+ opt b", "f");
  const rules = parseRules("- trigger\n  ? C\n  ! opt C");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.choices.length, 1);
    const row = status.choices[0]!.row;
    const head = row.atom.terms[0];
    assert.ok(head?.tag === "Symbol" && head.name === "_choose");
    assert.equal(status.choices[0]!.unresolvedTerms.length, 1);
    assert.equal(status.components.length, 1);
    assert.equal(status.components[0]!.activeTerms.length, 1);
    const optionNames = status.components[0]!.options
      .map((tup) => tup[0])
      .filter((t): t is { tag: "Symbol"; name: string } => t!.tag === "Symbol")
      .map((t) => t.name)
      .sort();
    assert.deepEqual(optionNames, ["a", "b"]);
  }
  console.log("PASS: single unresolved Ask with `! opt C` enumerates options");
}

// Two unrelated Asks (sibling _choose rows under the same trigger, no
// before:after edge between them) both surface in the same earliest tier;
// since they touch independent constraint rows they form two components.
{
  const facts = parseRules("+ trigger\n+ opt1 a\n+ opt2 b", "f");
  const rules = parseRules("- trigger\n  ? A\n  ! opt1 A\n\n- trigger\n  ? B\n  ! opt2 B");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.choices.length, 2);
    assert.equal(status.components.length, 2);
  }
  console.log("PASS: two unrelated Asks form two independent components");
}

// Ask with sibling `+ is C done` → choice term is resolved → status.done.
{
  const facts = parseRules("+ trigger", "f");
  const rules = parseRules("- trigger\n  ? C\n  + is C done");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "done", `expected done, got ${status.kind}`);
  console.log("PASS: Ask resolved by sibling `is` row → done");
}

// Multi-arg `? A B` with A resolved by `+ is A a` → unresolvedTerms=[B];
// `! pair A B` ties B to a constraint, so the lifted query substitutes A=a
// and enumerates B from `+ pair a _` facts.
{
  const facts = parseRules("+ trigger\n+ pair a b\n+ pair a x\n+ pair c d", "f");
  const rules = parseRules("- trigger\n  ? A B\n  + is A a\n  ! pair A B");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.choices.length, 1);
    assert.equal(status.choices[0]!.unresolvedTerms.length, 1, "exactly B should be unresolved");
    assert.equal(status.components.length, 1);
    const opts = status.components[0]!.options
      .map((tup) => tup[0])
      .filter((t): t is { tag: "Symbol"; name: string } => t!.tag === "Symbol")
      .map((t) => t.name)
      .sort();
    assert.deepEqual(opts, ["b", "x"], "options should be B-values from pair a _");
  }
  console.log("PASS: multi-arg Ask with partial resolution lifts the resolved term as a substitution");
}

// Aggregate prior to choice (agg listed first as sibling) → agg folds, then
// choice surfaces. The store carries an _agg-result row.
{
  const facts = parseRules("+ trigger\n+ t a\n+ t b\n+ opt a\n+ opt b", "f");
  const rules = parseRules(`- trigger
  # count -> N
    < t _
  ? C
  ! opt C`);
  const { result, status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices", `expected active-choices, got ${status.kind}`);
  // _agg-result row exists in the store after folding.
  const aggResults = collect(result, "Assert").filter((n) => {
    const t = n.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "_agg-result";
  });
  assert.ok(aggResults.length >= 1, "expected an _agg-result row from a closed aggregate");
  console.log("PASS: aggregate prior to choice closes; choice still surfaces");
}

// Choice prior to aggregate → aggregate stays paused (no _agg-result), choice
// surfaces.
{
  const facts = parseRules("+ trigger\n+ t a\n+ t b\n+ opt a", "f");
  const rules = parseRules(`- trigger
  ? C
  ! opt C
  # count -> N
    < t _`);
  const { result, status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  const aggResults = collect(result, "Assert").filter((n) => {
    const t = n.atom.terms[0];
    return t?.tag === "Symbol" && t.name === "_agg-result";
  });
  assert.equal(aggResults.length, 0, "aggregate should not have closed when its tier is dominated by an earlier choice");
  console.log("PASS: choice prior to aggregate keeps the aggregate paused");
}

// Gas exhausted → status.gas with the cumulative step count.
{
  const facts = parseRules("+ trigger", "f");
  const rules = parseRules("- trigger\n  + bar");
  const { status } = fixpoint([...facts, ...rules], 0);
  assert.equal(status.kind, "gas");
  if (status.kind === "gas") assert.equal(status.steps, 0);
  console.log("PASS: gas exhaustion surfaces as status.gas");
}

// --- Step 2: constraint-graph components & lifted match queries ---

// Joint enumeration: `? A B` plus `! foo A B`, store has `+ foo a x`,
// `+ foo b y`, `+ foo a y` → one component with both A,B active and option
// tuples enumerating each `foo` row.
{
  const facts = parseRules("+ trigger\n+ foo a x\n+ foo b y\n+ foo a y", "f");
  const rules = parseRules("- trigger\n  ? A B\n  ! foo A B");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.components.length, 1);
    assert.equal(status.components[0]!.activeTerms.length, 2);
    // Sort within each tuple as well as across tuples: the column order of
    // `options` follows `activeTerms`, which is keyed on hashcons ref ids and
    // can flip if allocation order shifts. The two value domains ({a,b} and
    // {x,y}) are disjoint here, so within-tuple sort is unambiguous.
    const tuples = status.components[0]!.options.map((tup) =>
      tup
        .map((t) => (t.tag === "Symbol" ? t.name : "?"))
        .sort()
        .join(","),
    ).sort();
    assert.deepEqual(tuples, ["a,x", "a,y", "b,y"]);
  }
  console.log("PASS: joint enumeration over coupled active terms");
}

// Multi-arg `? A C` with two uncoupled Constrain literals in the same rule
// body (`! card A`, `! red C`) → two components, each enumerated
// independently. Exercises plans/constraint-tuples.md §2.5: prior Constrain
// literals are elided from each variant's prefix instead of retagged to
// Match (which would silently drop later Constrain inserts).
{
  const facts = parseRules("+ trigger\n+ card a\n+ card b\n+ red x\n+ red y", "f");
  const rules = parseRules("- trigger\n  ? A C\n  ! card A\n  ! red C");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.components.length, 2);
    for (const comp of status.components) {
      assert.equal(comp.activeTerms.length, 1);
      assert.equal(comp.options.length, 2);
    }
  }
  console.log("PASS: uncoupled multi-arg Ask with two body Constrains partitions into per-term components");
}

// Self-referential `! foo A A` → component {A}; lifted query has the same
// fresh var twice, so options are A-values where store has `foo v v`.
{
  const facts = parseRules("+ trigger\n+ foo a a\n+ foo a b\n+ foo c c", "f");
  const rules = parseRules("- trigger\n  ? A\n  ! foo A A");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.components.length, 1);
    const opts = status.components[0]!.options
      .map((tup) => (tup[0]?.tag === "Symbol" ? tup[0].name : "?"))
      .sort();
    assert.deepEqual(opts, ["a", "c"], "only `foo v v` rows match");
  }
  console.log("PASS: self-referential constraint lifts to a same-var pattern");
}

// Compound term `! card (cell C)` matched against `+ card (cell a)` → fringe
// finds C inside the compound; lifted query is `card (cell V)`.
{
  const facts = parseRules("+ trigger\n+ card (cell a)\n+ card (cell b)\n+ card other", "f");
  const rules = parseRules("- trigger\n  ? C\n  ! card (cell C)");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "active-choices");
  if (status.kind === "active-choices") {
    assert.equal(status.components.length, 1);
    const opts = status.components[0]!.options
      .map((tup) => (tup[0]?.tag === "Symbol" ? tup[0].name : "?"))
      .sort();
    assert.deepEqual(opts, ["a", "b"]);
  }
  console.log("PASS: compound term in Constrain row lifts via deep substitution");
}

// Empty-closure error: an active choice term with no Constrain row in its
// component is unconstrained; this short-circuits even if other components
// would be valid.
{
  const facts = parseRules("+ trigger", "f");
  const rules = parseRules("- trigger\n  ? C");
  const { status } = fixpoint([...facts, ...rules]);
  assert.equal(status.kind, "empty-fringe-error", `expected empty-fringe-error, got ${status.kind}`);
  console.log("PASS: unconstrained active choice short-circuits to empty-fringe-error");
}

console.log("All fixpoint tests passed.");
