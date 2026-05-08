import { readFileSync } from "fs";
import { parse } from "./v2/parse.js";
import { runFixpoint } from "./v2/fixpoint.js";

const source = readFileSync("data/v2/ttt.t", "utf-8");

const parsed = parse(source);
if ("message" in parsed) {
  console.error("Parse error:", parsed.message);
  process.exit(1);
}

const GAS = 100;
const TUPLE_GAS = 5000;
const ITERATIONS = 10;

for (let i = 0; i < 5; i++) {
  runFixpoint(parsed, GAS, TUPLE_GAS);
}

let lastResult;
for (let i = 0; i < ITERATIONS; i++) {
  lastResult = runFixpoint(parsed, GAS, TUPLE_GAS);
}

console.log(lastResult!.store.tuples.length);
