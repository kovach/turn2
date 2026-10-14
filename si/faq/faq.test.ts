// Spirit Island FAQ scenarios and misconceptions (si/faq; design in
// DESIGN.md, entry list in TODO.md). Run from si/:
//   node --import tsx faq/faq.test.ts
//
// Scenarios, faq/tests/q-<id>.t, one per Querki FAQ entry: a `-- uses: a.t b.t`
// header names the rule files to run on (paths relative to si/),
// and `-- expect: <tuple>` / `-- expect-not: <tuple>` lines state the FAQ's
// answer. A tuple matches when its rendered atom (compound terms printed,
// interval dropped) equals the line, at any time in the run. Every scenario
// must pass on the real rules.
//
// Misconceptions, faq/misconceptions/<id>.json: text edits to a rule file that
// formalize a wrong reading of the rules. Each must make every scenario in its
// `caught_by` fail, with at least the listed problems.
//
//   FAQ=<substring>    run only scenarios / misconceptions whose name contains it
//   FAQ_DIR=<dir>      read scenarios from another folder (skips misconceptions)

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parse } from "turn/src/v2/parse.js";
import { runFixpoint } from "turn/src/v2/fixpoint.js";
import { renderTerm } from "turn/src/v2/print.js";

const si = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.FAQ_DIR ?? resolve(si, "faq/tests");
const mdir = resolve(si, "faq/misconceptions");
const only = process.env.FAQ;

type Edit = { file: string; find: string; replace: string };
type Misconception = { id: string; misconception: string; caught_by: Record<string, string[]>; edits: Edit[] };

// Run one scenario on its `uses` files, with `edits` applied; returns the
// list of problems (empty when it passes).
function runScenario(name: string, edits: Edit[] = []): string[] {
  const text = readFileSync(resolve(dir, name), "utf-8");
  const lines = text.split("\n");
  const uses = lines.find((l) => l.startsWith("-- uses:"))?.slice(8).trim().split(/\s+/) ?? [];
  const expect = lines.filter((l) => l.startsWith("-- expect:")).map((l) => l.slice(10).trim());
  const expectNot = lines.filter((l) => l.startsWith("-- expect-not:")).map((l) => l.slice(14).trim());
  assert.ok(uses.length > 0 && expect.length + expectNot.length > 0, `${name}: needs -- uses: and -- expect: lines`);

  for (const e of edits) assert.ok(uses.includes(e.file), `${name} does not use ${e.file}`);
  const files = uses.map((u) => {
    let src = readFileSync(resolve(si, u), "utf-8");
    for (const e of edits.filter((e) => e.file === u)) {
      assert.equal(src.split(e.find).length, 2, `edit to ${u} must match exactly once: ${JSON.stringify(e.find.slice(0, 60))}`);
      src = src.replace(e.find, () => e.replace);
    }
    return src;
  });
  const parsed = parse([...files, text].join("\n"));
  if ("message" in parsed) return [`parse error line ${parsed.line}: ${parsed.message}`];
  const { store, status } = runFixpoint(parsed, 3000, 200000);

  // only the relations the expectations name (rendering every tuple is slow)
  const heads = new Set([...expect, ...expectNot].map((e) => e.split(" ")[0]!));
  const seen = new Set<string>();
  for (const h of heads) for (const i of store.byHead.get(h) ?? []) {
    const t = store.tuples[i]!;
    seen.add(t.atom.terms.slice(0, -1).map((x) => renderTerm(store, x)).join(" "));
  }
  return [
    ...(status.kind === "done" ? [] : [`status ${status.kind}`]),
    ...expect.filter((e) => !seen.has(e)).map((e) => `missing: ${e}`),
    ...expectNot.filter((e) => seen.has(e)).map((e) => `present: ${e}`),
  ];
}

let failed = 0;
console.log("    scenarios (must pass)");
for (const name of readdirSync(dir).filter((f) => f.endsWith(".t")).sort()) {
  if (only && !name.includes(only)) continue;
  const problems = runScenario(name);
  console.log(`      ${problems.length ? "FAIL" : "ok  "} ${name}`);
  for (const p of problems) console.log(`           ${p}`);
  if (problems.length) failed++;
}

if (!process.env.FAQ_DIR) {
  console.log("    misconceptions (must be caught)");
  for (const file of readdirSync(mdir).filter((f) => f.endsWith(".json")).sort()) {
    const m: Misconception = JSON.parse(readFileSync(resolve(mdir, file), "utf-8"));
    assert.equal(`${m.id}.json`, file, `${file}: id must match the file name`);
    for (const [q, want] of Object.entries(m.caught_by)) {
      if (only && !m.id.includes(only) && !q.includes(only)) continue;
      const problems = runScenario(`${q}.t`, m.edits);
      const unmet = want.filter((w) => !problems.includes(w));
      const ok = problems.length > 0 && unmet.length === 0;
      console.log(`      ${ok ? "ok  " : "FAIL"} ${m.id} caught by ${q}${ok ? ` (${problems.length} problems)` : ""}`);
      if (!problems.length) console.log("           scenario still passes");
      for (const w of unmet) console.log(`           expected problem not seen: ${w}`);
      if (!ok) failed++;
    }
  }
}
assert.equal(failed, 0, `${failed} FAQ check(s) failed`);
