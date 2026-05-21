# v2 editor — line-number gutter

Goal: add a left-side gutter to the v2 `Editor` (`ts/src/v2/editor.ts`)
that displays the line number for each visible row. Line-number text is
rendered in a color slightly muted from the main editor text. No other
gutter affordances (breakpoints, fold markers, diff indicators) — those
can come later; the gutter element is structured so adding them later
is local.

## Approach

A `<textarea>` can't paint its own gutter, so we add a sibling `<div>`
rendered alongside it. The two are wrapped in a flex container that the
existing host receives. Scroll position and content are synced from the
textarea to the gutter.

### DOM

When `Editor` is constructed without `existing`, instead of appending a
bare `<textarea>` to `opts.host`, build:

```
<div class="editor-wrap">
  <div class="editor-gutter" aria-hidden="true">…</div>
  <textarea class="editor-textarea">…</textarea>
</div>
```

For the `existing` (adopted) textarea path, wrap the textarea in place:
insert `editor-wrap` as its parent and prepend the gutter sibling. This
keeps `opts.existing` callers working without DOM surgery on their end.

### Sync

The gutter content is a stack of `<div>`s, one per line, holding the
1-indexed line number. Rebuild whenever the line count changes
(detected on `input`/`value=` setter). For pure scrolling, mirror
`textarea.scrollTop` onto `gutter.scrollTop` via a `scroll` listener;
the gutter's own overflow is clipped (`overflow: hidden`).

To avoid a full innerHTML rebuild on every keystroke when the line
count is unchanged, cache `lastLineCount` and only update when it
differs. Each line div is one `textContent` write of the number.

### CSS

Add to a shared stylesheet (or inline where the other `.editor-*` CSS
lives — currently scattered across `ts/presentation*.html` and
`ts/index-pres.html`; pick `ts/index-v2.html` as the primary home and
mirror into the pres HTMLs since they each duplicate editor styles).

```
.editor-wrap {
  display: flex;
  align-items: stretch;
  /* inherit background/border from the previous .editor-textarea host */
}
.editor-gutter {
  flex: 0 0 auto;
  user-select: none;
  text-align: right;
  padding: 14px 8px 14px 10px;       /* match textarea top/bottom padding */
  font-family: monospace;            /* match textarea */
  font-size: inherit;                /* match textarea */
  line-height: 1.45;                 /* must match textarea exactly */
  color: var(--editor-gutter-fg, #999);  /* slightly muted vs main fg */
  overflow: hidden;
  white-space: pre;
}
.editor-textarea { /* unchanged except: */
  flex: 1 1 auto;
  /* keep existing padding/line-height; these MUST match the gutter */
}
```

The exact muted color is left to the host stylesheet via the
`--editor-gutter-fg` custom property; default `#999` is a reasonable
mid-gray on both light and dark backgrounds. Each host page that
already styles `.editor-textarea` should set this var if its
foreground isn't roughly black.

### autoGrow interaction

`fitHeight` reads `this.ta.scrollHeight` and sets `this.ta.style.height`.
With the wrap in place, the gutter's height should track the textarea's
height. Solution: set `gutter.style.height` to the textarea's computed
height inside `fitHeight`, right after setting the textarea height.
Alternatively, give the wrap `align-items: stretch` (already in CSS
above) and put the height on the wrap rather than the textarea — but
that's more disruptive. Go with the explicit gutter-height write inside
`fitHeight`.

### Adopted textarea path

For `opts.existing`, we cannot assume the existing textarea has a
suitable parent. Strategy in the constructor:

1. Build the wrap div and gutter div.
2. `existing.parentNode.insertBefore(wrap, existing)`.
3. Move `existing` into the wrap (after the gutter).
4. Add the `editor-wrap` class to the wrap so CSS applies.

On `destroy`, if `!this.adopted` we currently call `this.ta.remove()`.
With the wrap, remove the wrap instead. For adopted: leave the wrap in
place but remove our listeners (no behavior change for callers, which
already expect the textarea to stick around).

## Step-by-step

1. Add a private `gutterEl: HTMLElement` field and a `rebuildGutter()`
   method that computes `lineCount = (value.match(/\n/g)?.length ?? 0) + 1`
   and either appends new line divs or removes extras so the gutter
   matches.
2. Constructor: build `editor-wrap` and `editor-gutter` siblings.
   Handle both `existing` and `host` paths. Call `rebuildGutter()`
   after initial value is set.
3. Add a `scroll` listener on the textarea that copies `scrollTop` to
   the gutter.
4. `onInput`: call `rebuildGutter()` before/after the existing logic.
5. `value` setter: call `rebuildGutter()` after assignment.
6. `fitHeight`: after setting `this.ta.style.height`, mirror it on
   `this.gutterEl.style.height`.
7. `destroy`: remove the scroll listener; remove the wrap (not just
   the textarea) when `!this.adopted`.
8. CSS: add `.editor-wrap` and `.editor-gutter` blocks to
   `ts/index-v2.html`, `ts/index-pres.html`, `ts/presentation.html`,
   `ts/presentation2.html`. Set `--editor-gutter-fg` per page if the
   default is wrong for that page's color scheme.

## Out of scope

- Soft-wrap line numbers (a wrapped line should still get one number;
  we count `\n`s, not visual rows). The v2 editor uses `white-space:
  pre` so this isn't an issue in practice.
- Clicking the gutter to select a line.
- Breakpoint / fold / diff markers.
- Highlighting the current line's number.
- Reflecting parse-error lines (could come later via a `setLineMarks`
  API; would attach a class to the matching gutter div).

## Tradeoffs

- Rebuilding the gutter on every keystroke that changes the line
  count is O(maxLines) DOM writes. For these editor sizes (tens to a
  few hundred lines) this is fine. If it ever shows up, switch to
  incremental add/remove.
- Two sources of truth for line-height — the textarea CSS and the
  gutter CSS. They must stay in sync; mismatches manifest as visible
  drift between line numbers and text rows. Documented in the CSS
  comments above.
- Adopted-textarea callers get their DOM rearranged (a new parent
  appears). Acceptable: nothing in the tree currently depends on the
  textarea's direct parent.
