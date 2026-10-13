// Scenario tests (plans/v2-editor-tests.md): a `.t` fragment that runs on
// top of other files and states what the run must produce.
//
//   -- uses: core.t ext-sweden.t
//   scenario, ~add-piece l3 city
//   -- choose: (cell z z)
//   -- expect: count l3 explorer 1
//   -- expect-not: count l3 explorer 2
//
// The `uses` files are concatenated in order, then the scenario. Saved
// choices in a `uses` file (the `= V…` / `^ is` rows the editor appends on a
// click) are dropped first, so a scenario always starts a fresh game. Each
// `-- choose: <value>` line, in order, answers the next pending choice that
// offers that value (rendered as the editor shows it), exactly as a click
// would: the run is repeated with the `is` rows appended. The final run must
// reach status `done` (no pending choice); each `expect` line must equal
// some tuple of it, and no `expect-not` line may, comparing the rendered
// atom with its interval dropped (compound terms printed), at any time in
// the run. No file access: the caller supplies the `uses` texts, so the web
// editor can pass its unsaved buffer (v2-test-worker.ts).

import { parse } from "./parse.js";
import { runFixpoint } from "./fixpoint.js";
import { compressRefs, renderTerm } from "./print.js";
import type { Store } from "./store.js";
import type { ComponentOptions } from "./types.js";

export interface Scenario {
  uses: string[];
  choose: string[];
  expect: string[];
  expectNot: string[];
}

export interface ScenarioResult {
  // Empty when the scenario passes.
  problems: string[];
  ms: number;
}

// Gas for a scenario run: generous for one game turn, but a looping rule set
// still stops.
export const SCENARIO_GAS = 3000;
export const SCENARIO_TUPLE_GAS = 200000;

export function parseScenario(text: string): Scenario {
  const lines = text.split("\n");
  const after = (prefix: string): string[] =>
    lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
  return {
    uses: after("-- uses:").flatMap((u) => u.split(/\s+/)).filter((u) => u !== ""),
    choose: after("-- choose:"),
    expect: after("-- expect:"),
    expectNot: after("-- expect-not:"),
  };
}

// A scenario is a file with a `-- uses:` line and at least one expectation.
export function isScenario(s: Scenario): boolean {
  return s.uses.length > 0 && s.expect.length + s.expectNot.length > 0;
}

// Drop saved choice rows: each block the editor appends starts at column 0
// with `= V<n> (` or `^ is ` and continues on indented `= V<n>` / `^ is`
// lines (web-v2.ts appendIsRows).
export function stripSavedChoices(src: string): string {
  const start = /^(= V\d+ |\^ is )/;
  const cont = /^\s+(= V\d+ |\^ is )/;
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    if (start.test(line)) inBlock = true;
    else if (!(inBlock && cont.test(line))) inBlock = false;
    if (!inBlock) out.push(line);
  }
  return out.join("\n");
}

// The source rows that answer the pending single-term choice offering
// `want` with that value — what a click appends — or an error message.
export function choiceRows(store: Store, components: ComponentOptions[], want: string): string[] | string {
  const comp = components.find((c) =>
    c.activeTerms.length === 1 && c.options.some((o) => renderTerm(store, o[0]!) === want));
  if (comp === undefined) {
    const offered = components.map((c) => c.options.map((o) => o.map((t) => renderTerm(store, t)).join(",")).join(" | "));
    return `no pending choice offers ${want}; offered: ${offered.join(" ;; ")}`;
  }
  const value = comp.options.find((o) => renderTerm(store, o[0]!) === want)![0]!;
  const { bindings, results } = compressRefs([comp.activeTerms[0]!, value], store);
  return [...bindings, `^ is ${results[0]} ${results[1]}`].map((l, i) => (i === 0 ? l : "  " + l));
}

// Run `text` on its `uses` files, read from `files` by name. A missing file
// is a problem, not a throw, so one broken scenario doesn't stop a batch.
export function runScenario(text: string, files: ReadonlyMap<string, string>): ScenarioResult {
  const t0 = performance.now();
  const done = (problems: string[]): ScenarioResult => ({ problems, ms: performance.now() - t0 });
  const sc = parseScenario(text);
  if (!isScenario(sc)) return done(["needs a -- uses: line and -- expect: lines"]);
  const missing = sc.uses.filter((u) => !files.has(u));
  if (missing.length > 0) return done(missing.map((u) => `missing file: ${u}`));

  let source = [...sc.uses.map((u) => stripSavedChoices(files.get(u)!)), text].join("\n");
  for (let i = 0; ; i++) {
    const parsed = parse(source);
    if ("message" in parsed) return done([`parse error line ${parsed.line}: ${parsed.message}`]);
    let result;
    try {
      result = runFixpoint(parsed, SCENARIO_GAS, SCENARIO_TUPLE_GAS);
    } catch (e) {
      return done([`error: ${(e as Error).message}`]);
    }
    const { store, status } = result;
    const want = sc.choose[i];
    if (want !== undefined) {
      if (status.kind !== "active-choices") return done([`choose ${want}: no pending choice (status ${status.kind})`]);
      const rows = choiceRows(store, status.components, want);
      if (typeof rows === "string") return done([`choose ${want}: ${rows}`]);
      source += "\n" + rows.join("\n") + "\n";
      continue;
    }

    // Render only the relations the expectations name: rendering every tuple
    // is slow (a fresh object renders its whole derivation).
    const heads = new Set([...sc.expect, ...sc.expectNot].map((e) => e.split(" ")[0]!));
    const seen = new Set<string>();
    for (const h of heads) for (const j of store.byHead.get(h) ?? []) {
      const t = store.tuples[j]!;
      seen.add(t.atom.terms.slice(0, -1).map((x) => renderTerm(store, x)).join(" "));
    }
    return done([
      ...(status.kind === "done" ? [] : [`status ${status.kind}`]),
      ...sc.expect.filter((e) => !seen.has(e)).map((e) => `missing: ${e}`),
      ...sc.expectNot.filter((e) => seen.has(e)).map((e) => `present: ${e}`),
    ]);
  }
}
