# Scenario tests in the web editor

Goal: when the web editor runs a file, it also re-runs every scenario test
that uses that file, with the file's current editor buffer (saved or not) in
place of the copy on disk, and shows pass/fail beside the run. The first
suite is the Spirit Island FAQ scenarios (`si/faq/tests`). Misconceptions
stay a command-line check (`faq.test.ts`), not part of the editor.

Constraint: tracked code in `ts/` must not import or read `si/` (memory
`si-project-layout`). Everything below is generic: a scenario format, a
server flag that points at a folder, and an editor view. The FAQ suite is
wired in only by the server command line.

## Today

- `si/faq/faq.test.ts` holds the runner: a scenario's `-- uses: a.t b.t`
  files are concatenated, then the scenario; `runFixpoint` with gas
  3000/200000; `-- expect:` / `-- expect-not:` lines are compared with
  rendered tuples (interval dropped); the status must be `done`.
  Misconceptions are find/replace edits (each `find` exactly once) on a
  `uses` file, and must make each `caught_by` scenario fail with the listed
  problems. All 6 checks take about 0.3 s together.
- The editor (`web-v2.ts`) edits one `.t` file found in `data/v2` or a
  `--v2-data` dir; Ctrl/Cmd+Enter runs it (and the page re-runs after a
  choice click or rng roll). Typing autosaves. `core.t` already opens and
  runs there with `--v2-data ../si`.

## Design

1. **Runner in the engine: `ts/src/v2/scenario.ts`** (no `fs`, so it runs in
   the browser too), the same checks as `faq.test.ts`'s `runScenario`:
   - `parseScenario(text)` gives `{uses, expect, expectNot}`;
   - `runScenario(text, files)` gives `{problems, ms}`.

   `faq.test.ts` is left as it is (it also applies misconception edits); it
   could import the shared module later. A unit test in `ts/src/tests/` uses
   an in-memory scenario.

2. **Server: `--v2-tests <dir>`**, repeatable.
   - `GET /api/v2-tests` returns `{tests: [{name, text}]}`,
     read fresh on each request so new test files show up without a restart.
   - Test dirs join the end of the `findV2` search path, so a scenario opens
     in the editor with `?file=q-….t`.
   - `uses` names resolve through `findV2`, like any editor file. They must be
     bare names; every FAQ test already uses bare names.
   - To launch the SI copy:
     `--v2-data ../si/game --v2-data ../si --v2-tests ../si/faq/tests`.

3. **Worker: `ts/src/v2-test-worker.ts`**, added to `tsconfig.browser.json`.
   - The page posts `{batch, jobs: [{name, text, files}]}`; the worker
     runs the jobs in order and posts each result as it finishes.
   - A new run terminates the worker and starts a fresh one, so a stale batch
     never reports and a runaway scenario can't hang the page.

4. **Editor: after each `run()`** of file F with buffer B:
   - Re-fetch `/api/v2-tests`. Pick the scenarios whose `uses` includes F,
     plus F itself when F is a scenario.
   - Fetch the other `uses` files fresh from `/data/v2/`, since another tab
     may have edited them.
   - Substitute B for F.
   - Hand the batch to the worker.
   - If nothing uses F, the view says so. If no test flags were given, the
     feature stays hidden.

5. **UI**
   - A third button in the result pane's toggle: Database / Timeline /
     **Tests**.
   - A summary chip in the header beside the status line: `tests 3/3`, or
     `tests 2/3 ✗` in the error colour, or `tests …` while running.
   - Each row in the Tests view shows ok / FAIL / running, the name and the
     time, with the problems indented under a failure. Clicking a scenario
     name opens it in a new tab.

6. **Docs:** a short section in `ts/src/v2/overview.md`. In
   `si/faq/DESIGN.md`, the runner section names the shared module and the
   server flags. `si/` is untracked and yours, so I'll only touch it if you
   want.

## Amendment: scripted choices, engine scenarios (2026-10-12)

- `-- choose: <value>` lines answer pending choices in order, by rendered
  value, the way a click does (`choiceRows`, shared with
  `replay-choices.ts`). A test never hardcodes choice-term or moment ids, so
  it stays valid when rules change.
- Saved `is` rows in a `uses` file are dropped (`stripSavedChoices`): the
  editor appends moves to `ttt.t` itself, so without this every scenario
  would inherit whatever game is in progress.
- `data/v2/tests` is always a test dir. The first scenarios are for `ttt.t`:
  three in a row ends the game, and a full board with no winner ends it.
  `v2_scenario.test.ts` runs every scenario there.
- The Tests button and chip show only for a file that some scenario uses.

## Not in this plan (possible follow-ups)

- **Running a scenario file as the main program.** Opening `q-….t` and
  pressing Ctrl+Enter still runs the fragment alone. Prepending its `uses`
  files would show the scenario's game in the timeline, but it shifts every
  source line, so the source links would need an offset.
- **Parallel workers** (one per core) for the full 850-entry suite. At about
  50 ms a scenario, one worker finishes 850 in under a minute, streaming
  results as it goes.
- **Misconceptions in the editor** (left out on purpose).

## Tests

- **Unit:** `parseScenario`, and `runScenario` pass and fail on a tiny
  in-memory program.
- **Headless check** on a throwaway server and throwaway copies of `core.t`:
  - an edit that breaks Defend turns `q-7w4geew` red;
  - an untouched file shows 3/3.

---
Claude Opus 5.5 (claude-opus-5-5)
