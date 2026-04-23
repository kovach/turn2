import type { AggregateInfo, LiteralType, MatchConstraint, Term, Tree } from "./types.js";
import { sym, vari, isPositive, match, assert_, newTrail, trailPush } from "./types.js";
import { substAtom, substTerm } from "./unify.js";

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
  rewriteCounter = 0;
  return patterns.flatMap(expand).map(rewriteUnboundAssertVars);
}

// --- Eliminate Variable terms in asserted output ---
//
// A variable whose first pre-order mention is inside an Assert (`+`) or Ask
// (`?`) node would survive into the reference store as a literal Variable
// term. Rewrite each such occurrence to a fresh id atom whose tail matches
// what `idExpand` would have emitted for a positive at that position —
// `previousVars` is recomputed by the same rule idExpand uses (push the
// node id of each Match/Before/Overlap, skip positives). See
// plans/eliminate-variables-output.md.

let rewriteCounter = 0;

// An expanded rule no longer carries the original positive tag on former
// positives (pruneAndConvert rewrote them to Match), but their id is still
// the id atom idExpand emitted. Detect that shape so we don't treat them
// as pushers during previousVars recomputation.
function isPositiveIdAtom(t: Term): boolean {
  if (t.tag !== "Atom") return false;
  const terms = t.atom.terms;
  if (terms.length < 3) return false;
  const [head, nm, ln] = terms;
  return head !== undefined && head.tag === "Symbol" && head.name === "id"
    && nm !== undefined && nm.tag === "Symbol"
    && ln !== undefined && ln.tag === "Symbol";
}

function findRuleName(rule: Tree): string | null {
  let found: string | null = null;
  function scan(node: Tree): boolean {
    if (isPositiveIdAtom(node.id) && node.id.tag === "Atom") {
      const nm = node.id.atom.terms[1]!;
      if (nm.tag === "Symbol") { found = nm.name; return true; }
    }
    for (const c of node.children) if (scan(c)) return true;
    return false;
  }
  scan(rule);
  return found;
}

function collectVarNames(t: Term, out: string[]): void {
  switch (t.tag) {
    case "Variable": out.push(t.name); return;
    case "Atom": for (const s of t.atom.terms) collectVarNames(s, out); return;
    default: return;
  }
}

export function rewriteUnboundAssertVars(rule: Tree): Tree {
  const maybeName = findRuleName(rule);
  if (maybeName === null) return rule;  // no positives → nothing to rewrite
  const name: string = maybeName;

  const seen = new Set<string>();
  const previousVars: Term[] = [];
  const subst = newTrail();

  function walk(node: Tree): Tree {
    const lt = node.literal.literalType;

    // Determine which terms to scan for variable mentions.
    // Match/Before/Overlap also contribute their `.id` — `-[Id] foo` binds
    // Id at match time, so Id is already bound for later nodes.
    const scanned: Term[] = lt.tag === "Aggregate"
      ? [lt.info.out]
      : (lt.tag === "Match" || lt.tag === "Before" || lt.tag === "Overlap")
      ? [node.id, ...node.literal.atom.terms]
      : node.literal.atom.terms;
    const substScanned = scanned.map(t => substTerm(t, subst));
    const mentions: string[] = [];
    for (const t of substScanned) collectVarNames(t, mentions);

    // For Assert/Ask: any variable first seen here gets a fresh id atom.
    if (lt.tag === "Assert" || lt.tag === "Ask") {
      for (const v of mentions) {
        if (seen.has(v)) continue;
        const idAtom: Term = {
          tag: "Atom",
          atom: { terms: [sym("id"), sym(name), sym("id" + ++rewriteCounter), ...previousVars] },
        };
        trailPush(subst, v, idAtom);
      }
    }

    // Apply running substitution to the node's atom (picks up both
    // previously rewritten vars and any new bindings from this node).
    const atom = substAtom(node.literal.atom, subst);

    for (const v of mentions) seen.add(v);

    // previousVars: push ids of original Match/Before/Overlap nodes (which
    // have non-Atom ids). Former positives converted to Match by
    // pruneAndConvert have positive-id Atom ids and must not push — idExpand
    // didn't push them in the pre-expand pass.
    const bindsId = lt.tag === "Match" || lt.tag === "Before" || lt.tag === "Overlap";
    if (bindsId && !isPositiveIdAtom(node.id)) {
      previousVars.push(node.id);
    }

    // Aggregate children are scoped to the fold — don't descend.
    const children = lt.tag === "Aggregate"
      ? node.children
      : node.children.map(walk);

    return { ...node, literal: { ...node.literal, atom }, children };
  }

  return { ...rule, children: rule.children.map(walk) };
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
  rewriteCounter = 0;
  const expanded = patterns.flatMap(expand).map(rewriteUnboundAssertVars);
  return expanded.flatMap(generateDeltaVariants);
}
