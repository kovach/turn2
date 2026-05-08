# v2 editor + ttt GUI — standalone page

## Goal

A second, standalone editor page that runs v2 programs (`*.t`, the new
flat syntax) and renders the ttt board next to it. Inspired by the
existing `index.html` + `src/web.ts` + `data/ttt.js` trio, but built on
the v2 evaluator (`runFixpoint`) and the v2 store, not Trees / Ask /
components. The existing v1 editor stays untouched so we can keep
running the legacy program while v2 stabilizes.

## Why a separate page

- The v1 editor depends on the Tree-shaped `root` node, the `Ask`
  pause/resume protocol, and the component/choice model. None of those
  exist in v2 — the v2 evaluator is a one-shot fixpoint over a flat
  tuple store.
- Translating v1 in place would mean stripping out the bits we want to
  keep around. A second page costs nothing and lets us A/B.
- Cutover (and removal of the v1 page) is deferred to the v2 migration
  plan's stage 5.

## Run model

v2 *does* have a native pause-on-choice now (see `plans/redo-choice.md`,
implemented in `ts/src/v2/scheduler.ts` + `fixpoint.ts`). `runFixpoint`
returns a `FixpointStatus` that is one of `done | gas | active-choices |
empty-fringe-error`. The shape of the loop is:

1. User edits source → debounce → `parse` → `runFixpoint(program)` →
   render board + error bar; if `status.kind === "active-choices"`,
   render `status.choices` as click targets.
2. User clicks a cell → we append an `is`-resolution row (see "Choice
   injection" below) → re-`runFixpoint` from scratch → re-render.
3. An "errors" panel shows parse errors and `empty-fringe-error`.
   Treat `gas` as an error too.

Re-running from scratch each turn is fine for ttt (tens of tuples, ~10
iterations). The engine *interface* is resumable (the scheduler pauses
on store contents alone), but the v0 page restarts.

## Choice injection

A `BlockedChoose` row carries a `chooseId` plus one or more `activeTerms`
(fresh `*id …` terms minted by `bindUnbound` for the variables in the
`?` atom). The harness resolves by writing `+ is <activeTerm> <value>`
— per active term. `is` is a regular fact relation; the link between
the resolution row and the choice is by hashcons-token equality on the
active term.

The translated `data/v2/ttt.t` already uses `?`/`!`/`is` (no
placeholder `choose R C` relation). Two ways to wire clicks:

- **(A) source append** — when the user clicks a cell, append
  `^ is <activeTermPrinted> <value>` as a new line at the end of the
  source buffer. Use `^` (anchor marker) so the row's interval is
  `(bot, top)` and is moment-comparable to every other tuple — `is`
  is conceptually timeless. Pros: source is the single source of
  truth, undo is literal text undo, click history is visible. Cons:
  source grows; reset means deleting trailing lines; printed
  `*id` terms are noisy in source.
- **(B) side-channel input list** — keep a separate `inputs: string[]`
  state in the page; before each `runFixpoint`, parse `source +
  "\n" + inputs.join("\n")` together. Pros: clean reset, source stays
  clean, printed fresh-ids don't pollute the user's editor view.
  Cons: two sources of truth, history not in source.

Recommended: **(B)**. The v1 plan recommended (A) by analogy to v1, but
v2 active terms are printed fresh-id forms (e.g.
`(*id turn-rule 0 C ...)`), which look like noise in the editor. Keep
the `is` rows out of the user's source. Add a "reset choices" button
that clears `inputs`.

### Printing the active term

To build the `is` line we must serialise `activeTerm` (a hashconsed
`Term`) back to surface syntax. The test file's `renderTerm` helper
(`ts/src/tests/v2_choice.test.ts:18`) already does this; lift it into
a shared util (`ts/src/v2/print.ts` or similar) and reuse from both
test and editor.

## Layout

Two-pane horizontal split, much simpler than v1:

```
+------------------------------+--------------------------+
| editor (source .t)           | ttt board                |
|                              |                          |
|                              +--------------------------+
|                              | outputs / errors         |
+------------------------------+--------------------------+
```

- Left pane: `<textarea>` with the program source (or CodeMirror, if we
  want syntax highlighting later — out of scope for v0).
- Right top: ttt board (re-uses CSS from `data/ttt.js`).
- Right bottom: errors panel — parse errors, `empty-fringe-error`,
  `gas`, and a small status line (`done` / `active-choices(N)`).
  Note: v2 has no `!`-output sink anymore; "outputs" as a concept is
  gone. If we want a panel of derived facts later, pick a head sym
  convention (e.g. `+ display-line "..."`) and read `store.byHead`.

## Display-module contract (v2)

The v1 contract took `(root, hc, ctx)` where `root` was a Tree and `ctx`
had `components` for live choices. v2 has neither. The new contract:

```ts
type V2DisplayApi = {
  addStyles(css: string): void;
  // Module receives the Store + the latest FixpointStatus and decides
  // what to render. `byHead` lookup goes through store.byHead directly.
};

type V2DisplayResult = {
  element: HTMLElement;
  // Each click maps to a list of `is`-rows the harness should append
  // to its inputs buffer (option B above).
  clicks: Map<HTMLElement, ChoiceInjection>;
};

type ChoiceInjection = {
  // Each entry is one resolution line, ready to parse, e.g.
  //   "^ is (*id turn-rule 0 Cell) (cell (s z) z)"
  asserts: string[];
};
```

The ttt module's `render` function:
- finds `cell R C` tuples (matching the head sym `cell` directly via
  `store.byHead`), renders the 3x3 grid;
- finds `filled (cell R C) M` tuples, fills marks;
- consumes `ctx.components` (the per-component option lists computed
  by the engine; see "Constraint fringe" below). For each component
  with one active term whose options are cell ids, register a click
  per option that injects `^ is <activeTermPrinted> <option>`.

`peek(term, hc)` from v1 maps cleanly to a `peekTerm` helper over
`store.hash` that returns the stored atom for a Ref. Most of the
peano-int and term-equality helpers in the existing `data/ttt.js` carry
over verbatim.

## Files added / touched

- `ts/index-v2.html` — second entry HTML; lighter than `index.html`,
  drops the dual-pane editor layout.
- `ts/src/web-v2.ts` — client bundle. Owns the editor textarea, the
  parse/run cycle, the renderer registration, and the click-injection
  loop. Probably ~250 lines (much smaller than `web.ts` because no
  pause/resume, no component-stepping, no incremental engine).
- `ts/data/v2/ttt-display.js` — v2-shaped display module. Re-uses CSS
  from `data/ttt.js`; new render contract.
- `ts/src/server.ts` — add a route serving `index-v2.html` and the v2
  bundle. (Or: make the page fully static with esbuild + serve from
  `dist/`. Decision: fully static is simpler since v2 has no
  server-side state to keep.)
- `ts/data/v2/ttt.t` — already exists and already uses `?`/`!`/`is`.
  No further changes needed for the editor; the placeholder
  `choose R C` mention in the file's leading comments can be cleaned
  up.
- `ts/src/v2/print.ts` — new. Lift `renderTerm`/`renderAtom` from
  `ts/src/tests/v2_choice.test.ts` so the editor and tests share the
  same surface-syntax printer.

## Bundling

The v1 page already uses esbuild. Add a second entry (`web-v2.ts`)
producing `dist/web-v2.js`. The display module stays as a separate
ES module loaded at runtime via dynamic `import()` so user-supplied
display modules don't need rebuilding — same pattern as v1.

## Things that simplify because of v2

- Pause/resume is store-shaped: `runFixpoint` returns the blocked
  `BlockedChoose[]` directly, no message channel and no component
  stepper.
- No incremental tree → the renderer just walks `store.tuples` /
  `store.byHead`.
- No `Tree`/`Assert`/`Ask` node types → no need to reconstruct a
  parent/child traversal.
- No outputs concept; nothing to render in an outputs panel beyond
  errors and a status line.

## Things that get harder

- The v1 frontmatter `display: ttt.js` was discoverable from the
  loaded `.sl` source. v2 keeps the same convention: a leading
  `-- display: <file>` comment line in the source. `web-v2.ts` greps
  the prefix of `--`-only lines once on each parse.
- Active terms are printed fresh-ids (`(*id <rule> <pos> <var> …)`).
  These are stable within a fixpoint run but ugly. Under option B the
  user never sees them; under option A they would land in source.

## Constraint fringe (general; matches v1)

The engine — not the display — computes the per-active-choice option
lists. Mirrors v1's `ts/src/constraint-query.ts` semantics:

- Build a bipartite graph between unresolved active terms (from
  `choose` rows) and `constrain` rows that mention them.
- BFS to form connected components.
- Empty-fringe error: any component containing an active term but no
  `constrain` rows is a programmer error (an unconstrained `?` —
  surfaced as `FixpointStatus = "empty-fringe-error"`).
- For each kept component, lift the constrain rows to a conjunctive
  query over the v2 store: replace active and existential subterms
  with fresh substitution slots, then run a backtracking match against
  candidate tuples (using `store.byHead`). Collect the joint bindings
  of active terms as deduped option tuples.

`runFixpoint` therefore returns, alongside `BlockedChoose[]`, an array
of `ComponentOptions` (`{ activeTerms, options }`). Display modules
consume that directly and never run their own constraint solver. ttt's
display becomes: "for each component whose options are cell-id
ground terms, draw a click on the matching cell."

## Migration stages (independent of the v2 evaluator stages)

1. Static client-only page that parses and runs `data/v2/ttt.t`,
   renders the board read-only. No clicks yet. Verifies the
   display-module contract and the parse/run loop.
2. Add click → inputs-append (option B) → re-run. End-to-end
   playable. Print fresh-id active terms via the shared `print.ts`
   helper.
3. Add errors / status panel (parse errors, `empty-fringe-error`,
   `gas`, `done`/`active-choices(N)`).
4. Add a "reset choices" button (clears `inputs`).
5. Optional: syntax highlighting / CodeMirror.

## Open items

- **Choice injection style**: A vs B above. Defaulting B now that the
  rows the harness writes are noisy fresh-id forms; revisit if we
  ever stabilise a friendlier surface name for active terms.
- **Display-module discovery**: leading `-- display: <file>` comment,
  matching v1's frontmatter convention. Parsed by a tiny helper in
  the page (no parser changes).
- **Server vs static**: do we still need `server.ts` for v2? With no
  incremental engine state the page can be fully static. Default:
  static; reuse `server.ts` only as a dev-time file server.
- **Re-running and `is` rows**: each click re-runs fixpoint with all
  prior `is` rows still in the inputs buffer. v2 store dedupes so this
  is fine, but if a click should ever *replace* a prior resolution the
  model breaks. Not an issue for ttt (each turn introduces a fresh
  chooseId via `~ turn`).
- **Multi-active-term choices**: ttt's `? Cell` has one active term, so
  one click → one `is` row. A choice with multiple active terms (e.g.
  `? R C`) would need the click to inject one `is` line per active
  term. The display contract above already takes a list (`asserts`),
  so this works; but it imposes structure on the display module.
- **`% display: ...` schema decl**: arguably cleaner than a comment, but
  requires extending the parser. Held until we have a second consumer.
