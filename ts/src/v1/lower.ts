// Lowering: nested Tree → flat TurnExpr.
//
// Runs once per rule, after `expand`. The output is the constraint-list
// IR consumed by the new evaluator (PR 2). See plans/flat-relational-ir.md
// for the design and per-tag lowering rules.
//
// Conventions enforced here:
// - The synthetic Match root is stripped: its direct children have a null
//   pattern parent and emit no `(Assert)IntervalRel{contains, …}`
//   constraint referencing the root.
// - Negative leaves (Match/Before/Overlap) lower to a single `Match`
//   constraint plus a sibling `IntervalRel` carrying the structural
//   relation (contains / before:after / overlap).
// - Positive leaves (Assert/Constrain) lower to an `Assert`/`Constrain`
//   plus zero or more `AssertIntervalRel` edges — one for `parent:child`
//   if the pattern parent is non-root, one for `before:after` if there's
//   a prior bindable sibling. This mirrors `step.ts:insertChild` +
//   `addBeforeAfter` today.
// - Sibling order: `prevBindableSibling` matches the rule in
//   `tree.ts:collectPositiveNodes` — only Match/Before/Overlap siblings
//   count as anchors.
// - Output order: tree-traversal order for matching constraints, with all
//   assertions appended at the end so they fire only after the matching
//   prefix has succeeded.

import type { BodyTree, MatchingConstraint, PositiveConstraint, Tree, TurnExpr } from "./types.js";

const isBindableTag = (tag: Tree["tag"]): boolean =>
  tag === "Match" || tag === "Before" || tag === "Overlap";

export function lower(tree: Tree): TurnExpr {
  if (tree.tag === "Equal" || tree.tag === "Ask") {
    throw new Error(`lower: top-level ${tree.tag} — pattern root must be body-bearing`);
  }

  const matching: MatchingConstraint[] = [];
  const assertions: PositiveConstraint[] = [];

  // `parent` is the pattern parent's BodyTree, or null when `node` is a
  // direct child of the (stripped) synthetic root. `prevBindable` is the
  // closest preceding sibling whose tag is Match/Before/Overlap, else null.
  function walk(node: Tree, parent: BodyTree | null, prevBindable: BodyTree | null): void {
    if (node.tag === "Ask") {
      throw new Error("lower: Ask should have been rewritten to Assert(_choose) by expand");
    }
    if (node.tag === "Aggregate") {
      throw new Error("lower: Aggregate should have been rewritten to Assert(_agg-instance) by expand");
    }

    if (node.tag === "Equal") {
      matching.push({ tag: "Equal", lhs: node.lhs, rhs: node.rhs });
      return;
    }

    switch (node.tag) {
      case "Match": {
        // Match first, then IntervalRel{contains} as a check. This preserves
        // the symbol-index prefilter the pre-TE matcher relied on: matchAt
        // iterates the (typically small) `index.get(headSymbol)` bucket and
        // each survivor is then filtered by `strictlyContains(parent, …)`.
        // Reordering to IntervalRel-first would force descendant iteration
        // and lose that prefilter — slow when the parent's subtree is large
        // but the head symbol is rare.
        matching.push({ tag: "Match", mode: node.constraint, id: node.id, atom: node.atom });
        if (parent !== null) {
          matching.push({ tag: "IntervalRel", kind: "contains", a: parent.id, b: node.id });
        }
        break;
      }
      case "Before": {
        // Anchor: previous bindable sibling, falling back to parent. The
        // Before literal `< pat` matches a node temporally BEFORE the
        // anchor — so the matched id is the *earlier* (a) and the anchor
        // is the *later* (b) under the beforeAfter(a, b) convention.
        const anchor = prevBindable ?? parent;
        if (anchor === null) {
          throw new Error(
            "lower: top-level Before (`< pat`) has no anchor — `<` requires either a prior bindable sibling or a non-root parent",
          );
        }
        matching.push({ tag: "Match", mode: node.constraint, id: node.id, atom: node.atom });
        matching.push({ tag: "IntervalRel", kind: "before:after", a: node.id, b: anchor.id });
        break;
      }
      case "Overlap": {
        matching.push({ tag: "Match", mode: node.constraint, id: node.id, atom: node.atom });
        if (parent !== null) {
          matching.push({ tag: "IntervalRel", kind: "overlap", a: parent.id, b: node.id });
        }
        break;
      }
      case "Assert": {
        assertions.push({ tag: "Assert", id: node.id, atom: node.atom });
        if (parent !== null) {
          assertions.push({ tag: "AssertIntervalRel", kind: "contains", a: parent.id, b: node.id });
        }
        if (prevBindable !== null) {
          assertions.push({ tag: "AssertIntervalRel", kind: "before:after", a: prevBindable.id, b: node.id });
        }
        break;
      }
      case "Constrain": {
        assertions.push({ tag: "Constrain", id: node.id, atom: node.atom });
        if (parent !== null) {
          assertions.push({ tag: "AssertIntervalRel", kind: "contains", a: parent.id, b: node.id });
        }
        if (prevBindable !== null) {
          assertions.push({ tag: "AssertIntervalRel", kind: "before:after", a: prevBindable.id, b: node.id });
        }
        break;
      }
    }

    // Recurse into children. `prev` tracks the previous bindable sibling
    // for the next iteration. Equal and Ask aren't body-bearing and don't
    // count toward the bindable-sibling chain.
    let prev: BodyTree | null = null;
    for (const child of node.children) {
      walk(child, node, prev);
      if (child.tag !== "Equal" && child.tag !== "Ask" && isBindableTag(child.tag)) {
        prev = child as BodyTree;
      }
    }
  }

  // Strip the synthetic root: walk its children with parent = null.
  let prev: BodyTree | null = null;
  for (const child of tree.children) {
    walk(child, null, prev);
    if (child.tag !== "Equal" && child.tag !== "Ask" && isBindableTag(child.tag)) {
      prev = child as BodyTree;
    }
  }

  return { matching, assertions };
}
