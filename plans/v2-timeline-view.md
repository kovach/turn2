# v2 timeline view

A new visualization of a v2 fixpoint store that lays out moments left-to-right
according to the moment partial order, draws each `~` episode as a labeled
horizontal bar between its two endpoint moments, draws each `+` fact as a
vertical line at its left endpoint with the tuple text below, and connects
moments by Hasse-edge arrows.

## Goals
- Make the temporal structure of a run visible at a glance: nesting,
  sequencing, and which facts attach where.
- Reuse moment identity: the same hashconsed moment term always maps to the
  same x-coordinate, so a `^` tuple bound to existing endpoints visibly aligns
  with those endpoints (no extra work — falls out of the layout).
- Run from store data only (no eval-time hooks). The store already carries
  `tuples`, `orderFwd` (forward edges of the moment order), and `bot`/`top`.

## Inputs
- `Store` from `ts/src/v2/store.ts` (post-`runFixpoint`).
- A few display options: width budget, lane height, whether to hide
  internal heads (`choose`, `constrain`, `do-agg`, `agg-result`, names
  starting with `_`).

## Where it lives
- New module `ts/src/v2/timeline.ts` that exports
  `renderTimeline(store, opts): { main: SVGSVGElement; sidebar: HTMLElement }`.
  `main` is the timeline SVG; `sidebar` is the secondary tuple area
  (see "Sidebar" below).
- Surfaced as a **separate tab** in `index-v2.html`, not a pane in the
  existing right column. The page grows a tab strip in the header
  (next to the file name): two tabs — "Editor" (the current
  editor/display/db/info workspace) and "Timeline". Selecting a tab
  toggles which top-level container is visible; the inactive one is
  hidden via `display: none` (state preserved, no re-mount). The
  Timeline tab uses the full page area below the header.
- Re-rendered at the end of `run()`, alongside `renderDatabase`. Cheap
  enough to recompute every run; if it becomes a hotspot we can gate
  on tab visibility.
- Pure DOM/SVG output; no React, no extra deps. Same styling
  conventions as the existing panes (palette already defined in the
  `<style>` block).

## Page layout

```
┌─ header ─────────────────────────────────────────────────────────┐
│ SLIDE V2   file ·   [Editor] [Timeline]              status      │
├──────────────────────────────────────────────────────────────────┤
│  <#editor-tab>  ── existing workspace (editor | display/db/info) │
│  <#timeline-tab> ── timeline view (hidden when not active)       │
│    ┌─ main ────────────────────────────────┬─ sidebar ────────┐  │
│    │ <svg> moments + bars + facts          │ is / ! tuples    │  │
│    │                                       │                  │  │
│    └───────────────────────────────────────┴──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

Tab strip: two `<button>`s with an `aria-pressed`/`active` class
indicating selection. Default tab is Editor. Selection persists in
`sessionStorage` so reloads keep the user's view.

## Data model

Three derived structures, all keyed by hashcons token (`tokenOf(store, term)`):

1. **Moments**: every distinct endpoint that appears in any tuple, plus
   `bot` and `top`. From `store.tuples` walk `t.l` and `t.r`; intern via
   `tokenOf`. Keep a map `tok -> Term` for rendering.
2. **Order edges**: `store.orderFwd` already holds the explicit edges
   added by eval. Treat this as the cover relation candidate set; we
   compute the *transitive reduction* over the subset of moments that
   appear as endpoints (Hasse diagram). Bot/top edges are implicit per
   `addOrder`'s contract — synthesize edges `bot -> m` for every minimal
   moment and `m -> top` for every maximal moment in the displayed set,
   so the diagram is connected.
3. **Tuples**: classified by marker shape:
   - **episode** (bar): `r !== top` (treat any tuple with a finite right
     endpoint as a bar — covers `~`, `^`-into-bar, `!` outputs, and
     anything else with two real moments).
   - **fact** (vertical-line + label): `r === top` (covers `+` and any
     `^` whose anchor right was top).
   - **sidebar tuples**: `is` rows and `!` outputs are pulled out of
     the main viz and listed in the secondary sidebar area instead
     (see "Sidebar" below). They do not get bars or vertical lines in
     the main SVG.
   - **internal** (`choose`/`constrain`/`do-agg`/`agg-result`,
     `_`-heads): hide by default; show when "internal" toggle is on.
     Same toggle semantics as the existing `#hide-internal` checkbox
     (consider sharing it).

   We don't have access to the original `marker` post-eval; the
   classification is recovered from interval shape, which matches the
   marker semantics in `eval.ts:153`-onward (`fact` => `r = top`,
   `episode` => fresh `(l,r)` strictly inside anchor).

## Layout algorithm

### x-axis: layered topological order

Goal: a stable left-to-right placement that respects the partial order
and groups equivalent moments at the same x.

1. Build `succ` from `store.orderFwd` restricted to displayed moments,
   plus the bot/top synthesis above.
2. Compute longest-path layering:
   `rank(bot) = 0`, `rank(m) = 1 + max rank(predecessors(m))`,
   `rank(top) = 1 + max rank(everything-else)`.
3. Within a rank, sort by hashcons token id (stable, deterministic).
4. Map rank -> x via `x = leftPad + rank * colWidth`.

Ties (incomparable moments) end up at the same column. That's fine
because the Hasse arrows only connect across ranks, and bars/lines
attach to specific moment x's. Within-column collisions on bars are
handled by lane assignment (below).

### Hasse reduction

From `succ`, compute the transitive reduction:
- For each edge `(u,v)` in `succ`, drop it iff there's an alternative
  path `u -> w -> ... -> v` of length ≥ 2.
- For graphs of the size produced by realistic v2 runs (typically <1k
  moments) the naive `O(V*E)` BFS-per-edge is fine. Cache reachability
  per source node during the pass.

Render each surviving edge as an arrow from `(x[u], y[u])` to
`(x[v], y[v])`, where `y[u]` is the moment's "spine" y (mid-canvas).
Use SVG `<marker>` for the arrowhead.

### y-axis: lanes for episode bars

Each episode bar occupies `[x[l], x[r]]`. Pack bars into lanes
(horizontal rows) so no two bars in the same lane overlap in x:

1. Sort bars by `(x[l], x[r])`.
2. Greedy lane assignment: place each bar in the lowest-numbered lane
   whose last-placed bar ends at an x ≤ this bar's start.
3. Above the moment spine, lay out lanes upward; below the spine, lay
   out fact-label columns downward.

Bar y = `spineY - laneIdx*laneH - laneH/2`. Bar drawn as a rounded
rectangle from `x[l]` to `x[r]` with the head sym + first few args as
the label (truncate with ellipsis to fit). Tooltip (SVG `<title>`)
carries the full rendered atom (use `renderTermShallow`).

### Facts: vertical lines + labels

For each fact tuple, draw a 1-px vertical line at `x[l]` from a few
pixels above the spine down to a label band. Stack labels for facts
sharing the same `l` vertically, top-down by hashcons token order.
Label = `renderAtomShallow(store, tup.atom)`. Same hide-internal rule
applies.

### Moment dots

Optional: small circle at each `(x[m], spineY)` to anchor incoming
arrows visually. Skip for `bot`/`top` if they were synthesized and
don't appear in any tuple — render them as left/right edge ticks
labeled "bot"/"top".

## Sidebar (secondary area)

Right-edge column (`flex: 0 0 280px`) inside the Timeline tab,
scrollable, listing tuples that are pulled out of the main viz:

- **`is` rows** (choice resolutions): grouped under an "is" heading.
  One line per row, formatted as `<choice-id> ↦ <value>` using
  `renderTermShallow`. Sorted by hashcons token of the choice-id.
- **`!` outputs** (external tuples): grouped under an "outputs"
  heading. One line per row, formatted as `renderAtomShallow(atom)`,
  with the interval shown next to it as `[l, r]` using the same
  `renderEndpoint` shorthand the DB pane uses. Sorted by `l` token.

Headings only render when their group is non-empty. Future hover/link
behavior (e.g., highlight the corresponding moment in the main SVG)
is out of scope but the renderer should keep `tok -> SVGElement`
registries in shared state so it can be wired without restructuring.

The sidebar is part of the `renderTimeline` output (the `sidebar`
field) so layout and tuple classification happen in one place.

This fixed allowance ("for now: `is` and `!`") is meant to grow:
later we may add `choose`/`constrain` debug surfaces or
`do-agg`/`agg-result` traces. The sidebar API should accept an
extensible `Section[]` shape rather than hardcoding two lists.

## Rendering

- One `<svg>` element sized to fit (`viewBox` with computed width/height).
- Layer order (z): order edges → moment dots → episode bars → fact
  vertical lines → fact labels → episode labels (so labels sit on top).
- Color palette reuses the DB pane CSS classes:
  - episode bar fill: `#264f78` with `#4fc1ff` border (matches `.head`)
  - fact line + label: `#c8c8c8`
  - hasse arrow: `#666` (matches `.interval`)
  - bot/top tick: `#888`
- Pan/zoom: out of scope for v1. If the SVG overflows, the parent pane
  scrolls (it already has `overflow: auto`).

## Hover / click (future)

Out of scope for the first cut, but the layout module should keep a
side table `{ tupleIndex -> SVGElement }` so a follow-up can wire
hover-to-highlight-related-tuples without restructuring.

## Step plan

1. Add `ts/src/v2/timeline.ts` exporting `renderTimeline(store, opts):
   { main: SVGSVGElement; sidebar: HTMLElement }` plus a small
   `interface TimelineOpts`. Keep all layout helpers (rank assignment,
   transitive reduction, lane packing, tuple classification) as
   un-exported pure functions so they can be unit-tested. Split the
   pure layout step (returning a plain data structure) from SVG/DOM
   construction so tests don't need a DOM.
2. Add a tab strip to `index-v2.html` with two tabs ("Editor",
   "Timeline"), two top-level containers (`#editor-tab`,
   `#timeline-tab`), and CSS for both plus the timeline tab's
   main/sidebar split. Tab selection persists in `sessionStorage`.
3. Wire into `web-v2.ts:run()` after `renderDatabase`: render the
   timeline into `#timeline-tab` (main SVG + sidebar). Honor the
   existing hide-internal toggle.
4. Smoke test against `ts/data/v2/ttt.t` in the editor: confirm the
   `~ turn`, `~ move`, etc. episodes show as nested bars; the cell
   facts appear as a row of vertical lines with labels; choice options
   render as a fact at their `is` resolution moment.
5. Add a single unit test in `ts/src/tests/v2_timeline.test.ts` that
   constructs a small store by hand (a couple of episodes + a fact +
   a few order edges) and asserts the layout function produces
   expected ranks, lane assignments, and Hasse-reduced edges. Don't
   test the SVG output — just the layout data structure (split it out
   from the rendering call so it's testable).

## Ambiguities / open questions

- **`!` outputs and `is` rows in sidebar**: pulled into the sidebar
  regardless of the hide-internal toggle. If the user wants them ALSO
  drawable in the main SVG (e.g., to see when in time an output was
  emitted), the right pattern is probably a "show in timeline too"
  toggle per sidebar group — out of scope for v1.
- **Bar labels for long heads**: how to truncate? Defaulting to "head
  arg1 arg2…" with an ellipsis when over ~24 chars; tooltip has the
  full atom. Tunable via `opts`.
- **Multiple facts at the same moment**: stacking them downward works
  for a handful, but a moment with dozens of facts will overflow.
  Cap at N (say 8) with a "+k more" line; full list still in DB pane.
- **Moments that aren't tuple endpoints**: `store.orderFwd` may carry
  edges between moments that no tuple uses (unlikely given how
  `addOrder` is called by eval, but possible). The plan filters to
  endpoint moments; alternate is to include any moment mentioned in
  `orderFwd`. I picked "endpoints only" for simplicity — flag if the
  user wants the larger view.
- **Wide partial orders**: when many moments are mutually incomparable
  at the same rank, longest-path layering compresses them into one
  column. Bars between them collapse to zero width. Worth testing on
  ttt to see if this is a problem in practice; may want a secondary
  rule to spread them out (e.g., assign distinct sub-x within a rank
  by lane parity). Deferred until we see it in the wild.
- **Sidebar growth**: starting with `is` + `!` only. Adding more
  groups later is just another `Section` in the sidebar's input list,
  but if the set of pulled-out heads grows large we should reconsider
  whether it should remain a fixed allowlist or become a "show in
  sidebar" property of the classification step.
