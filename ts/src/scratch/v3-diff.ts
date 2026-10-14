// usage (from ts/): node --import tsx src/scratch/v3-diff.ts file.t [steps] [first|random] [seed]
import { readFileSync } from "fs";
import { diffRun } from "../v3/diff.js";
const [file, steps = "50", pick = "first", seed = "1"] = process.argv.slice(2);
const r = diffRun(readFileSync(file!, "utf8"), {
  steps: Number(steps), pick: pick as "first" | "random", seed: Number(seed),
  log: process.env.VERBOSE ? (l) => console.log(l) : undefined,
});
for (const m of r.mismatches) console.log(m);
console.log(`${r.ok ? "MATCH" : "MISMATCH"} after ${r.steps} steps (${r.status}); v2 ${r.v2ms.toFixed(0)} ms, v3 ${r.v3ms.toFixed(0)} ms`);
