# GUI Interpretation of Programs

## Goal

Handle the `?` (Ask) literal type as interactive user input in the result view. Users click nodes to assert relationships between them.

## Behavior Summary

1. `?` nodes behave like `+` nodes during fixpoint — inserted into the result tree with `literalType` preserved as `Ask`.
2. `Match` (`-`) patterns can match both `Assert` and `Ask` nodes in the reference.
3. In the rendered result, `?` and `+` nodes are clickable:
   - Clicking a `?` node marks it as the selected node. Clicking the same `?` node again deselects.
   - Clicking a `+` node while a `?` node M is selected appends `+ click M N` to the input and clears the selection.
   - Clicking a `+` node with no selection: silent no-op.

## Implementation Steps

### 0. Engine: match `?` nodes with `-` patterns (in `unify.ts`)

Change `unifyNode` so that a `Match` pattern node can unify with either an `Assert` or `Ask` reference node:

```ts
// before
if (pat.literal.literalType !== "Match" || ref.literal.literalType !== "Assert") return null;
// after
if (pat.literal.literalType !== "Match") return null;
if (ref.literal.literalType !== "Assert" && ref.literal.literalType !== "Ask") return null;
```

No changes needed to `step` or `fixpoint` — `?` nodes are already positive (non-Match) and are inserted with their `Ask` literalType preserved.

### 1. Render ids on nodes (in `web.ts`)

Update `renderTree` / `renderLiteral` to emit `data-id` and `data-literal-type` attributes on the outer `<span>` so the click handler can read them. The `data-id` value is the node's id serialized with `formatTerm`.

### 2. Track selection state

Add a module-level variable `let selectedAsk: Term | null = null` — the id term of the most recently clicked `?` node.

### 3. Wire up click handler on the result container

Attach a single delegated click listener to `resultEl`. On click, find the nearest ancestor element with `data-literal-type`:
- `Ask`: if it is already `selectedAsk`, deselect (set to null); otherwise set it as `selectedAsk` and highlight it.
- `Assert` and `selectedAsk !== null`: call `assertClick(selectedAsk, thisNodeId)`; clear `selectedAsk`.
- Otherwise: clear `selectedAsk`.

### 4. `assertClick(askId, assertId)`

Appends a new pattern to the textarea using `execCommand("insertText", ...)` so it lands on the browser's native undo stack:

1. Move the textarea selection to the end.
2. Insert `\n\n+ click <M> <N>` where `<M>` and `<N>` are the ids serialized with `formatTerm` — compound atom ids like `(id r1 X1)` get parentheses and parse back correctly as atoms.
3. Call `run()` to re-evaluate. The normal `input` event fires, triggering debounce/sync if attached.

### 5. Visual feedback

`?` nodes get a pointer cursor (add to `lit-ask` CSS). When selected, apply a highlight class. `+` nodes always get a pointer cursor so users know they are clickable.

## Design Decisions

1. **Id serialization.** Use `formatTerm` — compound atom ids get parentheses and parse back as atoms.
2. **Appended line location.** End of textarea, preceded by a blank line. `execCommand` makes it undoable via ctrl-z.
3. **Clicking `?` twice.** Deselects.
4. **Clicking `+` with no `?` selected.** Silent no-op.
5. **`?` literalType in result.** Preserved as `Ask`; `-` patterns match both `Assert` and `Ask` in the reference.
6. **Server sync.** Normal `input` event path — no special handling needed.
