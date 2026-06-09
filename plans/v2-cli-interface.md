# v2 CLI interface

Goal: a standalone script giving command-line access to the v2 compilation /
evaluation pipeline, with a `--stage` flag selecting which point of the
pipeline to dump, reading source from a file argument or stdin.

## Background

The v2 pipeline (see `ts/src/v2/overview.md`): **parse → expand → fixpoint eval
(store) → render**. Relevant entry points:

- `parse(input: string): Program | ParseError` — `ts/src/v2/parse.ts` (no hashconsing)
- `expand(program: Program): Program` — `ts/src/v2/expand.ts`. Internally:
  `decomposeRule` + `pruneChains` → `splitRule` → dead-slice `filter` →
  `generateDeltaVariants`. Only `generateDeltaVariants` is currently exported;
  `decomposeRule` and `splitRule` are module-private.
- `runFixpoint(program, gas?, tupleGas?, {stats?}): FixpointResult` —
  `ts/src/v2/fixpoint.ts`. `expand()` is called inside `runFixpoint`, so the
  CLI should not pre-expand before evaluating.
- Store renderers: `renderTimelineAscii(store, opts)` (`timeline.ts`),
  `renderDebugDump(store)` (`print.ts`), and the per-tuple loop pattern in
  `src/v2-ascii-demo.ts` (`renderAtom`/`renderTerm` over `store.tuples`).

Existing standalone scripts (`src/v2-ascii-demo.ts`, `src/profile-ttt-v2.ts`)
establish the convention: a plain `tsx`-run `.ts` file under `src/` importing
from `./v2/*.js`, exiting non-zero on parse error. Do **not** place the script
in `/tmp` (relative imports break — see CLAUDE.md).

## Gap: no text renderer for the IR

`renderTerm`/`renderAtom` operate on **hashconsed** terms via a `Store`. The
parse output (pre-expand `Program`) and the expanded `Program` are plain
`Rule`/`RuleAtom` structures over **raw** (un-hashconsed) `Term`s — there is no
renderer for them today. (The memory note's `renderAtomDebug`/`renderTermDebug`
no longer exist in `print.ts`.) The CLI's parse/expand stages need one.

## Plan

### 1. Expose expand sub-stages — `ts/src/v2/expand.ts`

Refactor so the named intermediates are reachable without duplicating logic:

- Add `export function expandStages(program: Program): { decomposed: Rule[];
  split: Rule[]; filtered: Rule[]; variants: Rule[] }` that runs the four steps
  and returns each intermediate.
- Reimplement `expand()` as `return { rules: expandStages(program).variants,
  schema: program.schema, jsDefs: program.jsDefs }` so there is a single source
  of truth.

### 2. IR text renderer — new `ts/src/v2/print-ir.ts`

A DOM-free, Store-free renderer for raw `Rule`/`RuleAtom`/`Term` values:

- `renderTermRaw(term: Term): string` — walk the raw `Term` algebra
  (`Variable`/`Symbol`/`Compound`/`Ref`/`Id`), honoring the id-opacity invariant
  documented at the top of `print.ts` (ids render as opaque handles, never
  unfolded).
- `renderRuleAtom(atom: RuleAtom): string` — one line per atom tag
  (`Atom`/`Sub`/`Equal`/`JsCall`/`Match`/`Emit`/`Le`/`AssertLt`/`Max`/`Min`),
  showing `MatchConstraint` (`delta`/`old`/`any`) on `Match`.
- `renderRule(rule: Rule): string` and `renderProgram(program: Program):
  string` — `#def`-style header + indented atom lines + schema decls.

This is debug output, not required to round-trip through `parse`. Keep it
linear in node count.

### 3. Reify the stage set — in `ts/src/v2-cli.ts`

The set of stages is the single thing future pipeline changes must keep the CLI
in sync with, so make it a typed, enumerable value rather than scattered string
literals:

- A `const STAGES = [...] as const` ordered list (pipeline order) and a derived
  `type Stage = typeof STAGES[number]`. Stages:
  `"parse" | "decompose" | "split" | "filter" | "delta" | "expand" | "eval"`.
  `STAGES` doubles as the source for `--stage` validation and the usage message
  (no second hand-maintained list).
- A single `runStage(stage: Stage, parsed: Program, opts): string` dispatcher
  built as a `switch (stage)` whose `default:` branch is
  `const _exhaustive: never = stage; throw new Error(...)`. Adding a new member
  to `STAGES` without a matching `case` is then a **compile error** — the CLI
  cannot silently fall out of date.

### 4. The CLI script — `ts/src/v2-cli.ts` (continued)

- **Input**: first non-flag arg is a file path; if absent, read stdin
  (`readFileSync(0, "utf-8")`).
- **Flags**:
  - `--stage <name>` (default `eval`); validated against `STAGES`. Per-stage
    behavior inside `runStage`:
    - `parse` → `renderProgram(parsed)`
    - `decompose`, `split`, `filter`, `delta` → render the matching field of
      `expandStages(parsed)`
    - `expand` → the final expanded program (`expand(parsed)`; equivalently the
      `delta` field of `expandStages`)
    - `eval` → `runFixpoint(parsed)`, then render the store
  - `--gas N`, `--tuple-gas N` — forwarded to `runFixpoint` (defaults 200 / 5000).
  - `--out <fmt>` for the `eval` stage: `tuples` (default; the
    `renderAtom`-per-tuple listing), `timeline` (`renderTimelineAscii`), `debug`
    (`renderDebugDump`, JSON-stringified). Print `status.kind` to stderr.
- On `ParseError`, print `{line, message}` to stderr and `process.exit(1)`.
- Unknown `--stage` value (not in `STAGES`) → usage message built from `STAGES`,
  exit 1.

### 5. npm script — `ts/package.json`

Add `"v2": "tsx src/v2-cli.ts"` so usage is `npm run v2 -- --stage expand foo.t`
(or piped: `cat foo.t | npm run v2 -- --stage parse`).

### 6. Tests — new `ts/src/tests/v2_cli.test.ts`

Follow the existing `src/tests/*.test.ts` assert-based style. Export `STAGES`
and `runStage` from `v2-cli.ts` so they can be driven directly. Cover:

- **Completeness over every stage**: iterate `STAGES` and assert
  `runStage(stage, parsed, defaults)` returns non-empty output for a small
  program (and does not throw / does not hit the `never` default). This is the
  guard the requirement asks for — a newly added stage that `runStage` forgets
  to handle fails this test (and already fails to compile via the `never`
  branch). The static check is the primary guarantee; this test backs it at
  runtime and confirms each stage actually produces output.
- `expandStages` returns four non-throwing intermediates for that program.
- `--stage eval` on a tiny source yields the expected `status.kind`.

(Test the underlying functions directly; optionally shell out to the CLI for
one stdin smoke test.)

### 7. Docs

- Update `ts/src/v2/overview.md`: add a `# print-ir.ts` section, and note the
  new `expandStages` export under `# expand.ts`. (The CLI script `src/v2-cli.ts`
  lives outside `src/v2/`, so mention it in passing rather than as a section —
  matching how `overview.md` scopes itself to `ts/src/v2/`.)

## Out of scope

- Round-trippable surface-syntax printing of the IR (debug rendering only).
- Watch mode / a long-lived server (covered by the existing `watch`/`serve`
  scripts).
