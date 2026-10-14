// One finished game, timed both ways: v2 replays the whole saved game in one
// run (its normal harness re-runs like this after every answer); v3 plays it
// incrementally from the start. Usage (from ts/):
//   node --import tsx src/scratch/v3-bench.ts file.t [seed] [steps]
import { readFileSync } from "fs";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { diffRun, prepareSource } from "../v3/diff.js";
import { Runtime } from "../v3/runtime.js";
const [file, seed = "1", steps = "400"] = process.argv.slice(2);
const src = readFileSync(file!, "utf8");
const d = diffRun(src, { steps: Number(steps), pick: "random", seed: Number(seed) });
const best = (f: () => void) => { let b = Infinity; for (let i = 0; i < 5; i++) { const t0 = performance.now(); f(); b = Math.min(b, performance.now() - t0); } return b; };
const p2 = parse(d.source2);
if ("message" in p2) throw new Error(p2.message);
let tuples2 = 0;
const v2 = best(() => { tuples2 = runFixpoint(p2, 20000, 1_000_000).store.tuples.length; });
const p3 = parse(prepareSource(src));
if ("message" in p3) throw new Error(p3.message);
let tuples3 = 0;
const v3 = best(() => {
  const rt = new Runtime(p3);
  let s = rt.run();
  for (const a of d.answers3) {
    if (s.kind !== "choices") throw new Error("replay diverged");
    const c = s.components[a.comp]!;
    rt.answer(c, c.options[a.option]!);
    s = rt.run();
  }
  tuples3 = rt.tuplesStored;
});
console.log(`${file!.split("/").pop()} seed ${seed}: ${d.ok ? "match" : "MISMATCH"}, ${d.answers3.length} answers; v2 replay ${v2.toFixed(1)} ms (${tuples2} tuples), v3 game ${v3.toFixed(1)} ms (${tuples3} tuples), ${(v2 / v3).toFixed(1)}x`);
