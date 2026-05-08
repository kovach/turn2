# v2: reified `is` insertion via `=` bindings; remove inputs side-channel

Port v1's share-aware `compressRefs` reification (`ts/src/web.ts:475-540`) to
the v2 editor (`ts/src/web-v2.ts`). Click handling for an active-choice
option (and any future click-to-resolve flow) appends a compact reified
block — `= V… (…)` shared-binding lines plus `+ is L R` lines — directly
into the source textarea. Drop the `inputs[]` side-channel buffer and the
"reset choices" button along with it.

## Why

- v2 currently injects choice resolutions as out-of-band `^ is …` lines
  buffered in `inputs[]` and concatenated to the user's source on each run
  (`web-v2.ts:48,260-269`). That is opaque: the resolutions don't appear in
  the editor, can only be cleared via the "reset" button, and don't
  round-trip through file save (the PUT writes `sourceEl.value`, which
  doesn't include `inputs`).
- v1 already solved this by inserting the resolution lines directly into
  the editor textarea (`web.ts:162-168, 542-554`). The user sees the lines,
  edits/deletes them like any other source, and they round-trip via
  ordinary save.
- The new v2 `=` syntax (see `plans/v2-equal.md`) gives us a way to *bind*
  shared subterms once and reference them by short variable names, so a
  reified block stays compact even when the active term and option tuple
  share deep moment chains.

## Surface result

A click on an option line (today: `^ is (*id r5 2 cell) (cell z z)` in
`inputs`) becomes textarea-appended source like:

```

= V1 (*id r5 2 cell)
+ is V1 (cell z z)
```

(or, for the example where multiple resolutions share substructure:)

```

= V1 (*mom r5 2 ...)
= V2 (*id r5 2 cell V1)
+ is V2 (cell z z)
+ is (*id r6 1 marker V1) marker-x
```

The leading blank line is `"\n\n"` per v1 convention so the new lines
become a fresh top-level rule (v2 parser ends rules on blank-line +
column-0 next line).

## Files touched

- `ts/src/web-v2.ts` — main rewrite (see below).
- `ts/index-v2.html` — drop `<button id="reset-btn">`.
- `ts/src/v2/print.ts` — add a share-aware compressing renderer (or keep it
  in `web-v2.ts`; see "Placement").

## Detailed changes — `web-v2.ts`

### Remove

1. Delete `inputs: string[]` (line 48).
2. Delete the `combined = userSource + "\n\n" + inputs.join("\n") …`
   concatenation in `run()` (lines 266-269). `parse(userSource)` directly.
3. Delete `resetBtn` lookup (line 42) and its click handler (lines 375-378).
4. Delete the `inputs (N):` info-pane block (lines 322-323).

### Replace `handleClick`

`handleClick` (line 260) currently pushes asserts to `inputs` and re-runs.
Rewrite it to insert into the textarea — mirror v1's `handleDisplayClick`
(`web.ts:146-168`):

```ts
function handleClick(intent: ChoiceInjection): void {
  if (lastStore === null) return;
  const text = "\n\n" + intent.lines.join("\n");
  sourceEl.focus();
  sourceEl.setSelectionRange(sourceEl.value.length, sourceEl.value.length);
  document.execCommand("insertText", false, text);
  // The "input" event handler already fires from execCommand, so the
  // debounced run + PUT both schedule automatically.
}
```

The injected payload changes from a list of bare `^ is L R` strings to a
list of arbitrary source lines (`= V… …` bindings + `+ is L R` rows). To
make this clear, rename `ChoiceInjection.asserts` → `lines`, and update
the JSON contract in the option-line `data-intent` attribute (line 314)
to match.

### Reified construction

The current `run()` builds asserts as

```ts
`^ is ${renderTerm(store, at)} ${renderTerm(store, opt[j]!)}`
```

(line 312) — `renderTerm` deep-expands every Ref. For atoms with deep
moment chains this produces enormous lines.

Replace with a call to a new helper `compressRefsV2(roots, store)` that
mirrors v1's `compressRefs` (`web.ts:475-540`), but adapted to v2:

- Input: an array of `Term` roots and a v2 `Store`.
- Output: `{ bindings: string[]; results: string[] }`. `bindings` is the
  list of `= V<i> <body>` source lines (in topological / hashcons-id
  ascending order), `results` is the rendered string for each root, using
  variable names where applicable.
- DAG walk: visit each `Ref` at most once via `store.hash.refToAtom`.
  Count refs (root Refs counted as ≥ 2 so they always get a binding).
  Inline non-shared refs at their single use site.
- Naming: `V1, V2, …` in ascending hashcons-id order. v2's hashcons ids
  are bottom-up so this is a valid topological order, same as v1.
- Body wrapping: v1 wraps `Id`-tagged refs as `(@id …)`. v2 has no
  surface-level `@id` form — the parser produces only `Atom` compounds.
  Confirm that v2's hashcons never stores `Id`-tagged refs (the
  defensive `t.tag === "Atom" || t.tag === "Id"` checks in `eval.ts`,
  `scheduler.ts`, `constraint-query.ts` exist only because of the shared
  `../types.ts` Term union; the v2 producers — `intern`, `internAtom`,
  `freshIdTerm`, etc. — only construct `Atom`). Plain `(…)` is safe.
- Rendering of leaf terms: reuse `renderTerm` for the non-Ref path, but
  short-circuit at Refs to either `Vk` or inlined body.

Per click intent, build the block as:

```ts
const N = activeTerms.length;
const roots = [...activeTerms, ...optionTuple];
const { bindings, results } = compressRefsV2(roots, store);
const isLines: string[] = [];
for (let i = 0; i < N; i++) isLines.push(`+ is ${results[i]} ${results[i + N]}`);
const lines = [...bindings, ...isLines];
```

The marker switches from `^ is` to `+ is` to match v1 — `+` is
fact-marker (fresh `l`, `r = top`), which is what choice resolutions
should be. (v2's `^` clones the *current* anchor, which for a top-level
appended rule is `(bot, top)` — basically the same effect, but `+` is
the conventional marker and what v1 emits.)

### `lastStore` capture

`compressRefsV2` needs the current store to expand Refs. Add
`let lastStore: Store | null = null;` and assign it at the end of `run()`
after fixpoint. `handleClick` short-circuits if `lastStore === null` (no
fixpoint has run yet — shouldn't happen post-bootstrap, but cheap to
guard).

### `data-intent` payload

Today the JSON shape is `{ asserts: string[] }` (line 314). Construct the
compressed lines at the moment we render the option list (in `run()`),
so `data-intent` carries `{ lines: string[] }` ready to insert. This
matches v1's flow where `compressRefs` is called once per click rather
than once per option — but v1 calls it inside the click handler because
v1 holds `clickableTerms: Map<key, Term>` and resolves keys at click
time. v2's `data-intent` already serializes the rendered strings, so
do the compression at render time and stash the resulting `lines` in
the JSON.

(Alternative: keep a `clickableIntents: Map<HTMLElement, ChoiceInjection>`
on the side and avoid JSON encoding altogether, like v1's design. Cleaner
but a bigger rewrite. Plan recommends the JSON path for minimal change.)

### Display-module clicks

`display.render(...)` returns `clicks: Map<HTMLElement, ChoiceInjection>`
(line 33, 348). Today the display module fills `ChoiceInjection.asserts`
with deep-expanded lines. After this change, the display module would
need to call `compressRefsV2` itself to produce compressed lines.

Two options:
- (A) Push the compression into `web-v2.ts` and have display modules
  return raw `{ activeTerms, optionTuple }` intents; `web-v2.ts`
  compresses on click. Mirrors v1's `ClickIntent` exactly.
- (B) Expose `compressRefsV2` via the `DisplayApi` so modules can call it.

(A) is cleaner — display modules shouldn't know how reification is
formatted. Plan recommends: rename `ChoiceInjection` → `ClickIntent` with
shape `{ activeTerms: Term[]; optionTuple: Term[] }`, push compression
into `handleClick`. Update the existing `ttt-display.js` (the only
display module today) accordingly. The info-pane option list also moves
to this shape — its on-click handler builds the compressed block from
saved `activeTerms`/`optionTuple` instead of reading pre-baked lines from
`data-intent`.

Storing `Term[]` across the JSON-attribute boundary requires
serializing terms. Two paths:
- (A1) Use a side-table `Map<string, ClickIntent>` keyed by a stable
  click-id; `data-click-id="..."`. Avoids encoding Refs through JSON.
- (A2) Serialize `Term` as JSON (works for Symbol/Variable/Wildcard/Atom;
  `Ref`s would need to round-trip the numeric id, which is fine since
  the same store is live).

Plan recommends **(A1)**: a per-render `Map<string, ClickIntent>` cleared
at the start of each `run()`, keyed by a counter. Same lifetime as the
DOM nodes that reference it. Display-module clicks already use a Map of
HTMLElement → intent (line 347-349), so the info-pane option list is the
only thing that needs the new id-keyed Map.

## Placement

`compressRefsV2` could live in:
- `ts/src/web-v2.ts` — fine, it's UI-level concern; v1 keeps it in
  `web.ts`.
- `ts/src/v2/print.ts` — slightly cleaner since it's near the existing
  printers, and would let tests (Node-side) exercise it without a DOM.

Plan recommends **`ts/src/v2/print.ts`**: export `compressRefs(roots,
store): { bindings, results }`. v1 keeps it in `web.ts` only because v1
has no `print.ts`-equivalent module; v2 does, and there's value in
testing the compression deterministically.

## HTML

Remove `<button id="reset-btn">reset choices</button>` from
`ts/index-v2.html:45`. Drop the corresponding `#reset-btn` CSS rules
(lines 15-16). The header layout (`status-line` margin-left:auto)
auto-rebalances.

## Tests

Add a unit test `ts/src/tests/v2_compress.test.ts` covering
`compressRefs`:

1. **Single root, no sharing**: a flat hashconsed atom — `bindings` is
   one entry (root is Ref so always shared), `results[0] === "V1"`.
2. **Two roots sharing a sub-Ref**: shared subterm gets one `Vk`
   binding; both roots reference it.
3. **Active/option pair with deep moment chain**: an active term `(*id r
   k cell)` and option `(cell z z)` sharing nothing — two top-level
   bindings, no deep expansion in either result.
4. **Round-trip**: feed the produced `bindings ++ "+ is " + results[0] +
   " " + results[1]` back through `parse` and confirm it parses.

(No browser-level tests for the click flow; that's out of scope.)

## Migration notes

- The `inputs` array was the only state distinguishing "fresh source" from
  "source plus pending resolutions". After this change, the whole runtime
  state is the textarea content, so save/load is automatically lossless
  (the resolutions live in the file).
- Existing `data/v2/*.t` files don't contain reified blocks — they will
  the first time a user clicks an option after this lands. That's the
  intended effect.

## Ambiguities / open questions

1. **Compression of in-source `is` / `=` lines re-running.** Once a click
   adds `= V1 …` and `+ is V1 …` to the source, the next fixpoint run
   sees them. The new `=` semantics (plans/v2-equal.md) is per-rule:
   `V1` only binds for the rule it appears in. Since the appended block
   is its own rule (separated by blank lines), `V1` is local and the
   `+ is V1 …` line in that same rule sees the binding. Confirm in a
   round-trip test.

2. **Naming collisions.** If the user has already authored `V1, V2 …` in
   their source, the appended block's variable names don't collide
   (different rule, different scope). Still worth a comment in
   `compressRefs` flagging that the names need only be locally unique.

3. **`+ is` vs `^ is`.** v1 uses `+ is`. v2 today uses `^ is` in
   `web-v2.ts:312`. Plan switches to `+` for parity. Verify nothing in
   the v2 scheduler/constraint-query depends on the *interval* of `is`
   rows (it shouldn't — `is` lookup is purely structural).

4. **`@id` form.** Plan asserts v2 doesn't need `(@id …)` because the
   parser doesn't accept it and the engine doesn't construct `Id`-tagged
   refs. Worth a one-line check in implementation: if any tuple in the
   bootstrap `data/v2/ttt.t` produces an `Id`-tagged Ref after fixpoint,
   `compressRefs` should error loudly rather than silently round-trip an
   un-parseable `(@id …)`.

5. **Display module API change.** Switching `ChoiceInjection` from
   `{ asserts }` to `{ activeTerms, optionTuple }` breaks any existing
   display module. Today only `data/v2/ttt-display.js` exists; update it
   in the same change.
