// Replay a recorded sequence of `you` choices against a Turn program and
// print the program with the `^ is` rows appended — the same text the web
// client appends on a click (web-v2.ts `appendIsRows`).
//
//   node --import tsx src/replay-choices.ts <program.t> <value>...
//
// Each value resolves the next pending single-term component that offers it.
// Use this to regenerate a fixture whose saved rows have gone stale: choice
// terms are named by their id templates, which embed the rule's chain of
// earlier emit endpoints, so a change to how a rule mints moments changes
// them (plans/v2-choice-components-by-moment.md, Risks).

import { readFileSync } from "node:fs";
import { parse } from "./v2/parse.js";
import { runFixpoint } from "./v2/fixpoint.js";
import { compressRefs, renderTerm } from "./v2/print.js";

const [file, ...values] = process.argv.slice(2);
if (file === undefined) {
  console.error("usage: replay-choices.ts <program.t> <value>...");
  process.exit(2);
}
let source = readFileSync(file, "utf8").replace(/\s+$/, "") + "\n";
for (const want of values) {
  const parsed = parse(source);
  if ("message" in parsed) throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
  const { store, status } = runFixpoint(parsed, 5000, 400000);
  if (status.kind !== "active-choices") throw new Error(`before '${want}': status ${status.kind}, expected a pending choice`);
  const comp = status.components.find((c) =>
    c.activeTerms.length === 1 && c.options.some((o) => renderTerm(store, o[0]!) === want));
  if (comp === undefined) {
    const offered = status.components.map((c) => c.options.map((o) => o.map((t) => renderTerm(store, t)).join(",")).join(" | "));
    throw new Error(`no pending choice offers '${want}'; offered: ${offered.join(" ;; ")}`);
  }
  const value = comp.options.find((o) => renderTerm(store, o[0]!) === want)![0]!;
  const { bindings, results } = compressRefs([comp.activeTerms[0]!, value], store);
  const lines = [...bindings, `^ is ${results[0]} ${results[1]}`];
  source += "\n" + lines.map((l, i) => (i === 0 ? l : "  " + l)).join("\n") + "\n";
}
process.stdout.write(source);
