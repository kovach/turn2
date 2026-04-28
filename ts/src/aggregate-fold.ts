import type { Term } from "./types.js";
import { sym } from "./types.js";
import { termEq } from "./tree.js";
import { getAggregator } from "./aggregators.js";
import { hashconsTerm, hashconsAtom, type HashconsState } from "./hashcons.js";
import { before, idKey, insertChild, parentIdOf, type NodeRow, type RefStore } from "./refstore.js";

export interface AggInstance {
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
export function collectAggNodes(
  ref: RefStore,
  hc: HashconsState,
): { instances: AggInstance[]; bindings: AggBinding[]; results: AggResult[] } {
  const instances: AggInstance[] = [];
  const bindings: AggBinding[] = [];
  const results: AggResult[] = [];

  for (const row of ref.index.get("_agg-instance") ?? []) {
    const terms = row.node.atom.terms;
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

  for (const row of ref.index.get("_agg-binding") ?? []) {
    const terms = row.node.atom.terms;
    if (terms.length < 3) continue;
    bindings.push({
      row: row.node,
      lexId: terms[1]!,
      instanceId: terms[2]!,
      args: terms.slice(3),
    });
  }

  for (const row of ref.index.get("_agg-result") ?? []) {
    const terms = row.node.atom.terms;
    if (terms.length < 3) continue;
    results.push({
      lexId: terms[1]!,
      instanceId: terms[2]!,
    });
  }

  return { instances, bindings, results };
}

export function hasResult(instance: AggInstance, results: AggResult[], hc: HashconsState): boolean {
  return results.some(
    (r) => termEq(r.lexId, instance.lexId, hc) && termEq(r.instanceId, instance.instanceId, hc),
  );
}

// Paused agg-instances: every instance with no matching agg-result row.
// Tier selection happens in the scheduler — this is just the filter.
export function collectPausedAggregates(ref: RefStore, hc: HashconsState): AggInstance[] {
  const { instances, results } = collectAggNodes(ref, hc);
  return instances.filter((i) => !hasResult(i, results, hc));
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

// Pure folder: close exactly the agg-instances handed in. Caller is
// responsible for picking which ones (typically the earliest scheduling
// tier — see scheduler.ts). Bindings are re-collected from the store
// because the caller usually already discarded them after picking
// schedulables, and re-walking the symbol index is cheap.
export function closeAggregates(
  ref: RefStore,
  hc: HashconsState,
  iteration: number,
  toClose: AggInstance[],
): boolean {
  if (toClose.length === 0) return false;
  const { bindings } = collectAggNodes(ref, hc);

  let changed = false;

  for (const instance of toClose) {
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
      tag: "Id",
      atom: { terms: [sym("id"), sym("_agg-result"), instance.lexId, instance.instanceId] },
    };
    const rawAtom = { terms: [sym("_agg-result"), instance.lexId, instance.instanceId, acc] };
    const resultId = hashconsTerm(rawResultId, hc);
    const resultAtom = hashconsAtom(rawAtom, hc);

    insertChild(ref, instance.parentId, {
      tag: "Assert",
      id: resultId,
      atom: resultAtom,
      gen: iteration,
    }, hc);
    changed = true;
  }

  return changed;
}
