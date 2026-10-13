import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenario, runScenario, stripSavedChoices } from "../v2/scenario.js";

// A scenario on top of a one-rule base file.
const base = `go, ~ravage
ravage, ~damage l1 2
`;
const files = new Map([["base.t", base]]);

// 1) parseScenario: uses (one or more lines), expect, expect-not.
{
  const s = parseScenario("-- uses: a.t b.t\n-- uses: c.t\n-- expect: x 1\n-- expect-not: x 2\n~go\n");
  assert.deepEqual(s, { uses: ["a.t", "b.t", "c.t"], choose: [], expect: ["x 1"], expectNot: ["x 2"] });
}

// 2) A passing scenario: base rules run, then the fragment.
{
  const r = runScenario("-- uses: base.t\n-- expect: damage l1 2\n-- expect-not: damage l1 3\n~go\n", files);
  assert.deepEqual(r.problems, []);
}

// 3) Failing expectations are reported, both kinds.
{
  const r = runScenario("-- uses: base.t\n-- expect: damage l1 3\n-- expect-not: damage l1 2\n~go\n", files);
  assert.deepEqual(r.problems, ["missing: damage l1 3", "present: damage l1 2"]);
}

// 4) The caller's text for a `uses` file is what runs (the editor buffer).
{
  const edited = new Map([["base.t", base.replace("l1 2", "l1 3")]]);
  const r = runScenario("-- uses: base.t\n-- expect: damage l1 2\n~go\n", edited);
  assert.deepEqual(r.problems, ["missing: damage l1 2"]);
}

// 5) Missing file, parse error, and a fragment without expectations.
{
  assert.deepEqual(runScenario("-- uses: nope.t\n-- expect: x\n", files).problems, ["missing file: nope.t"]);
  assert.match(runScenario("-- uses: base.t\n-- expect: x\n(((\n", files).problems[0]!, /^parse error line/);
  assert.equal(runScenario("~go\n", files).problems.length, 1);
}

// 6) A run that doesn't finish is a problem.
{
  const loop = new Map([["loop.t", "#js-def plus +A +B -C { yield [A + B] }\nn X, plus X 1 Y, ~n Y\n"]]);
  const r = runScenario("-- uses: loop.t\n-- expect: n 1\n~n 1\n", loop);
  assert.ok(r.problems.includes("status gas"), r.problems.join("; "));
}

// 7) Saved choice rows (what the editor appends on a click) are dropped from
// `uses` files; other lines, including indented rule bodies, stay.
{
  const src = "a, ~b\n  ~c\n\n= V1 (*chain)\n  = V2 (*mom r1 1 V1 l)\n  ^ is V2 x\n^ is V3 y\nd, ~e\n";
  assert.equal(stripSavedChoices(src), "a, ~b\n  ~c\n\nd, ~e\n");
}

// 8) `-- choose:` answers pending choices in order, like clicks; a value no
// pending choice offers, or a choose after the game ended, is a problem.
{
  const pick = new Map([["pick.t", "~main\n  ~setup;\n  ~go\nsetup, +opt a, +opt b\ngo\n  ?C\n  !(opt C)\n  ~picked C\npicked C, is C X, ~chose X\n"]]);
  assert.deepEqual(runScenario("-- uses: pick.t\n-- choose: b\n-- expect: chose b\n", pick).problems, []);
  assert.deepEqual(runScenario("-- uses: pick.t\n-- expect: chose b\n", pick).problems,
    ["status active-choices", "missing: chose b"]);
  assert.match(runScenario("-- uses: pick.t\n-- choose: c\n-- expect: chose c\n", pick).problems[0]!,
    /^choose c: no pending choice offers c; offered: /);
  assert.deepEqual(runScenario("-- uses: pick.t\n-- choose: a\n-- choose: b\n-- expect: chose a\n", pick).problems,
    ["choose b: no pending choice (status done)"]);
}

// 9) The engine's own scenarios (data/v2/tests) pass on data/v2 — the same
// ones the editor's Tests view runs.
const v2 = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/v2");
const read = (dir: string, name: string): string => readFileSync(resolve(dir, name), "utf8");
const dataFiles = (text: string): Map<string, string> =>
  new Map(parseScenario(text).uses.map((u) => [u, read(v2, u)] as [string, string]));
for (const name of readdirSync(resolve(v2, "tests")).filter((f) => f.endsWith(".t"))) {
  const text = read(resolve(v2, "tests"), name);
  assert.deepEqual(runScenario(text, dataFiles(text)).problems, [], name);
}

// 10) ...and they catch the bugs they are about: without the `not winner _`
// guard the game asks for a move after o's row.
{
  const text = read(resolve(v2, "tests"), "ttt-row-ends-game.t");
  const files = dataFiles(text);
  const ttt = files.get("ttt.t")!;
  assert.equal(ttt.split("  not winner _\n").length, 2);
  files.set("ttt.t", ttt.replace("  not winner _\n", ""));
  assert.deepEqual(runScenario(text, files).problems, ["status active-choices"]);
}

console.log("v2_scenario: ok");
