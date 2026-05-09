# v2 source ↔ output highlight linking

Port the bidirectional source/output highlight feature from v1 (`ts/src/web.ts`)
to the v2 editor (`ts/src/web-v2.ts`, db pane in `index-v2.html`).

## Behavior to reproduce

Forward — **cursor in source ⇒ matching output spans highlighted**:
- On `keyup` / `click` in the source textarea, compute the line index from
  `selectionStart`. Save as `currentLine`.
- Clear all `.source-highlight` classes in the db pane, then add the class to
  every `[data-source-line="<currentLine>"]` span. Scroll the last match
  into view (`block: nearest`).
- Only highlight when the source line carries at least one *positive* atom
  (assert markers `~`/`+`/`^`, plus `?` and `!`). Pure matches (`-`) on the
  cursor line should not light anything up. (v1 gates on the existence of a
  positive node in `patternSpanIndex`; v2 will gate on `RuleAtom.marker`.)

Reverse — **mouse over output tuple ⇒ source line + sibling tuples highlighted**:
- On `mouseover` inside the db pane, walk up to find a `[data-source-line]`
  ancestor. If found:
  - Position an absolutely-placed overlay div over that line of the textarea
    (computed from `lineHeight`, `paddingTop`, and `textarea.scrollTop`),
    making the source line glow.
  - Add `.hover-highlight` to all db spans sharing that line.
- On `mouseout`, hide the overlay and clear `.hover-highlight`.
- On textarea `scroll`, hide the overlay (its absolute position would drift
  off the actual line; cheaper than re-positioning every scroll tick).

(v1 also scrolls and re-shows the overlay on click; we can include this as
a small extra but it's not required for parity with the user's described
feature.)

## Pieces to build

### 1. Span map: `(rule, lexPos) → sourceLine`

v2 has all the data; nothing in eval/store currently exposes it.

`RuleAtom.span.line` is set by `parse.ts` and preserved through `expand.ts`.
`expand.assignIds` already labels each Atom with `id.chain = (*id <ruleName>
<lexPos> ...)`. After `parse` + `expand` we walk every rule and, for each
`tag === "Atom"` (skip `Sub` outer / `Equal`), record:

```
ruleLineMap : Map<string, number>   // key = `${ruleName}:${lexPos}`, value = span.line
```

Build this once per parse in `web-v2.ts` `run()` and stash on a module-level
`let`. Use `rule.name` as the key prefix (post-expansion rule names — the
display already groups by them).

This map is also useful for source linking only when the line has a *positive*
atom; track a parallel set:

```
positiveLines : Set<number>  // lines with at least one assert/ask/constrain marker
```

### 2. Tuple → source line lookup

For each tuple in `store.tuples`, identify its emitting `(rule, lexPos)`.

The cleanest way: thread it through eval. Add an optional sibling array on
`Store`:

```ts
// store.ts
export interface Store {
  ...
  tupleSource: Span[];   // parallel to `tuples`; index i = span of atom that emitted tuple i
}
```

…and have `addTuple(store, atom, l, r, span)` push the span. The three
emitter call sites in `eval.ts` (`evalAssert`, `evalAsk`, `evalConstrain`)
already have `a.span` in scope.

This is more reliable than reverse-engineering rule/lexPos from the atom's
`*id`/`*mom` terms (the asserted atom may not contain its own `*id` — e.g.
`anchor` markers reuse anchor endpoints and unbound-variable freshIds may
not appear if all variables are already bound).

`tupleSource[i].line` is everything `web-v2.ts` needs — no need to also
keep the (rule, lexPos) keys around for the consumer.

(If we don't want to widen `Store`, an alternative is a side `WeakMap<Tuple,
Span>` constructed during eval; but the parallel array is simpler given
that `Tuple` objects are plain.)

### 3. `data-source-line` attributes in the db pane

In `renderDatabase` (web-v2.ts:227), each tuple is currently rendered as
plain text into `dbEl.innerHTML`. Change the per-row template so each
tuple's outer `<span>` (or a new wrapping `<span class="row">`) carries
`data-source-line="<line>"` whenever `store.tupleSource[i]` is defined.

Specifically, build the row as:

```html
<span class="row" data-source-line="N">  <pred>p</pred> args        <span class="interval">[L, R]</span></span>
```

The current code joins lines with `\n` inside `<pre>`-equivalent
`white-space: pre` content; wrapping each row in a span is fine — keep the
trailing newline outside the wrapping span.

The group-heading line and the empty-DB placeholder don't get the attribute.

### 4. Forward highlight wiring

Add to `web-v2.ts`:

```ts
let currentLine: number | null = null;

function updateCursorLine() {
  const pos = sourceEl.selectionStart;
  currentLine = sourceEl.value.slice(0, pos).split("\n").length;
  highlightDbFromSource();
}

function highlightDbFromSource() {
  dbEl.querySelectorAll(".source-highlight").forEach(el => el.classList.remove("source-highlight"));
  if (currentLine === null || !positiveLines.has(currentLine)) return;
  const matches = dbEl.querySelectorAll(`[data-source-line="${currentLine}"]`);
  matches.forEach(el => el.classList.add("source-highlight"));
  const last = matches[matches.length - 1];
  if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

sourceEl.addEventListener("keyup", updateCursorLine);
sourceEl.addEventListener("click", updateCursorLine);
```

Also call `highlightDbFromSource()` at the end of `run()` so the highlight
re-applies after every fresh render (the dom nodes change identity).

### 5. Reverse highlight wiring + overlay

Build a `<div class="source-line-highlight">` inserted into the editor pane
sibling-positioned with the textarea (mirroring the v1 setup).

Helpers:

```ts
function highlightSourceLine(line: number) { /* same math as v1 */ }
function clearSourceHighlight() { sourceLineHighlightEl.style.display = "none"; }

dbEl.addEventListener("mouseover", e => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) return;
  const line = +target.getAttribute("data-source-line")!;
  highlightSourceLine(line);
  dbEl.querySelectorAll(`[data-source-line="${line}"]`).forEach(el => el.classList.add("hover-highlight"));
});
dbEl.addEventListener("mouseout", e => {
  if ((e.target as Element).closest("[data-source-line]")) {
    clearSourceHighlight();
    dbEl.querySelectorAll(".hover-highlight").forEach(el => el.classList.remove("hover-highlight"));
  }
});
sourceEl.addEventListener("scroll", () => {
  if (sourceLineHighlightEl.style.display !== "none") clearSourceHighlight();
});
```

### 5b. Click-to-focus

Clicking an output row should focus the textarea and place the caret at the
start of the corresponding source line. Add a `click` handler on `dbEl`:

```ts
dbEl.addEventListener("click", e => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) return;
  const line = +target.getAttribute("data-source-line")!;
  focusSourceLine(line);
});

function focusSourceLine(line: number) {
  const lines = sourceEl.value.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i]!.length + 1;
  sourceEl.focus();
  sourceEl.setSelectionRange(offset, offset);
  // Center the line and reposition the overlay (textarea scroll fires the
  // `scroll` listener which would clear it, so reapply after scroll settles).
  scrollSourceLineIntoView(line);
  requestAnimationFrame(() => highlightSourceLine(line));
  // Run the forward path so the db's `.source-highlight` reflects the new
  // caret position immediately (the `click` event won't trigger our `click`
  // handler on `sourceEl`).
  currentLine = line;
  highlightDbFromSource();
}

function scrollSourceLineIntoView(line: number) {
  const { lineHeight, paddingTop } = getLineMetrics();
  const lineTop = paddingTop + (line - 1) * lineHeight;
  sourceEl.scrollTop = lineTop - sourceEl.clientHeight / 2 + lineHeight / 2;
}
```

Beware ordering with the existing `mouseout`: a click also produces a
`mouseout` on the way out of the row, which would clear `.hover-highlight`
— that's fine, the forward path then re-applies `.source-highlight`.

Also: the existing v2 db pane likely has other click handlers (e.g. for
clickable terms in the display pane — though `dbEl` itself is text-only
today, double-check). If the click target has `data-clickable` or similar,
`closest("[data-source-line]")` will still match the wrapping row, so a
priority decision may be needed. Today no other click semantics exist on
`dbEl`, so the new handler stands alone.

### 6. CSS

Copy the three rules from `ts/index.html` into `ts/index-v2.html`:

```css
.source-highlight     { background-color: rgba(59,130,246,.30); border-radius: 2px; }
.hover-highlight      { background-color: rgba(168,85,247,.30); border-radius: 2px; }
.source-line-highlight{ position: absolute; left: 0; right: 0; background: rgba(59,130,246,.25); pointer-events: none; z-index: 1; display: none; }
```

The textarea's container (`.editors` `.pane` wrapping the `<textarea
id="source">`) needs `position: relative` so the absolutely-positioned
overlay aligns to it. Confirm/adjust in `index-v2.html`.

## Implementation order

1. Add `tupleSource: Span[]` to `Store`, push at `addTuple` (signature change),
   propagate `a.span` from the three eval sites. Verify tests still pass.
2. In `web-v2.ts`, build `ruleLineMap` and `positiveLines` from the parse tree
   (kept for future use; current consumer only needs `positiveLines`).
3. Wrap each rendered row in a `<span class="row" data-source-line="N">`.
4. Add the source-line overlay element + CSS.
5. Wire forward (`updateCursorLine` on `keyup`/`click`, re-apply at end of
   `run()`).
6. Wire reverse (`mouseover`/`mouseout` on `dbEl`, `scroll` on `sourceEl`).
7. Wire click-to-focus (`click` on `dbEl` → caret at line start, scroll into view).
8. Manual smoke test: load `ts/data/v2/ttt.t`, place cursor on assert lines,
   confirm db highlights; mouse over db rows, confirm source highlights.

## Ambiguities / open questions

- **Positive-line gating definition.** v1 includes Aggregate; v2 doesn't have
  a distinct Aggregate marker — weighted matches (`-` with `-> term`) are
  the analogue but they're matches, not asserts. Decision: gate on markers
  `episode`/`fact`/`anchor`/`ask`/`constrain` only. Confirm this matches
  the user's mental model.

- **Choice/aggregate desugaring.** `?`/`!` desugar at eval time into
  `_choose`/`_constrain` rows. Their `tupleSource` will be the original
  `?`/`!` line (since it's `a.span` of the original RuleAtom), which is
  what we want. No special-casing needed.

- **Sub-rule lines.** A `Sub` body's atoms have their own lines; the outer
  `Sub` itself has a span (the `(` line) but no atoms of its own. Since we
  only walk `tag === "Atom"` we skip the outer Sub line correctly — but a
  cursor placed on a line that contains *only* `(` or `)` won't highlight
  anything, which seems right.

- **Multi-atom lines.** If two atoms share a line (e.g. on the same source
  line), `data-source-line` collapses them — both contribute tuples and all
  show together. v1 has the same behavior; flag it as intentional.

- **Hide-internal interaction.** When `hideInternalEl` is checked, `_choose`
  / `_constrain` groups are filtered out. Forward highlights for `?`/`!`
  lines will then appear empty. Acceptable — same UX as v1's hide-internal.

- **Overlay placement.** The v2 editor uses CSS grid; the textarea is
  inside `.editors > .pane`. Need to make whichever element directly
  contains `<textarea id="source">` `position: relative` and insert the
  overlay as a sibling. Confirm by inspecting `index-v2.html` before
  picking the exact insertion point.

- **Caret column on click.** Plan places the caret at column 0 of the line.
  Alternative: move it to the first non-whitespace character (closer to the
  user's likely target). Pick one.

- **Re-running the linker after PUT-driven source updates.** When the
  server pushes new file contents into the textarea, `run()` re-fires and
  rebuilds `ruleLineMap`. `currentLine` based on the new `selectionStart`
  is fine. No extra wiring needed.
