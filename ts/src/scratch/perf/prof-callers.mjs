// For each named function, the distribution of its self time by caller chain (2 levels).
import { readFileSync } from "fs";
const [file, ...names] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const t = new Map();
for (let i = 0; i < prof.samples.length; i++) t.set(prof.samples[i], (t.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
const fn = (id) => byId.get(id)?.callFrame.functionName || "(anon)";
for (const name of names) {
  const agg = new Map();
  for (const [id, us] of t) {
    if (fn(id) !== name) continue;
    const p1 = parent.get(id), p2 = parent.get(p1), p3 = parent.get(p2);
    const k = `${fn(p1)} <- ${fn(p2)} <- ${fn(p3)}`;
    agg.set(k, (agg.get(k) ?? 0) + us);
  }
  console.log("== " + name);
  for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)}ms  ${k}`);
}
