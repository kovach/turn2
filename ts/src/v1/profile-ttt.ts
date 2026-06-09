import { readFileSync, writeFileSync } from "fs";
import { parseSource, formatTree } from "./parse.js";
import { fixpoint } from "./fixpoint.js";
import { stepStats, resetStepStats } from "./step.js";
import { unifyStats, resetUnifyStats } from "./unify.js";

const source = readFileSync("data/ttt.sl", "utf-8");

const sourceResult = parseSource(source);
if ("message" in sourceResult) {
  console.error("Parse error:", sourceResult.message, "at line", sourceResult.line);
  process.exit(1);
}
const parsed = sourceResult.patterns;

console.log("Parsed", parsed.length, "top-level patterns");
// console.log("--- parsed trees ---");
// console.dir(parsed, { depth: null });
// console.log("--- end parsed trees ---");

const GAS = 100;
const ITERATIONS = 10;

// Warmup
for (let i = 0; i < 5; i++) {
  fixpoint(parsed, GAS);
}

resetStepStats();
resetUnifyStats();
console.time(`fixpoint x${ITERATIONS}`);
let lastResult;
for (let i = 0; i < ITERATIONS; i++) {
  lastResult = fixpoint(parsed, GAS);
}
console.timeEnd(`fixpoint x${ITERATIONS}`);

const { result, steps, hc } = lastResult!;
console.log("Steps:", steps);
console.log("Hashcons entries:", hc.entryCount);

function countNodes(tree: { children: { children: unknown[] }[] }): number {
  let n = 1;
  for (const c of tree.children) n += countNodes(c as typeof tree);
  return n;
}

console.log("Result nodes:", countNodes(result));
console.log("Avg per iteration:", (ITERATIONS > 0 ? "see time above" : "n/a"));

// console.log("--- result ---");
// console.log(formatTree(result));
// console.log("--- end result ---");

const totalAttempts = stepStats.inserted + stepStats.dedupSkipped;
const dedupPct = totalAttempts > 0 ? ((stepStats.dedupSkipped / totalAttempts) * 100).toFixed(1) : "0.0";
console.log(`Step stats (across ${ITERATIONS} timed runs):`);
console.log(`  inserted:       ${stepStats.inserted}`);
console.log(`  dedup-skipped:  ${stepStats.dedupSkipped} (${dedupPct}% of ${totalAttempts} attempts)`);
console.log(`              c:  ${unifyStats.c}`);


//const dupLogPath = "dup-log.txt";
//writeFileSync(dupLogPath, stepStats.dupLog.join("\n") + (stepStats.dupLog.length > 0 ? "\n" : ""));
//console.log(`  wrote ${stepStats.dupLog.length} duplicate entries to ${dupLogPath}`);
