#!/usr/bin/env node
// Rewrite a V8 .cpuprofile to hide frames of given function names,
// reparenting their children onto the nearest surviving ancestor and
// retargeting any self-samples there too.
//
// Usage: node scripts/collapse-frame.mjs <in.cpuprofile> <names> <out.cpuprofile>
//   <names> is a comma-separated list of function names to hide.

import { readFileSync, writeFileSync } from "node:fs";

const [inPath, namesArg, outPath] = process.argv.slice(2);
if (!inPath || !namesArg || !outPath) {
  console.error("usage: collapse-frame.mjs <in.cpuprofile> <name1,name2,...> <out.cpuprofile>");
  process.exit(1);
}

const targets = new Set(namesArg.split(",").map((s) => s.trim()).filter(Boolean));

const p = JSON.parse(readFileSync(inPath, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parentOf = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);

const isTarget = (n) => {
  if (n === undefined) return false;
  const name = n.callFrame?.functionName;
  if (targets.has(name)) return true;
  if ((name === "" || name === undefined) && targets.has("(anonymous)")) return true;
  return false;
};

// Nearest surviving ancestor for each target node.
const redirectTo = new Map();
for (const n of p.nodes) {
  if (!isTarget(n)) continue;
  let pid = parentOf.get(n.id);
  while (pid !== undefined && isTarget(byId.get(pid))) pid = parentOf.get(pid);
  if (pid !== undefined) redirectTo.set(n.id, pid);
}

// Recursively flatten a children list, replacing target nodes with their
// (non-target) descendants.
function expand(childIds, out) {
  for (const cid of childIds) {
    const c = byId.get(cid);
    if (isTarget(c)) expand(c.children ?? [], out);
    else out.push(cid);
  }
}

let moved = 0;
for (const n of p.nodes) {
  if (!isTarget(n)) continue;
  const r = redirectTo.get(n.id);
  if (r !== undefined && n.hitCount) {
    const anc = byId.get(r);
    anc.hitCount = (anc.hitCount ?? 0) + n.hitCount;
    moved += n.hitCount;
  }
}

const survivors = p.nodes.filter((n) => !isTarget(n));
for (const n of survivors) {
  const out = [];
  expand(n.children ?? [], out);
  n.children = out;
}

const remapped = (p.samples ?? []).map((id) => {
  const n = byId.get(id);
  if (!isTarget(n)) return id;
  return redirectTo.get(id) ?? id;
});

p.nodes = survivors;
p.samples = remapped;
writeFileSync(outPath, JSON.stringify(p));

const targetCount = [...byId.values()].filter(isTarget).length;
console.log(`collapsed ${targetCount} nodes matching {${[...targets].join(", ")}}, moved ${moved} self-hits to ancestors`);
console.log(`nodes: ${[...byId.values()].length} -> ${survivors.length}`);
console.log(`wrote ${outPath}`);
