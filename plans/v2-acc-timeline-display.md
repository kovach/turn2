# Displaying `#acc` relations on the timeline

Follow-up to plans/v2-acc-relations.md (§10 listed timeline rendering as not
in that change). Display only: the engine, the stored rows, and the database
view are unchanged.

## Problem

The acc handler writes every acc relation's rows as point tuples `[m, m]` at
every resolved moment. A value that holds across ten moments is ten tuples,
and the timeline drew all ten, per row, as point bars. The picture was mostly
repetition, and it said nothing about which of those rows a rule ever looked
at.

## What is shown instead

1. **Merged bars.** Each distinct row content (the user terms; the trailing id
   names the moment) becomes bars over the moments it holds at, from where it
   starts to where it stops. `at me here` is one bar that ends where
   `at me there` begins.
2. **Read markers.** A dot on a bar at each moment where an ordinary rule read
   the relation. Reads are recorded whether or not a row matched, so a read
   that found nothing is still visible (in the inspector, as `read here` over
   `(no rows)`).
3. **Moment inspector.** Click a moment dot: the full acc state at that
   moment, every relation, diffed against the moment's immediate
   predecessors (`+` new, struck `−` gone).
4. **Per-relation toggles.** One checkbox per acc relation. Default: shown iff
   some ordinary rule reads it; relations only other acc rules read start
   hidden. The inspector ignores the toggles.

"Changed" and "used" are both shown and neither filters: a filter on use hides
exactly the row that would explain why a read did not fire.

## Merging in a partial order (acc-view.ts `accRuns`)

- Covers: Hasse covers of the asserted moment order, `bot` included (covering
  into every moment with no asserted predecessor), `top` excluded. Asserted
  edges are not reduced, so `u → v` is dropped when another asserted successor
  of `u` is strictly below `v`. The asserted order can be cyclic
  (moment-walk.ts); mutually reachable moments never drop each other's edges
  and the Kahn pass appends what a cycle strands.
- Chains: per content, walk a linear extension. A moment extends a chain whose
  last moment it covers; otherwise it starts a chain. A new chain whose moment
  has a predecessor holding the same content (a fork) starts its bar at that
  predecessor, so it does not read as "the value began here".
- Right end of a chain, by priority: a successor holding the content (it
  merged into another bar; closed), else the first resolved successor (the
  value ended; closed), else the first unresolved successor, else `top`
  (**open**: not computed past here — a pending choice, or the end of time).
- Limit, accepted: a bar runs through every column between its endpoints,
  including side-branch moments where the content does not hold. Episode bars
  have the same ambiguity against incomparable moments. The inspector is exact.

## Recording reads

- `Store.accRelations: Map<name, { readByRules }>`, seeded by `runFixpoint`
  from `expanded.accDecls`; `readByRules` iff some expanded ordinary rule has a
  `Match` on the head (static, so a rule that never fires still counts).
- `Store.accConsulted: Map<name, Set<momentTok>>`. `evalMatch`, before scanning
  candidates: if the head is an acc relation and the match's left endpoint is
  bound, record it. One map lookup per `Match` on programs with acc relations,
  a size check otherwise. Acc rules read through `AccMatch`, so only ordinary
  rules record.
- Neither field is read by evaluation.

## Timeline (timeline.ts)

- `layoutTimeline` skips acc rows (`isAccRow`) and adds a bar per `AccRun` of
  a visible relation (`TimelineOpts.accOverrides`). `Bar.acc` carries the
  relation, `open`, the displayed consulted moments, and the moment count.
- Bar endpoints and read moments join the displayed moment set. After a
  collapse, read moments strictly inside a collapsed interval are left out; an
  acc bar contained in a collapsed interval folds away like an episode.
- Lanes: acc bars are packed apart from episodes (`packAccBand`), in a band
  above them. Most run to `top`, and in the containment forest they adopted
  every later episode (`c` became a child of `crowded here`). Within the band
  each relation gets its own run of lanes and a bar takes the first lane free
  over its interval, so a key's successive values sit on one lane, like a
  track.
- Moment dots anchor on episode edges before acc bars (edges style).
- Drawing: square corners and a tint (`tl-bar-acc`); an open bar's later edge
  dashed via a `stroke-dasharray` that walks the rect outline; read markers
  (`tl-acc-read`) on the bar's outer corner at the moment's column; a
  transparent hit disc with `data-tl-moment` over every moment dot;
  `opts.selectedMoment` draws a ring.
- Point bars remain supported for any other tuple stored at `[m, m]`.

## Host (render-output.ts, web-v2.ts)

- `renderTimelineH` opts: `accOverrides`, `accControls`, `inspectKey`. With
  `accControls` and at least one acc relation it renders the toggle strip, the
  SVG, and (when `inspectKey` resolves) the inspector. Off by default, so pres
  embeds get the bare timeline (with merged bars).
- `momentKey(store, tok)`: `atomFingerprint` of the moment term, so the
  inspected moment survives re-evaluation, like collapse keys.
- web-v2 owns `accOverrides` (by relation name; only touched relations have an
  entry) and `inspectKey`, both in-memory. Click a moment dot or read marker to
  open, click it again or `×` to close.

## Tests

`ts/src/tests/v2_acc_view.test.ts`: merging (one bar per stretch, closed end
where a value is superseded, open to `top`), every row in exactly one bar,
reads recorded matched or not, lane bands and tracks in all three lane modes,
dot anchoring, overrides, static default, snapshot diffs, `momentKey` across an
edit, open end behind a pending choice, fork/join on a hand-built diamond with
a non-cover edge, and an SVG smoke test over a stub DOM.
`v2_timeline_layout.test.ts`: the point-bar fixture is now built by hand.

## Not in this change

- Source spans on acc rows. `#acc` declarations carry a line-only span, which
  `spanKey` rejects, so acc bars still link nowhere. Needs column spans on
  commands, or the contributing `/` rule's head span threaded through
  `AccContribute`.
- The database view still lists every point row.
- Vertical orientation draws the bars and markers but was not tuned.
- Engine-side compression (compute acc rows on demand): a semantics change,
  see plans/v2-acc-relations.md §10.

plan author: Claude Fable 5.1 (claude-fable-5-1), 2026-09-20
