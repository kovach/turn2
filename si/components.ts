// Print the pending choice components of a Turn file, as the web page sees them.
import { readFileSync } from "fs";
import { parse } from "turn/src/v2/parse.js";
import { runFixpoint } from "turn/src/v2/fixpoint.js";
import { renderTerm } from "turn/src/v2/print.js";

const src = readFileSync(process.argv[2]!, "utf8");
const parsed = parse(src);
if ("message" in parsed) { console.log("parse error", parsed); process.exit(1); }
const t0 = Date.now();
const r = runFixpoint(parsed, Number(process.argv[3] ?? 3000), Number(process.argv[4] ?? 200000));
console.log("status", r.status.kind, "iters", r.iterations, "tuples", r.store.tuples.length, "ms", Date.now() - t0);
if (r.status.kind === "active-choices") {
  for (const c of r.status.components) {
    const ask = r.store.tuples.find((t) => t.atom.terms[0]?.tag === "Symbol" && (t.atom.terms[0] as any).name === "ask"
      && c.activeTerms.some((a) => renderTerm(r.store, a) === renderTerm(r.store, t.atom.terms[2]!)));
    console.log("-- component @", renderTerm(r.store, c.moment), "actors", c.actors.join(","),
      "ask:", ask ? ask.atom.terms.slice(0, -1).map((x) => renderTerm(r.store, x)).join(" ") : "?");
    for (const o of c.options.slice(0, 12)) console.log("   ", o.map((x) => renderTerm(r.store, x)).join(" "));
  }
}
