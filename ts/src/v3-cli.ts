// v3 command line: run a Turn program with the procedural evaluator.
//
//   node --import tsx src/v3-cli.ts file.t [options]
//     --answers N      answer up to N choice components automatically (default 0)
//     --pick first|random   how to answer (default first; random uses --seed)
//     --seed N         seed for --pick random and for ?[rng] choices
//     --gas N          tuple budget (default 1000000)
//     --report         per-rule lookup/subscription report instead of running
//     --acc            print acc rows at the end (at top, or at the pending choice)
//     --quiet          print only the status line
//   A program on stdin when no file is given.

import { readFileSync } from "fs";
import { parse } from "./v2/parse.js";
import { Runtime, type Status } from "./v3/runtime.js";
import { dumpAcc, dumpTuples, showComponent, showReport } from "./v3/print.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : dflt;
};
const valued = new Set(["--answers", "--pick", "--seed", "--gas"]);
const file = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
const src = file !== undefined ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
const program = parse(src);
if ("message" in program) {
  console.error(`parse error line ${program.line}: ${program.message}`);
  process.exit(1);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = Number(opt("--seed", "1"));
const rt = new Runtime(program, { tupleGas: Number(opt("--gas", "1000000")), random: argv.includes("--seed") ? mulberry(seed) : undefined });
if (flag("--report")) {
  for (const l of showReport(rt)) console.log(l);
  process.exit(0);
}

const pickRandom = opt("--pick", "first") === "random";
const pickRng = mulberry(seed + 1);
let answers = Number(opt("--answers", "0"));
const t0 = performance.now();
let status: Status = rt.run();
let answered = 0;
while (status.kind === "choices" && answers > 0) {
  const comp = status.components[0]!;
  const option = pickRandom ? comp.options[Math.floor(pickRng() * comp.options.length)]! : comp.options[0]!;
  if (!flag("--quiet")) console.log(`${showComponent(rt, comp)}\n  -> ${option.map((v) => rt.terms.show(v)).join(" ")}`);
  rt.answer(comp, option);
  answers--;
  answered++;
  status = rt.run();
}
const ms = performance.now() - t0;

for (const w of rt.warnings) console.error(`warning: ${w}`);
if (!flag("--quiet")) {
  for (const l of dumpTuples(rt, { episodes: false })) console.log(l);
  if (flag("--acc")) {
    const m = status.kind === "choices" ? status.components[0]!.moment : rt.mom.top;
    console.log("-- acc");
    for (const l of dumpAcc(rt, m)) console.log(l);
  }
}
if (status.kind === "choices") for (const c of status.components) console.log(showComponent(rt, c));
const detail = status.kind === "error" ? `: ${status.message}` : status.kind === "gas" ? ` (${status.tuples} tuples)` : "";
console.log(`status: ${status.kind}${detail}; ${answered} answered; ${rt.tuplesStored} tuples, ${rt.frames.length} frames, ${rt.mom.all.length} moments; ${ms.toFixed(1)} ms`);
