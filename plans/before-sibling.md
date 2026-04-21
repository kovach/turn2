# Before sibling semantics

Fix `<` (Before) to match nodes before the **previous sibling** rather than
the parent. Falls back to parent if no previous sibling exists.

Ref: `notes/overview.md` line 62 TODO.

## Current behavior

```typescript
// unify.ts:143-144
if (isBefore) {
  if (!isTemporallyBefore(path, deepest)) continue;
}
```

`deepest` is the parent's path. So `< foo` matches anything before the parent.

## Expected behavior

From overview.md example (lines 93-108):
```
- a
  - c
  < b
  + ok
```
applied to `+ a (+ b) (+ c) (+ d)` adds `ok`.

Here `< b` should match reference node `b` because `b` is before `c` (the
previous pattern sibling `-c`'s image). Current implementation looks for
nodes before `a`, finding nothing.

## Design

### Anchor resolution

For a Before node at index `i` in its parent's children:
1. If `i > 0`: anchor = path of reference node matched by sibling at `i-1`
2. If `i == 0`: anchor = `deepest` (parent's path)

The previous sibling's id is bound in the substitution by the time we process
the Before node (since `matchChildren` processes left-to-right). Look it up
via `subst.get(prevSibling.id)`, then `findPath(boundId, reference)`.

### Interface change

`matchChildren` and `matchSubtree` need access to:
- The full sibling list (to find previous sibling)
- The current sibling index
- The reference tree root (for `findPath`)

Option A: Pass these as extra parameters.
Option B: Restructure `matchChildren` to compute anchor per-child before
calling `matchSubtree`.

Option B is cleaner — keeps `matchSubtree` focused on a single pattern node.

## Implementation

### 1. Add reference root to SearchState

```typescript
interface SearchState {
  deepest: number[];
  subst: Substitution;
  root: Tree;  // reference tree root
}
```

Thread `root` through all calls. Set it once in `unifyTree`.

### 2. Compute anchor in matchChildren

```typescript
function matchChildren(
  patChildren: Tree[],
  candidates: Candidate[],
  state: SearchState
): SearchState[] {
  if (patChildren.length === 0) return [state];
  const [head, ...tail] = patChildren as [Tree, ...Tree[]];
  const ht = head.literal.literalType;
  if (ht !== "Match" && ht !== "Before") {
    return matchChildren(tail, candidates, state);
  }

  // Compute anchor for this child
  let anchor = state.deepest;
  if (ht === "Before") {
    // Find previous negative sibling
    const prevSib = findPreviousNegativeSibling(patChildren, 0);
    if (prevSib !== null) {
      const boundId = substTerm(prevSib.id, state.subst);
      const prevPath = findPath(boundId, state.root);
      if (prevPath !== null) anchor = prevPath;
    }
  }

  const headResults = matchSubtree(head, candidates, state, anchor);
  return headResults.flatMap((s) =>
    matchChildren(tail, candidates, { ...s, root: state.root })
  );
}
```

Wait — this doesn't work because `matchChildren` recurses with `tail`, losing
track of the original index. Need to restructure.

### 2 (revised). Index-based iteration

```typescript
function matchChildren(
  patChildren: Tree[],
  candidates: Candidate[],
  state: SearchState
): SearchState[] {
  return matchChildrenFrom(patChildren, 0, candidates, state);
}

function matchChildrenFrom(
  patChildren: Tree[],
  idx: number,
  candidates: Candidate[],
  state: SearchState
): SearchState[] {
  if (idx >= patChildren.length) return [state];
  const head = patChildren[idx]!;
  const ht = head.literal.literalType;
  if (ht !== "Match" && ht !== "Before") {
    return matchChildrenFrom(patChildren, idx + 1, candidates, state);
  }

  const anchor = computeAnchor(patChildren, idx, state);
  const headResults = matchSubtree(head, candidates, state, anchor);
  return headResults.flatMap((s) =>
    matchChildrenFrom(patChildren, idx + 1, candidates, { ...state, subst: s.subst })
  );
}

function computeAnchor(
  siblings: Tree[],
  idx: number,
  state: SearchState
): number[] {
  const node = siblings[idx]!;
  if (node.literal.literalType !== "Before") return state.deepest;

  // Walk backwards to find previous Match/Before sibling
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i]!;
    const lt = sib.literal.literalType;
    if (lt === "Match" || lt === "Before") {
      const boundId = substTerm(sib.id, state.subst);
      const path = findPath(boundId, state.root);
      if (path !== null) return path;
    }
  }
  return state.deepest; // no previous sibling, use parent
}
```

### 3. Update matchSubtree signature

```typescript
function matchSubtree(
  pat: Tree,
  candidates: Candidate[],
  state: SearchState,
  anchor: number[]  // temporal anchor for Before check
): SearchState[] {
  const results: SearchState[] = [];
  const isBefore = pat.literal.literalType === "Before";
  for (const { path, node } of candidates) {
    if (isBefore) {
      if (!isTemporallyBefore(path, anchor)) continue;
    } else {
      if (!isStrictDescendant(state.deepest, path)) continue;
    }
    // ... rest unchanged
  }
}
```

### 4. Update unifyTree

Pass `reference` as `root` in initial state:

```typescript
return matchChildrenFrom(pattern.children, 0, candidates, {
  deepest: [],
  subst: rootSubst,
  root: reference,
}).map((s) => s.subst);
```

## Tests

Add to `unify.test.ts` or `fixpoint.test.ts`:

1. **Previous sibling anchor**: The example from overview.md — `- a (- c) (< b) (+ ok)` matches when `b` is before `c`.

2. **No previous sibling**: `- a (< b) (+ ok)` — falls back to parent anchor, matches `b` if before `a`.

3. **Multiple Before siblings**: `- a (- c) (< b) (< d) (+ ok)` — second Before uses first Before's match as anchor.

4. **Skips positive siblings**: `- a (+ x) (< b)` — the `+ x` is not a valid anchor (positive), so falls back to parent.

## Order of work

1. Add `root: Tree` to `SearchState`
2. Rename `matchChildren` to `matchChildrenFrom` with index parameter
3. Add `computeAnchor` helper
4. Update `matchSubtree` to take explicit `anchor`
5. Update `unifyTree` to pass `root`
6. Add tests
7. Remove TODO from overview.md
