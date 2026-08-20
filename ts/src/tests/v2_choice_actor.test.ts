// Choice actors (plans/v2-choice-actors.md): `?[actor] V1 .. Vn` syntax,
// static ask checks (vars-only, fresh-only), and scheduler-driven `rng`
// auto-resolution (uniform over a component's joint option tuples).

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { expand } from "../v2/expand.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { compressRefs } from "../v2/print.js";
import type { Term } from "../v2/term.js";
import type { Store } from "../v2/store.js";
import type { RuleAtom } from "../v2/types.js";
import { expandTerm } from "../v2/hashcons.js";

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function parseError(input: string): string {
  const p = parse(input);
  if (!("message" in p)) throw new Error("expected parse error, got a Program");
  return p.message;
}

function renderTerm(store: Store, term: Term): string {
  const t = term.tag === "Ref" ? expandTerm(term, store.hash) : term;
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${t.id}`;
    case "Atom":
    case "Id":
      return `(${t.atom.terms.map((x) => renderTerm(store, x)).join(" ")})`;
  }
}

function listTuples(store: Store): string[] {
  return store.tuples.map((t) => {
    const ts = t.atom.terms.length > 0 ? t.atom.terms.slice(0, -1) : t.atom.terms;
    return ts.map((x) => renderTerm(store, x)).join(" ");
  });
}

// Active-term variable name from the `:varName` tail of its id template
// (see freshIdTemplate / variableToSymbol in expand.ts).
function varNameOf(term: Term, store: Store): string {
  const t = expandTerm(term, store.hash);
  if (t.tag !== "Atom" && t.tag !== "Id") return "?";
  const last = t.atom.terms[t.atom.terms.length - 1];
  if (last?.tag !== "Symbol") return "?";
  return last.name.startsWith(":") ? last.name.slice(1) : last.name;
}

// Reify one commit as appendable source, same shape as web-v2's
// appendIsRows: `= V… (…)` shared bindings + `^ is <term> <value>`.
function isRowSource(store: Store, activeTerm: Term, value: Term): string {
  const { bindings, results } = compressRefs([activeTerm, value], store);
  const lines = [...bindings, `^ is ${results[0]} ${results[1]}`];
  return "\n\n" + lines.map((l, i) => (i === 0 ? l : "  " + l)).join("\n");
}

const throwingRandom = (): number => {
  throw new Error("random() called — a persisted roll re-rolled");
};

// 1) Parse: actor annotation lands on the ask atom's IR.
{
  function askAtoms(src: string) {
    const p = ok(src);
    const out: Extract<RuleAtom, { tag: "Atom" }>[] = [];
    const walk = (body: RuleAtom[]): void => {
      for (const a of body) {
        if (a.tag === "Sub") { walk(a.body); continue; }
        if (a.tag === "Atom" && a.marker === "ask") out.push(a);
      }
    };
    for (const r of p.rules) walk(r.body);
    return out;
  }
  assert.equal(askAtoms("turn, ?C, !cell C\n")[0]!.actor, undefined);
  assert.equal(askAtoms("turn, ?[you] C, !cell C\n")[0]!.actor, "you");
  assert.equal(askAtoms("turn, ?[rng] C, !cell C\n")[0]!.actor, "rng");
  // No space between `]` and the variable.
  assert.equal(askAtoms("turn, ?[rng]C, !cell C\n")[0]!.actor, "rng");
  // Multiple variables in one ask.
  const multi = askAtoms("turn, ?[rng] A B, !pair A B\n")[0]!;
  assert.equal(multi.actor, "rng");
  assert.equal(multi.atom.terms.length, 2);
  console.log("PASS: parse — actor annotation on ask atoms");
}

// 2) Parse errors: actor group and vars-only ask shape.
{
  assert.match(parseError("turn, ?[bogus] C, !cell C\n"), /unknown actor 'bogus'/);
  assert.match(parseError("turn, ?[] C, !cell C\n"), /unknown actor ''/);
  assert.match(parseError("turn, ?[rng C, !cell C\n"), /unterminated '\[' after '\?'/);
  assert.match(parseError("turn, ?cell C\n"), /'\?' accepts only variables/);
  assert.match(parseError("turn, ?(a b)\n"), /'\?' accepts only variables/);
  assert.match(parseError("turn, ?_\n"), /'\?' accepts only variables/);
  assert.match(parseError("turn, ?C C\n"), /duplicate variable 'C' in '\?'/);
  assert.match(parseError("turn, ?C -> 1\n"), /'\?' atom cannot carry a '-> weight'/);
  assert.match(parseError("turn, ?\n"), /'\?' requires at least one variable/);
  console.log("PASS: parse errors — actor group + vars-only ask shape");
}

// 3) Expand rejects asking an already-bound variable.
{
  const rejects = (src: string, label: string): void => {
    assert.throws(() => expand(ok(src)), /already bound at '\?'/, label);
  };
  rejects("cell X, ?X, !cell X\n", "match-bound");
  rejects("turn, +mark X, ?X, !cell X\n", "emit-bound");
  rejects("turn, = X (a b), ?X, !cell X\n", "equal-bound");
  rejects("turn, ?C, !cell C, ?C\n", "double ask");
  rejects("turn, ?[you] C, !cell C, ?[rng] C\n", "conflicting-actor double ask");
  // Fresh asks still expand.
  expand(ok("cell X, ?Y, !cell Y\n"));
  console.log("PASS: expand rejects '?' on bound variables");
}

// 4) `_choose` rows carry the actor column; BlockedChoose surfaces it.
{
  const src = `
+ cell c1
  + turn

turn
  ? C
  ! cell C
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices[0]!.actor, "you");
  assert.deepEqual(status.components[0]!.actors, ["you"]);
  const chooseRows = listTuples(store).filter((t) => t.startsWith("_choose "));
  assert.equal(chooseRows.length, 1);
  assert(chooseRows[0]!.endsWith(" you"), `expected actor column, got: ${chooseRows[0]}`);
  console.log("PASS: _choose rows carry the actor column (default you)");
}

// 5) An all-rng component auto-resolves; `you` variant of the same program
//    halts. Different random streams pick different values.
{
  const src = (actor: string) => `
+ cell c1
  + cell c2
  + cell c3
  + turn

turn
  ?${actor} C
  ! cell C
  + picked C

picked C
  is C V
  + resolved V
`;
  // Default actor halts.
  const rYou = runFixpoint(ok(src("")));
  assert.equal(rYou.status.kind, "active-choices");
  assert.equal(rYou.rngCommits.length, 0);

  // rng auto-resolves to done, committing one binding.
  const rLo = runFixpoint(ok(src("[rng]")), 200, 5000, { random: () => 0 });
  assert.equal(rLo.status.kind, "done", `rng status: ${rLo.status.kind}`);
  assert.equal(rLo.rngCommits.length, 1);
  const cells = ["c1", "c2", "c3"];
  const resolvedLo = listTuples(rLo.store).filter((t) => t.startsWith("resolved "));
  assert.equal(resolvedLo.length, 1, `resolved rows: ${resolvedLo.join(" | ")}`);
  const valLo = resolvedLo[0]!.slice("resolved ".length);
  assert(cells.includes(valLo), `resolved value: ${valLo}`);
  assert.equal(renderTerm(rLo.store, rLo.rngCommits[0]!.value), valLo);

  // A different stream lands on a different option (3 options: index 0 vs 2).
  const rHi = runFixpoint(ok(src("[rng]")), 200, 5000, { random: () => 0.99 });
  assert.equal(rHi.status.kind, "done");
  const valHi = renderTerm(rHi.store, rHi.rngCommits[0]!.value);
  assert(cells.includes(valHi));
  assert.notEqual(valLo, valHi, "expected different picks for different streams");
  console.log("PASS: all-rng component auto-resolves uniformly; you halts");
}

// 6) Persistence round-trip: appending the reported commit as `^ is` rows
//    reproduces the run without calling random() again.
{
  const src = `
+ cell c1
  + cell c2
  + cell c3
  + turn

turn
  ?[rng] C
  ! cell C
  + picked C

picked C
  is C V
  + resolved V
`;
  const r1 = runFixpoint(ok(src), 200, 5000, { random: () => 0.5 });
  assert.equal(r1.status.kind, "done");
  assert.equal(r1.rngCommits.length, 1);
  const c = r1.rngCommits[0]!;
  const val = renderTerm(r1.store, c.value);
  const src2 = src + isRowSource(r1.store, c.activeTerm, c.value);
  const r2 = runFixpoint(ok(src2), 200, 5000, { random: throwingRandom });
  assert.equal(r2.status.kind, "done", `round-trip status: ${r2.status.kind}`);
  assert.equal(r2.rngCommits.length, 0, "persisted roll must not re-roll");
  const resolved2 = listTuples(r2.store).filter((t) => t.startsWith("resolved "));
  assert.deepEqual(resolved2, [`resolved ${val}`]);
  console.log("PASS: persisted rng commit round-trips without re-rolling");
}

// 7) Mixed component: `you` term surfaces (rng untouched); after the user's
//    partial `is` binding, the rng remainder auto-resolves over the
//    narrowed options.
{
  const src = `
+ pair c1 c2
  + pair c1 c3
  + pair c2 c4
  + turn

turn
  ? A
  ?[rng] B
  ! pair A B
`;
  const r1 = runFixpoint(ok(src), 200, 5000, { random: throwingRandom });
  assert.equal(r1.status.kind, "active-choices", `phase1 status: ${r1.status.kind}`);
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(r1.rngCommits.length, 0, "rng term must not auto-resolve while you is highest");
  const comp1 = r1.status.components[0]!;
  assert.equal(comp1.activeTerms.length, 2);
  const actorsByVar = new Map(
    comp1.activeTerms.map((t, i) => [varNameOf(t, r1.store), comp1.actors[i]!]),
  );
  assert.equal(actorsByVar.get("A"), "you");
  assert.equal(actorsByVar.get("B"), "rng");

  // Bind A=c1 (one-at-a-time partial binding). B then auto-resolves over
  // the narrowed options {c2, c3}.
  const aIdx = comp1.activeTerms.findIndex((t) => varNameOf(t, r1.store) === "A");
  const c1Val = comp1.options.find((row) => renderTerm(r1.store, row[aIdx]!) === "c1")![aIdx]!;
  const src2 = src + isRowSource(r1.store, comp1.activeTerms[aIdx]!, c1Val);
  const r2 = runFixpoint(ok(src2), 200, 5000, { random: () => 0 });
  assert.equal(r2.status.kind, "done", `phase2 status: ${r2.status.kind}`);
  assert.equal(r2.rngCommits.length, 1);
  const bVal = renderTerm(r2.store, r2.rngCommits[0]!.value);
  assert(["c2", "c3"].includes(bVal), `B resolved to ${bVal}, expected c2|c3`);
  console.log("PASS: mixed component — you first, rng auto-resolves the remainder");
}

// 8) Multi-variable rng component resolves in a single joint roll: the
//    committed pair is one of the joint option tuples.
{
  const src = `
+ pair c1 c2
  + pair c1 c3
  + pair c2 c4
  + turn

turn
  ?[rng] A
  ?[rng] B
  ! pair A B
`;
  const r = runFixpoint(ok(src), 200, 5000, { random: () => 0.5 });
  assert.equal(r.status.kind, "done", `status: ${r.status.kind}`);
  assert.equal(r.rngCommits.length, 2, "joint roll commits both terms at once");
  const byVar = new Map(
    r.rngCommits.map((c) => [varNameOf(c.activeTerm, r.store), renderTerm(r.store, c.value)]),
  );
  const pair = `${byVar.get("A")},${byVar.get("B")}`;
  assert(
    ["c1,c2", "c1,c3", "c2,c4"].includes(pair),
    `joint commit must be one option tuple, got ${pair}`,
  );
  // Different streams land on different option rows.
  const r0 = runFixpoint(ok(src), 200, 5000, { random: () => 0 });
  const r9 = runFixpoint(ok(src), 200, 5000, { random: () => 0.99 });
  const pairOf = (rr: typeof r0): string => {
    const m = new Map(
      rr.rngCommits.map((c) => [varNameOf(c.activeTerm, rr.store), renderTerm(rr.store, c.value)]),
    );
    return `${m.get("A")},${m.get("B")}`;
  };
  assert.notEqual(pairOf(r0), pairOf(r9), "expected different joint picks");
  console.log("PASS: multi-variable rng component resolves as one joint roll");
}

// 9) Zero-option rng component resolves dead (v2_dead_choice.test.ts):
//    the run completes without ever consulting the random stream
//    (throwingRandom proves the rng path never touches the empty
//    component) and without committing anything.
{
  const src = `
+ turn

turn
  ?[rng] C
  ! cell C
`;
  const r = runFixpoint(ok(src), 200, 5000, { random: throwingRandom });
  assert.equal(r.status.kind, "done", `status: ${r.status.kind}`);
  assert.equal(r.rngCommits.length, 0);
  console.log("PASS: zero-option rng component dies without a roll");
}

// 10) Program-provided seed: `+ rng-seed <n>` makes rolls deterministic —
//     same seed reproduces the same pick sequence; a different seed gives a
//     different one. Rolls happen at three sequential moments, all drawn
//     from the one latched stream.
const seededSrc = (seed: number) => `
~game
  + cell c1
  + cell c2
  + cell c3
  + cell c4
  + cell c5
  + rng-seed ${seed}
  (~t1); (~t2); (~t3)

t1, ?[rng] A, !cell A, +sel s1 A

t2, ?[rng] B, !cell B, +sel s2 B

t3, ?[rng] C, !cell C, +sel s3 C

sel P X, is X V, +pick P V
`;
function picksOf(src: string, random?: () => number): string {
  const r = runFixpoint(ok(src), 400, 5000, random ? { random } : undefined);
  assert.equal(r.status.kind, "done", `status: ${r.status.kind}`);
  assert.equal(r.rngCommits.length, 3, `commits: ${r.rngCommits.length}`);
  return listTuples(r.store).filter((t) => t.startsWith("pick ")).sort().join(" | ");
}
{
  const a = picksOf(seededSrc(7));
  const b = picksOf(seededSrc(7));
  assert.equal(a, b, "same seed must reproduce the same picks");
  const c = picksOf(seededSrc(13));
  assert.notEqual(a, c, "different seed should give a different pick sequence");
  console.log("PASS: + rng-seed makes rolls deterministic per seed");
}

// 11) An explicitly passed options.random overrides the program seed.
{
  const a = picksOf(seededSrc(7), () => 0);
  const b = picksOf(seededSrc(13), () => 0);
  assert.equal(a, b, "explicit random must win over the program seed");
  console.log("PASS: options.random overrides + rng-seed");
}

// 12) Seed errors: multiple distinct values; non-numeric value. Only
//     surfaced when a roll is actually needed (latched at first use).
{
  const base = `
+ cell c1
  + turn

turn
  ?[rng] C
  ! cell C
`;
  assert.throws(
    () => runFixpoint(ok(base + "\n+ rng-seed 3\n\n+ rng-seed 4\n")),
    /rng-seed: asserted with multiple values \(3 and 4\)/,
  );
  assert.throws(
    () => runFixpoint(ok(base + "\n+ rng-seed banana\n")),
    /rng-seed: argument must be a number/,
  );
  // Same value asserted twice is fine (dedup), and a seed with no rng
  // choice anywhere is inert.
  const rDup = runFixpoint(ok(base + "\n+ rng-seed 3\n\n+ rng-seed 3\n"));
  assert.equal(rDup.status.kind, "done");
  const rInert = runFixpoint(ok("+ rng-seed banana\n"), 400, 5000, { random: throwingRandom });
  assert.equal(rInert.status.kind, "done");
  console.log("PASS: rng-seed conflict/shape errors; duplicates and unused seeds are inert");
}

console.log("ALL v2 choice-actor tests passed");
