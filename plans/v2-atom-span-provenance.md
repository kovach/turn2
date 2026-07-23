# Atom-granular source provenance (span, not line)

## Goal

Today every tuple is linked to a *source line*. When one line contains several
assertions, all of them light up together: hovering a timeline bar highlights
the whole line, the forward (caret → output) highlight fires for every atom on
the caret's line, and `Ctrl-.` / double-click cycles through the union of all
their occurrences.

Refine this so a tuple is associated with the **single atom** that emitted it,
identified by its source span (line + column range).

## Why it's cheap

`store.tupleSource` already holds a full `Span`, not a line number
(`ts/src/v2/store.ts:32`), and `Span` (`ts/src/v2/term.ts:22`) already declares
`startCol?` / `endCol?`. The gap is only at the two ends of the pipeline:

- the parser builds every span as a bare `{ line }` (~10 sites in `parse.ts`),
  so `startCol` is **never populated anywhere** in the codebase;
- every consumer projects `span.line` (`render-output.ts:53`,
  `timeline.ts:381,1141,1216,1243`, and all of `source-link.ts`).

The middle of the pipeline needs no work: expansion, desugaring, macro
instantiation and exception lowering all copy spans wholesale (`expand.ts`
spreads `a.span` into synthesized atoms, using the *call site* span for macro
bodies), so columns propagate for free once the parser emits them.
`resolveExceptionProvenance` (`fixpoint.ts:94-116`) re-points a tuple at another
tuple's whole span, so it is likewise unaffected.

(Line references in this plan were taken from an older working tree and some
have drifted — the code all still exists as described, but grep for the
identifiers rather than trusting the numbers.)

No evaluator, store, scheduler or fixpoint changes are required.

## Every displayed tuple's span can carry columns

Worth establishing up front, because it removes the need for any line-only
fallback machinery. A displayed tuple's span comes from `Emit.span`
(`eval.ts:198`) or is copied verbatim from another tuple (`scheduler.ts:191,364`,
`comp-aggregate.ts:111,123`). Only two constructs ever become an `Emit`:

- **atom tokens** — the atom scanner (`parse.ts:313-320`) breaks on `[`, `{`,
  `,`, `)`, `.`, `;` and never advances `li`, so an emitting atom token always
  lies within one line and has a clean `start`..`pos` extent;
- **exception blocks** (`parse.ts:796`) — the tokenizer requires `{...}` to
  close on the same line, so likewise column-able.

One wrinkle inside exceptions: the RHS of `{p t => e}` is parsed by re-running
`tokenize` on a **sliced fragment** (`parse.ts:788`), and `remapItemLines`
(`parse.ts:800`) re-stamps only `.line`. Exception lowering then splices
`...exc.right` verbatim into the generated exception rule (`expand.ts`, step 6
of the lowering), so an emitting RHS atom — `{p t => +q x}` — reaches an
`Emit` under its own span. Without care, its columns would be relative to the
fragment string, not the original line, and reverse hover would highlight the
wrong character range. Step 1 handles this with a column offset.

The other line-only spans are irrelevant here: `[...]` aggcomp is a separate
token whose items become *match* atoms (`parse.ts:1574`) and whose results copy
provenance from the source row, so it never emits under its own span; `#def` /
`#js` / `#macro` / whole-rule spans never reach an `Emit` at all.

The single exception is `scheduler.ts:722` (aggregate value tuples), which calls
`addTuple` with **no** span at all — `undefined`, not line-only. Those are
already unlinked today and stay that way; the existing `?.line` /
`span === undefined` guards cover them.

So: columns are mandatory on the tokens that matter, span keys are always
`line:startCol-endCol`, and matching is plain key equality. Consequently
`data-source-span` **replaces** `data-source-line` rather than supplementing it.
Its v2 consumers are `source-link.ts` and one CSS rule —
`[data-source-line] { cursor: pointer; }` (`styles/theme.css:33`) must become
`[data-source-span]` or the hover/click affordance silently disappears
(`v1/web.ts` has its own copy and is untouched).

The one fallback that does survive is on the *caret* side, not the span side:
the caret can sit in whitespace or on a line with no emitting atom, which still
needs an answer (see step 4).

## Steps

### 1. Parser: populate `startCol` / `endCol`

`tokenize` (`ts/src/v2/parse.ts:73`) already tracks `start` and `pos` around the
atom-content scanner (`parse.ts:313-345`). Note `stripComment` only slices the
tail, so indices into `raw` are already original-line columns.

- Add `startCol` / `endCol` to the `atom` and `equal` tokens, trimmed to the
  non-whitespace extent of the atom text (include the marker char, so `+foo x`
  spans from the `+`).
- Add the same to the `exception` token (`parse.ts:149`), whose `pos`..`end`
  extent is already computed.
- **Fragment re-parses need a column offset.** The exception RHS runs
  `tokenize(rhsText)` on a slice of the (already-trimmed) exception token text
  (`parse.ts:788`), so the fragment's atom tokens carry columns relative to
  `rhsText`, and `remapItemLines` (`parse.ts:800`) only fixes `.line`. These
  atoms *do* reach `Emit` — exception lowering splices `...exc.right` into the
  generated exception rule — so their columns must be shifted to true
  source-line columns:
  - the `exception` token additionally records `textStartCol`, the column of
    its (trimmed) `text` within `raw`;
  - `parseExceptionItem` computes the RHS's base offset within `text`
    (`arrow + 2` plus the leading whitespace `rhsText`'s trim dropped,
    `parse.ts:756-759`), adds `textStartCol`, and passes the total to
    `remapItemLines`, which gains a `colOffset` parameter shifting
    `startCol`/`endCol` on every atom span it visits.
  - The aggcomp fragment path also goes through `remapItemLines` with
    fragment-relative columns, but its items are forced to `match` markers and
    never emit; pass offset 0 (or strip columns) there — either is fine since
    nothing reads them. (Aggcomp text can span multiple joined source lines,
    so a true offset isn't even well-defined; this is another reason its spans
    stay line-only.)
- Thread the columns into the span constructors that can reach an `Emit`:
  `parse.ts:1340` (`Atom`), `:1383`, `:1296` (`Equal`), `:796` (exception).
  The rest — `:491` (`#js`), `:520` (rule), `:618` (`#macro`), `:1283`
  (aggregate spec), `:1571`/`:1576` (aggcomp), `:670`/`:697` (subs) — stay
  line-only; nothing in the display path reads them. Giving subs a column range
  is a possible follow-up (it would let a sub's extent be highlighted), not part
  of this change.
- Tests: a parser test asserting `startCol`/`endCol` for two emitting atoms on
  one line and for a marker-prefixed atom; the same for an emitting atom inside
  an exception RHS (`{p => +q x}` — catches the fragment-offset bug); and an
  assertion over a compiled program that every `Emit.span` has columns **and**
  that `sourceLines[span.line - 1].slice(startCol, endCol)` reproduces the
  atom's source text — existence alone wouldn't catch wrong-but-present
  columns from a fragment re-parse.

### 2. Span key helper

One exported helper (natural home: `ts/src/v2/term.ts`, next to `Span`):

```ts
spanKey(s: Span): string        // "12:4-19"
```

This is the DOM attribute value, and matching is plain string equality — no
`spanMatches` predicate is needed, per the invariant established above. Have it
assert (or return `undefined`) on a column-less span so a regression surfaces
instead of silently collapsing two atoms back onto one key.

### 3. Stamp `data-source-span` in the renderers

`data-source-span` replaces `data-source-line` throughout the v2 renderers.

- `render-output.ts:45-71` — `renderTupleRow` returns the `Span` instead of
  `line`; `emitRows` stamps `data-source-span`.
- `timeline.ts` — `Bar`, `Fact` and `SidebarSection.rows` carry `span: Span |
  undefined` in place of `line: number | undefined`
  (`timeline.ts:121,138,145-149,514-527`); the SVG renderer stamps the
  attribute on bar rects, bar labels, fact labels and sidebar rows
  (`timeline.ts:1285,1311,1368,1394`). `undefined` (aggregate value
  tuples) stamps nothing, exactly as today.
- `styles/theme.css:33` — the `[data-source-line] { cursor: pointer; }`
  selector becomes `[data-source-span]`.
- `renderTimelineAscii` ignores spans entirely — no change.
- `tests/v2_timeline_layout.test.ts:196-206` reads `store.tupleSource[...]`
  directly, so it only needs adjusting if the helper field names move.

### 4. `source-link.ts`: match on spans

This is the actual behavior change (`ts/src/v2/source-link.ts`).

- `collectPositiveLines` → `collectPositiveSpans`, returning the set of emitting
  atom spans, indexed by line so the caret lookup below is cheap.
- Forward direction needs the caret **column**, not just the line: add
  `Editor.caretPos(): { line: number; col: number }` (`editor.ts:139` already
  walks the value to find the line; extend it to return the column). Pick the
  atom span on that line containing the caret column. The caret can legitimately
  sit in whitespace, on a marker, or on a line whose atoms don't emit — in that
  case highlight *all* emitting spans on the line, i.e. exactly today's
  behavior, so nothing gets worse. (Alternative worth a look during
  implementation: snap to the nearest span on the line instead. Whole-line is
  the conservative default.)
- `matchesFor(line)` → `matchesFor(key)`, a direct
  `[data-source-span="<key>"]` query.
- The reverse hover/click handlers (`source-link.ts:156-181`) read
  `data-source-span` off the closest ancestor.
- `cyclePress` (`source-link.ts:131`) then cycles only the occurrences of the
  atom under the caret — the biggest UX win of this change. Cycle state keys on
  the span key rather than the line.
- Both hosts (`web-v2.ts:472`, `pres/render.ts:548`) call `attachSourceLink`
  with the same signature; no change needed there.
- Note `collectPositiveLines` today skips `Exception` items entirely (the walk
  only descends `Sub`), so exception lines never forward-highlight;
  `collectPositiveSpans` keeps that behavior — with the offset fix in step 1
  the RHS atoms' spans are correct if this is ever revisited.

### 5. Editor: column-range highlight overlay

The only genuinely new UI. `Editor.highlightLine` (`editor.ts:149`) positions a
full-width bar using the gutter row's vertical extent. Add
`highlightRange(line, startCol, endCol)` which additionally sets `left` /
`width`.

Cheap here because the textarea is `white-space: pre`, monospace, and never
soft-wraps (`styles/editor.css:16-24`): `x = col * chWidth + paddingLeft -
scrollLeft`, with `chWidth` measured once from a hidden probe span (re-measure
on font-size change). `repositionHighlight` (`editor.ts:186`) also needs to
track horizontal scroll, not just `scrollTop`.

`highlightLine` stays for the whole-line cases (caret in whitespace; reverse
hover on an element whose span is unknown).

## Docs

No new files, but `ts/src/v2/overview.md` needs updating in two places:

- the `data-source-line` bullet (`overview.md:238`) — it becomes
  `data-source-span`, noting that every `Emit.span` carries columns and that
  span-less aggregate value tuples stamp nothing;
- the source-link section (`overview.md:256`) — highlighting and `Ctrl-.`
  cycling are per-atom, not per-line.

---

Plan written by Claude Opus 4.8 (claude-opus-4-8, 1M context).
Revised after review by Claude Fable 5 (claude-fable-5): exception-RHS
fragment column offset, theme.css selector, refreshed line references.
