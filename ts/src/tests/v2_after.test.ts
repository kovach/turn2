// `>p` (match, continue after p) and `~>p` (assert episode p, continue after
// it). See `after` on the pre-expand Atom in v2/types.ts.
import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { lessThan, type Store } from "../v2/store.js";
import { renderTermShallow } from "../v2/print.js";
import type { Term } from "../v2/term.js";

function run(src: string, lattice = false): Store {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  const { store, status } = runFixpoint(p, 200, 5000, { lattice });
  assert.equal(status.kind, "done");
  return store;
}

function rows(store: Store, head: string): { l: Term; r: Term }[] {
  return store.tuples.filter((t) => renderTermShallow(store, t.atom.terms[0]!) === head);
}

function one(store: Store, head: string): { l: Term; r: Term } {
  const rs = rows(store, head);
  assert.equal(rs.length, 1, `exactly one '${head}' row`);
  return rs[0]!;
}

function parseError(src: string): string {
  const p = parse(src);
  assert.ok("message" in p, `expected a parse error for: ${src}`);
  return (p as { message: string }).message;
}

// 1) `~>a, ~b`: b is placed after a ends, inside the outer window
{
  const s = run("~game\ngame, ~>a, ~b\n");
  const g = one(s, "game"), a = one(s, "a"), b = one(s, "b");
  assert(lessThan(s, a.r, b.l), "b starts after a ends");
  assert(lessThan(s, g.l, a.l) && lessThan(s, b.r, g.r), "both inside game");
  console.log("PASS: ~>p continues after the asserted episode");
}

// 2) `>a` matches an episode and continues after it, with the outer right
// end kept
{
  const s = run("~game\ngame, ~a\ngame, >a, ~c\n");
  const g = one(s, "game"), a = one(s, "a"), c = one(s, "c");
  assert(lessThan(s, a.r, c.l), "c after a");
  assert(lessThan(s, c.r, g.r), "c still inside game");
  console.log("PASS: >p matches p and continues after it");
}

// 3) `>p` does not require p to overlap the anchor, only to end before its
// right end: a finished `a` is matched from inside a later sibling
{
  const s = run("~game\ngame, ~>a, ~b\nb, >a, ~c\n");
  const a = one(s, "a"), b = one(s, "b"), c = one(s, "c");
  assert(lessThan(s, a.r, b.l), "a ended before b started");
  assert(lessThan(s, b.l, c.l) && lessThan(s, c.r, b.r), "c inside b");
  console.log("PASS: >p does not need p to overlap the anchor");
}

// 4) `>p` on a fact: a fact never ends, so nothing can be placed after it
{
  const s = run("~game\ngame, +f\ngame, >f, ~never\ngame, >f, +also-never\n");
  assert.equal(rows(s, "never").length, 0);
  assert.equal(rows(s, "also-never").length, 0);
  console.log("PASS: nothing is asserted after a fact");
}

// 5) `>p` with p ending after the anchor's right end does not match
{
  const s = run("~outer\nouter, ~inner\ninner, ~late\ninner, >outer, ~x\n");
  assert.equal(rows(s, "x").length, 0, "outer ends after inner, so nothing fits");
  console.log("PASS: >p requires p to end within the anchor");
}

// 6) sequence `;` is unchanged and still available alongside `>`
{
  const s = run("~game\ngame, ~a; ~b\n");
  const a = one(s, "a"), b = one(s, "b");
  assert(lessThan(s, a.r, b.l));
  console.log("PASS: ';' still sequences");
}

// 7) lattice mode: sibling facts join, and `>` then moves past an episode
// on top of the joined start — `after a b` lands after both pins began and
// after warmup ended
{
  const src = `~setup
setup, ~>warmup, +n a
setup, +n b
n X, +pin X
pin A, pin B, >warmup, ~after A B
`;
  // By default only `a a` fires: `pin b` is not ordered against warmup's
  // end, so the `>warmup` step's max fails (and so do the cross pairs).
  assert.equal(rows(run(src, false), "after").length, 1, "only a a by default");
  const s = run(src, true);
  const after = rows(s, "after");
  assert.equal(after.length, 4, "all pairs in lattice mode");
  const w = one(s, "warmup");
  const pinStart = (name: string): Term =>
    s.tuples.find((t) => renderTermShallow(s, t.atom.terms[0]!) === "pin" &&
      renderTermShallow(s, t.atom.terms[1]!) === name)!.l;
  for (const x of s.tuples.filter((t) => renderTermShallow(s, t.atom.terms[0]!) === "after")) {
    assert(lessThan(s, w.r, x.l), "after warmup ends");
    for (const arg of x.atom.terms.slice(1, 3)) {
      assert(lessThan(s, pinStart(renderTermShallow(s, arg)), x.l), "after both of its pins start");
    }
  }
  console.log("PASS: >p composes with lattice joins");
}

// 8) parse errors: only matches and episodes take `>`
{
  for (const src of ["+>p\n", "^>p\n", "?>X\n", "!>p\n", ">p -> W, +q W\n"]) {
    assert.match(parseError(src), /'>'|marker|aggregate/, src);
  }
  assert.match(parseError("{>p => ~q}\n~p\n"), /marker/);
  assert.match(parseError("#acc t : e @count\n>p / t p\n"), /acc rule bodies/);
  console.log("PASS: '>' is rejected outside matches and episodes");
}

console.log("ALL v2 after tests passed");
