// Per-rule candidate scan statistics for a Turn file.
import { readFileSync } from "fs";
import { parse } from "../../v2/parse.js";
import { runFixpoint } from "../../v2/fixpoint.js";
const parsed = parse(readFileSync(process.argv[2]!, "utf8"));
if ("message" in parsed) throw new Error(parsed.message);
const r = runFixpoint(parsed, 20000, 600000);
const rules: any[] = (r.store.stats as any).rules ?? [];
let scanned = 0, passed = 0;
const rows = rules.map((s, i) => ({ i, name: r.rules?.[i]?.name, line: (r.rules?.[i] as any)?.span?.line ?? (r.rules?.[i] as any)?.atoms?.[0]?.span?.line, ...s }))
  .filter((s) => s && s.candScanned);
for (const s of rows) { scanned += s.candScanned; passed += s.candPassedUnify; }
console.log("total candidates scanned", scanned, "unified", passed, `(${(100 * passed / scanned).toFixed(2)}%)`);
for (const s of rows.sort((a, b) => b.candScanned - a.candScanned).slice(0, 15))
  console.log(String(s.candScanned).padStart(11), String(s.candPassedGen).padStart(10), String(s.candPassedOverlap).padStart(9), String(s.candPassedUnify).padStart(8), s.name, "line", s.line);
const heads: any = (r.store.stats as any).heads;
if (heads) for (const [h, v] of [...(heads instanceof Map ? heads : Object.entries(heads))].sort((a: any, b: any) => b[1].scanCount - a[1].scanCount).slice(0, 8)) console.log("head", h, JSON.stringify(v));
