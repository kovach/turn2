import { parse as parseV2 } from "./v2/parse.js";
import { runFixpoint } from "./v2/fixpoint.js";
import { renderTimelineAscii } from "./v2/timeline.js";
import { renderAtom, renderTerm } from "./v2/print.js";

const SOURCE = `
~game

game, ~turn

turn
  ( ~action-phase );
  ( ~buy-phase );
  ( ~cleanup-phase )

~foo

foo, ~a

foo, ~b
`;

const parsed = parseV2(SOURCE);
if ("message" in parsed) { console.error(parsed); process.exit(1); }
const { store, status } = runFixpoint(parsed, 200, 5000);
console.log("status:", status.kind);
console.log("compact:");
console.log(renderTimelineAscii(store, { laneMode: "compact" }));
console.log("\nnested:");
console.log(renderTimelineAscii(store, { laneMode: "nested" }));
console.log("\ntree:");
console.log(renderTimelineAscii(store, { laneMode: "tree" }));

console.log("\ntuples:");
for (const t of store.tuples) {
  console.log(`  l=${renderTerm(store, t.l)}  r=${renderTerm(store, t.r)}  ${renderAtom(store, t.atom)}`);
}
