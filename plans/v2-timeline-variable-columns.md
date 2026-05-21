# v2 timeline — variable column widths (horizontal mode)

Goal: in `renderTimeline` (horizontal orientation) replace the fixed
`colWidth` with per-rank-step widths so that columns shrink where there
is little text and grow where labels demand more room.

## Scope

- Affects `ts/src/v2/timeline.ts` only.
- Horizontal mode only. Vertical mode keeps its current vertical-step
  sizing (already adaptive via `maxStartGroupSize`).
- Measurement uses canvas `measureText` (option 1 from the chat). No
  DOM-attachment two-pass; `layoutTimeline` stays pure-ish (it gains a
  dependency on a measurer callback rather than the DOM directly).

## Design

### Measurer

Add a small module-level helper:

```ts
type Measurer = (text: string, fontPx: number) => number;

const FONT_FAMILY = "monospace";
const BAR_LABEL_PX = 11;
const FACT_LABEL_PX = 11;
const END_TICK_PX = 10;

let _ctx: CanvasRenderingContext2D | null = null;
function defaultMeasurer(text: string, fontPx: number): number {
  if (_ctx === null) _ctx = document.createElement("canvas").getContext("2d")!;
  _ctx.font = `${fontPx}px ${FONT_FAMILY}`;
  return _ctx.measureText(text).width;
}
```

The renderer's `<text>` attributes must use the same `font-size` /
`font-family` constants so measurement matches what's drawn. Factor
those into the constants above and reference them from both the
measurer and the SVG attribute calls.

For testability, `layoutTimeline` accepts an optional `measure?:
Measurer` parameter; production callers pass nothing (uses the canvas
default), tests can inject a deterministic stub (e.g. `len * 6.5`).

### Per-step width computation

After bars/facts are classified (current end of `layoutTimeline`), but
before the projector is built, compute an array `colWidths[0..maxRank-1]`
where `colWidths[r]` is the width of the step from rank `r` to `r+1`.

For each rank step `r`:

- **Bar contribution**: for every bar with `lRank <= r < rRank`, the bar
  spans this step. A bar's label is left-anchored at its starting rank,
  so it consumes width starting from `xOf(lRank)`. The constraint is
  that the **cumulative** width from `lRank` to `rRank` must be at
  least `labelWidth + 2*labelPadX`. We capture this by tracking per-bar
  required cumulative widths and distributing later (see "Solver").
- **Fact contribution**: for every fact at rank `r`, its label is
  left-anchored at `xOf(r) + 4` and must not overflow into `xOf(r+1)`.
  So `colWidths[r] >= factLabelPadX + measure(label) + factLabelPadRight`.
- **End-tick contribution**: for the steps adjacent to `bot` (rank 0)
  and `top` (rank `maxRank`), reserve half of `measure("bot")` /
  `measure("top")` on each side so the centered tick label fits.
- **Floor**: `MIN_COL_WIDTH` (e.g. 32px) so empty stretches don't
  collapse to zero and Hasse arrows remain visible.
- **Ceiling**: none for now; if a single label is enormous, the column
  grows. Revisit if it becomes a problem (truncation is already applied
  via `barLabelMaxLen`).

### Solver (bar cumulative constraints)

A bar from `lRank` to `rRank` with required width `W` imposes:

    sum(colWidths[lRank..rRank-1]) >= W

Greedy two-pass approach:

1. First pass: handle "local" constraints (facts, end ticks,
   single-step bars) directly. Each contributes only to one
   `colWidths[r]`. Take per-step max.
2. Second pass: walk multi-step bars in increasing `(rRank - lRank)`
   order. For each, compute current cumulative sum across its span; if
   short by `delta`, distribute `delta` evenly across the bar's steps
   (or just add to the last step — simpler and still correct, since
   we're only enforcing a sum lower bound). Pick "add to last step" for
   simplicity; revisit if it produces visibly skewed layouts.

This is O(bars · maxSpan) worst-case but in practice tiny.

### Projector wiring

Change horizontal `xOf` from `margin + rank * colWidth` to a prefix sum
of `colWidths`:

```ts
const xs: number[] = [margin];
for (let r = 0; r < layout.maxRank; r++) xs.push(xs[r]! + layout.colWidths[r]!);
const xOf = (rank: number) => xs[rank]!;
const width = xs[layout.maxRank]! + margin;
```

The projector needs access to `colWidths`, so:

- Add `colWidths: number[]` to `TimelineLayout` (length `maxRank`,
  empty `[]` for vertical mode for now).
- `makeProjector` for horizontal reads `layout.colWidths`.
- `opts.colWidth` becomes a *default/fallback minimum*, kept for back
  compat as `MIN_COL_WIDTH`'s default value; or rename to
  `minColWidth`. Pick the rename — `colWidth` no longer accurately
  describes what it does.

## Step-by-step

1. Add `FONT_FAMILY` / `*_PX` constants and `defaultMeasurer` at top of
   `timeline.ts`. Replace the inline `font-size`/`font-family`
   attribute strings in `renderTimeline` with these constants.
2. Add `measure?: Measurer` to `layoutTimeline` signature; default to
   `defaultMeasurer`.
3. Rename `colWidth` → `minColWidth` in `TimelineOpts` (and
   `DEFAULT_OPTS`); update existing callers (search for `colWidth`).
4. Extend `TimelineLayout` with `colWidths: number[]`.
5. Implement the two-pass solver inside `layoutTimeline` (horizontal
   only — vertical sets `colWidths = []`).
6. Update horizontal branch of `makeProjector` to use the prefix sum.
   Vertical branch unchanged.
7. Smoke-test in browser with a couple of real `.t` programs that
   have (a) long bar labels on short spans, (b) long fact label
   stacks, (c) lots of empty cover edges in a row.

## Out of scope

- Vertical mode adaptive widths.
- Truncating labels to fit a max column width (existing
  `barLabelMaxLen` continues to govern that).
- Word-wrapping fact labels.
- Two-pass DOM measurement (kept simple — single canvas measurer).

## Tradeoffs

- Layout now depends on the runtime canvas (browser-only). Existing
  layout was already browser-bound at render time; only the *layout*
  becomes browser-bound too. Tests inject a stub measurer.
- Bar arrows along the spine traverse uneven gaps. Acceptable — the
  rank order is preserved visually, which is what matters.
- A single multi-rank bar with a long label only widens one step (its
  last), which can look slightly off-center. If this is visible in
  practice, switch the distribution to "spread evenly" in the solver.
