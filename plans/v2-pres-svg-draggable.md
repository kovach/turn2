# Draggable SVG in slides

Add a `[svg][% ... %]` block kind to `.pres` documents. The body is raw
SVG markup that renders inline; numeric coordinate attributes on geometry
get drag handlers so the user can edit positions by mouse, with the
source text updated to match.

## Scope (v1)

In: `<circle>` (cx, cy, r), `<rect>` (x, y, width, height), `<line>`
(x1, y1, x2, y2), `<ellipse>` (cx, cy, rx, ry), `<text>` (x, y).
Out (v1): `<path>` d-attribute editing, `<polygon>`/`<polyline>` points
arrays, viewBox-aware scaling, transforms, nested groups with their own
coordinate systems. Defer to a later pass.

Each draggable element exposes one or two "handles" (a center handle
that translates the whole element; for rect/ellipse also a corner/radius
handle). v1 ships translate only; resize handles are a follow-up.

## Pieces

### 1. Parser — new block kind

`ts/src/pres/types.ts`:
- Add `| { kind: "svg"; body: string; bodyOffset: number; reveal: number }`
  to `Block`. `bodyOffset` is the absolute char offset of the body start
  within the full `.pres` source — this is the splice target for drag
  commits.
- `reveal` is the slide's reveal counter at the point this block was
  emitted (mirrors how `code` segments carry `reveal`; the whole svg
  block is one atomic reveal unit in v1).

`ts/src/pres/parse.ts`:
- `tokenize` already tracks `i`; thread a `bodyStart` through `readBody`
  return so cmd tokens carry the absolute offset of the body. Plumb
  through `Tok` and the main loop.
- **Forbid nested `[%`/`%]` inside `[svg]` bodies.** The general
  `readBody` unescapes nesting (writes the inner `[%`/`%]` into the
  output string), which breaks the 1:1 body-offset → source-offset
  mapping that drag commits rely on. Either check
  `depth === 0` throughout the svg body and throw on nesting, or scan
  the svg body separately with a non-nesting reader. Simpler: after
  the normal tokenize, when handling the `svg` cmd, scan the body for
  `[%`/`%]` substrings and throw a parse error if found.
- Add a branch alongside `if (tok.name === "code")` for
  `tok.name === "svg"`. No `[pause]` semantics inside the body, no
  `opts`. Multiple per slide allowed (unlike `code`). Flush in-progress
  para/list first, push `{ kind: "svg", body, bodyOffset, reveal: b.reveal }`.
- The block participates in the surrounding `[pause]` machinery the
  same way `code` and list items do: renderer toggles `.hidden-frag`
  on the wrapper based on `data-reveal`.

### 2. SVG source index

New file `ts/src/pres/svg-index.ts`:
- Parse the SVG body once with `DOMParser` to a detached `<svg>`
  element. Also run a lightweight regex/state-machine pass over the
  body string to record, for each element + attribute we care about,
  the `(start, end)` offsets of the attribute *value* substring within
  the body.
- Result shape:
  ```
  type CoordRef = { elementIndex: number; attr: string; start: number; end: number };
  type SvgIndex = {
    el: SVGSVGElement;
    coords: Map<SVGElement, Map<string, { start: number; end: number }>>;
  };
  ```
- The regex pass is more reliable than walking the DOM, because we need
  byte offsets in the original text. It can be element-aware enough by
  matching `<(circle|rect|line|ellipse|text)\b[^>]*>` and then walking
  attributes within the tag. Self-closing and unquoted attrs both need
  handling; quote `"`/`'`/none.
- Pair DOM nodes to source offsets by index: nth matched tag in the
  regex pass corresponds to nth matching DOM node in document order.

### 3. Renderer — mount SVG, attach handles

`ts/src/pres/render.ts`:
- New `renderBlock` branch for `kind === "svg"`: emit
  `<div class="block svg" data-block-idx="${blockIdx}"></div>`.
- In `mountCodeBlocks` (rename or add sibling `mountSvgBlocks` — prefer
  one walk that dispatches by `block.kind`): for each svg block call
  `mountSvg`.
- `mountSvg(h, blockIdx, block)`:
  - Build `SvgIndex` from `block.body`.
  - Append `index.el` to the container.
  - For each element with known coordinate attrs, attach a transparent
    handle child (a `<circle>` or pair of `<circle>`s sized by viewport
    px, set `pointer-events: all`, css class `svg-handle`). Position it
    on top of the element's logical center / corner.
  - On `pointerdown`: capture pointer, record start client coords and
    start attr values.
  - On `pointermove`: compute dx/dy in SVG user units (apply inverse of
    the SVG's CTM via `el.getScreenCTM()`), set live values on the DOM
    attributes for visual feedback, but **don't** rewrite source yet.
  - On `pointerup`: commit. Construct a new body string by splicing the
    updated values into the recorded `(start, end)` ranges. Then
    rewrite the surrounding `.pres` source: replace
    `source.slice(block.bodyOffset, block.bodyOffset + oldBody.length)`
    with the new body. Trigger a parse → mount cycle.

### 4. Source round-trip — transient in-memory only

`mount` accepts an optional `source: string` and holds the live copy on
the `RenderHandle` as `currentSrc`. Drag commits update `currentSrc`
in-memory. No persistence, no callbacks, no reload survival. Reloading
the page reverts edits — acceptable for v1.

### 5. Commit strategy — no re-render

On pointerup we do NOT re-parse or re-mount. The SVG DOM is already
showing the new state (we mutated attributes live during drag). We:

1. Read the new attribute value off the DOM (formatted — see §7 below).
2. Splice it into `currentSrc` at
   `block.bodyOffset + range.start ..  block.bodyOffset + range.end`.
3. Compute the length delta `Δ = newValue.length - (range.end - range.start)`.
4. Update the active block's own SvgIndex: for every coord range in
   the same block whose `start >= range.end`, shift by Δ; also update
   the committed range's `end = start + newValue.length`.
5. Update the block's `body` field (same splice) and any later svg
   block in `effectiveSlides` whose `bodyOffset` exceeds the edit
   point: shift by Δ.

This keeps the DOM, drag handles, code-block editors, and reveal state
all untouched.

### 6. Tests

`ts/src/tests/pres-svg.test.ts`:
- Parse a `[svg][% <svg>...</svg> %]` block; assert block kind, body
  bytes match, bodyOffset points to first char of body.
- Build SvgIndex on a known string; assert coord ranges. E.g.
  `<circle cx="10" cy="20" r="5"/>` → cx range covers `"10"` exclusive
  of quotes, etc.
- Splice helper: given a body + new value at a coord ref, returns the
  expected updated body.

DOM/drag behavior is exercised manually in browser.

### 7. Number formatting on commit

Round to 2 decimals, strip trailing zeros and trailing `.`:
`format(10.5)` → `"10.5"`, `format(10.0)` → `"10"`, `format(10.526)` → `"10.53"`.
Keeps diff noise minimal and avoids `0.30000000000000004` blowups.

### 8. Handles only on present attributes

A handle attaches to an element only if all coord attributes it needs
are *literally present* in the source (within the recorded ranges).
We never add new attributes on drag — that would expand the source and
require inserting (not splicing) ranges, which is a more invasive
operation. If a `<circle>` is missing `cx`, no drag handle.

## Open questions / deferred

- Path `d` attribute editing — needs a path command tokenizer; meaningful
  unit of "drag" is per-point. Defer.
- viewBox / responsive sizing in user-unit conversion. v1 reads CTM
  per-drag which handles uniform scale.
- Multiple selection, snap, undo. Out of scope.
- Whether `[svg]` blocks should participate in `[pause]` reveals (e.g.
  show element N at reveal R). Defer — bodies are atomic in v1.

## Order of work

1. types + parse + parser tests
2. svg-index module + tests
3. renderer mount path, no drag (just renders the SVG inline)
4. drag handles for `<circle>` (smallest case), wire up source rewrite
5. extend to rect/line/ellipse/text
6. integrate `onSourceEdit` callback shape; for now log on commit
