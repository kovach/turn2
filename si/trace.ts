// Print the tuples of the named relations, compound arguments rendered.
//   node --import tsx trace.ts <file.t> <rel,rel,...> [gas]
import { readFileSync } from "fs";
import { parse } from "turn/src/v2/parse.js";
import { runFixpoint } from "turn/src/v2/fixpoint.js";
import { renderTerm } from "turn/src/v2/print.js";

const [file, rels, gas] = process.argv.slice(2);
const want = new Set(rels!.split(","));
const parsed = parse(readFileSync(file!, "utf8"));
if ("message" in parsed) { console.log("parse error", parsed); process.exit(1); }
const r = runFixpoint(parsed, Number(gas ?? 3000), 200000);
console.log("status", r.status.kind);
for (const t of r.store.tuples) {
  const h = t.atom.terms[0];
  if (h?.tag !== "Symbol" || !want.has((h as any).name)) continue;
  console.log(t.atom.terms.slice(0, -1).map((x) => renderTerm(r.store, x)).join(" "));
}
