# pres preserves edits during a presentation

## Goal
During a presentation, edits made to a code block's final (fully-revealed) version
should persist across slide navigation. Edits to partially-revealed states are
disallowed entirely (the editor is **frozen** until the last pause is passed).

## Current state
`ts/src/pres/render.ts` already maintains `RenderHandle.editMap : Map<key,string>`
keyed by `slideIdx/blockIdx`. It is:

- Read on mount (`mountActive`, line ~292): the initial editor text is
  `editMap.get(key) ?? (fullyRevealed ? fullText : revealedText(...))`.
- Written on input (line ~380) and on teardown (line ~647), but only when
  `state.reveal >= codeMaxReveal`.
- Overwritten on reveal change by `applyCodeReveal` (line ~256), which assigns
  `editor.value = revealedText(segments, reveal)` whenever it differs.

So persistence across *slide* changes works for fully revealed blocks. What's
missing:

1. Nothing stops the user from typing into a partially revealed editor. Those
   keystrokes are visible but silently discarded on the next reveal step — a
   confusing experience.
2. When advancing reveal to/past `codeMaxReveal`, the editor should switch from
   "scripted partial text" to "the editable full version (with any saved edits
   reloaded)". Currently `applyCodeReveal` will load `fullText` (via
   `revealedText` at max reveal == all segments concatenated) but ignores
   `editMap`, so a user who already edited this block on a previous visit loses
   their edits on first reveal step into the final stage.

## Plan

### 1. Editor: add a `frozen` flag

In `ts/src/v2/editor.ts`:

- Add private `frozen: boolean = false`.
- Add `get frozen()` and `setFrozen(v: boolean)` (or simple `set frozen(v)`).
- When frozen:
  - `this.ta.readOnly = true` and `this.ta.classList.add("editor-frozen")` so
    we can style it (e.g. dim background, no-caret cursor).
  - In `onKeyDown`, short-circuit before any custom keybinding (Tab, Enter,
    Home, Delete) — let the browser/readOnly handle keys; just return.
- When unfrozen, reverse both.
- `set value(v)` continues to work regardless of frozen (programmatic writes
  bypass readOnly).
- `onInput` is not fired when readOnly, so `editMap` cannot be poisoned by
  user input while frozen — but it can still fire from `execCommand("insertText", …)`
  in the indent/auto-indent paths; the early return in `onKeyDown` prevents
  reaching those.

### 2. render.ts: drive freeze from reveal state

- `ActiveBlock` already knows `codeMaxReveal`. Define a helper
  `isFinalReveal(h, active) := h.state.reveal >= active.codeMaxReveal`.
- In `mountActive`, after constructing the editor, call
  `editor.setFrozen(!isFinalReveal(h, active))`.
- In `applyCodeReveal`, when iterating active blocks:
  - Compute `final := isFinalReveal(h, a)`.
  - Compute target text:
    - `final` → `editMap.get(key) ?? fullText` (fullText computed once on
      mount, store on `ActiveBlock`).
    - not final → `revealedText(a.segments, h.state.reveal)`.
  - If `a.editor.value !== target`, set it (existing path); always call
    `a.editor.setFrozen(!final)` so transitions in either direction take effect.
  - Existing `runAndRender` flow stays as-is.

### 3. Simplify the `onChange` guard

Once the editor is frozen during partial reveals, the `onChange` callback in
`mountActive` will only fire on the final reveal. The `if (h.state.reveal >=
active.codeMaxReveal)` guard around `editMap.set(...)` becomes redundant —
but leave it as a belt-and-suspenders check. Same for the teardown guard.

### 4. Tests / manual verification

Existing tests in `ts/src/tests/pres_build.test.ts` are about parsing/build; no
existing render-mode tests. Manual verification:

- Open `ts/data/pres/presentation2.pres` (or any pres with `[pause]` inside a
  `[code]` block).
- Confirm: while reveal < last-segment, the editor is visually frozen and
  typing/Tab/Enter do nothing.
- Advance to full reveal — typing works. Edit the code. Navigate to next slide
  and back — edits restored.
- Step back to a pre-pause reveal — editor shows scripted text and is frozen.
  Step forward again to full reveal — your saved edits reappear.

### 5. CSS (optional, small)

Add `.editor-frozen { background: <slightly muted>; cursor: not-allowed; }` in
whichever stylesheet currently styles `.editor-textarea` (find via grep for
`editor-textarea`). Keep it subtle — the main signal is that keys don't take.

## Out of scope
- Persisting edits to disk / across page reloads.
- Allowing edits to per-stage source (the spec explicitly forbids this).
- Any UI affordance to "reset to script" — user can refresh the page.
