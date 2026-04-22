import type { AggregateInfo, LiteralType, MatchConstraint, Term, Tree } from "./types.js";
import { sym, vari, isPositive, match, assert_, newTrail, trailPush } from "./types.js";
import { substAtom } from "./unify.js";

export function idExpand(tree: Tree, name: string): Tree {
  const previousVars: Term[] = [];
  let counter = 1;

  function walk(node: Tree): Tree {
    const lt = node.literal.literalType;
    const positive = isPositive(lt);
    // Only Match/Before/Overlap actually bind their node id against the reference
    // tree at match time. Equal (and any other non-positive non-Match non-Before
    // non-Overlap literal) has no id binding, so its auto-X would stay free and
    // leak into downstream positives' ids. Exclude it from previousVars.
    const bindsId = lt.tag === "Match" || lt.tag === "Before" || lt.tag === "Overlap";
    let newId: Term;
    if (positive) {
      newId = { tag: "Atom", atom: { terms: [sym("id"), sym(name), sym("id" + counter++), ...previousVars] } };
    } else {
      const isAutoId = node.id.tag === "Variable" && /^\d+$/.test(node.id.name);
      newId = isAutoId ? vari("X" + counter++) : node.id;
      if (bindsId) previousVars.push(newId);
    }
    let atom = node.literal.atom;
    if (node.id.tag === "Variable") {
      const t = newTrail();
      // Exempt from the unify.ts trail-hashcons invariant: this trail lives
      // for a single substAtom call at parse time, never participates in
      // fixpoint matching, and no HashconsState is available here.
      trailPush(t, node.id.name, newId);
      atom = substAtom(atom, t);
    }
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
  const lt = node.literal.literalType;
  const isAgg = lt.tag === "Aggregate";

  if (node === targetNode) {
    state.found = true;
    if (isAgg && aggMeta) {
      return { ...node, literal: { ...node.literal, literalType: assert_() }, children: [] };
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
        literalType: match(),
        atom: { terms: [sym("agg-result"), aggMeta.lexId, aggMeta.nodeId, aggMeta.info.out] },
      },
      children: [],
    };
  }

  let newNode: Tree;
  if (isPositive(lt)) {
    newNode = { ...node, literal: { ...node.literal, literalType: match() } };
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
    const lt = node.literal.literalType;
    if (isPositive(lt)) {
      positiveNodes.push(node);
      if (lt.tag === "Aggregate") {
        aggMap.set(node, {
          lexId: sym(`agg_${lt.info.funcName}_${expandCounter++}`),
          nodeId: node.id,
          info: lt.info,
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

    const lt = node.literal.literalType;
    const isAgg = lt.tag === "Aggregate";
    const priorAgg = aggMap.get(node);

    if (node === targetNode) {
      state.found = true;
      return {
        id: aggMeta.nodeId,
        literal: {
          literalType: assert_(),
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
          literalType: match(),
          atom: { terms: [sym("agg-result"), priorAgg.lexId, priorAgg.nodeId, priorAgg.info.out] },
        },
        children: [],
      };
    } else if (isPositive(lt)) {
      newNode = { ...node, literal: { ...node.literal, literalType: match() } };
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
      literalType: assert_(),
      atom: { terms: [sym("agg-binding"), aggMeta.lexId, aggMeta.nodeId, ...aggMeta.info.args] },
    },
    children: [],
  };

  function prune(node: Tree): Tree | null {
    if (state.found) return null;

    const lt = node.literal.literalType;
    const isAgg = lt.tag === "Aggregate";
    const priorAgg = aggMap.get(node);

    if (node === targetNode) {
      state.found = true;
      return {
        id: aggMeta.nodeId,
        literal: {
          literalType: match(),
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
          literalType: match(),
          atom: { terms: [sym("agg-result"), priorAgg.lexId, priorAgg.nodeId, priorAgg.info.out] },
        },
        children: [],
      };
    } else if (isPositive(lt)) {
      newNode = { ...node, literal: { ...node.literal, literalType: match() } };
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
  expandCounter = 0;
  return patterns.flatMap(expand);
}

function countMatchNodes(tree: Tree): number {
  const lt = tree.literal.literalType;
  const self = (lt.tag === "Match" || lt.tag === "Before" || lt.tag === "Overlap") ? 1 : 0;
  return self + tree.children.reduce((acc, c) => acc + countMatchNodes(c), 0);
}

function cloneWithConstraints(tree: Tree, constraints: MatchConstraint[], pos: { i: number }): Tree {
  const lt = tree.literal.literalType;
  let newLiteralType: LiteralType;

  if (lt.tag === "Match") {
    newLiteralType = { tag: "Match", constraint: constraints[pos.i++]! };
  } else if (lt.tag === "Before") {
    newLiteralType = { tag: "Before", constraint: constraints[pos.i++]! };
  } else if (lt.tag === "Overlap") {
    newLiteralType = { tag: "Overlap", constraint: constraints[pos.i++]! };
  } else {
    newLiteralType = lt;
  }

  return {
    ...tree,
    literal: { ...tree.literal, literalType: newLiteralType },
    children: tree.children.map(c => cloneWithConstraints(c, constraints, pos)),
  };
}

export function generateDeltaVariants(pattern: Tree): Tree[] {
  const matchCount = countMatchNodes(pattern);
  if (matchCount === 0) {
    return [pattern];
  }

  const variants: Tree[] = [];
  for (let j = 0; j < matchCount; j++) {
    const constraints: MatchConstraint[] = [];
    for (let pos = 0; pos < matchCount; pos++) {
      if (pos < j) constraints.push("old");
      else if (pos === j) constraints.push("delta");
      else constraints.push("any");
    }
    variants.push(cloneWithConstraints(pattern, constraints, { i: 0 }));
  }
  return variants;
}

export function expandAllWithDeltaVariants(patterns: Tree[]): Tree[] {
  expandCounter = 0;
  const expanded = patterns.flatMap(expand);
  return expanded.flatMap(generateDeltaVariants);
}
