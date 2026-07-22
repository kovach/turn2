// Tests for exception default-case provenance
// (plans/v2-exception-default-provenance.md): a tuple re-emitted by an
// exception's default rule is attributed (store.tupleSource) to the line
// that asserted the original tuple, not the exception's line. Implemented
// as static head→prime links derived by applyExceptions plus a
// post-fixpoint fixup (resolveExceptionProvenance) that matches each
// linked tuple to its stored prime tuple.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { applyExceptions } from "../v2/expand.js";
import { candidatesByHead, tokenOf, type Store } from "../v2/store.js";
import type { Program } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function run(src: string): Store {
  return runFixpoint(ok(src)).store;
}

// Source lines (via tupleSource) of every stored tuple with the given head.
function linesOf(store: Store, head: string): (number | undefined)[] {
  return [...candidatesByHead(store, head)].map((i) => store.tupleSource[i]?.line);
}

// 1) The motivating example: `x` is re-written by an exception whose host
// never fires; the default-case re-emit is attributed to line 1 (`~x`),
// not line 3 (the exception).
{
  const store = run(`~x

y, {x => ~z}
`);
  assert.deepEqual(linesOf(store, "x"), [1], "default-case x attributed to the asserting line");
  assert.equal(candidatesByHead(store, "z").length, 0, "exception RHS must not fire");
  // Non-vacuity: x really was renamed and re-emitted by the default rule
  // (its Emit atom's static span is line 3 — the fixup rewrote it).
  assert.equal(candidatesByHead(store, "_x_prime1").length, 1, "prime tuple present");
  console.log("PASS: default case attributed to asserting line");
}

// 2) Exception case unchanged: when the host fires over the producer's
// interval, `z` carries the RHS atom's own line, and `x` is intercepted.
{
  const store = run(`~ctx

ctx, ^x a

#def r
  ctx
  {x X => ^z X}
`);
  assert.equal(candidatesByHead(store, "x").length, 0, "x should be intercepted");
  assert.deepEqual(linesOf(store, "z"), [7], "z attributed to the RHS's own line");
  console.log("PASS: exception case attribution unchanged");
}

// 3) Two assertion sites: each surviving default-case tuple carries its own
// originating line (distinct args keep the tuples distinct).
{
  const store = run(`~m1; ~m2

m1, ^x a

m2, ^x b

nope, {x X => ^z X}
`);
  assert.deepEqual(linesOf(store, "x").sort(), [3, 5], "each x carries its own asserting line");
  console.log("PASS: per-tuple attribution across assertion sites");
}

// 4) Chained exceptions, default path both times: attribution follows the
// prime links transitively back to the original assertion.
{
  const store = run(`~x

nope1, {x => ~z1}

nope2, {x => ~z2}
`);
  assert.deepEqual(linesOf(store, "x"), [1], "chained defaults resolve to the original line");
  console.log("PASS: chained exceptions");
}

// 5) Structural invariant pin: the re-emitted tuple has identical argument
// terms (sans trailing id slot) and identical endpoints to its prime
// tuple. The whole approach rests on this — if the default rule's shape
// ever changes, fail here loudly rather than silently mis-attribute.
{
  const store = run(`~m1

m1, ^x a

nope, {x X => ^z X}
`);
  const xs = candidatesByHead(store, "x");
  const primes = candidatesByHead(store, "_x_prime1");
  assert.equal(xs.length, 1, "one re-emitted x");
  assert.equal(primes.length, 1, "one prime tuple");
  const xt = store.tuples[xs[0]!]!;
  const pt = store.tuples[primes[0]!]!;
  assert.equal(xt.atom.terms.length, pt.atom.terms.length, "same width");
  for (let i = 1; i < xt.atom.terms.length - 1; i++) {
    assert.equal(
      tokenOf(store, xt.atom.terms[i]!),
      tokenOf(store, pt.atom.terms[i]!),
      `arg ${i} equal`,
    );
  }
  assert.equal(tokenOf(store, xt.l), tokenOf(store, pt.l), "same left endpoint");
  assert.equal(tokenOf(store, xt.r), tokenOf(store, pt.r), "same right endpoint");
  assert.deepEqual(linesOf(store, "x"), [3]);
  console.log("PASS: default re-emit preserves args and endpoints");
}

// 6) No-match fallback: an off-arity emit escapes renaming
// (rewriteEmitHeads is arity-gated), so its tuple keeps its own span and
// the fixup leaves it alone.
{
  const store = run(`^x a b

nope, {x X => ^z X}
`);
  assert.deepEqual(linesOf(store, "x"), [1], "off-arity x keeps its own span");
  console.log("PASS: off-arity fallback");
}

// 7) Mixed arities on one head: `{x X => e}` and `{x X Y => e}` produce
// two links sharing head `x`; each tuple resolves through the link of its
// own arity (exercises the ProvLink[] bucketing). Explicit args — a bare
// head would auto-fill to arity 1 and collide instead of mixing.
{
  const src = `^x a

^x a b

nope1, {x X => ~z1}

nope2, {x X Y => ^z2 X Y}
`;
  const links = applyExceptions(ok(src)).provLinks ?? [];
  assert.equal(links.filter((l) => l.head === "x").length, 2, "two links on head x");
  const store = run(src);
  const byWidth = new Map<number, number | undefined>();
  for (const i of candidatesByHead(store, "x")) {
    byWidth.set(store.tuples[i]!.atom.terms.length, store.tupleSource[i]?.line);
  }
  // Arity 1 stores [x, a, id] (width 3); arity 2 stores [x, a, b, id]
  // (width 4).
  assert.equal(byWidth.get(3), 1, "arity-1 x attributed to line 1");
  assert.equal(byWidth.get(4), 3, "arity-2 x attributed to line 3");
  console.log("PASS: mixed arities");
}

console.log("v2_exception_provenance: all tests passed");
