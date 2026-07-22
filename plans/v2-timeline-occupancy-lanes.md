# v2 timeline — occupancy-based lane placement

Goal: fix the layout artifact where a subtree's bars drift to high
lanes when unrelated later bars open new lanes below them. Observed
case: `setup`'s `move` children are placed at lane 1 (adjacent to
their parent), then pushed to lane 3 when `turn`'s incomparable
children `b`/`c` each splice a new lane in at index 1.

Root cause: the placer (`makePlacer` in `ts/src/v2/timeline.ts`)
remembers only **one number per lane** — `laneLastRTok`, the end
moment of the last bar placed there. That forces per-lane
left-to-right commitment, which forces the splice-insert + global
`lane[i] += 1` shift when a later bar needs a lane "below" existing
ones. The shift is what moves already-correctly-placed bars.

This is a follow-up to plans/v2-timeline-weakened-lane-sharing.md,
which established the partial-order sharing rule; here we keep that
rule but change the lane data structure so placement is monotone.

## Semantics of lane placement

Distilled rules. Let `<=` be the moment partial order (`leqTok`,
i.e. reachability in the db order graph, with `bot <= everything`).
A bar is an interval `[l, r]` of moments with `l <= r`.

1. **Disjointness.** Two bars may share a lane iff they are
   *temporally disjoint in the partial order*: `a.r <= b.l` or
   `b.r <= a.l`. Incomparable bars are never disjoint — a lane is
   always a chain of bars. (Rank coincidence is irrelevant; only the
   order matters.)

2. **Nesting.** A bar sits strictly farther from the spine than its
   parent in the containment forest: `lane(child) > lane(parent)`.
   Parent = innermost proper container by the same partial order
   (`buildContainmentForest`, unchanged). Bars are never separated by
   ownership beyond this — rule 1 is the only sharing restriction, so
   bars from different subtrees cohabit a lane whenever disjoint.

3. **Greedy proximity.** Each bar takes the *lowest* lane satisfying
   rules 1–2 at the moment it is placed, where "satisfying rule 1" is
   checked against the lane's full occupancy, not a frontier. Visit
   order determines ties: tree mode = pre-order DFS (roots nearest
   the spine), nested mode = post-order DFS (leaves nearest the
   spine); siblings ordered by `(lRank, span, tupleIndex)`.

4. **Monotonicity** (new — the fix). Once placed, a bar's lane never
   changes. A bar that cannot fit goes *up* to the next free lane; it
   never displaces others. Consequently a bar's lane depends only on
   the bars visited before it, not on the whole input.

Rules 1–2 are the invariants (asserted nowhere today — worth a test);
rules 3–4 are the policy that picks one layout among the valid ones.
The current code implements 1–3 but violates 4 via splice-shifting,
which is exactly the reported bug: the `move` bars' final lane is an
artifact of how many splices happened after them.

## What changes

All in `ts/src/v2/timeline.ts`, inside `makePlacer`:

- Replace `laneLastRTok: number[]` with `lanes: RawBar[][]` (bars
  placed per lane).
- Replace the frontier probe with a pairwise disjointness check:

  ```ts
  const fits = (laneBars: RawBar[], b: RawBar): boolean =>
    laneBars.every(x => leqTok(x.rTok, b.lTok) || leqTok(b.rTok, x.lTok));

  const place = (idx: number, minLane: number): void => {
    const b = rawBars[idx]!;
    let li = minLane;
    while (li < lanes.length && !fits(lanes[li]!, b)) li++;
    while (lanes.length <= li) lanes.push([]);
    lanes[li]!.push(b);
    lane[idx] = li;
  };
  ```

- Delete: the splice-insert, the global shift loop, the `botTok`
  sentinel padding (an empty lane trivially fits), and therefore the
  `botTok` parameter of `makePlacer`/`packBarsNested`/`packBarsTree`.
- `packBarsNested`: the "re-read lane[c] after subtrees — splices may
  have shifted them" comment and its motivation go away; `childMax`
  is stable once children are placed. Logic can stay as written.
- `laneCount` comes from `lanes.length`.
- `packBarsCompact` untouched (it's rank-based by design).

Complexity: `fits` is O(bars-in-lane) per probe instead of O(1), so
worst-case O(N²) `leqTok` calls total — fine at display sizes, and it
replaces the O(N) shift loop the old code paid on every new lane.

## Expected behavior change

On the motivating program (`~setup; ~turn` with four `move` children
under setup and incomparable `a`/`b`/`c` under turn): moves stay on
lane 1 next to `setup`; `a` shares lane 1 (disjoint), `b`→2, `c`→3.
Same lane count as today, but the moves no longer depend on a/b/c.

More generally: any layout where the old code's splice pushed
unrelated bars upward will now keep those bars low; bars needing a
fresh lane appear higher instead of shoving the stack. Existing tests
in `ts/src/tests/v2_timeline_layout.test.ts` (game/step/look/print,
3 lanes, game on lane 0) should be unaffected — verify.

## Steps

1. Rewrite `makePlacer` per above; thread signature changes through
   `packBarsNested`/`packBarsTree`.
2. Run `v2_timeline_layout` test module (./run-tests.sh).
3. Add a regression test from the motivating program asserting the
   `move` bars sit on `lane(setup) + 1`, plus (optionally) invariant
   checks for rules 1–2 over the final layout.
4. Spot-check `renderTimelineAscii` output on a few existing `.t`
   files in `ts/data/v2/`.

No new files; `ts/src/v2/overview.md` needs no structural update
(mention the placement-rule change in its timeline section if it
describes the old splice behavior).
