// Run each program with and without moment-lattice max/min; report status,
// tuple counts, lattice-node counts, wall time, and the tuple-set diff size.
import { readFileSync } from "node:fs";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { renderTermShallow } from "../v2/print.js";

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf-8");
  const row: string[] = [file.replace(/.*\//, "").padEnd(22)];
  const sets: Set<string>[] = [];
  for (const lattice of [false, true]) {
    const p = parse(src);
    if ("message" in p) { row.push("parse error"); break; }
    const t0 = performance.now();
    try {
      const { store, status } = runFixpoint(p, 200, 5000, { lattice, random: () => 0 });
      const ms = (performance.now() - t0).toFixed(0);
      const set = new Set(store.tuples.map((t) => t.atom.terms.slice(0, -1).map((x) => renderTermShallow(store, x)).join(" ")));
      sets.push(set);
      row.push(`${lattice ? "lat" : "old"}: ${status.kind} ${store.tuples.length}t ${store.latticeNodes.size}n ${ms}ms`);
    } catch (e) {
      row.push(`${lattice ? "lat" : "old"}: THREW ${(e as Error).message.slice(0, 60)}`);
    }
  }
  if (sets.length === 2) {
    const [a, b] = sets as [Set<string>, Set<string>];
    const lost = [...a].filter((x) => !b.has(x)).length;
    const gained = [...b].filter((x) => !a.has(x)).length;
    row.push(`atoms -${lost} +${gained}`);
  }
  console.log(row.join(" | "));
}
