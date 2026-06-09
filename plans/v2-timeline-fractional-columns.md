# Timeline edges variant: step vs. fractional horizontal separation

## Problem

In the `momentStyle: "edges"` horizontal timeline, x-position currently comes
from a **linear extension** of the moment poset (`timeline.ts`, the Kahn block
~lines 282–300): every moment gets its own column and consecutive columns are
floored to `minColWidth` (32px). So two *incomparable* moments that happen to be
adjacent in the extension sit a full step apart — wasting width and visually
implying an ordering that does not exist.

We want **two tiers** of horizontal separation:

- **Step difference** (the unit, `minColWidth`): if `x < y` (comparable), their
  x must differ by at least one step.
- **Fractional difference** (much smaller, new `minFracWidth`): if `x` and `y`
  are incomparable *and share a longest-path rank*, they need only a small
  offset so their dots are distinguishable but visibly clustered.

(Per the practical algorithm below, incomparable moments that land on
*different* longest-path ranks still get step separation — this is accepted, and
matches "use the old ranking to separate step differences.")

## Key insight: this reuses the existing column machinery unchanged

The variable-separation scheme is exactly equivalent to keeping **one column per
moment** (as today) but making the per-column-gap widths non-uniform:

- order columns so same-rank moments are **contiguous**;
- floor a gap to `minFracWidth` when it sits **within** a rank, and to
  `minColWidth` when it **crosses** a rank boundary.

Because every comparable pair `x < y` has `rank(x) < rank(y)` (longest-path
layering is strict across the order), the two columns are separated by **at least
one boundary gap ≥ minColWidth**. Same-rank adjacent (necessarily incomparable)
columns are separated by `minFracWidth`. A fat rank bucket of `k` moments
occupies `(k-1)·minFracWidth + minColWidth` before the next bucket — so "a step
bucket with many moments is physically wider than a singleton" falls out for
free.

Crucially, `m.rank` stays the **column index** (as it already is after the Kahn
overwrite), so `xOf`, `barRect`, `momentAnchorPos`, the renderer, lane packing,
and all label sizing are **untouched**. Only two things change: how columns are
ordered/assigned, and how `colWidths` is floored.

## Changes

### 1. Replace the Kahn linear extension with a rank-sorted ordering
`timeline.ts`, the `momentStyle === "edges" && orientation === "horizontal"`
block (~282–300):

- Snapshot the longest-path ranks already in `rank` before overwriting:
  `const stepRank = new Map(rank)`.
- Build `order = [...displayed].sort((a, b) => stepRank(a) - stepRank(b) || a - b)`.
  This is a valid linear extension (comparable ⇒ different rank ⇒ ordered by
  rank; same rank ⇒ contiguous, tie-broken by token), and puts each rank's
  moments adjacent. Drop the Kahn loop entirely.
- Assign `rank.set(u, col)` for `col` = position in `order`; keep
  `maxRank = order.length - 1`.
- Record `const colStepRank: number[]` where `colStepRank[col] = stepRank(u)` —
  the original rank of the moment now living in column `col`.

`colStepRank` is only built in edges+horizontal mode; declare it `number[] | null`
(null elsewhere).

### 2. Per-gap floor in the colWidths pass
`timeline.ts`, the uniform floor loop (~430–432):

```ts
for (let r = 0; r < maxRank; r++) {
  const floor = colStepRank && colStepRank[r] === colStepRank[r + 1]
    ? opts.minFracWidth : opts.minColWidth;
  if (colWidths[r]! < floor) colWidths[r] = floor;
}
```

Gap `r` is between column `r` and `r+1`; `colStepRank` has length `maxRank+1`, so
both indices are in range. Spine/vertical mode (`colStepRank === null`) keeps the
uniform `minColWidth` floor exactly as today.

The fact-label and bar-label width contributions (added to `colWidths` *before*
this loop) are unaffected — they only raise a gap above its floor.

### 3. New option + default
Add `minFracWidth: number` to `TimelineOpts`; default it in `DEFAULT_OPTS` to
~**12** (must exceed the 6px dot diameter so same-rank dots don't overlap; well
below `minColWidth = 32`). No host-page UI toggle needed — it is a layout
constant, not a user mode.

### 4. Tests + docs
- Update `v2_timeline_layout.test.ts` ("edges variant assigns unique
  order-respecting columns and anchors"): assert (a) columns are still unique and
  order-respecting, (b) two same-rank incomparable moments are `minFracWidth`
  apart while a comparable pair is `≥ minColWidth` apart. The test already builds
  a layout and can read `colWidths` + `moments`.
- Update `ts/src/v2/overview.md`'s description of the edges variant (step vs.
  fractional columns instead of "linear extension, one full column each").

## Known interaction (call out; fix is optional)

The bar-label top-up (~442–450) adds missing width to `colWidths[rR-1]`, the
**last** gap in a bar's column span. If that gap is a *within-rank* gap, a wide
bar label will spread two same-rank moments far apart, locally breaking the
"incomparable = tight" look. A bar always spans `l < r` (comparable), so its span
contains **at least one boundary gap**; the clean fix is to top up the last
*boundary* gap in the span (`colStepRank[r] !== colStepRank[r+1]`) instead of the
last gap. Recommended but can land as a follow-up.

## Complexity

**Low–moderate.** No projector, renderer, lane-packing, or arrow-routing changes
— `m.rank` remains the column index, so the whole downstream pipeline is
untouched. The substantive edits are one ~15-line block swap (sort instead of
Kahn + record `colStepRank`), a 3-line floor change, one new option/default, and
test/overview updates. Main risks are off-by-one in the gap↔column indexing and
the bar-label/within-rank interaction above. No new files, so no further
`overview.md` additions beyond the variant description.

## Possible refinements (defer)
- Order within a rank bucket by lane/anchor rather than token to reduce arrow
  tangle (currently token order, deterministic but arbitrary).
- Boundary-gap bar-label top-up (above).
- Truly isolated moments (no order relation, fallback rank 0) cluster near `bot`;
  fine for now, revisit if it looks odd on real data.
