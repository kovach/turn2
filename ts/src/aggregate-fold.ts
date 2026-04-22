import type { Term, Tree } from "./types.js";
import { sym, assert_ } from "./types.js";
import { findPath, isTemporallyBefore, termEq } from "./tree.js";
import { getAggregator } from "./aggregators.js";
import { hashconsTerm, hashconsAtom, type HashconsState } from "./hashcons.js";
import { indexedInsertAt, type IndexedTree } from "./unify.js";

function isSymbol(t: Term, name: string): boolean {
  return t.tag === "Symbol" && t.name === name;
}

interface AggInstance {
  node: Tree;
  lexId: Term;
  instanceId: Term;
  path: number[];
  parent: Tree;
  parentPath: number[];
}

interface AggBinding {
  node: Tree;
  lexId: Term;
  instanceId: Term;
  args: Term[];
  path: number[];
}

interface AggResult {
  lexId: Term;
  instanceId: Term;
}

function collectAggNodes(
  tree: Tree,
  path: number[] = [],
  parent: Tree | null = null,
  parentPath: number[] = [],
): { instances: AggInstance[]; bindings: AggBinding[]; results: AggResult[] } {
  const instances: AggInstance[] = [];
  const bindings: AggBinding[] = [];
  const results: AggResult[] = [];

  const terms = tree.literal.atom.terms;
  if (terms.length >= 2 && isSymbol(terms[0]!, "agg-instance")) {
    if (parent) {
      instances.push({
        node: tree,
        lexId: terms[1]!,
        instanceId: tree.id,
        path,
        parent,
        parentPath,
      });
    }
  } else if (terms.length >= 3 && isSymbol(terms[0]!, "agg-binding")) {
    bindings.push({
      node: tree,
      lexId: terms[1]!,
      instanceId: terms[2]!,
      args: terms.slice(3),
      path,
    });
  } else if (terms.length >= 3 && isSymbol(terms[0]!, "agg-result")) {
    results.push({
      lexId: terms[1]!,
      instanceId: terms[2]!,
    });
  }

  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i]!;
    const childPath = [...path, i];
    const sub = collectAggNodes(child, childPath, tree, path);
    instances.push(...sub.instances);
    bindings.push(...sub.bindings);
    results.push(...sub.results);
  }

  return { instances, bindings, results };
}

function hasResult(instance: AggInstance, results: AggResult[]): boolean {
  return results.some(
    (r) => termEq(r.lexId, instance.lexId) && termEq(r.instanceId, instance.instanceId),
  );
}

function getBindingsForInstance(instance: AggInstance, bindings: AggBinding[]): AggBinding[] {
  return bindings.filter(
    (b) => termEq(b.lexId, instance.lexId) && termEq(b.instanceId, instance.instanceId),
  );
}

function sortBindings(bindings: AggBinding[], root: Tree): AggBinding[] {
  return [...bindings].sort((a, b) => {
    if (isTemporallyBefore(a.path, b.path)) return -1;
    if (isTemporallyBefore(b.path, a.path)) return 1;
    throw new Error(
      `cannot order agg-bindings: paths [${a.path}] and [${b.path}] are incomparable`,
    );
  });
}

function selectEarliestTier(paused: AggInstance[]): AggInstance[] {
  if (paused.length === 0) return [];
  if (paused.length === 1) return paused;

  const sorted = [...paused].sort((a, b) => {
    if (isTemporallyBefore(a.path, b.path)) return -1;
    if (isTemporallyBefore(b.path, a.path)) return 1;
    return 0; // incomparable — same tier
  });

  const earliest: AggInstance[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    if (isTemporallyBefore(sorted[0]!.path, sorted[i]!.path)) {
      break; // this and all subsequent are after the first
    }
    earliest.push(sorted[i]!);
  }
  return earliest;
}

export function closeAggregates(ref: IndexedTree, hc: HashconsState, iteration: number = 1): boolean {
  const { instances, bindings, results } = collectAggNodes(ref.root);

  const paused = instances.filter((i) => !hasResult(i, results));
  const earliest = selectEarliestTier(paused);

  let changed = false;

  for (const instance of earliest) {
    const matchingBindings = getBindingsForInstance(instance, bindings);
    const sorted = sortBindings(matchingBindings, ref.root);

    // Look up aggregator by examining the atom
    // The aggregator name needs to come from somewhere... but we only have lexId
    // For now, we need to track the funcName somehow.
    // Let's encode it in the lexId: agg_funcName_N
    const lexIdStr = instance.lexId.tag === "Symbol" ? instance.lexId.name : "";
    const m = lexIdStr.match(/^agg_([^_]+)_/);
    const funcName = m ? m[1]! : "count";

    const agg = getAggregator(funcName);
    let acc = agg.zero;
    for (const binding of sorted) {
      acc = agg.fold(acc, ...binding.args);
    }

    // Insert + agg-result lexId instanceId acc as sibling of agg-instance
    const rawResultId: Term = {
      tag: "Atom",
      atom: { terms: [sym("id"), sym("agg-result"), instance.lexId, instance.instanceId] },
    };
    const rawAtom = { terms: [sym("agg-result"), instance.lexId, instance.instanceId, acc] };
    const resultId = hashconsTerm(rawResultId, hc);
    const resultAtom = hashconsAtom(rawAtom, hc);
    const resultNode: Tree = {
      id: resultId,
      literal: {
        literalType: assert_(),
        atom: resultAtom,
      },
      children: [],
      gen: iteration,
    };

    indexedInsertAt(ref, instance.parentPath, resultNode);
    changed = true;
  }

  return changed;
}
