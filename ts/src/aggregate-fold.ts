import type { Term } from "./types.js";
import { sym, assert_ } from "./types.js";
import { termEq } from "./tree.js";
import { getAggregator } from "./aggregators.js";
import { hashconsTerm, hashconsAtom, type HashconsState } from "./hashcons.js";
import { before, idKey, insertChild, parentIdOf, prior, type NodeRow, type RefStore } from "./refstore.js";

function isSymbol(t: Term, name: string): boolean {
  return t.tag === "Symbol" && t.name === name;
}

interface AggInstance {
  row: NodeRow;
  lexId: Term;
  instanceId: Term;
  parentId: Term;
}

interface AggBinding {
  row: NodeRow;
  lexId: Term;
  instanceId: Term;
  args: Term[];
}

interface AggResult {
  lexId: Term;
  instanceId: Term;
}

// Collect agg-instance / agg-binding / agg-result rows from the store. The
// symbol index buckets rows by first-atom symbol, so we only touch the three
// relevant buckets — no full scan of the reference.
function collectAggNodes(
  ref: RefStore,
  hc: HashconsState,
): { instances: AggInstance[]; bindings: AggBinding[]; results: AggResult[] } {
  const instances: AggInstance[] = [];
  const bindings: AggBinding[] = [];
  const results: AggResult[] = [];

  for (const row of ref.index.get("agg-instance") ?? []) {
    const terms = row.node.literal.atom.terms;
    if (terms.length < 2) continue;
    const parent = parentIdOf(ref, row.node.id, hc);
    if (parent === null) continue;
    instances.push({
      row: row.node,
      lexId: terms[1]!,
      instanceId: row.node.id,
      parentId: parent,
    });
  }

  for (const row of ref.index.get("agg-binding") ?? []) {
    const terms = row.node.literal.atom.terms;
    if (terms.length < 3) continue;
    bindings.push({
      row: row.node,
      lexId: terms[1]!,
      instanceId: terms[2]!,
      args: terms.slice(3),
    });
  }

  for (const row of ref.index.get("agg-result") ?? []) {
    const terms = row.node.literal.atom.terms;
    if (terms.length < 3) continue;
    results.push({
      lexId: terms[1]!,
      instanceId: terms[2]!,
    });
  }

  return { instances, bindings, results };
}

function hasResult(instance: AggInstance, results: AggResult[], hc: HashconsState): boolean {
  return results.some(
    (r) => termEq(r.lexId, instance.lexId, hc) && termEq(r.instanceId, instance.instanceId, hc),
  );
}

function getBindingsForInstance(instance: AggInstance, bindings: AggBinding[], hc: HashconsState): AggBinding[] {
  return bindings.filter(
    (b) => termEq(b.lexId, instance.lexId, hc) && termEq(b.instanceId, instance.instanceId, hc),
  );
}

function sortBindings(ref: RefStore, hc: HashconsState, bindings: AggBinding[], commutative: boolean): AggBinding[] {
  return [...bindings].sort((a, b) => {
    const aId = idKey(a.row.id, hc);
    const bId = idKey(b.row.id, hc);
    if (before(ref, aId, bId)) return -1;
    if (before(ref, bId, aId)) return 1;
    if (commutative) return 0;
    throw new Error(
      `cannot order agg-bindings: nodes ${idKey(a.row.id, hc)} and ${idKey(b.row.id, hc)} are temporally incomparable`,
    );
  });
}

// Scheduling uses `prior` (= before ∪ contains⁻¹) rather than `before`: a
// nested `agg-instance` must close first so the outer fold observes its
// `agg-result`. The `contains⁻¹` component is what captures that.
function selectEarliestTier(ref: RefStore, hc: HashconsState, paused: AggInstance[]): AggInstance[] {
  if (paused.length === 0) return [];
  if (paused.length === 1) return paused;

  const sorted = [...paused].sort((a, b) => {
    const aId = idKey(a.row.id, hc);
    const bId = idKey(b.row.id, hc);
    if (prior(ref, aId, bId)) return -1;
    if (prior(ref, bId, aId)) return 1;
    return 0; // incomparable — same tier
  });

  const earliest: AggInstance[] = [sorted[0]!];
  const firstId = idKey(sorted[0]!.row.id, hc);
  for (let i = 1; i < sorted.length; i++) {
    const nextId = idKey(sorted[i]!.row.id, hc);
    if (prior(ref, firstId, nextId)) {
      break; // this and all subsequent are after the first
    }
    earliest.push(sorted[i]!);
  }
  return earliest;
}

export function closeAggregates(ref: RefStore, hc: HashconsState, iteration: number = 1): boolean {
  const { instances, bindings, results } = collectAggNodes(ref, hc);

  const paused = instances.filter((i) => !hasResult(i, results, hc));
  const earliest = selectEarliestTier(ref, hc, paused);

  let changed = false;

  for (const instance of earliest) {
    const matchingBindings = getBindingsForInstance(instance, bindings, hc);

    // Aggregator funcName is encoded in the lexId as agg_funcName_N.
    const lexIdStr = instance.lexId.tag === "Symbol" ? instance.lexId.name : "";
    const m = lexIdStr.match(/^agg_([^_]+)_/);
    const funcName = m ? m[1]! : "count";

    const agg = getAggregator(funcName);
    const sorted = sortBindings(ref, hc, matchingBindings, agg.commutative);
    let acc = agg.zero;
    for (const binding of sorted) {
      acc = agg.fold(acc, ...binding.args);
    }

    // Insert `agg-result <lexId> <instanceId> <acc>` as a sibling of agg-instance.
    const rawResultId: Term = {
      tag: "Atom",
      atom: { terms: [sym("id"), sym("agg-result"), instance.lexId, instance.instanceId] },
    };
    const rawAtom = { terms: [sym("agg-result"), instance.lexId, instance.instanceId, acc] };
    const resultId = hashconsTerm(rawResultId, hc);
    const resultAtom = hashconsAtom(rawAtom, hc);

    insertChild(ref, instance.parentId, {
      id: resultId,
      literal: { literalType: assert_(), atom: resultAtom },
      gen: iteration,
    }, hc);
    changed = true;
  }

  return changed;
}
