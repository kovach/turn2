import * as fs from "fs";
import * as path from "path";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
// Read ttt.t and append a synthetic `is` row resolving the first cell
// choice. Re-runs the fixpoint and reports a summary.
const tttPath = path.join(process.cwd(), "data", "v2", "ttt.t");
const base = fs.readFileSync(tttPath, "utf8");
const src = base + "\n^ is (*id r5 2 cell) (cell z z)\n";

const p = parse(src);
if ("message" in p) { console.error("parse error:", p); process.exit(1); }

const r = runFixpoint(p, 20, 1000);
console.log("status:", r.status.kind, "iters:", r.iterations, "tuples:", r.store.tuples.length, "dupes:", r.store.tupleDupes);
