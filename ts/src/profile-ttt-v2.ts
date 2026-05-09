import { readFileSync } from "fs";
import { parse } from "./v2/parse.js";
import { runFixpoint } from "./v2/fixpoint.js";
import { formatReport } from "./v2/stats.js";

const source = readFileSync("data/v2/ttt.t", "utf-8");

const parsed = parse(source);
if ("message" in parsed) {
  console.error("Parse error:", parsed.message);
  process.exit(1);
}

const GAS = 100;
const TUPLE_GAS = 5000;
const ITERATIONS = 10;

// Warm-up runs (no stats — keep V8 honest, avoid measuring the JIT).
for (let i = 0; i < 5; i++) {
  runFixpoint(parsed, GAS, TUPLE_GAS);
}

let lastResult;
const t0 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  lastResult = runFixpoint(parsed, GAS, TUPLE_GAS, { stats: true });
}
const totalMs = performance.now() - t0;

console.log(`tuples: ${lastResult!.store.tuples.length}`);
console.log(`total: ${totalMs.toFixed(2)} ms over ${ITERATIONS} runs (${(totalMs / ITERATIONS).toFixed(2)} ms/run)`);
console.log("");
console.log(formatReport(lastResult!.store.stats));
