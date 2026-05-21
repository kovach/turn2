# v2 timeline — weakened lane-sharing rule

Goal: relax the constraint that all bars on a lane share a containment
parent. Replace it with a purely temporal check using the **moment
partial order** (not rank order): for any two bars `a < b` on the same
lane, require `a.rTok <= b.lTok` in the db order. This admits more
sharing — siblings of different parents can cohabit a lane when they
don't temporally overlap — at the cost of weaker visual grouping by
hierarchy.

Locus: `ts/src/v2/timeline.ts` — `makeOwnedPlacer`, `packBarsNested`,
`packBarsTree`. Containment-forest construction (`buildContainmentForest`)
is unchanged: it still picks each bar's innermost partial-order
container as parent. We only weaken the lane-pack rule.

## What changes

### Drop the per-lane owner

`makeOwnedPlacer` currently tracks `laneOwners: (number | null)[]` and
in `place(idx, minLane)`:

```ts
if (laneOwners[li] === owner && laneEnds[li]! <= b.lRank) { … }
```

Drop the owner half of the conjunction. A lane is reusable as long as
the temporal check passes.

### Replace rank-based laneEnds with partial-order check

Today `laneEnds[lane]` is a `number` (the last placed bar's `rRank`),
checked via `<=` against the new bar's `lRank`. Two issues with that
under the weakened rule:

1. **Rank-coincidence.** Two moments may share a rank without being
   comparable in the partial order. The rank check would say "lane
   available" when the moments are actually incomparable (i.e., the
   two bars cross). We saw the symmetric problem in containment — same
   fix applies here.
2. **Ownership was the implicit cushion.** Today the same-parent
   requirement kept incomparable moments from colliding because two
   children of one parent are typically ordered. Dropping ownership
   removes that cushion.

So switch `laneEnds[lane]` to the **last bar's `rTok`** (a moment
token), and check availability with `leqTok(lastRTok, b.lTok)`. This
matches the user's spec — `a_right <= b_left in the db order` (with
`<=` reflexive so touching-at-same-moment is allowed; strict `<` is a
straightforward variant if we want stricter separation).

If `leqTok` returns false because the two endpoints are **incomparable**
in the partial order, the lane is unavailable — exactly what we want
for crossing bars.

### Keep `minLane` (parent/child structural constraint)

The other half of the placer's logic — `minLane` derived from "above
all my children" (nested) or "above my parent" (tree) — is
**structural**, not about sibling lane-sharing. Keep it. Otherwise a
parent could land on the same lane as one of its children, producing
visually overlapping bars on top of each other.

### Empty-lane padding

`while (laneEnds.length < minLane) { laneEnds.push(0); laneOwners.push(null); }`
becomes simply:

```ts
while (laneEnds.length < minLane) laneEnds.push(/* sentinel meaning "available" */);
```

Need a sentinel for an empty lane — pick `store.botTok` (which is
`leqTok(botTok, anything) === true`, so the lane reads as "empty,
anything can go here"). That avoids a separate `laneOpen[]` array.

## Effects on existing examples

### foo/game/turn

The picture barely changes. The original fix was about *containment*
(getting `~foo` correctly tagged as game's child, not action-phase's
parent), and that lives in `buildContainmentForest`, untouched here.
Lane assignment in nested mode for that program already split things
by structural depth; the few cases where the weakened rule would let
two bars merge are also temporally disjoint AND structurally
compatible, so the merge is sensible.

### step/look/print (the case that motivated this)

`print here` and `print there` have different parents (`look₁` vs
`look₂`) and are temporally disjoint. Under the current rule they can't
share — opening a separate lane for each — so the picture climbs to 4
lanes for the tree mode (game, the four step/looks, print here, print
there on different lanes).

With the weakened rule, `print here` and `print there` share lane 2 in
tree mode:

```
                          [print here ]                              [print there]
            [step here]   [look      ]   [step there]                [look       ]
[game                                                                            ]
```

3 lanes total — same as compact mode for this example, but with the
hierarchical structure (game at bottom, children above, grand-children
above that) preserved through `minLane`.

### Crossings (genuinely incomparable in partial order)

Two bars `A:[m1,m3]`, `B:[m2,m4]` with `m1 < m2 < m3` but `m3` and `m4`
incomparable: `leqTok(A.rTok, B.lTok)` = `leqTok(m3, m2)` = false (m3
is after m2). They can't share a lane. Correct.

## Step-by-step

1. Change `laneEnds: number[]` to `laneLastRTok: number[]` (moment
   tokens) in `makeOwnedPlacer`. Initial sentinel for empty lanes is
   `store.botTok`.
2. Thread `leqTok` and `store.botTok` (or a single "sentinel + leq"
   helper) into `makeOwnedPlacer`. Currently the placer is closed
   over `parent` only; widen its signature.
3. Drop `laneOwners` and the owner check in `place`. Drop the
   `parent` argument too — it's no longer used inside.
4. In `place`'s reuse loop, replace the rank `<=` check with
   `leqTok(laneLastRTok[li]!, b.lTok)`.
5. In the "open a new lane" path, replace the `laneOwners.push(null)`
   pad with a `laneLastRTok.push(botTok)` pad.
6. `packBarsNested` and `packBarsTree` callers: drop the second
   argument they pass to `makeOwnedPlacer` (or rename the helper).
7. Run the existing `ts/src/v2-ascii-demo.ts` against the
   foo/game/turn and step/look/print programs, eyeball the diffs,
   commit if reasonable.
8. Consider whether the weakened rule should be a **third axis**
   (`laneSharing: "strict" | "loose"`) instead of replacing the
   strict rule outright. If real decks lose useful hierarchy in
   nested mode under the loose rule, keep both. For tree mode the
   loose rule is almost certainly an improvement.

## Out of scope

- A separate `LaneSharing` option exposing strict vs. loose to the
  UI. Decide based on whether the loose rule looks worse for any
  real program; only add the toggle if it does.
- Strict `<` instead of reflexive `<=` in the temporal check (so
  bars touching at a single moment can't share a lane). Easy switch
  later if the touching-share looks visually noisy.
- Replacing the per-lane "last rTok" tracking with a full interval
  set (would allow inserting bars in the middle of a lane out of
  start order). Current DFS visits siblings in start order, so the
  monotone last-rTok approximation is correct.
- Changing containment-forest construction. The forest still
  determines `parent[]` for the `minLane` calculation; this plan
  doesn't touch it.

## Tradeoffs

- **Fewer lanes** in nested and (especially) tree mode: bars from
  different subtrees coexist on a lane when they don't temporally
  overlap. Real programs with many small "leaf" bars under different
  parents will compress significantly.
- **Weaker visual grouping by parent.** Today you can read a single
  lane as "siblings under one parent"; under the loose rule, a lane
  is just "a sequence of temporally disjoint episodes" — could mix
  pre-game setup, mid-game turn details, and post-game cleanup on the
  same line, depending on the forest. Mitigation: the structural
  `minLane` keeps the rough hierarchy (descendants further from the
  spine than their containers), so the picture still reads as a tree
  even if individual lanes mix subtrees.
- **Rank-vs-partial-order fix is invariant under the weakening.** We
  switched containment to the partial order earlier; we now also
  switch the lane temporal check. The two algorithms now agree on
  which notion of "before" they're using — easier to reason about.
- **The current "ownership" picture remains a useful debug mode.**
  Keeping it behind a toggle (out of scope above) is cheap if the
  strict rule turns out to communicate structure better in some
  decks.
