# `before` literal type

Implement the new negative literal-type `Before`, denoted in source by the
prefix marker `<`. Spec: `notes/overview.md` → "query algorithm update".

## Semantics

A `<` node behaves like a `-` (Match) node — same unification of id and
atom against an Assert/Ask node in the reference — with one extra
constraint:

> the matched reference node must be *temporally before* the reference
> node matched by the parent of the `<` node in the pattern.

"Temporally before" is the relation already implemented in
`tree.ts:nodesBefore` (siblings ordered by child index; nested children
inherit their ancestor's order).

Worked example (from overview):

```
- turn A
  < move X
    + note A X
```

against

```
+ root
  + move a
  + move b
  + turn
```

For the pattern's `turn A` matching reference `turn`, the `< move X`
sub-pattern can match `move a` and `move b` because both are temporally
before `turn`, even though they are not descendants of it. The `+ note`
is then inserted as a child of `turn` (the image of the parent pattern
node under the substitution — the Before node itself), once per Before
match.

## Type changes (`ts/src/types.ts`)

Extend `LiteralType`:

```
export type LiteralType = "Match" | "Before" | "Assert" | "Ask" | "Constrain";
```

Treat `Before` alongside `Match` everywhere "negative" is meant. No new
fields needed — the temporal constraint is structural, derived from the
parent relationship in the pattern.

## Parser / formatter (`ts/src/parse.ts`)

- `prefixToLiteralType`: add `case "<": return "Before";`
- `literalTypeToPrefix`: add `case "Before": return "<";`
- No other parsing changes (id-binding `<[Id] foo` already falls out of
  the existing `*[<term>]` handling).

## id-expand (`ts/src/expand.ts`)

`idExpand` treats `Before` exactly like `Match`:
- `isPositive` should be `literalType === "Assert" || "Ask" || "Constrain"`,
  i.e. anything not in `{Match, Before}`. Cleanest is a small helper
  `isNegative(lt)` / `isPositive(lt)` in `types.ts` and use it here and
  in `expand`, `step`, `tree.ts`, `unify.ts`.
- A `Before` node gets a fresh id Variable just like a Match node, and
  its variable joins `previousVars`.

## Rule expansion (`ts/src/expand.ts`)

`pruneAndConvert` currently rewrites earlier positive nodes to `Match`
when building each prefix rule. Keep that; `Before` nodes are already
negative and pass through unchanged.

`expand` walks for "positive" nodes — switch the test to
`isPositive(literalType)` so `Before` nodes don't generate their own
prefix rules.

`collectPositiveNodes` (`tree.ts`) likewise needs the `isPositive` test.

## Unification (`ts/src/unify.ts`)

This is the core change. The current search treats every pattern child
as either Match (must be a strict descendant of the deepest matched
ancestor) or non-Match (skipped — those are positives, handled by
`step`). We need a third case: `Before`.

### Approach

`matchSubtree` and `matchChildren` track `deepest: number[]` (path of
the deepest ancestor's image). For Match children we require
`isStrictDescendant(deepest, candPath)`. For Before children we instead
require: the candidate node is *temporally before* the node at
`deepest` in the reference tree.

Add a helper in `tree.ts`:

```
export function isTemporallyBefore(root: Tree, aPath: number[], bPath: number[]): boolean
```

Implementable directly from paths without walking the tree: given
pre-order, "a is before b and a is not an ancestor of b" iff the
first index where the paths diverge has `a[i] < b[i]`. (Ancestors of b
share b's prefix — these are excluded.) That's a 5-line function.

Wire it in `matchChildren` / `matchSubtree`:

- `matchChildren` currently dispatches on `head.literal.literalType !==
  "Match"` to skip positives. Change to: if `Match` → existing
  descendant-path; if `Before` → call a new `matchBeforeSubtree`; if
  positive → skip.
- `matchBeforeSubtree(pat, candidates, {deepest, subst})`: like
  `matchSubtree` but the path filter is `isTemporallyBefore(root,
  candPath, deepest)` instead of `isStrictDescendant(deepest,
  candPath)`. Recurse into the Before node's own children with the
  Before node's path as the new `deepest` — descendants of a Before
  match are matched as descendants in the usual way (the spec doesn't
  forbid this; the temporal constraint applies between the Before
  node and its *parent* only).
- `unifyNode` already only requires the pattern be `Match`. Generalize
  to allow `Before` as well (or factor a `unifyNegativeAgainstAssert`).

`unifyTree` now needs the reference root to compute paths-vs-deepest;
pass it (or compute paths inline). The `Candidate` already carries
`path` — just thread the comparison through.

### Edge cases

- Top-level `<` child of pattern root: parent path is `[]` (root), so
  "before root" matches nothing. That's fine — a Before at the root has
  no temporal anchor; it should match nothing (or we can forbid it at
  parse time as a follow-up).
- Multiple Before siblings: each matched independently against the
  shared parent's image, same as Match siblings.
- Nested Before under Before: descendants of a Before match use normal
  descendant matching against the Before node's image (treat the inner
  one as a regular Match path unless it's *also* `<`).

## Step (`ts/src/step.ts`)

`collectPositiveNodes` change (above) is the only thing required.
Insertion in `step.ts` now uses `substTerm(parent.id, subst)` directly
(post simplification), and a Before node — like a Match node — contributes
its id var → reference id binding to the substitution. So positives
under a Before parent are inserted under the temporally-before reference
node with no special case.

Verify: in the worked example, `+ note A X` has the Before node as its
parent in the pattern; the Before node's id var was bound to (say)
`move a`, so `note r a` is inserted as a child of `move a` — matches
the expected output.

## Tests

Add to `ts/src/unify.test.ts` and `ts/src/tree.test.ts`:

1. `isTemporallyBefore` unit tests against the example tree in the
   "temporal semantics" section of overview.md (a < c, b < c, c < d,
   c < e; not a < b, not d < e since d is ancestor of e).
2. The worked example from "query algorithm update" — feed the pattern
   and reference through the full pipeline (parse → idExpand → expand →
   fixpoint) and assert the output matches the expected tree.
3. Negative case: `< move X` under a parent that has nothing before it
   produces zero substitutions.
4. Mixed: a `<` sibling alongside `-` siblings under the same parent —
   each constraint applied independently.

Add a small `.sl` fixture in `ts/data/` exercising the worked example.

## Order of work

1. `types.ts`: add `Before` + `isNegative`/`isPositive` helpers.
2. `parse.ts`: prefix mapping both directions.
3. `expand.ts`, `tree.ts`: switch to `isPositive` helpers.
4. `tree.ts`: `isTemporallyBefore` + tests.
5. `unify.ts`: Before branch in `matchChildren` / new
   `matchBeforeSubtree` + tests.
6. End-to-end fixture test through `fixpoint`.
