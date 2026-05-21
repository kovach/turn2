# v2 timeline — nested lane layout

Goal: add a second lane-assignment mode that arranges episode bars by
**causal proximity** (containment hierarchy) instead of pure
minimum-lane interval packing. The motivating case is a top-level
`~game` bar that contains everything: today's greedy puts it on lane 0
and arbitrary siblings fight for lanes above; the new mode puts leaves
on lane 0, their parents above them, and `~game` on the outermost
lane — the structure of the program becomes visible in the picture.

Keep the existing mode as the default; expose a parameter to switch.

## Scope

- Affects `ts/src/v2/timeline.ts` only for the layout pass.
- Both orientations benefit (the lane number is the cross-axis index in
  both); no projector changes needed.
- New mode coexists with the old; we don't delete the greedy pack.

## Parameter

Extend `TimelineOpts`:

```ts
export type LaneMode = "compact" | "nested";

export interface TimelineOpts {
  …
  laneMode: LaneMode;   // "compact" = existing greedy; "nested" = forest DFS
}

export const DEFAULT_OPTS: TimelineOpts = {
  …
  laneMode: "compact",
};
```

Pass-through callers:

- `web-v2.ts`: add a toggle button in the timeline toolbar (alongside
  orientation). Persist choice the same way orientation is persisted
  (URL param or localStorage — match the existing pattern).
- `pres/render.ts`: code blocks could accept a `nested-lanes` opt in
  the `[opts]` list; defer unless decks need it. For now, default to
  "compact" in pres.

## Algorithm

### Step 1 — containment forest (via the moment partial order)

For every bar `b` with endpoint moment tokens `(lTok, rTok)`:

- Define `contains(A, B) := lA ≤ lB ∧ rB ≤ rA` where `≤` is the
  **moment partial order** (not rank ordering). Ranks come from
  longest-path layering and can coincide between incomparable moments
  — two episodes that happen to lay out at the same rank-interval
  may not be causally containing. Use the partial order directly so
  the forest reflects causality, not visual coincidence.
- Source of truth for the order: the `gt` reachability map already
  computed at the top of `layoutTimeline` for the displayed moments
  (bot below everything, top above everything, transitive over
  `store.orderFwd`). Expose a `leqTok(a, b)` helper to
  `packBarsNested` so it doesn't have to know about `Store` internals.
- Build a parent for each bar: the **smallest** bar that properly
  contains it. Since the partial order is not total, "smallest" needs
  a tiebreaker — use rank-interval span (`rRank - lRank`) ascending,
  then `tupleIndex`. This is a stable choice for the cases where two
  containers are incomparable to each other but both contain the
  child.
- Identical-endpoint duplicates (`lA == lB ∧ rA == rB`) tie-break by
  `tupleIndex` so `properlyContains` is antisymmetric.
- Bars with no container become forest roots.

Implementation: O(N²) over bars; for each bar `i`, walk all `j`,
test `properlyContains(j, i)` via two `leqTok` calls, keep the best.
N is small (tens of bars typically). If it ever matters, precompute
each moment's downward-reachability set once and use set membership
instead of repeated `leqTok` calls.

### Step 2 — crossing (non-containment) overlaps

Pairs like `a:[m1,m3]` / `b:[m2,m4]` overlap without one containing
the other (in the partial order — `m1 ≤ m2` but `m3` and `m4` are
incomparable, or similar). They are not edges in the containment
forest. The forest still covers every bar (every bar gets a unique
parent or is a root); the crossing relationship is **not preserved**
in the forest, only in the overlap on the shared moments along the
spine.

If a bar both crosses some and is contained in another, the container
wins (it's the bar's parent). If a bar crosses everything at its level
and is contained in nothing, it's a root with no children — fine.

We accept that crossings are visualized only via the spine, not via
lane adjacency. Documented tradeoff.

### Step 3 — DFS post-order assignment with lane ownership

Traverse the forest:

1. Sort roots by `(lRank, rRank, tupleIndex)` — rank ordering is fine
   for sibling traversal order; only containment needs the partial
   order.
2. For each root, recurse: sort children by the same key, recurse
   into each child, **then** place the current bar.
3. Track per-lane state `(laneEnd, owner)` where `owner` is the index
   of the bar that is the containment parent of all bars on that lane
   (or `null` for lanes carrying forest roots). To place bar `b`:
   - Compute `minLane = (max direct-child lane) + 1`, or `0` if no
     children.
   - Scan lanes from `minLane` upward; a lane is reusable iff
     `owners[lane] === parent(b)` **and** `laneEnds[lane] <= b.lRank`.
   - First reusable lane wins; otherwise open a new lane with
     `owner = parent(b)` and `laneEnd = b.rRank` at index
     `max(minLane, laneEnds.length)` (pad with empty lanes if
     `minLane` exceeds current length).

The `owner` rule is what produces the visual hierarchy: bars from
two different subtrees (e.g. one parent's child and another's) can't
share a lane even when they're temporally disjoint, so the picture
preserves "lane = sibling group under one parent." Without it,
greedy lane reuse mixes children of different parents on lane 0 and
the nesting becomes unreadable.

Because children are placed before their parent, every direct child
has a known lane by the time the parent is placed, so `minLane` is
just `max(child.lane) + 1`. Sibling subtrees that don't temporally
overlap can share lanes (same owner), so depth of the forest — not
bar count — drives lane count.

### Step 4 — `startGroupRow` re-computation

The current code computes `startGroupRow` (used by vertical projector
label staggering) after lane-pack. Re-run the same logic over the new
lane assignment — no algorithmic change, just runs on a different
input.

## Where the dispatch lives

Inside `layoutTimeline`, where today's `// Lane-pack bars greedily…`
block lives (`timeline.ts:279–297`):

```ts
const leqTok = (a: number, b: number): boolean =>
  a === b || (gt.get(a)?.has(b) ?? false);

const { bars, laneCount } = opts.laneMode === "nested"
  ? packBarsNested(rawBars, leqTok)
  : packBarsCompact(rawBars);
```

Extract the existing block into `packBarsCompact` for symmetry and to
keep `layoutTimeline` readable. The closure threads the partial-order
check into `packBarsNested` without coupling it to `Store`.

## Edge cases

- **No bars:** both modes return `[]` trivially.
- **Identical endpoints on multiple bars:** `properlyContains` falls
  back to `tupleIndex` so the "outer" is deterministic; the nested
  pair stacks in input order.
- **Rank-coincidence without partial-order comparability:** two
  bars `A`, `B` may have `A.lRank <= B.lRank` and `B.rRank <= A.rRank`
  yet `A.lTok` and `B.lTok` are incomparable in the moment order
  (they happened to land at the same rank). Because containment is
  defined via `leqTok`, `A` is **not** treated as `B`'s container —
  this is the bug the rank-based version of the algorithm would
  introduce, with a temporally coincident `~foo` getting mis-classified
  as a parent of `~action-phase`.
- **A bar spanning [bot, top]** (the conventional `~game`): contains
  every other bar in the order; ends up as a single forest root with
  everything as its descendants. Result: a single nesting chain —
  leaves at lane 0, game at the top.
- **Several disjoint top-level bars:** multiple forest roots; they
  may share lanes when temporally disjoint (lane owner is `null` for
  all roots), or stack on different lanes when they overlap.

## Step-by-step

1. Add `LaneMode` type and `laneMode` to `TimelineOpts` / `DEFAULT_OPTS`.
2. Extract the current greedy block into `packBarsCompact(rawBars)`,
   returning `{ bars: PartialBar[]; laneCount: number }`. No behavior
   change yet.
3. Inside `layoutTimeline`, define `leqTok(a, b)` as a closure over
   the local `gt` reachability map (built immediately after rank
   layering).
4. Write `packBarsNested(rawBars, leqTok)` that:
   - Computes `parent[i]` via O(N²) scan using
     `properlyContains(A, B) := leqTok(A.lTok, B.lTok) && leqTok(B.rTok, A.rTok)`
     with span+tupleIndex tiebreakers.
   - DFS-post-orders the forest.
   - Places each bar via the ownership-constrained greedy: scan
     lanes from `(max-child-lane + 1)` upward; lane reusable iff
     `owners[lane] === parent[bar]` AND `laneEnds[lane] <= b.lRank`.
5. Branch on `opts.laneMode` in `layoutTimeline`.
6. UI: add a `compact / nested` button to the v2 timeline toolbar in
   `web-v2.ts`, persist in `sessionStorage` like orientation.
   Re-render on change.
7. Smoke-test against `ts/data/v2/*.t` programs — include at least
   one with two temporally-coincident top-level episodes (to exercise
   the rank-coincidence case) and one with a deep `~game`/`~turn`
   containment chain.

## Out of scope

- Re-introducing a visible **divider** between top-level forest roots.
  Could come later as a faint horizontal rule between lane groups
  belonging to different roots; not needed for the primary win.
- Coloring bars by depth or by root subtree. Could help disambiguate
  crossings; revisit after seeing real programs.
- Promoting crossing overlaps into the forest (multi-parent DAG).
  The forest assumption simplifies the placement; abandon only if
  visual results in real decks demand it.
- A third mode that minimizes label crowding by collapsing nesting
  whenever the parent has only one child. Aesthetic optimization;
  defer.

## Tradeoffs

- **Lane count grows** vs. compact mode: bounded by the depth of the
  containment forest. For a program with a top-level `~game` and a
  3-deep chain inside, lane count is at least 4 — comfortably small.
  For pathologically deep decks, the picture grows vertically.
- **Crossing intervals look unmotivated** in nested mode: two bars
  that cross but neither contains the other will end up on
  non-adjacent lanes determined by their forest position. The
  shared-moment lines on the spine remain the only cue. If this
  bites, the forest-with-crossings escape hatch (out-of-scope above)
  can be added.
- **Determinism on identical intervals** depends on `tupleIndex`
  ordering, which mirrors insertion order. Reasonable for tutorial
  programs; could become surprising for shuffled inputs.
