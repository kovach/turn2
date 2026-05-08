# v2 timeline: horizontal + vertical layout

Generalize `ts/src/v2/timeline.ts` so the same store renders in either of
two layout strategies.

- **horizontal** (current): time → x, increasing rightward. Episode bars
  stack upward from a horizontal spine; fact lines are vertical and labels
  drop below the spine. Wheel-scroll is mapped to horizontal scroll
  (existing behavior).
- **vertical** (new): time → y, increasing downward. Episode bars stack
  to the right of a vertical spine — outer episodes (lane 0) closest to
  the spine, inner/nested ones further right ("nesting shown left to
  right"). Fact lines are horizontal: drawn from the moment on the spine
  across the bar area, with the label past the rightmost lane. Wheel
  scroll is unmodified (default vertical scroll is what we want).

## Refactor

- `TimelineOpts` gains `orientation: "horizontal" | "vertical"`. Default
  horizontal so existing callers don't change.
- `layoutTimeline` stays orientation-agnostic in its core: it produces
  `timeRank` for moments, `lane` for bars, `row` for facts (already does
  this). Drop the precomputed `MomentNode.x` field; the projector owns
  pixel placement.
- A new internal `Projector` interface owns the (timeRank, cross) →
  (x, y) mapping plus dimensions and shape primitives:
  - `momentPos(rank): {x, y}`
  - `barRect(rank_l, rank_r, lane): {x, y, w, h}`
  - `factLine(rank, rowCountAtMoment): {x1, y1, x2, y2}`
  - `factLabelPos(rank, row): {x, y, anchor}`
  - `botTopLabelPos(rank, which): {x, y, anchor}`
  - `width`, `height`, `spineCoord` for the spine line if we draw one
- Two implementations: `HorizontalProjector`, `VerticalProjector`.
- `renderTimeline` selects a projector then walks the same layout output
  in either case.

## UI

- Add an orientation toggle in the timeline tab — a button labeled
  "Horizontal" / "Vertical" sitting above `#timeline-main` (or in the
  tab strip area). Click flips and persists in `sessionStorage` (key
  `v2-timeline-orientation`).
- Wheel→horizontal-scroll handler is gated on the active orientation:
  active in horizontal mode, off in vertical mode.

## Notes / minor decisions

- Bar labels stay horizontal in both modes (rotated text is hard to
  read). For vertical mode this means a long bar gets a single label
  near its top; the label may visually sit outside the bar if the bar
  is short — in that case truncate harder via `barLabelMaxLen`.
- Fact lines in vertical mode extend across all bar lanes plus a small
  gap before the label. This intentionally crosses any bars whose
  `[time_l, time_r]` covers the fact's moment — it visually
  communicates which bars overlap that moment, similar to how the
  horizontal mode's fact line drops below the spine and doesn't
  intersect bars (since bars sit above).
- `bot`/`top` ticks: in horizontal, labels go below; in vertical, label
  for `bot` above, `top` below.
- We could allow per-axis `colWidth`/`rowHeight`, but starting simple:
  `colWidth` is reused as both column width (horizontal) and row
  height (vertical). Tunable later if the visual density differs in
  practice.

## Step plan

1. This plan file.
2. Refactor `timeline.ts`: introduce `Projector`, drop `MomentNode.x`,
   parameterize all rendering through the projector.
3. Add toggle button + handler in `index-v2.html` / `web-v2.ts`.
   Persist in sessionStorage. Re-render on toggle. Disable
   wheel→hscroll in vertical mode.
