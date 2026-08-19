// End-to-end dungeon regression: `fixtures/dungeon-play.t` is the Ceptre
// dungeon-crawler port (data/v2/dungeon.t) with a recorded playthrough
// appended as `^ is` choice rows: shop/buy sword, adventure (three wins,
// go home), adventure (a two-round fight, go home), shop/buy sword, rest,
// quit. It runs to quiescence with no choice pending, and the `last`
// aggregates of the mutable state must end at the values the play implies:
//   - weapon-damage 5 (the bought sword replaces the starting 4),
//   - hp 8           (10, minus 5 from the monster's strike, plus a rest of 3).
// "Final" means the tuple whose start moment is above every other tuple of
// the same head, i.e. what `hp -> X` / `weapon-damage -> X` would read next.

import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { lessThan } from "../v2/store.js";
import { renderAtom } from "../v2/print.js";
import type { Store } from "../v2/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "fixtures/dungeon-play.t"), "utf-8");

const parsed = parse(source);
if ("message" in parsed) throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
const { store, status } = runFixpoint(parsed, 5000, 400000);

assert.equal(status.kind, "done", `expected the recorded play to finish, got '${status.kind}'`);

function finalValue(store: Store, head: string): string {
  const idxs = store.byHead.get(head) ?? [];
  assert.ok(idxs.length > 0, `no '${head}' tuples`);
  const latest = idxs.filter((i) => idxs.every((j) => j === i || lessThan(store, store.tuples[j]!.l, store.tuples[i]!.l)));
  assert.equal(latest.length, 1, `expected exactly one maximal '${head}' tuple, got ${latest.length}`);
  return renderAtom(store, store.tuples[latest[0]!]!.atom);
}

assert.equal(finalValue(store, "weapon-damage"), "weapon-damage 5");
assert.equal(finalValue(store, "hp"), "hp 8");

console.log("PASS: dungeon playthrough ends with weapon-damage 5, hp 8");
console.log("ALL v2 dungeon tests passed");
