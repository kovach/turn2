import type { Term, Tree } from "./types.js";
import { sym } from "./types.js";
import { findPath, isTemporallyBefore } from "./tree.js";
import { getAggregator } from "./aggregators.js";

function termEq(a: Term, b: Term): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "Symbol" && b.tag === "Symbol") return a.name === b.name;
  if (a.tag === "Variable" && b.tag === "Variable") return a.name === b.name;
  if (a.tag === "Atom" && b.tag === "Atom") {
    const at = a.atom.terms, bt = b.atom.terms;
    return at.length === bt.length && at.every((t, i) => termEq(t, bt[i]!));
  }
  if (a.tag === "Wildcard") return true;
  return false;
}

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

export function closeAggregates(ref: Tree): boolean {
  const { instances, bindings, results } = collectAggNodes(ref);

  let changed = false;

  for (const instance of instances) {
    if (hasResult(instance, results)) continue;

    const matchingBindings = getBindingsForInstance(instance, bindings);
    const sorted = sortBindings(matchingBindings, ref);

    // Look up aggregator by examining the atom
    // The aggregator name needs to come from somewhere... but we only have lexId
    // For now, we need to track the funcName somehow.
    // Let's encode it in the lexId: agg_funcName_N
    const lexIdStr = instance.lexId.tag === "Symbol" ? instance.lexId.name : "";
    const match = lexIdStr.match(/^agg_([^_]+)_/);
    const funcName = match ? match[1]! : "count";

    const agg = getAggregator(funcName);
    let acc = agg.zero;
    for (const binding of sorted) {
      acc = agg.fold(acc, ...binding.args);
    }

    // Insert + agg-result lexId instanceId acc as sibling of agg-instance
    const resultId: Term = {
      tag: "Atom",
      atom: { terms: [sym("id"), sym("agg-result"), instance.lexId, instance.instanceId] },
    };
    const resultNode: Tree = {
      id: resultId,
      literal: {
        literalType: "Assert",
        atom: { terms: [sym("agg-result"), instance.lexId, instance.instanceId, acc] },
      },
      children: [],
    };

    instance.parent.children.push(resultNode);
    changed = true;
  }

  return changed;
}
