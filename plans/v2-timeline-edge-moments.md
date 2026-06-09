# Timeline variant: edge-anchored moments with pairwise arrows

## Motivation

The current horizontal timeline (`ts/src/v2/timeline.ts`) places every moment
on a single spine at `y = spineY`, with `x` determined by longest-path rank.
Two problems follow:

1. **Rank collapse.** Incomparable moments frequently land on the same rank
   and are drawn as a single visual position on the spine, so distinct
   moments become indistinguishable.
2. **Order information is lossy.** Only Hasse-cover arrows are drawn, and
   they all run along the spine, so an arrow between two collapsed columns
   is invisible (zero length) or ambiguous (which of the co-ranked moments
   does it touch?).

This variant fixes both by moving moment dots off the spine and onto the
**left and right edges of the interval bars** that reference them, and by
drawing arrows **between pairs of moments** directly, dot to dot. Since dots
inherit their bar's lane (y), two moments that share a rank (x) still render
at distinct positions, and the arrows carry the full ordering information
that rank collapse currently hides.

## Design

### Option plumbing

Add a field to `TimelineOpts`:

```ts
momentStyle: "spine" | "edges";   // default "spine" (current behavior)
```

`"edges"` is initially horizontal-only; `makeProjector` throws (or falls back
to spine) for `orientation: "vertical"` + `"edges"` until there's a need.
`render-output.ts`'s `renderTimelineH` grows a pass-through option so the
host page can toggle the variant.

### Column assignment (replaces rank for x)

In edges mode, x-position comes from a **linear extension** of the displayed
moment poset rather than longest-path ranks: a topological order over the
Hasse `succ` graph (Kahn's algorithm, which the rank pass already runs),
tie-breaking incomparable moments deterministically by token order. `bot` is
column 0; `top` is the last column. Each moment gets a unique column index,
so no two moments ever share an x.

Mechanically: compute `col: Map<number /*tok*/, number>` and reuse the
existing per-step width machinery keyed by column instead of rank — fact
widths land in `colWidths[col(lTok)]`, and the bar pass enforces
`sum(colWidths[col(lTok)..col(rTok)-1]) >= label + pad`. Rank mode is the
degenerate case where `col = rank`, so this can be a parameter of the
existing sizing pass rather than a copy. Lane packing already orders by the
moment partial order (`leqTok`), not ranks, so it is unaffected; only its
rank-based tiebreaks need the column substituted.

### Layout changes (`layoutTimeline`)

Keep everything that exists — lane packing, colWidths (re-keyed per above),
facts, sidebar — and add new outputs to `TimelineLayout`:

```ts
// Canonical anchor per displayed moment: the (bar, side) edge its dot sits
// on, or null for spine placement (fact-only moments, bot, top).
momentAnchor: Map<number, { barIndex: number; side: "l" | "r" } | null>;
// Dashed vertical ties: the non-canonical bar edges sharing a moment.
momentTies: { tok: number; barIndex: number; side: "l" | "r" }[];
// Hasse cover pairs to draw as arrows, minus bar-implied pairs.
orderPairs: { from: number; to: number }[];
```

- `momentAnchor` / `momentTies` are derived from `bars`: each bar contributes
  an `l` and an `r` edge occurrence; per moment, the canonical one becomes
  the anchor and the rest become ties. Moments that appear on **no** bar
  (fact-only moments, `bot`, `top`) get a `null` anchor and keep their spine
  dot as today; arrows touch them at the spine position.
- `orderPairs` is the **Hasse cover relation** (decided) — the existing
  `edges` array already holds it, so no new computation is needed; the field
  exists only to subtract bar-implied pairs (below). A pair is **suppressed**
  when it is exactly some bar's own (lTok, rTok) endpoints — the bar itself
  shows that ordering (decided).

### Anchor selection (decided: one canonical dot per moment)

A moment can be an endpoint of several bars:

- Draw **one canonical dot per moment**, on an arbitrarily chosen (bar,
  side) occurrence — arbitrary but deterministic: lowest `tupleIndex`,
  tie-broken by side (`l` before `r`). Moments on no bar (fact-only, `bot`,
  `top`) keep their spine dot.
- For the **other** bars sharing that moment, draw a thin dashed vertical
  "tie" line from that bar's edge to the canonical dot (both sit at
  `xOf(col(tok))`, so ties are vertical segments).
- Arrows anchor at the canonical dots only — one arrow per cover pair.

### Arrow rendering

- Interval-aware per pair (decided): a straight dot-to-dot line when it
  clears every bar; otherwise an orthogonal detour along a horizontal
  corridor — just above all obstructing bars, or through the gap between
  the lane area and the spine — picking the corridor whose segments cross
  the fewest bars. Verticals run at the endpoint columns, i.e. along bar
  edges, which the grazing-tolerant Liang-Barsky test doesn't count as
  overlap. Same `#666` stroke and the existing `tl-arrow` marker.
- Bar-implied pairs are suppressed entirely (decided), so the arrow count is
  |Hasse covers| − |bars|, which stays modest; verify readability on
  `ts/data/v2/dominion.t`.

### Projector additions

```ts
// Dot position for a (bar, side) anchor: bar edge midpoint.
momentAnchorPos(colL: number, colR: number, lane: number, side: "l" | "r"): { x: number; y: number };
// Curved arrow path between two anchor points.
pairArrowPath(a: { x: number; y: number }, b: { x: number; y: number }): string; // SVG path d
```

Horizontal-edges values: `x = xOf(column of that side)`, `y = ` vertical
center of the bar's edge (`spineY - (lane+1)*laneHeight - barInset + barH/2`).
All projector positions in edges mode (bars, labels, fact stubs, end ticks)
take column indices where spine mode takes ranks.

### Renderer changes (`renderTimeline`)

When `momentStyle === "edges"`:
- Skip spine Hasse `<line>`s; instead emit one `<path>` per `orderPairs`
  entry with `marker-end`, anchored at the two canonical dots.
- Emit one dot per moment at its canonical anchor (same `<circle>`+`<title>`
  treatment as today; title shows the moment term).
- Emit one dashed vertical tie `<line>` per `momentTies` entry.
- Everything else (bars, labels, facts, sidebar, wheel scroll) unchanged.

### ASCII renderer

Unchanged — it only shows bars/lanes.

## Implementation steps

1. `TimelineOpts.momentStyle` + defaults; thread through `render-output.ts`.
2. Layout: linear-extension column assignment; build `momentAnchor`,
   `momentTies`, and `orderPairs`; unit-style driver under `ts/src/` (NOT
   /tmp) to eyeball counts on dominion data.
3. Projector: `momentAnchorPos` + `pairArrowPath` for horizontal.
4. Renderer: edges-mode branch (canonical dots, ties, pair arrows).
5. Toggle in the host page UI next to the existing orientation/lane controls.
6. Run `./run-tests.sh`; visually verify on dominion via the app.
7. Update `ts/src/v2/overview.md` to describe the new variant (and any new
   files this adds, e.g. the driver/test module).

## Decisions

1. **Arrows**: Hasse covers only (not the transitive closure).
2. **Bar-implied pairs**: suppressed — no arrow when a pair is exactly a
   bar's own (l, r) endpoints.
3. **Routing**: interval-aware — straight dot-to-dot lines when clear,
   orthogonal corridor detours around bars otherwise. (Iterated: Bézier
   dip → plain straight lines → interval-aware.)
4. **Scope**: horizontal orientation only.
5. **Columns**: each distinct moment gets its own horizontal position — a
   linear extension of the moment order replaces rank-based x in this
   variant, so no two moments ever share an x.
6. **Dots**: one canonical dot per moment, placed on an arbitrarily chosen
   bar edge; other bars sharing the moment connect to it with dashed
   vertical tie lines. Arrows anchor at canonical dots only.

No open questions remain.
