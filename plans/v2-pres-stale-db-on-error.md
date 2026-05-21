# v2 pres — show last valid run when editor text is invalid

Goal: in presentation mode, when the editor's current source fails to
parse (or hits the gas cap), keep displaying the db/timeline from the
most recent successful run instead of overwriting them with an error
message. Surface the error in a dedicated strip attached to the editor.

Locus: `ts/src/pres/render.ts` — `runAndRender`, `mountActive`,
`ActiveBlock`.

## State

Add to `ActiveBlock`:

- `lastValidStore: Store | null` — most recent fixpoint result that
  completed without parse/gas failure. Lives for the lifetime of the
  active block (cleared on `teardownActive`, naturally).
- A reference to the new error-strip element (or look it up via class
  inside the editor host; either is fine).

## DOM

Append a `<div class="pres-parse-error">` **after** the existing
`outBox` (so it sits below the db/timeline), hidden by default
(`display: none` until populated). Placing it last avoids layout shift:
toggling its visibility doesn't push the db/timeline up and down.

CSS: red-ish background, monospace, one-line height with horizontal
overflow.

## Flow

Rewrite `runAndRender` (signature changes to take `active: ActiveBlock`
rather than the loose `hosts`/`enabled` pair):

1. `const parsed = parseV2(source)`.
2. If `"message" in parsed`: leave `hosts.timeline` and `hosts.tuples`
   untouched, populate the error strip with `parse error line N: …`,
   unhide it. (Optionally tag `pres-output` with a `stale` class so the
   user sees that what they're looking at is not the live source.)
   Return.
3. `const { store, status } = runFixpoint(parsed, …)`.
4. If `status.kind === "gas"`: same fallthrough — error strip gets
   `gas exceeded (N iterations)`, hosts left intact. Return.
5. Success: hide the error strip, remove the `stale` class, set
   `active.lastValidStore = store`, render into hosts via a factored
   `renderIntoHosts(store, hosts, enabled)`.

### Initial render

On the very first call from `mountActive`, `lastValidStore` is `null`.
Rather than special-casing this with a placeholder, **initialize
`lastValidStore` to an empty `Store`** (e.g. construct one with
`makeStore()` or whatever the empty constructor is) and render it
through the normal path before the first user-driven `runOnce` fires.
Result: on a parse error in the seed text, the user sees an empty
db/timeline and the parse error in the strip — no extra branching.

## Toggle interaction

`toggleFn` currently calls `runOnce(editor.value)` when a host becomes
enabled — which re-evaluates the (possibly broken) current source.
Change it to render `active.lastValidStore` into the newly enabled host
instead. The factored `renderIntoHosts` handles both cases identically.

## Step-by-step

1. Factor `renderIntoHosts(store, hosts, enabled)` out of the current
   success branch in `runAndRender`.
2. Add `lastValidStore: Store | null` to `ActiveBlock` and an
   `errorStrip: HTMLElement` field (or expose via a closure).
3. Build the `pres-parse-error` div in `mountActive` and add CSS in
   the relevant stylesheet.
4. In `mountActive`, create an empty `Store` and assign it to
   `lastValidStore` before the first `runOnce`. (Confirms the seed
   path's behavior.)
5. Rewrite `runAndRender` to take `active` and implement the flow
   above; delete `showError`.
6. Update `toggleFn` to render `lastValidStore` via
   `renderIntoHosts` rather than re-running.
7. Wire `mountActive`'s callers (initial run, debounced onChange,
   toggle) to the new signature.

## Out of scope

- Persisting last-valid across slide changes — dies with the active
  block, same as the editor's runtime state.
- Highlighting the offending line inside the editor.
- Differentiating parse error vs gas error styling — same strip,
  different prefixes.

## Tradeoffs

- Users might not notice immediately that the db/timeline is stale;
  the visible error strip + `stale` class on `pres-output` mitigate.
- Toggling a host on while broken now shows the last-valid render
  instead of an empty pane. This is the whole point — the stale
  indicator keeps it honest.
