# evaluation pipeline plan

## Overview

Replace the current ad-hoc node-id assignment and multi-positive-node step with the two-pass pipeline described in overview.md: `idExpand` followed by `expand`/`expandAll`.

## 1. `idExpand(tree: Tree, name: string): Tree`

New function (probably in `step.ts` or a new `expand.ts`).

Walk nodes top-to-bottom in document order, maintaining:
- `varCounter`: integer, incremented for each match node
- `previousVars`: list of Terms — the id of each node seen so far (match id variables + positive id atoms)

For each node:
- **Match**: assign fresh id `Variable("X" + varCounter++)`, append that variable to `previousVars`
- **Positive** (Assert/Ask/Constrain): assign id `Atom([sym("id"), sym(name), ...previousVars])`, append that atom to `previousVars`

Returns a new tree with all ids replaced; does not mutate the input.

`previousVars` collects the id term of each node in order, so each positive node's id encodes the full preceding context.

## 2. `expand(tree: Tree): Tree[]`

New function. Given a single (id-expanded) pattern:

1. Number all nodes (excluding the wrapper root) in pre-order.
2. For each positive node at pre-order index `k`, build a prefix tree ending at `k`:
   - Keep nodes with pre-order index ≤ k; drop nodes with index > k.
   - Node k retains its literal type but loses all children (they come after k in pre-order).
   - This preserves siblings that precede k in document order, not just ancestors.
   - Convert any positive nodes with index < k to Match.
3. Return the list of prefix trees.

Implementation: `pruneAndConvert(node, targetIdx, counter)` walks in pre-order, returning `null` once past targetIdx. Prune and convert happen in one pass.

## 3. `expandAll(patterns: Tree[]): Tree[]`

`patterns.flatMap(expand)` — apply expand to each pattern and concatenate.

## 4. Update `step.ts`

Remove the `nodeId` function. The id for a newly inserted node is now just `substTerm(posNode.id, subst)` — id-expand has already embedded the context into the pattern's id field.

The rest of `step` is unchanged: unify, clone ref, iterate positive nodes, apply substitution to id and atom, insert if not already present.

Since `expandAll` reduces each pattern to a single positive node at the tip, `collectPositiveNodes` will always return exactly one node per expanded rule. The loop in `step` still works correctly for zero or one positive node.

## 5. Update `fixpoint.ts`

Apply `expandAll` once before the loop:

```ts
export function fixpoint(rawPatterns: Tree[], initial: Tree, gas = 20) {
  const patterns = expandAll(rawPatterns);
  // ... existing loop unchanged
}
```

## 6. Update parsing pipeline

`parsePatterns` should apply `idExpand` to each parsed tree. The name for each rule could be its 1-based index (`"r1"`, `"r2"`, ...) or a user-supplied label. Start with index-based names.

## 7. Tests to remove / rewrite

- **`step.test.ts`**: remove entirely; the hand-constructed trees use the old line-number id scheme and multi-positive-node patterns. Replace with tests for `idExpand` and `expand` directly.
- **`fixpoint.test.ts`**: keep basic structure; update if the new id scheme changes what the inserted atoms look like.
- **`parse.test.ts`**: keep; parsing itself doesn't change. Remove the `example.sl` roundtrip tests if that file is updated to use the new format, otherwise keep.
- **`unify.test.ts`**: keep unchanged — unification is unaffected.
- **`tree.test.ts`**: keep unchanged — tree utilities are unaffected.

## New tests to add

- `idExpand`: verify match nodes get sequential variable ids, positive nodes get structured Atom ids encoding preceding context. Use the example from overview.md (`f / +g / -h / +i`).
- `expand`: verify the two prefixes from the overview example are generated correctly; verify earlier positive nodes are converted to match.
- Integration: verify `fixpoint0` with a two-level pattern (match → assert → match → assert) reaches the correct fixed point.
