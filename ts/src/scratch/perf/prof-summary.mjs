// Summarize a .cpuprofile: self time and inclusive time per function.
import { readFileSync } from "fs";
const prof = JSON.parse(readFileSync(process.argv[2], "utf8"));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas; const samples = prof.samples;
const t = new Map();
for (let i = 0; i < samples.length; i++) t.set(samples[i], (t.get(samples[i]) ?? 0) + (dt[i] ?? 0));
const key = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
for (const [id, us] of t) { const k = key(byId.get(id)); self.set(k, (self.get(k) ?? 0) + us); }
// inclusive: walk parents
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map();
for (const [id, us] of t) {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const k = key(byId.get(cur)); if (seen.has(k)) continue; seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + us);
  }
}
const total = [...t.values()].reduce((a, b) => a + b, 0);
const fmt = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)}ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join("\n");
console.log("total", (total / 1000).toFixed(0), "ms\n-- self\n" + fmt(self, 25) + "\n-- inclusive\n" + fmt(incl, 30));
