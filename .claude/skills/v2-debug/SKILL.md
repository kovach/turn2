---
name: v2-debug
description: Inspect how the v2 compiler parses, expands, and evaluates a program using the v2-cli tool. Use when debugging a v2 compiler/expansion bug, when asked how rule expansion was applied to a program, to diff what one expansion pass did, to find which rules emit or match a relation, or to dump the evaluated database for a source file.
---

The `v2-cli` tool (`ts/src/v2-cli.ts`, npm script `v2`) gives CLI access to each
stage of the v2 pipeline (parse → expand → eval). Reach for it instead of writing
a one-off script when diagnosing how the compiler transformed a specific program.

Run from `ts/`:

```
npm run -s v2 -- [flags] [file]        # file arg
cat foo.t | npm run -s v2 -- [flags]   # or stdin (omit file)
```

(`-s` silences npm's own output. Stage output → stdout; run status + filter
notes → stderr.)

## Stages (`--stage`, default `eval`)

Pipeline order: `parse · decompose · split · filter · delta · expand · eval`.

- `parse` — parsed pre-expand IR.
- `decompose` / `split` / `filter` / `delta` — the four `expand` sub-passes, in
  order. `decompose` lowers markers to the post-expand IR (Match/Emit/Le/…),
  `split` slices at every Emit, `filter` drops no-op tails, `delta` clones
  semi-naive variants.
- `expand` — the final expanded program the evaluator consumes (= `delta`).
- `eval` — run to fixpoint, render the resulting store.

## Filters (rule-list stages only — not `eval`; AND-combine)

- `--rule <name>` — keep only the rule with that `#def` name (auto-named rules
  are `r1`, `r2`, … in source order).
- `--emits <sym>` — keep rules that emit/assert relation `<sym>` (its producers).
- `--matches <sym>` — keep rules that match relation `<sym>` (its consumers).
- `--lines` — prefix every atom and `#def` with its source line (`Lnn`), to map
  expanded output back to source.

## Eval output (`--out`, eval stage only)

`tuples` (default; shallow-rendered, safe on big stores) · `timeline`
(`renderTimelineAscii`) · `debug` (share-aware `renderDebugDump` JSON).
`--gas N` / `--tuple-gas N` bound the run (defaults 200 / 5000).

## Recipes

- **How was this rule expanded?**
  `npm run -s v2 -- --stage expand --rule turn --lines foo.t`
- **What did one pass change?** diff adjacent stages:
  `diff <(npm run -s v2 -- --stage split foo.t) <(npm run -s v2 -- --stage filter foo.t)`
- **Who produces / reads a relation?**
  `npm run -s v2 -- --stage expand --emits score foo.t`
  `npm run -s v2 -- --stage expand --matches score foo.t`
- **What does it evaluate to?**
  `npm run -s v2 -- --stage eval foo.t` (or `--out timeline`).

## Notes

- Id templates render structurally with values substituted (e.g.
  `(*mom r2 2 (*chain ?_l_1 ?_r_1) l)`); hashcons `Ref`s stay opaque as `*n`.
- For ad-hoc temp programs, pipe via stdin or write under `ts/src/` — never
  `/tmp` (relative imports break).
