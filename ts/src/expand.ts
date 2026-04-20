import type { AggregateInfo, Term, Tree } from "./types.js";
import { sym, vari, isPositive } from "./types.js";
import { substAtom } from "./unify.js";

export function idExpand(tree: Tree, name: string): Tree {
  const previousVars: Term[] = [];
  let counter = 1;

  function walk(node: Tree): Tree {
    const positive = isPositive(node.literal.literalType);
    let newId: Term;
    if (positive) {
      newId = { tag: "Atom", atom: { terms: [sym("id"), sym(name), sym("id" + counter++), ...previousVars] } };
    } else {
      const isAutoId = node.id.tag === "Variable" && /^\d+$/.test(node.id.name);
      newId = isAutoId ? vari("X" + counter++) : node.id;
      previousVars.push(newId);
    }
    const atom = node.id.tag === "Variable"
      ? substAtom(node.literal.atom, new Map([[node.id.name, newId]]))
      : node.literal.atom;
    const children = node.children.map(walk);
    return { ...node, id: newId, literal: { ...node.literal, atom }, children };
  }

  const children = tree.children.map(walk);
  return { ...tree, children };
}

interface AggMeta {
  lexId: Term;
  nodeId: Term;
  info: AggregateInfo;
  localPattern: Tree[];
}

function pruneAndConvert(
  node: Tree,
  targetNode: Tree,
  state: { found: boolean },
  aggMap: Map<Tree, AggMeta>,
): Tree | null {
  if (state.found) return null;

  const aggMeta = aggMap.get(node);
  const isAgg = node.literal.literalType === "Aggregate";

  if (node === targetNode) {
    state.found = true;
    if (isAgg && aggMeta) {
      return { ...node, literal: { ...node.literal, literalType: "Assert" }, children: [] };
    }
    return { ...node, children: [] };
  }

  // Before target: convert positive to Match, aggregate to agg-result
  if (isAgg && aggMeta) {
    const resultId: Term = {
      tag: "Atom",
      atom: { terms: [sym("id"), sym("agg-result"), aggMeta.lexId, aggMeta.nodeId] },
    };
    return {
      id: resultId,
      literal: {
        literalType: "Match",
        atom: { terms: [sym("agg-result"), aggMeta.lexId, aggMeta.nodeId, aggMeta.info.out] },
      },
      children: [],
    };
  }

  let newNode: Tree;
  if (isPositive(node.literal.literalType)) {
    newNode = { ...node, literal: { ...node.literal, literalType: "Match" } };
  } else {
    newNode = node;
  }

  const children: Tree[] = [];
  for (const child of node.children) {
    const result = pruneAndConvert(child, targetNode, state, aggMap);
    if (result === null) break;
    children.push(result);
  }
  return { ...newNode, children };
}

let expandCounter = 0;

export function expand(pattern: Tree): Tree[] {
  const positiveNodes: Tree[] = [];
  const aggMap = new Map<Tree, AggMeta>();

  function findPositivesAndAggs(node: Tree): void {
    if (isPositive(node.literal.literalType)) {
      positiveNodes.push(node);
      if (node.literal.literalType === "Aggregate" && node.aggregateInfo) {
        aggMap.set(node, {
          lexId: sym(`agg_${node.aggregateInfo.funcName}_${expandCounter++}`),
          nodeId: node.id,
          info: node.aggregateInfo,
          localPattern: node.children,
        });
      }
    }
    for (const child of node.children) findPositivesAndAggs(child);
  }
  for (const child of pattern.children) findPositivesAndAggs(child);

  const rules: Tree[] = [];

  for (const targetNode of positiveNodes) {
    const aggMeta = aggMap.get(targetNode);

    if (aggMeta) {
      rules.push(buildAggRule1(pattern, targetNode, aggMeta, aggMap));
      rules.push(buildAggRule2(pattern, targetNode, aggMeta, aggMap));
    } else {
      const state = { found: false };
      const children: Tree[] = [];
      for (const child of pattern.children) {
        const result = pruneAndConvert(child, targetNode, state, aggMap);
        if (result === null) break;
        children.push(result);
      }
      rules.push({ ...pattern, children });
    }
  }

  return rules;
}

function buildAggRule1(
  pattern: Tree,
  targetNode: Tree,
  aggMeta: AggMeta,
  aggMap: Map<Tree, AggMeta>,
): Tree {
  const state = { found: false };

  function prune(node: Tree): Tree | null {
    if (state.found) return null;

    const isAgg = node.literal.literalType === "Aggregate";
    const priorAgg = aggMap.get(node);

    if (node === targetNode) {
      state.found = true;
      return {
        id: aggMeta.nodeId,
        literal: {
          literalType: "Assert",
          atom: { terms: [sym("agg-instance"), aggMeta.lexId] },
        },
        children: [],
      };
    }

    let newNode: Tree;
    if (isAgg && priorAgg) {
      newNode = {
        id: priorAgg.nodeId,
        literal: {
          literalType: "Match",
          atom: { terms: [sym("agg-result"), priorAgg.lexId, priorAgg.nodeId, priorAgg.info.out] },
        },
        children: [],
      };
    } else if (isPositive(node.literal.literalType)) {
      newNode = { ...node, literal: { ...node.literal, literalType: "Match" } };
    } else {
      newNode = node;
    }

    const children: Tree[] = [];
    for (const child of node.children) {
      const result = prune(child);
      if (result === null) break;
      children.push(result);
    }
    return { ...newNode, children };
  }

  const children: Tree[] = [];
  for (const child of pattern.children) {
    const result = prune(child);
    if (result === null) break;
    children.push(result);
  }
  return { ...pattern, children };
}

function buildAggRule2(
  pattern: Tree,
  targetNode: Tree,
  aggMeta: AggMeta,
  aggMap: Map<Tree, AggMeta>,
): Tree {
  const state = { found: false };

  function collectIds(nodes: Tree[]): Term[] {
    return nodes.flatMap((n) => [n.id, ...collectIds(n.children)]);
  }
  const localPatternIds = collectIds(aggMeta.localPattern);

  const bindingId: Term = {
    tag: "Atom",
    atom: { terms: [sym("id"), sym("agg-binding"), aggMeta.lexId, aggMeta.nodeId, ...localPatternIds] },
  };
  const aggBinding: Tree = {
    id: bindingId,
    literal: {
      literalType: "Assert",
      atom: { terms: [sym("agg-binding"), aggMeta.lexId, aggMeta.nodeId, ...aggMeta.info.args] },
    },
    children: [],
  };

  function prune(node: Tree): Tree | null {
    if (state.found) return null;

    const isAgg = node.literal.literalType === "Aggregate";
    const priorAgg = aggMap.get(node);

    if (node === targetNode) {
      state.found = true;
      return {
        id: aggMeta.nodeId,
        literal: {
          literalType: "Match",
          atom: { terms: [sym("agg-instance"), aggMeta.lexId] },
        },
        children: [...aggMeta.localPattern, aggBinding],
      };
    }

    let newNode: Tree;
    if (isAgg && priorAgg) {
      newNode = {
        id: priorAgg.nodeId,
        literal: {
          literalType: "Match",
          atom: { terms: [sym("agg-result"), priorAgg.lexId, priorAgg.nodeId, priorAgg.info.out] },
        },
        children: [],
      };
    } else if (isPositive(node.literal.literalType)) {
      newNode = { ...node, literal: { ...node.literal, literalType: "Match" } };
    } else {
      newNode = node;
    }

    const children: Tree[] = [];
    for (const child of node.children) {
      const result = prune(child);
      if (result === null) break;
      children.push(result);
    }
    return { ...newNode, children };
  }

  const children: Tree[] = [];
  for (const child of pattern.children) {
    const result = prune(child);
    if (result === null) break;
    children.push(result);
  }

  return { ...pattern, children };
}

export function expandAll(patterns: Tree[]): Tree[] {
  return patterns.flatMap(expand);
}
