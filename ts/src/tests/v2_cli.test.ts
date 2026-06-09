import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { expandStages } from "../v2/expand.js";
import { renderProgram } from "../v2/print-ir.js";
import { STAGES, runStage, DEFAULT_OPTIONS, type RunOptions } from "../v2-cli.js";

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

const SOURCE = `~game

game, ~turn

turn, +score 1
`;

const OPTS: RunOptions = { ...DEFAULT_OPTIONS };

// --- expandStages exposes the four intermediates ---
{
  const parsed = ok(SOURCE);
  const stages = expandStages(parsed);
  for (const key of ["decomposed", "split", "filtered", "variants"] as const) {
    assert.ok(Array.isArray(stages[key]), `${key} is an array`);
    assert.doesNotThrow(() => renderProgram({ ...parsed, rules: stages[key] }));
  }
  console.log("PASS: expandStages returns four renderable intermediates");
}

// --- completeness: every declared stage produces non-empty output and never
// falls into runStage's `never` default ---
{
  const parsed = ok(SOURCE);
  for (const stage of STAGES) {
    const out = runStage(stage, parsed, OPTS);
    assert.equal(typeof out, "string", `stage ${stage} returns a string`);
    assert.ok(out.length > 0, `stage ${stage} produced non-empty output`);
  }
  console.log("PASS: every STAGE produces output via runStage");
}

// --- filters: --emits / --matches / --rule narrow the rule list ---
{
  const parsed = ok(SOURCE);
  // `turn` is matched by the score rule and emitted by the game rule.
  const emitsTurn = runStage("expand", parsed, { ...OPTS, emits: "turn" });
  const matchesTurn = runStage("expand", parsed, { ...OPTS, matches: "turn" });
  assert.ok(emitsTurn.includes("Emit turn"), `--emits turn keeps the producer:\n${emitsTurn}`);
  assert.ok(!emitsTurn.includes("Emit score"), "--emits turn drops the score rule");
  assert.ok(matchesTurn.includes("Match[delta] turn"), `--matches turn keeps the consumer:\n${matchesTurn}`);
  assert.ok(!matchesTurn.includes("Emit game"), "--matches turn drops the game rule");
  // A filter that matches nothing yields an empty rule body.
  const none = runStage("expand", parsed, { ...OPTS, emits: "nonexistent" });
  assert.ok(!none.includes("#def"), `no-match filter prints no rules:\n${none}`);
  console.log("PASS: --emits/--matches filter the rule list");
}

// --- --lines annotates atoms with source line numbers ---
{
  const parsed = ok(SOURCE);
  const out = runStage("parse", parsed, { ...OPTS, lines: true });
  assert.match(out, /L\d+/, `--lines emits Lnn tags:\n${out}`);
  console.log("PASS: --lines annotates source lines");
}

// --- eval stage reaches a fixpoint ('done') on this program ---
{
  const parsed = ok(SOURCE);
  const out = runStage("eval", parsed, OPTS);
  assert.ok(out.includes("score"), `eval tuples mention emitted relation: ${out}`);
  console.log("PASS: eval stage renders store tuples");
}
