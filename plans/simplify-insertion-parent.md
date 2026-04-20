# Remove `deepestAncestorImage`

The function `tree.ts:deepestAncestorImage` and its use in `step.ts` are
holdovers from an earlier matching scheme that allowed gaps between an
ancestor in the pattern and its image in the reference. Under the
current `unify.ts` (every Match child must land on a strict descendant
of its parent's image), the substitution already pins every pattern
node to a concrete reference node — so to find where a positive node
should be inserted, we just substitute its parent's id directly.

## Current behavior

`step.ts` for each positive pattern node N:
```
const parent = nodeAt(pattern, posPath.slice(0, -1));
const P = deepestAncestorImage(parent.id, pattern, refCopy, subst);
const pPath = findPath(P.id, refCopy);
insertAt(refCopy, pPath, ...);
```

`deepestAncestorImage` walks every ancestor of N (including N) in the
pattern, applies subst to each id, looks each up in the reference, and
keeps the deepest hit. With the current unifier this always equals
`substTerm(parent.id, subst)` — every ancestor of a positive node is
either the root or a Match node whose id var is bound by subst to a
real reference id, and unification guarantees those images form a
descendant chain.

## Replacement

In `step.ts`:

```
let pPath: number[];
if (posPath.length === 0) {
  pPath = [];
} else {
  const parent = nodeAt(pattern, posPath.slice(0, -1))!;
  const parentRefId = substTerm(parent.id, subst);
  const found = findPath(parentRefId, refCopy);
  if (found === null) continue;  // shouldn't happen given unify invariants
  pPath = found;
}
```

The `continue` is defensive only; with the current unifier it's
unreachable. Worth keeping as a guard (with a comment) rather than `!`
in case future literal types weaken the invariant.

## Files to change

1. `ts/src/step.ts`
   - Drop `deepestAncestorImage` from the import.
   - Replace the parent-resolution block with the direct substitution.

2. `ts/src/tree.ts`
   - Delete `deepestAncestorImage`.

3. `ts/src/tree.test.ts`
   - Delete the three `deepestAncestorImage` test blocks (lines ~66–126)
     and remove the symbol from the import.

4. `notes/overview.md`
   - In the `# step algorithm` section, replace
     `P := deepestAncestorImage applied to the parent of N`
     with
     `P := the reference node whose id is S(parent.id)`.
   - Remove the `deepestAncestorImage: see tree.ts` line above it.

5. `plans/before.md`
   - Drop the references to `deepestAncestorImage` in the Step
     section and the worked-example justification; restate as "the
     parent pattern node's id (a Match or Before var) is bound by the
     substitution to the reference node we matched, so we just insert
     under that node." For the `<` case, the parent's image is the
     temporally-before reference node (e.g. `move a`), and a positive
     child of `<` is inserted there directly.

## Interaction with the `before` feature

This simplification is *compatible* with the planned `Before` literal
type and in fact makes that plan cleaner: a `<` node, like a `-` node,
contributes a (var → reference id) binding to the substitution, so a
`+` child of a `<` parent gets inserted under the temporally-before
reference node automatically — no special case in `step.ts`. Update
`plans/before.md` accordingly (item 5 above).

Order of work: land this simplification first, then implement
`before.md` against the simpler `step.ts`.

## Verification

- `expand.test.ts`, `fixpoint.test.ts`, `unify.test.ts`, the trimmed
  `tree.test.ts`, and `parse.test.ts` should all still pass with no
  changes besides the test deletions in `tree.test.ts`.
- Spot-check by re-running the existing `.sl` fixtures through
  `fixpoint` and diffing the output against pre-change output.
