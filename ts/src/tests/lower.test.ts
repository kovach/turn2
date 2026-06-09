import assert from "node:assert/strict";
import { lower } from "../v1/lower.js";
import { sym, vari } from "../v1/types.js";
import type { Constraint, Tree } from "../v1/types.js";

// Helpers
const matchNode = (id: ReturnType<typeof sym>, head: string, children: Tree[] = []): Tree => ({
  tag: "Match",
  constraint: "any",
  id,
  atom: { terms: [sym(head)] },
  children,
});

const beforeNode = (id: ReturnType<typeof sym>, head: string, children: Tree[] = []): Tree => ({
  tag: "Before",
  constraint: "any",
  id,
  atom: { terms: [sym(head)] },
  children,
});

const overlapNode = (id: ReturnType<typeof sym>, head: string, children: Tree[] = []): Tree => ({
  tag: "Overlap",
  constraint: "any",
  id,
  atom: { terms: [sym(head)] },
  children,
});

const assertNode = (id: ReturnType<typeof sym>, head: string, children: Tree[] = []): Tree => ({
  tag: "Assert",
  id,
  atom: { terms: [sym(head)] },
  children,
});

const constrainNode = (id: ReturnType<typeof sym>, head: string, children: Tree[] = []): Tree => ({
  tag: "Constrain",
  id,
  atom: { terms: [sym(head)] },
  children,
});

const root = (children: Tree[]): Tree => ({
  tag: "Match",
  constraint: "any",
  id: sym("$root"),
  atom: { terms: [] },
  children,
});

// Flatten a TurnExpr back to a single list for shape assertions: matching
// first, then assertions. Tests that care about ordering across the
// matching/assertion boundary keep working unchanged.
const allConstraints = (te: ReturnType<typeof lower>): Constraint[] =>
  [...te.matching, ...te.assertions];

// Find all constraints matching a predicate (used for shape assertions).
const find = (cs: Constraint[], pred: (c: Constraint) => boolean): Constraint[] =>
  cs.filter(pred);

// --- 1. Synthetic root is stripped: top-level Match has no `IntervalRel{contains}` ---
{
  const a = matchNode(sym("a"), "a");
  const te = lower(root([a]));
  // Exactly one Match constraint, no IntervalRel constraints (root is stripped).
  const matches = find(allConstraints(te), (c) => c.tag === "Match");
  const intervals = find(allConstraints(te), (c) => c.tag === "IntervalRel");
  assert.equal(matches.length, 1, "one Match constraint");
  assert.equal(intervals.length, 0, "no IntervalRel: root is stripped");
  console.log("PASS: synthetic root stripped");
}

// --- 2. Nested Match emits IntervalRel{contains, parent, child} ---
{
  const inner = matchNode(sym("b"), "b");
  const outer = matchNode(sym("a"), "a", [inner]);
  const te = lower(root([outer]));
  const intervals = find(allConstraints(te), (c) => c.tag === "IntervalRel") as Extract<Constraint, { tag: "IntervalRel" }>[];
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]!.kind, "contains");
  assert.deepEqual(intervals[0]!.a, sym("a"));
  assert.deepEqual(intervals[0]!.b, sym("b"));
  console.log("PASS: nested Match emits IntervalRel{contains}");
}

// --- 3. Before with prior bindable sibling emits IntervalRel{before:after, X, anchor} ---
//     The Before literal `< pat` matches a node temporally before its anchor,
//     so the matched id is the earlier (a) and the anchor is the later (b)
//     under the beforeAfter(a, b) convention.
{
  const s = matchNode(sym("s"), "s");
  const x = beforeNode(sym("x"), "x");
  const outer = matchNode(sym("p"), "p", [s, x]);
  const te = lower(root([outer]));
  const baCons = find(allConstraints(te), (c) => c.tag === "IntervalRel" && c.kind === "before:after") as Extract<Constraint, { tag: "IntervalRel" }>[];
  assert.equal(baCons.length, 1, "one before:after IntervalRel for the Before node");
  assert.deepEqual(baCons[0]!.a, sym("x"), "matched id is the earlier (before)");
  assert.deepEqual(baCons[0]!.b, sym("s"), "anchor is the later (after)");
  console.log("PASS: Before with prior sibling, X is earlier than anchor");
}

// --- 4. Before with no prior bindable sibling falls back to parent anchor ---
{
  const x = beforeNode(sym("x"), "x");
  const outer = matchNode(sym("p"), "p", [x]);
  const te = lower(root([outer]));
  const baCons = find(allConstraints(te), (c) => c.tag === "IntervalRel" && c.kind === "before:after") as Extract<Constraint, { tag: "IntervalRel" }>[];
  assert.equal(baCons.length, 1);
  assert.deepEqual(baCons[0]!.a, sym("x"), "matched id (earlier)");
  assert.deepEqual(baCons[0]!.b, sym("p"), "fallback anchor is the parent (later)");
  console.log("PASS: Before falls back to parent anchor");
}

// --- 5. Top-level Before with no anchor throws (programmer error) ---
//     `< pat` at the top level has no prior bindable sibling and no
//     non-root parent to anchor against. lower flags this as a rule-shape
//     error rather than silently neutering the rule.
{
  const x = beforeNode(sym("x"), "x");
  assert.throws(
    () => lower(root([x])),
    /top-level Before .* has no anchor/,
    "lower throws on top-level Before with no anchor",
  );
  console.log("PASS: top-level Before with no anchor throws");
}

// --- 6. Overlap emits IntervalRel{overlap, parent, X} ---
{
  const x = overlapNode(sym("x"), "x");
  const outer = matchNode(sym("p"), "p", [x]);
  const te = lower(root([outer]));
  const overlaps = find(allConstraints(te), (c) => c.tag === "IntervalRel" && c.kind === "overlap") as Extract<Constraint, { tag: "IntervalRel" }>[];
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0]!.a, sym("p"));
  assert.deepEqual(overlaps[0]!.b, sym("x"));
  console.log("PASS: Overlap emits IntervalRel{overlap}");
}

// --- 7. Positive node under non-root parent emits Assert + AssertIntervalRel{contains} ---
{
  const a = assertNode(sym("a"), "a");
  const outer = matchNode(sym("p"), "p", [a]);
  const te = lower(root([outer]));
  const asserts = find(allConstraints(te), (c) => c.tag === "Assert");
  const aiContains = find(allConstraints(te), (c) => c.tag === "AssertIntervalRel" && c.kind === "contains") as Extract<Constraint, { tag: "AssertIntervalRel" }>[];
  assert.equal(asserts.length, 1);
  assert.equal(aiContains.length, 1);
  assert.deepEqual(aiContains[0]!.a, sym("p"));
  assert.deepEqual(aiContains[0]!.b, sym("a"));
  console.log("PASS: positive under parent emits Assert + AssertIntervalRel{contains}");
}

// --- 8. Top-level positive becomes a parentless Assert (no AssertIntervalRel{contains}) ---
{
  const a = assertNode(sym("a"), "a");
  const te = lower(root([a]));
  const asserts = find(allConstraints(te), (c) => c.tag === "Assert");
  const aiContains = find(allConstraints(te), (c) => c.tag === "AssertIntervalRel" && c.kind === "contains");
  assert.equal(asserts.length, 1);
  assert.equal(aiContains.length, 0, "no contains edge when synthetic root is stripped");
  console.log("PASS: top-level positive is parentless");
}

// --- 9. Positive after a bindable sibling emits AssertIntervalRel{before:after, prev, new} ---
{
  const s = matchNode(sym("s"), "s");
  const a = assertNode(sym("a"), "a");
  const outer = matchNode(sym("p"), "p", [s, a]);
  const te = lower(root([outer]));
  const aiBA = find(allConstraints(te), (c) => c.tag === "AssertIntervalRel" && c.kind === "before:after") as Extract<Constraint, { tag: "AssertIntervalRel" }>[];
  assert.equal(aiBA.length, 1);
  assert.deepEqual(aiBA[0]!.a, sym("s"), "earlier = prior bindable sibling");
  assert.deepEqual(aiBA[0]!.b, sym("a"), "later = the positive being inserted");
  console.log("PASS: positive sibling-after-Match emits AssertIntervalRel{before:after}");
}

// --- 10. Two consecutive positives: no AssertIntervalRel{before:after} between them ---
//      (today step.ts only emits the edge when prev sibling is bindable Match/Before/Overlap)
{
  const a = assertNode(sym("a"), "a");
  const b = assertNode(sym("b"), "b");
  const outer = matchNode(sym("p"), "p", [a, b]);
  const te = lower(root([outer]));
  const aiBA = find(allConstraints(te), (c) => c.tag === "AssertIntervalRel" && c.kind === "before:after");
  assert.equal(aiBA.length, 0, "two positives in a row do not chain a before:after edge");
  console.log("PASS: consecutive positives do not chain before:after");
}

// --- 11. Constrain lowers like Assert (separate tag, same edge emission) ---
{
  const c = constrainNode(sym("c"), "c");
  const outer = matchNode(sym("p"), "p", [c]);
  const te = lower(root([outer]));
  const constrains = find(allConstraints(te), (cc) => cc.tag === "Constrain");
  const aiContains = find(allConstraints(te), (cc) => cc.tag === "AssertIntervalRel" && cc.kind === "contains");
  assert.equal(constrains.length, 1);
  assert.equal(aiContains.length, 1);
  console.log("PASS: Constrain emits Constrain + AssertIntervalRel{contains}");
}

// --- 12. Equal lowers 1:1 and lands in matching prefix (before any assertion) ---
{
  const eq: Tree = { tag: "Equal", lhs: vari("X"), rhs: sym("v") };
  const a = assertNode(sym("a"), "a");
  const te = lower(root([eq, a]));
  // Equal must come before Assert in the constraint list (assertions appended last).
  const eqIdx = allConstraints(te).findIndex((c) => c.tag === "Equal");
  const aIdx = allConstraints(te).findIndex((c) => c.tag === "Assert");
  assert.notEqual(eqIdx, -1);
  assert.notEqual(aIdx, -1);
  assert.ok(eqIdx < aIdx, "Equal precedes Assert in constraint list");
  console.log("PASS: Equal lowered into matching prefix");
}

// --- 13. Output ordering: all matching constraints precede all assertions ---
{
  const inner = matchNode(sym("b"), "b");
  const a = assertNode(sym("a"), "a");
  const outer = matchNode(sym("p"), "p", [inner, a]);
  const te = lower(root([outer]));
  let sawAssertish = false;
  for (const c of allConstraints(te)) {
    const isAssertish = c.tag === "Assert" || c.tag === "Constrain" || c.tag === "AssertIntervalRel";
    if (isAssertish) sawAssertish = true;
    else assert.ok(!sawAssertish, `matching constraint ${c.tag} appeared after an assertion`);
  }
  console.log("PASS: matching prefix precedes assertion suffix");
}

// --- 14. Aggregate is a tripwire — lower throws ---
{
  const aggTree: Tree = {
    tag: "Aggregate",
    info: { funcName: "sum", args: [vari("X")], out: vari("Y") },
    id: sym("g"),
    atom: { terms: [sym("g")] },
    children: [],
  };
  assert.throws(
    () => lower(root([aggTree])),
    /Aggregate should have been rewritten/,
    "lower throws on Aggregate",
  );
  console.log("PASS: lower throws on Aggregate");
}

// --- 15. Ask is a tripwire — lower throws ---
{
  const askTree: Tree = { tag: "Ask", id: sym("q"), atom: { terms: [sym("?")] } };
  assert.throws(
    () => lower(root([askTree])),
    /Ask should have been rewritten/,
    "lower throws on Ask",
  );
  console.log("PASS: lower throws on Ask");
}

console.log("All lower tests passed.");
