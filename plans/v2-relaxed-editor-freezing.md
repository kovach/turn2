# relaxed editor freezing

## Goal
Partially walk back `plans/v2-pres-preserve-edits.md`. That plan froze the editor
at *every* partial reveal and only allowed edits to the fully-revealed state. We
now want each intermediate reveal state to be editable again, while still
preventing the one ambiguous case: editing an *earlier* state after a *later*
state has already been edited.

Conceptually, a code block with `n` pauses is `n+1` editor states (each a
*reveal*). Moving from reveal `R-1` to `R` concatenates the next *segment* of
source onto the previous state. Edits accumulate forward. A single guard rail —
"is there an edited reveal beyond the current one?" — freezes the editor when the
current reveal drops below the latest edited reveal.

## Data structure

Per code block we keep a structure `S` mapping each reveal to its state:

- `left` — this reveal is the untouched source: its text is the previous reveal's
  text plus this reveal's source segment.
- `right EditState` — this reveal has been edited; `EditState` is the *full*
  editor content at that reveal (with any lower edits already baked in).

In code, `S` is sparse: store only the `right` entries. Absence of a key means
`left`.

```ts
// key = `${slideIdx}/${blockIdx}`; value maps reveal -> edited full content.
type EditMap = Map<number, string>;            // the "right" entries of S
RenderHandle.edits: Map<string, EditMap>;      // replaces the old editMap
```

`edits` lives on `RenderHandle`, so it persists across slide navigation (edits
stick when leaving and returning to a slide).

### Reconstructing the editor text

```ts
function editorState(S: EditMap, segments: Segment[], reveal: number): string {
  // base = nearest "right" entry at or below `reveal`, else "" from reveal 0
  let base = "", start = 0;
  for (let r = reveal; r >= 1; r--) {
    const e = S.get(r);
    if (e !== undefined) { base = e; start = r; break; }
  }
  // append the source segments for reveals (start, reveal]
  let out = base;
  for (const s of segments) if (s.reveal > start && s.reveal <= reveal) out += s.text;
  return out;
}
```

This is the iterative form of the recursion in the spec
(`editorState(R) = S(R)` if right, else `editorState(R-1) ++ segment(R)`). Because
it walks back through `S`, a frozen view of reveal `R` still reflects edits made
at reveals *below* `R` (e.g. `S(1)=right`, viewing reveal 2 yields
`EditState(1) ++ seg2`). `segment(R)` here is the concat of `segment.text` for
segments whose `reveal === R`.

### Freeze rule

Let `maxEdited(S)` = the greatest reveal with a `right` entry, or `0` if none.

- The editor is **frozen** at reveal `R` iff `maxEdited(S) > R` — i.e. some later
  reveal has been edited.
- On the initial forward pass nothing is ever frozen: you're always at the
  frontier, so no edited reveal lies beyond the current one.
- This is recomputed on **every** reveal change (forward, backward, slide
  re-entry), not just backward steps.

### Editing

An edit at reveal `R` (the `onChange` callback) does:

```ts
if (maxEdited(S) > R) throw new Error("edit landed on a frozen reveal");
S.set(R, value);   // mark reveal R as right with the current full content
```

The `throw` is a defensive invariant check, not a real code path: when
`maxEdited(S) > R` the editor was set `readOnly` (frozen), so `onChange` cannot
fire. The dangerous state — `right` entries at reveals greater than the current
one — only arises after backward navigation, which is exactly when we freeze; the
freeze keeps the edit from landing, and the throw catches any regression where it
slips through. Setting `S(R)` whether it was `left` or already `right` covers both
"first edit here" and "re-edit the latest edited reveal".

## Background: current code

`ts/src/pres/render.ts`:
- `RenderHandle.editMap: Map<key,string>` — one string per block (final text only).
  **Replace with `edits: Map<key, EditMap>` as above.**
- `ActiveBlock` carries `segments`, `codeMaxReveal`, `fullText`, `editor`.
- `applyCodeReveal` (~line 257): computes `final = reveal >= codeMaxReveal`, picks
  text from `editMap`/`fullText`/`revealedText`, calls `editor.setFrozen(!final)`,
  re-runs the fixpoint on change.
- `mountActive` (~line 288): seeds `initial`, builds the editor whose `onChange`
  writes `editMap` only when `reveal >= codeMaxReveal`, calls
  `editor.setFrozen(reveal < codeMaxReveal)`.
- `teardownAll` (~line 650): snapshots `editor.value` into `editMap` only when
  `reveal >= codeMaxReveal`.

`ts/src/v2/editor.ts`: `frozen`/`setFrozen` (readOnly + `editor-frozen` class +
blur) already exist — no change needed. `set value` bypasses `readOnly`, so
programmatic reveal updates work while frozen.

`revealedText(segments, reveal)` (still used as the `S`-empty case of
`editorState`) concatenates `segment.text` for `segment.reveal <= reveal`.

## Plan

### 1. render.ts — types and helpers
- Add `type EditMap = Map<number, string>`; change `RenderHandle.editMap` to
  `edits: Map<string, EditMap>` and update the three `RenderHandle` literals in
  `mount`.
- Add pure helpers near `revealedText`: `editorState(S, segments, reveal)` and
  `maxEdited(S)`. (`revealedText` can stay; `editorState` with an empty map equals
  it.)

### 2. render.ts — `applyCodeReveal`
```ts
for (const a of h.activeBlocks) {
  const S = h.edits.get(editKey(a.slideIdx, a.blockIdx))!;  // created in mountActive
  const R = h.state.reveal;
  const target = editorState(S, a.segments, R);
  a.editor.setFrozen(maxEdited(S) > R);
  if (a.editor.value === target) continue;
  a.editor.value = target;
  if (a.debounceTimer !== null) { clearTimeout(a.debounceTimer); a.debounceTimer = null; }
  runAndRender(target, a);
}
```

### 3. render.ts — `mountActive`
- Ensure an `EditMap` exists for the key; create an empty `new Map()` if absent
  (never overwrite an existing one — that's what preserves edits across visits).
- Compute `initial = editorState(S, block.segments, h.state.reveal)`, mount the
  editor with it, then `editor.setFrozen(maxEdited(S) > h.state.reveal)`. The
  `applyCodeReveal` that `renderCurrent` runs next is then a no-op
  (`value === target`), so no double fixpoint run.
- Rewrite `onChange`:
  ```ts
  onChange: (value) => {
    const R = h.state.reveal;
    if (maxEdited(S) > R) throw new Error("edit on a frozen reveal");
    S.set(R, value);
    // existing debounce -> runOnce(value)
  }
  ```
- `codeMaxReveal` / `fullText` are no longer used for freezing. Remove `fullText`
  and the `codeMaxReveal` field if nothing else reads them after this change
  (grep to confirm before deleting).

### 4. render.ts — `teardownAll`
Drop the snapshot entirely. `onChange` writes `S` synchronously on every
keystroke (only `runAndRender` is debounced), so `S` is always current; there is
nothing to flush. Removing it also avoids accidentally marking an unedited reveal
as `right`.

### 5. Tests
`editorState` and `maxEdited` are pure — add `ts/src/tests/pres_reveal_state.test.ts`:
- empty `S`: `editorState(S, segs, R)` equals `revealedText(segs, R)` for several `R`.
- edit at `R` (`S.set(R, txt)`): `editorState` returns `txt` at `R`, and appends
  later source segments at `R+1`.
- below-frozen reflection: `S={1:e1}`, `editorState(S, segs, 2) === e1 ++ seg2`.
- `maxEdited`: `0` for empty; greatest key otherwise; drives the
  `maxEdited(S) > R` freeze predicate.

Run via the `run-tests` skill (`./run-tests.sh`); also run `pres_build` to confirm
no parse/build regression.

### 6. Manual verification (`ts/data/pres/presentation2.pres`)
- Forward pass: every reveal of a `[code]` block is editable; typing works at each.
- Edit at an early reveal, advance: the edit is preserved and the next segment
  appends after it.
- Edit at a later reveal, step back: the editor freezes; the earlier view still
  shows any edits made at or below it; step forward — later edit reappears.
- Leave the slide and return: all edits persist.

## Out of scope
- Disk persistence / reload survival.
- Per-edit invalidation of `right` entries above the edit point: it cannot occur
  (the freeze blocks editing when later `right` entries exist), so it is asserted
  via the `throw` rather than handled.
