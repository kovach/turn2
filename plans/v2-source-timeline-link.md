# linking program to timeline view

Goal: extend the bidirectional source-line ↔ output linking (today: db view
only, editor page only) to the timeline view, on both the v2 editor page and
presentation-mode code blocks, via a shared abstraction. Also fix the
gutter-highlight alignment bug.

## Current state

- Tuple provenance already exists: `store.tupleSource[i]: Span | undefined`
  (`ts/src/v2/store.ts:30`), filled at `addTuple` time and propagated through
  the scheduler/aggregates.
- The db renderer stamps `data-source-line` on each row
  (`ts/src/v2/render-output.ts:69`). All linking behavior lives inline in
  `ts/src/web-v2.ts:428-533`:
  - forward: caret line in the textarea → `.source-highlight` on matching db
    rows (only lines in `positiveLines`, i.e. lines with an emitting atom)
  - reverse: hover on a db row → overlay highlight on the source line +
    `.hover-highlight` on sibling rows; click → caret to end of that line,
    centered
- The timeline renderer (`renderTimeline` in `ts/src/v2/timeline.ts`) draws
  bar rects / fact labels from `Bar.tupleIndex` / `Fact.tupleIndex` but emits
  no provenance attributes and has no pointer handlers.
- Presentation mode (`ts/src/pres/render.ts`) renders the same
  `renderTuples`/`renderTimelineH` per code block (so db rows there already
  carry `data-source-line`) but has no linking logic at all.
- The two pages duplicate the parse → `runFixpoint` → render-into-hosts loop;
  full unification of that loop is out of scope here. The shared abstraction
  below covers the linking concern: one live program = one source editor +
  its last successful execution (store, rules) + N output widgets.

## Alignment bug (fix first — the new code builds on it)

`web-v2.ts` inserts `.source-line-highlight` into `.editors .pane`
(position: relative) and positions it with `sourceEl.offsetTop`. But
`new Editor({ existing: sourceEl })` later re-parents the textarea into
`.editor-wrap`, which is itself `position: relative`
(`ts/styles/editor.css:15`). So `offsetTop` is now relative to
`.editor-wrap` while the overlay lives in `.pane` — the highlight sits too
high by the pane-label height, and the overlay also spans the gutter.

Fix by moving line-highlight ownership into `Editor` (step 1), where the
overlay is a child of `.editor-wrap` and vertical placement can be read
directly off the gutter row elements — exact alignment by construction.

## Step 1 — `Editor` line-highlight/focus API (`ts/src/v2/editor.ts`)

Add to the `Editor` class:

- a lazily created overlay div (class `editor-line-highlight`) appended to
  `this.wrap`, `position: absolute; pointer-events: none; display: none`.
- `highlightLine(line: number): void` — show the overlay at the line.
  Vertical: `gutterEl.children[line-1]` gives `offsetTop`/`offsetHeight`
  relative to the gutter; overlay top = that offsetTop − `ta.scrollTop` +
  gutter's offsetTop. Horizontal: `left: 0; right: 0` (highlighting the
  gutter number too is desirable). Clamp/hide when the line is scrolled out
  or beyond the line count.
- `clearHighlight(): void`.
- `focusLine(line: number): void` — port `focusSourceLine` from web-v2.ts:
  caret to end of line, center via scrollTop, re-show highlight after the
  scroll, works when `readOnly` (frozen pres editors still allow selection).
- `caretLine(): number` — line of `selectionStart` (used by the linker's
  forward direction and by web-v2's `L:C` label).
- scroll handler: reposition (or hide) the overlay on textarea scroll
  instead of web-v2's current "clear on scroll".

Move the `.editor-line-highlight` base rule into `ts/styles/editor.css`
(background stays host-themable via a `--editor-line-highlight-bg` variable;
default the current `rgba(59,130,246,0.25)`).

Delete the old overlay code from web-v2.ts in step 4; index-v2.html's
`.source-line-highlight` rule is replaced by the shared one.

## Step 2 — provenance attributes in the timeline renderer (`ts/src/v2/timeline.ts`)

In `renderTimeline`:

- Bars: on each bar `rect` (and its label `text`), set
  `data-source-line` from `store.tupleSource[b.tupleIndex]?.line` when
  defined. SVG elements accept `data-*` and `Element.closest` works, so the
  delegated handlers in step 3 need no special casing.
- Facts: same on each fact label `text` via `f.tupleIndex`.
- Sidebar: `SidebarSection.rows` currently keeps only `{label, full}`; add
  `line?: number` (from the tuple's `tupleSource`) and stamp
  `data-source-line` on the sidebar row divs.
- Add class `tl-bar` on bar rects so CSS can target highlight states.

Keep `layoutTimeline` and `renderTimelineAscii` output unchanged (Bar/Fact
already expose `tupleIndex`; only the sidebar struct grows a field).

CSS (index-v2.html + index-pres.html or a shared block):

```
.timeline-svg [data-source-line] { cursor: pointer; }
.timeline-svg .tl-bar.source-highlight { stroke: #3b82f6; stroke-width: 2.5; }
.timeline-svg .tl-bar.hover-highlight  { stroke: #a855f7; stroke-width: 2.5; }
.timeline-svg text.source-highlight,
.timeline-svg text.hover-highlight { fill: #a855f7; }
.timeline-sidebar-row.source-highlight { background: rgba(59,130,246,.30); }
.timeline-sidebar-row.hover-highlight  { background: rgba(168,85,247,.30); }
```

(`renderTimelineH` drops the sidebar today — `host.replaceChildren(out.main)`
— leave that as is; sidebar stamping is inert until a host shows it.)

## Step 3 — shared linker: new file `ts/src/v2/source-link.ts`

```ts
export interface SourceLink {
  // Re-arm after a successful run: rules drive positiveLines; outputs have
  // been re-rendered so highlights are re-applied from the current caret.
  update(rules: Rule[]): void;
  // Forward direction; call on caret movement. No-op if line unchanged.
  setCaretLine(line: number | null): void;
  destroy(): void;
}

export function attachSourceLink(
  editor: Editor,
  outputs: HTMLElement[],   // e.g. [dbEl, timelineInlineEl]
): SourceLink;
```

Behavior (all logic ported from web-v2.ts:428-533, generalized to N outputs):

- `collectPositiveLines(rules)` moves here from web-v2.ts (exported for
  tests).
- Delegated `mouseover`/`mouseout`/`click` listeners on each output root,
  targeting `closest("[data-source-line]")`:
  - hover: `editor.highlightLine(line)` + `.hover-highlight` on every
    `[data-source-line="${line}"]` across *all* outputs (so hovering a
    timeline bar also lights up the matching db rows when both are visible)
  - unhover: clear both
  - click: `editor.focusLine(line)`
- Forward: `setCaretLine(line)` clears `.source-highlight` everywhere, and
  when `line ∈ positiveLines` applies it to matches in all outputs;
  `scrollIntoView({block:"nearest"})` only for non-SVG matches — calling it
  on an SVG child scrolls the whole timeline unpredictably; SVG matches get
  purpose-built scrolling in step 6 instead.
- Hidden outputs are harmless: hidden hosts simply have no hits, and
  re-showing a view re-renders it, after which the caller's `update()`/
  `setCaretLine()` re-applies.

## Step 4 — editor page migration (`ts/src/web-v2.ts`)

- Construct the `Editor` before the linker (move the `new Editor(...)` call
  above the linking section) and keep a reference:
  `const editor = new Editor({ existing: sourceEl, ... })`.
- `const link = attachSourceLink(editor, [dbEl, timelineInlineEl])`.
- Delete the inline linking block (overlay element, `getLineMetrics`,
  `highlightSourceLine`, `clearSourceHighlight`, `collectPositiveLines`,
  `highlightDbFromSource`, `focusSourceLine`, the dbEl mouse listeners, the
  scroll listener).
- `run()` success path: `link.update(parsed.rules)`; error paths:
  `link.update([])`.
- `updateCursorLine()` keeps computing L:C for the label, then calls
  `link.setCaretLine(line)`.
- `setDbView`/`renderDbPane`: after re-rendering the newly visible view,
  call `link.setCaretLine(currentLine)` (via a small refresh) so switching
  Database→Timeline carries the highlight over.

## Step 5 — presentation mode (`ts/src/pres/render.ts`)

- `ActiveBlock` gains `link: SourceLink`.
- In `mountActive`, after the `Editor` is constructed:
  `active.link = attachSourceLink(editor, [tuplesHost, timelineHost])`.
- `runAndRender` success path: `link.update(parsed.rules)` (parsed is
  already in scope); on parse/eval error leave the previous linking state —
  outputs still show `lastValidStore`, matching current behavior.
- `renderIntoHosts` callers (`toggleFn`, `applyCodeReveal`) don't need
  changes beyond the existing re-render; hover linking works immediately,
  forward-highlight refresh is caret-driven.
- Caret tracking: add the same caret listeners web-v2 uses (`keyup`,
  `click`, `select`, `focus` on the textarea → `link.setCaretLine(...)`).
  Consider folding this into `attachSourceLink` itself (it has the Editor)
  so both pages get it for free — do that, and web-v2's `updateCursorLine`
  then only owns the L:C label.
- `teardownAll`: `a.link.destroy()` before `a.editor.destroy()`.
- index-pres.html: add the timeline/db highlight CSS from step 2 and the
  `--editor-line-highlight-bg` variable.

## Step 6 — keybinding-gated timeline scroll-to-highlight (forward direction)

Caret movement never scrolls the timeline; `setCaretLine` only applies
`.source-highlight` there. Scrolling is driven by a keybinding that cycles
through the caret line's timeline occurrences:

- Binding: `Ctrl-.` on the editor textarea, handled by a `keydown` listener
  that `source-link.ts` attaches to `editor.element` (kept in the linker,
  not the `Editor` class — the cycle state and outputs live here).
  `preventDefault`; ignore when the caret line has no timeline matches.
- Cycle state in the linker: `{ line: number, presses: number }`. Any caret
  line change (`setCaretLine` with a different line) and any `update()`
  resets it. On each press: collect the timeline matches
  (`[data-source-line="${line}"]` elements inside SVG outputs, document
  order, deduped to one entry per bar — prefer the `rect` over its label
  `text`), scroll to match `presses % matches.length`, then increment
  `presses`. So the first press goes to the first occurrence and subsequent
  presses walk forward, wrapping back to the first.
- Focused-occurrence feedback: give the target a `.cycle-focus` class
  (cleared from the others and on cycle reset) so the user can see which of
  N same-line bars the press landed on:
  `.timeline-svg .tl-bar.cycle-focus { stroke-width: 3; }`.
- Scroll mechanics (per target): scroll the timeline's scroll container
  (the host with `overflow: auto` — `#timeline-inline` on the editor page,
  `.pres-output-timeline` in pres), not the SVG itself. The scroller is the
  SVG's nearest scrollable ancestor within the registered output (in
  practice `svg.parentElement`; guard with a `scrollWidth > clientWidth`
  check like `attachHorizontalWheelScroll` does at
  `ts/src/v2/timeline.ts:1212`). Compute the target's horizontal extent
  from the rect's `x`/`width` attributes — attribute coordinates equal CSS
  pixels here since the SVG has no scaling transform and `viewBox` matches
  its width/height 1:1. Center it via
  `scroller.scrollTo({ left: xMid - clientWidth / 2, behavior: "smooth" })`;
  when cycling (unlike the db pane's scroll-only-if-offscreen), always
  center so each press gives visible motion. Vertical: same treatment with
  `y`/`height` when the container also scrolls vertically (lane stacks can
  exceed the pane height).
- Hover (reverse direction) never scrolls.
- Docs surface: add the binding to pres's `HELP_ITEMS`
  (`ts/src/pres/render.ts:177` — note its comment says to update bindings
  and list together; here the binding lives in the linker but the help list
  is still the user-facing surface) and mention it in the editor page's
  pane label or leave to overview.md.

## Step 7 — tests

No DOM in the test harness, so cover the pure layers:

- `v2_timeline_layout.test.ts`: assert `layoutTimeline` bars'/facts'
  `tupleIndex` round-trips to a defined `store.tupleSource[...]` line for a
  small program, and that the new sidebar `line` field is populated.
- New `v2_source_link.test.ts`: `collectPositiveLines` on a parsed program —
  emitting markers (`~`/`+`/`^`/`?`/`!`) counted, pure matches and `Sub`
  bodies handled (port the behavior currently implied by web-v2).

Run via `./run-tests.sh` (sandbox: `node --import tsx` fallback).

## Step 8 — docs

- Update `ts/src/v2/overview.md`: new file `source-link.ts`, the new
  `Editor` highlight API, and the timeline renderer's provenance attributes
  (this plan adds a file, so this step is required).
- Manual check via the browser (`/run` skill): editor page db+timeline hover
  both directions, view toggle, presentation slide with `timeline` opt,
  frozen-reveal editor click behavior, gutter alignment with the pane
  label present (the original bug's trigger), and `Ctrl-.` cycling on a
  line with multiple bars in a program wide enough to overflow the pane
  (wraps back to the first occurrence).

## Out of scope / follow-ups

- Unifying the parse→fixpoint→render loops of web-v2 and pres into one
  `LiveProgram` object (the linker's `(editor, outputs, update)` shape is
  the seed of that abstraction; a later plan can move the run loop in).
- Linking for display modules (`icon` tree etc.) — they render terms, not
  tuples, so provenance is less direct.
