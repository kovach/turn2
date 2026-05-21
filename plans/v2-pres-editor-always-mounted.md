# v2 pres — always-mounted editor for code blocks

Goal: stop the pre→editor transition. A code block renders as an
`Editor` from the moment the slide is mounted; advancing past a
`[pause]` updates the editor's value rather than revealing a styled
`<pre>` fragment. The visual style of "pre-editor" code disappears
because there is no pre-editor state to style.

Motivating cost: today the `<pre class="code-display">` and the
`Editor` (textarea + gutter) must look identical so the user can't
tell the swap happened. They duplicate font, padding, line-height,
background, and now gutter geometry across two stylesheets. Keeping
them in sync is brittle and gets worse as the editor grows features
(gutter, error strip, etc.).

Locus: `ts/src/pres/render.ts` — `renderBlock`, `renderCurrent`,
`reconcileCodeBlock`, `mountActive`, `teardownActive`, `applyReveal`.

## Reveal model change

Today a code block's `[pause]` segments are emitted as
`<span class="frag" data-reveal="N">`s inside the `<pre>`, and
`applyReveal` toggles `.hidden-frag` on them. After full reveal,
`reconcileCodeBlock` swaps the pre for an editor.

New model:
- The slide's `overlayCount` continues to include the code block's
  pauses (no change to navigation step count).
- Code segments are **not** rendered as DOM fragments. They are kept
  on the parsed `block.segments[]` and consulted at reveal time.
- On any reveal change, compute `revealedText = block.segments
  .filter(s => s.reveal <= state.reveal).map(s => s.text).join("")`
  and call `active.editor.value = revealedText` (which already
  triggers gutter rebuild + autoGrow).
- Output panes (db/timeline) are mounted alongside the editor from
  the start; the seeded empty `Store` (already in place) means the
  first render before user edits / before any segment is revealed is
  just empty.

This collapses "mount on full reveal / unmount on partial reveal" to
"mount on slide entry / unmount on slide leave". `reconcileCodeBlock`
goes away.

## Edit-vs-reveal interaction

Setting `editor.value` on each reveal overwrites any edits the user
made before they advanced. Two acceptable resolutions:

1. **Overwrite always (recommended).** Simplest. Users editing
   mid-presentation is rare; the document text is authoritative until
   the full reveal is reached. Document this and move on.
2. **Lock-on-edit.** Track a per-block `userTouched` flag set by
   `onChange`. If set, skip the reveal-driven `editor.value` writes.
   Slightly nicer but adds state and a subtle "why didn't my pause
   reveal the next line?" failure mode if the user accidentally
   typed.

Pick (1). If it bites in practice, add (2) as a follow-up.

`editMap` semantics: only persist edits **after** the block is fully
revealed (i.e., when `state.reveal >= codeMaxReveal`). Before then,
the editor value is a function of segments+reveal and should not
clobber the canonical seed text in `editMap`. Concretely: in the
`onChange` handler, only write to `editMap` if fully revealed; before
that, treat keystrokes as ephemeral (per option 1 above, they'll be
overwritten on the next reveal anyway).

## Render flow

`renderBlock(code)` returns just the outer container — no pre, no
fragments:

```html
<div class="block code" data-block-idx="N" data-opts="…"></div>
```

`mountActive` (rename to `mountCodeBlocks(h)` since it now handles
all code blocks on the slide) runs on every slide entry inside
`renderCurrent`'s "slide changed" branch. For each code block:

1. Find the `.block.code[data-block-idx="N"]` container.
2. Build the host box, toolbar, output box, error strip (same as
   today).
3. Compute initial text: if `editMap` has an entry → use it
   verbatim (user previously fully-revealed and edited this block);
   else use `revealedText` for the current reveal.
4. Instantiate `Editor` with that initial text.
5. Render the seeded empty store, then `runOnce(initial)`.

Then a new `applyCodeReveal(h)` walks each mounted code block and,
unless the user owns the value (case (1): always overwrite, so skip
this caveat; case (2): check `userTouched`), sets
`editor.value = revealedText` for the current reveal. This is called
from `renderCurrent` after `applyReveal` (which still handles
non-code frags: paragraphs, list items).

## Multiple code blocks per slide

Today `h.active` is a single `ActiveBlock`. With editors always
mounted, a slide may have several code blocks and they all need to
live concurrently. Change `h.active: ActiveBlock | null` →
`h.activeBlocks: ActiveBlock[]`. `teardownActive` → `teardownAll`
loops over them. Same for keystroke→debounce→evaluate state — that
already lives on each `ActiveBlock`.

(Look at existing decks before implementing: if every slide has at
most one code block today, the array still works and we don't pay
extra; if not, this change is required for correctness anyway.)

## DOM / CSS cleanup

- Drop `.code-display` styling entirely (font/padding/line-height
  rules in `index-pres.html` line 23 and in the .block.code
  selectors).
- Drop the `.pres-editor-host` rule that says `padding: 0;` — it
  existed to compensate for the host being inside `.block.code`
  which already had padding from `.code-display`. Reassess what
  padding belongs on `.block.code` itself vs. on the editor.
- The `.block.code` container's background/border becomes the
  editor's visible frame. The editor's textarea is already
  `background: transparent`, so the wrapper background shows
  through. Gutter background should be `transparent` too (currently
  inherits) so it doesn't paint over the wrapper.
- One source of truth for code-block-look colors/borders, applied to
  `.block.code`. No more duplicated metrics between `code-display`
  and `editor-textarea`.

## Step-by-step

1. Change `renderBlock(code)` to emit the bare container — no
   `<pre>`, no `<span class="frag">`.
2. Update the slide's `overlayCount` derivation — confirm it still
   counts code-segment pauses correctly. (It should: `overlayCount`
   is computed from segment `reveal`s upstream of `renderBlock`.)
3. Replace `h.active: ActiveBlock | null` with
   `h.activeBlocks: ActiveBlock[]`. Update `teardownActive` → loop.
4. Rename `mountActive` → `mountCodeBlocks(h)`; have it iterate all
   `code` blocks on the current slide. Move the call site to the
   `mountedSlide !== state.slide` branch of `renderCurrent` (i.e.,
   on slide entry, unconditionally).
5. Delete `reconcileCodeBlock`. The call site in `renderCurrent`
   goes away.
6. Add `applyCodeReveal(h)` called from `renderCurrent` after
   `applyReveal`. For each active block, compute `revealedText` from
   the block's segments and set `editor.value`.
7. Gate `onChange`'s `editMap.set(...)` on `state.reveal >=
   block.codeMaxReveal` so partial-reveal keystrokes don't poison
   the saved text.
8. Drop `.code-display` and `.pres-editor-host { padding: 0 }` CSS;
   reassign code-block frame styles onto `.block.code` directly.
   Same for the standalone template downstream (`build:pres`
   re-emits).
9. Run `npm run build:pres` against an existing `.pres` deck and
   smoke-test: navigate forward through pauses, backward, edit
   mid-presentation, toggle tuples/timeline, jump slides via hash.

## Out of scope

- Lock-on-edit (option 2 above). Add only if the always-overwrite
  behavior is annoying in practice.
- A "presentation mode" that makes the editor read-only until full
  reveal. Could be a follow-up; not needed for the cleanup motivating
  this plan.
- Animating the value change on reveal (e.g., typewriter effect).
  Just set `value` directly.
- Removing the segment-pause syntax. It still drives `overlayCount`
  and the reveal-driven value updates.

## Tradeoffs

- Editor (textarea) is heavier than `<pre>`. Mounting on every slide
  entry, possibly several per slide, is fine for decks of dozens of
  slides; revisit if a deck has hundreds.
- The user can edit before the block is fully revealed and have
  their edits clobbered by the next pause. Documented; lock-on-edit
  is a known follow-up if it matters.
- Outputs (db/timeline) become visible earlier than today — from
  slide entry, not from full reveal. This is arguably **better**
  (the audience sees the structure unfold), but is a behavior
  change. The seeded empty store means it's not visually jarring.
