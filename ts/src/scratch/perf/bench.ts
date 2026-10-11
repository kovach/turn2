// Time runFixpoint on a Turn file: node --import tsx bench.ts <file> [gas] [tupleGas]
import { readFileSync } from "fs";
import { parse } from "../../v2/parse.js";
import { runFixpoint } from "../../v2/fixpoint.js";
const src = readFileSync(process.argv[2]!, "utf8");
const t0 = performance.now();
const parsed = parse(src);
if ("message" in parsed) throw new Error(parsed.message);
const t1 = performance.now();
const r = runFixpoint(parsed, Number(process.argv[3] ?? 20000), Number(process.argv[4] ?? 600000));
const t2 = performance.now();
const heads = new Map<string, number>();
for (const t of r.store.tuples) { const h = t.atom.terms[0] as any; const k = h?.name ?? "?"; heads.set(k, (heads.get(k) ?? 0) + 1); }
console.log(JSON.stringify({ status: r.status.kind, iters: r.iterations, tuples: r.store.tuples.length,
  parseMs: Math.round(t1 - t0), runMs: Math.round(t2 - t1),
  top: [...heads].sort((a, b) => b[1] - a[1]).slice(0, 8) }));
