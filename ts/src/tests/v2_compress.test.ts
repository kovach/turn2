import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { compressRefs } from "../v2/print.js";
import { hashconsTerm } from "../v2/hashcons.js";
import type { Term } from "../v2/term.js";

function tupleRef(store: import("../v2/store.js").Store, atomVal: import("../v2/term.js").Atom): Term {
  // Re-hashcons the row's atom to obtain its stable Ref. addTuple stores
  // the original Atom object on the Tuple; refToAtom holds canonical
  // copies. Going through hashconsTerm gives us the canonical Ref.
  return hashconsTerm({ tag: "Atom", atom: atomVal }, store.hash);
}

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

// 1) Single Ref root: it's a root, so it gets a binding even at refCount 1.
{
  const src = `
+ foo a b
`;
  const { store } = runFixpoint(ok(src));
  const tup = store.tuples[0]!;
  const root = tupleRef(store, tup.atom);
  assert.equal(root.tag, "Ref");
  const { bindings, results } = compressRefs([root], store);
  assert.equal(results.length, 1);
  assert(results[0]!.startsWith("V"), `expected V<i>, got ${results[0]}`);
  // Some bindings will exist (root + any deep shared subterms).
  assert(bindings.length >= 1, `expected ≥1 bindings, got ${bindings.length}`);
  // Top-level binding is the last (highest id) since hashcons builds bottom-up.
  assert(bindings[bindings.length - 1]!.startsWith(`= ${results[0]} `));
  console.log("PASS: single Ref root binding");
}

// 2) Two roots sharing a sub-Ref get one binding for the shared part.
{
  const src = `
+ shared (sub x)
  + also (sub x)
`;
  const { store } = runFixpoint(ok(src));
  // The two stored rows share a Ref to (sub x). Find both row-atom Refs.
  const rowRefs: Term[] = store.tuples.map((t) => tupleRef(store, t.atom));
  assert.equal(rowRefs.length, 2, "expected 2 row Refs");
  const { bindings, results } = compressRefs(rowRefs, store);
  // Both results must be variable refs.
  for (const r of results) assert(r.startsWith("V"), `expected V, got ${r}`);
  // The shared (sub x) Ref gets its own binding.
  const subBinding = bindings.find((b) => b.includes("sub x"));
  assert(subBinding !== undefined, `expected (sub x) binding, got: ${bindings.join(" | ")}`);
  console.log("PASS: shared sub-Ref single binding");
}

// 3) Round-trip: appended block parses on its own.
{
  const src = `
+ shared (sub x)
  + also (sub x)
`;
  const { store } = runFixpoint(ok(src));
  const rowRefs: Term[] = store.tuples.map((t) => tupleRef(store, t.atom));
  const { bindings, results } = compressRefs(rowRefs, store);
  const block = [...bindings, `^ is ${results[0]} ${results[1]}`]
    .map((l, i) => (i === 0 ? l : "  " + l)).join("\n");
  // Parse the block standalone.
  const reparsed = parse(block);
  if ("message" in reparsed) {
    throw new Error(`round-trip parse failed: ${reparsed.message}\nblock:\n${block}`);
  }
  assert.equal(reparsed.rules.length, 1, `expected 1 rule, got ${reparsed.rules.length}`);
  console.log("PASS: round-trip parse of compressed block");
}

console.log("ALL v2 compress tests passed");
