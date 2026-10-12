// Rule browser core (plans/v2-rule-browser.md): segments as source ranges,
// the predicate index, the `uses` query, and the lexical highlighter.
import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { buildRuleIndex, runQuery, segmentRange, type RuleIndex } from "../v2/rule-index.js";
import { highlightLines } from "../v2/highlight.js";
import { relationAt } from "../v2/rule-browser.js";
import type { Program } from "../v2/types.js";

function index(src: string): RuleIndex {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return buildRuleIndex(src, p as Program);
}

const textOf = (src: string, ix: RuleIndex, i: number): string => {
  const r = segmentRange(ix.segs[i]!);
  return src.slice(r.start, r.end);
};

const SRC = `-- header, not attached (blank line below)

-- the game
~game
game, ~turn
  -- an indented comment continues the rule
-- doc for the turn rule
#def take
turn, p X,
  +q X
-- trailing, belongs to nobody

#acc total : (@sum int)
q X / total X
turn, total N, { q N => ~r N }, !(q Y), not total 0
`;

// 1) segments: ranges, doc comments, #def, continuation lines
{
  const ix = index(SRC);
  const texts = ix.segs.map((_, i) => textOf(SRC, ix, i));
  assert.deepEqual(texts, [
    "-- the game\n~game",
    "game, ~turn\n  -- an indented comment continues the rule",
    "-- doc for the turn rule\n#def take\nturn, p X,\n  +q X",
    "#acc total : (@sum int)",
    "q X / total X",
    "turn, total N, { q N => ~r N }, !(q Y), not total 0",
  ]);
  assert.deepEqual(ix.segs.map((s) => s.kind), ["rule", "rule", "rule", "acc-decl", "acc-rule", "rule"]);
  assert.equal(ix.segs[2]!.name, "take");
  assert.equal(ix.segs[2]!.docLine, 7);
  assert.equal(ix.segs[2]!.line, 8);
  assert.equal(ix.segOfLine.get(11), undefined, "the trailing comment belongs to no segment");
  console.log("PASS: segments cover each item, its doc comment and continuation lines");
}

// 2) uses and roles, with columns
{
  const ix = index(SRC);
  const roles = (p: string): string[] => (ix.uses.get(p) ?? []).map((u) => `${u.role}@${u.span.line}`);
  assert.deepEqual(roles("q"), ["assert@10", "match@14", "intercept@15", "constrain@15"]);
  assert.deepEqual(roles("total"), ["declare@13", "acc-head@14", "match@15", "not@15"]);
  assert.deepEqual(roles("r"), ["assert@15"]);
  for (const us of ix.uses.values()) {
    for (const u of us) assert.ok(u.span.startCol !== undefined && u.span.endCol !== undefined, JSON.stringify(u));
  }
  const line = (n: number): string => SRC.split("\n")[n - 1]!;
  const qUses = ix.uses.get("q")!;
  assert.equal(line(14).slice(qUses[1]!.span.startCol, qUses[1]!.span.endCol), "q X");
  assert.equal(line(15).slice(qUses[2]!.span.startCol, qUses[2]!.span.endCol), "q N");
  const head = ix.uses.get("total")![1]!;
  assert.equal(line(14).slice(head.span.startCol, head.span.endCol), "total X");
  console.log("PASS: every use has a role and a column span");
}

// 3) `uses` query: groups, one card per segment per group, value uses ignored
{
  const src = "~game\ngame, ~explore 3\ngame, card-at N explore C, ~x\nexplore L, +y L\n";
  const ix = index(src);
  const res = runQuery({ kind: "uses", pred: "explore" }, ix);
  assert.deepEqual(res.groups.map((g) => [g.title, g.cards.map((c) => c.seg)]), [
    ["Asserted by", [1]],
    ["Matched by", [3]],
  ]);
  assert.deepEqual(runQuery({ kind: "uses", pred: "nope" }, ix).groups, []);
  console.log("PASS: the uses query groups segments by role");
}

// 4) highlighter: classes, relation heads vs values, #js bodies
{
  const src = "game, ~>turn X, +f 3 -- note\n#js (add A B) {\n  return A + B;\n}\n{ q N => ~r N }";
  const lines = src.split("\n");
  const hl = highlightLines(src);
  const cls = (i: number): string[] => hl[i]!.map((t) => `${t.cls}:${lines[i]!.slice(t.start, t.end)}`);
  assert.deepEqual(cls(0), ["r:game", "p:,", "sl:~>", "r:turn", "v:X", "p:,", "sa:+", "r:f", "n:3", "c:-- note"]);
  assert.deepEqual(cls(1), ["d:#js", "r:(add", "js:{"]);
  assert.deepEqual(cls(2), ["js:  return A + B;"]);
  assert.deepEqual(cls(4), ["ex:{", "r:q", "v:N", "ex:=>", "sl:~", "r:r", "v:N", "ex:}"]);
  assert.equal(relationAt("game, card-at N explore C", 8), "card-at");
  assert.equal(relationAt("game, card-at N explore C", 17), "explore");
  assert.equal(relationAt("game, card-at N explore C", 14), null);
  console.log("PASS: the highlighter classes tokens as the report's turnhl.py does");
}

console.log("ALL v2 rule index tests passed");
