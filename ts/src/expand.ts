import type { AggregateInfo, BodyTree, MatchConstraint, Term, Tree } from "./types.js";
import { sym, vari, isPositive, retag, newTrail, trailPush } from "./types.js";
import { substAtom, substTerm } from "./unify.js";

export function idExpand(tree: BodyTree, name: string): BodyTree {
  const previousVars: Term[] = [];
  let counter = 1;

  function walk(node: Tree): Tree {
    if (node.tag === "Equal") return node;  // Equal carries no id/atom/children

    if (node.tag === "Ask") {
      // Positive-style id rewrite, no children to recurse into. Variables in
      // the Ask's atom get rewritten by the same `seen`-tracking pass that
      // handles Assert (`rewriteUnboundAssertVars`).
      const newId: Term = { tag: "Atom", atom: { terms: [sym("id"), sym(name), sym("id" + counter++), ...previousVars] } };
      let atom = node.atom;
      if (node.id.tag === "Variable") {
        const t = newTrail();
        trailPush(t, node.id.name, newId);
        atom = substAtom(atom, t);
      }
      return { ...node, id: newId, atom };
    }

    const positive = isPositive(node);
    // Only Match/Before/Overlap actually bind their node id against the reference
    // tree at match time. Other literals (Equal etc.) have no id binding, so an
    // auto-X would stay free and leak into downstream positives' ids — excluded
    // from previousVars by the bindsId guard.
    const bindsId = node.tag === "Match" || node.tag === "Before" || node.tag === "Overlap";
    let newId: Term;
    if (positive) {
      newId = { tag: "Atom", atom: { terms: [sym("id"), sym(name), sym("id" + counter++), ...previousVars] } };
    } else {
      const isAutoId = node.id.tag === "Variable" && /^\d+$/.test(node.id.name);
      newId = isAutoId ? vari("X" + counter++) : node.id;
      if (bindsId) previousVars.push(newId);
    }
    let atom = node.atom;
    if (node.id.tag === "Variable") {
      const t = newTrail();
      // Exempt from the unify.ts trail-hashcons invariant: this trail lives
      // for a single substAtom call at parse time, never participates in
      // fixpoint matching, and no HashconsState is available here.
      trailPush(t, node.id.name, newId);
      atom = substAtom(atom, t);
    }
    const children = node.children.map(walk);
    return { ...node, id: newId, atom, children };
  }

  const children = tree.children.map(walk);
  return { ...tree, children };
}

// Rewrite each Ask node into an Assert whose atom is
// `[sym("_choose"), ...ask.atom.terms]`. Runs once per rule before `expand`,
// so `expand` and downstream walks never see Ask. Ask carries no children, so
// the resulting Assert also has children = []. Preserves id, span, etc.
export function rewriteAskToChoose(tree: Tree): Tree {
  if (tree.tag === "Equal") return tree;
  if (tree.tag === "Ask") {
    const out: Tree = {
      tag: "Assert",
      id: tree.id,
      atom: { terms: [sym("_choose"), ...tree.atom.terms] },
      children: [],
      ...(tree.macroInvocation && { macroInvocation: tree.macroInvocation }),
      ...(tree.span && { span: tree.span }),
      ...(tree.gen !== undefined && { gen: tree.gen }),
    };
    return out;
  }
  return { ...tree, children: tree.children.map(rewriteAskToChoose) };
}

interface AggMeta {
  lexId: Term;
  nodeId: Term;
  info: AggregateInfo;
  localPattern: Tree[];
}

// A non-target Constrain in a delta variant's prefix is dropped, not
// retagged to Match. Constrain rows are invisible to Match (unify.ts:132),
// so retagging would prevent the variant from ever firing once its body
// holds two Constrain literals. Elision is sound because each Constrain is
// asserted by its own variant — see plans/constraint-tuples.md §2.5.
function isElidedConstrain(child: Tree, targetNode: Tree): boolean {
  return child.tag === "Constrain" && child !== targetNode;
}

function pruneAndConvert(
  node: Tree,
  targetNode: Tree,
  state: { found: boolean },
  aggMap: Map<Tree, AggMeta>,
): Tree | null {
  if (state.found) return null;

  // Equal is a leaf — no children to recurse into, no positives inside.
  // Pass it through unchanged.
  if (node.tag === "Equal") return node;
  if (node.tag === "Ask") {
    throw new Error("pruneAndConvert: unexpected Ask — should be rewritten to Assert(`_choose`)");
  }

  const aggMeta = aggMap.get(node);
  const isAgg = node.tag === "Aggregate";

  if (node === targetNode) {
    state.found = true;
    if (isAgg && aggMeta) {
      const asAssert = retag(node, "Assert", {});
      return { ...asAssert, children: [] };
    }
    return { ...node, children: [] };
  }

  // Before target: convert positive to Match, aggregate to agg-result
  if (isAgg && aggMeta) {
    return {
      tag: "Match",
      constraint: "any",
      id: {
        tag: "Atom",
        atom: { terms: [sym("id"), sym("_agg-result"), aggMeta.lexId, aggMeta.nodeId] },
      },
      atom: { terms: [sym("_agg-result"), aggMeta.lexId, aggMeta.nodeId, aggMeta.info.out] },
      children: [],
    };
  }

  let newNode: BodyTree;
  if (isPositive(node)) {
    newNode = retag(node, "Match", { constraint: "any" }) as BodyTree;
  } else {
    newNode = node;
  }

  const children: Tree[] = [];
  for (const child of node.children) {
    if (isElidedConstrain(child, targetNode)) continue;
    const result = pruneAndConvert(child, targetNode, state, aggMap);
    if (result === null) break;
    children.push(result);
  }
  return { ...newNode, children };
}

let expandCounter = 0;

export function expand(pattern: BodyTree): BodyTree[] {
  // Rewrite Ask → Assert(`_choose`) before any walk runs. Every walk below
  // assumes the input contains no Ask nodes; rewriteAskToChoose enforces
  // that invariant for direct callers (tests) as well as for expandAll.
  pattern = rewriteAskToChoose(pattern) as BodyTree;

  const positiveNodes: Tree[] = [];
  const aggMap = new Map<Tree, AggMeta>();

  function findPositivesAndAggs(node: Tree): void {
    if (node.tag === "Equal") return;  // leaf — no positives, no children
    if (node.tag === "Ask") {
      throw new Error("expand: unexpected Ask — should have been rewritten by rewriteAskToChoose");
    }
    if (isPositive(node)) {
      positiveNodes.push(node);
      if (node.tag === "Aggregate") {
        aggMap.set(node, {
          lexId: sym(`agg_${node.info.funcName}_${expandCounter++}`),
          nodeId: node.id,
          info: node.info,
          localPattern: node.children,
        });
      }
    }
    for (const child of node.children) findPositivesAndAggs(child);
  }
  for (const child of pattern.children) findPositivesAndAggs(child);

  const rules: BodyTree[] = [];

  for (const targetNode of positiveNodes) {
    const aggMeta = aggMap.get(targetNode);

    if (aggMeta) {
      rules.push(buildAggRule1(pattern, targetNode, aggMeta, aggMap));
      rules.push(buildAggRule2(pattern, targetNode, aggMeta, aggMap));
    } else {
      const state = { found: false };
      const children: Tree[] = [];
      for (const child of pattern.children) {
        if (isElidedConstrain(child, targetNode)) continue;
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
  pattern: BodyTree,
  targetNode: Tree,
  aggMeta: AggMeta,
  aggMap: Map<Tree, AggMeta>,
): BodyTree {
  const state = { found: false };

  function prune(node: Tree): Tree | null {
    if (state.found) return null;
    if (node.tag === "Equal") return node;  // leaf passthrough
    if (node.tag === "Ask") {
      throw new Error("buildAggRule1.prune: unexpected Ask");
    }

    const isAgg = node.tag === "Aggregate";
    const priorAgg = aggMap.get(node);

    if (node === targetNode) {
      state.found = true;
      return {
        tag: "Assert",
        id: aggMeta.nodeId,
        atom: { terms: [sym("_agg-instance"), aggMeta.lexId] },
        children: [],
      };
    }

    let newNode: BodyTree;
    if (isAgg && priorAgg) {
      newNode = {
        tag: "Match",
        constraint: "any",
        id: priorAgg.nodeId,
        atom: { terms: [sym("_agg-result"), priorAgg.lexId, priorAgg.nodeId, priorAgg.info.out] },
        children: [],
      };
    } else if (isPositive(node)) {
      newNode = retag(node, "Match", { constraint: "any" }) as BodyTree;
    } else {
      newNode = node as BodyTree;
    }

    const children: Tree[] = [];
    for (const child of node.children) {
      if (isElidedConstrain(child, targetNode)) continue;
      const result = prune(child);
      if (result === null) break;
      children.push(result);
    }
    return { ...newNode, children };
  }

  const children: Tree[] = [];
  for (const child of pattern.children) {
    if (isElidedConstrain(child, targetNode)) continue;
    const result = prune(child);
    if (result === null) break;
    children.push(result);
  }
  return { ...pattern, children };
}

function buildAggRule2(
  pattern: BodyTree,
  targetNode: Tree,
  aggMeta: AggMeta,
  aggMap: Map<Tree, AggMeta>,
): BodyTree {
  const state = { found: false };

  function collectIds(nodes: Tree[]): Term[] {
    return nodes.flatMap((n) => {
      if (n.tag === "Equal") return [];
      if (n.tag === "Ask") return [n.id];
      return [n.id, ...collectIds(n.children)];
    });
  }
  const localPatternIds = collectIds(aggMeta.localPattern);

  const bindingId: Term = {
    tag: "Atom",
    atom: { terms: [sym("id"), sym("_agg-binding"), aggMeta.lexId, aggMeta.nodeId, ...localPatternIds] },
  };
  const aggBinding: Tree = {
    tag: "Assert",
    id: bindingId,
    atom: { terms: [sym("_agg-binding"), aggMeta.lexId, aggMeta.nodeId, ...aggMeta.info.args] },
    children: [],
  };

  function prune(node: Tree): Tree | null {
    if (state.found) return null;
    if (node.tag === "Equal") return node;  // leaf passthrough
    if (node.tag === "Ask") {
      throw new Error("buildAggRule2.prune: unexpected Ask");
    }

    const isAgg = node.tag === "Aggregate";
    const priorAgg = aggMap.get(node);

    if (node === targetNode) {
      state.found = true;
      return {
        tag: "Match",
        constraint: "any",
        id: aggMeta.nodeId,
        atom: { terms: [sym("_agg-instance"), aggMeta.lexId] },
        children: [...aggMeta.localPattern, aggBinding],
      };
    }

    let newNode: BodyTree;
    if (isAgg && priorAgg) {
      newNode = {
        tag: "Match",
        constraint: "any",
        id: priorAgg.nodeId,
        atom: { terms: [sym("_agg-result"), priorAgg.lexId, priorAgg.nodeId, priorAgg.info.out] },
        children: [],
      };
    } else if (isPositive(node)) {
      newNode = retag(node, "Match", { constraint: "any" }) as BodyTree;
    } else {
      newNode = node as BodyTree;
    }

    const children: Tree[] = [];
    for (const child of node.children) {
      if (isElidedConstrain(child, targetNode)) continue;
      const result = prune(child);
      if (result === null) break;
      children.push(result);
    }
    return { ...newNode, children };
  }

  const children: Tree[] = [];
  for (const child of pattern.children) {
    if (isElidedConstrain(child, targetNode)) continue;
    const result = prune(child);
    if (result === null) break;
    children.push(result);
  }

  return { ...pattern, children };
}

export function expandAll(patterns: Tree[]): BodyTree[] {
  expandCounter = 0;
  rewriteCounter = 0;
  // Top-level patterns are Match-rooted from parse, so no top-level Ask.
  // `expand` itself runs `rewriteAskToChoose` on its input so child Asks
  // are converted before any walk inspects them.
  const bodyPatterns = patterns.filter((p): p is BodyTree => p.tag !== "Equal");
  return bodyPatterns.flatMap(expand).map(rewriteUnboundAssertVars);
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
    if (node.tag === "Equal") return false;
    if (isPositiveIdAtom(node.id) && node.id.tag === "Atom") {
      const nm = node.id.atom.terms[1]!;
      if (nm.tag === "Symbol") { found = nm.name; return true; }
    }
    if (node.tag === "Ask") return false;
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

export function rewriteUnboundAssertVars(rule: BodyTree): BodyTree {
  const maybeName = findRuleName(rule);
  if (maybeName === null) return rule;  // no positives → nothing to rewrite
  const name: string = maybeName;

  const seen = new Set<string>();
  const previousVars: Term[] = [];
  const subst = newTrail();

  function walk(node: Tree): Tree {
    // Equal: scan its lhs/rhs for variable mentions but no rewrite (Equal
    // isn't a positive); Equal can introduce bindings that later siblings
    // observe at match time, so its mentions feed `seen`.
    if (node.tag === "Equal") {
      const mentions: string[] = [];
      for (const t of [node.lhs, node.rhs].map(t => substTerm(t, subst))) {
        collectVarNames(t, mentions);
      }
      for (const v of mentions) seen.add(v);
      return node;
    }
    if (node.tag === "Ask") {
      throw new Error("rewriteUnboundAssertVars: unexpected Ask — should be rewritten before this pass");
    }

    // Determine which terms to scan for variable mentions.
    // Match/Before/Overlap also contribute their `.id` — `-[Id] foo` binds
    // Id at match time, so Id is already bound for later nodes.
    const scanned: Term[] = node.tag === "Aggregate"
      ? [node.info.out]
      : (node.tag === "Match" || node.tag === "Before" || node.tag === "Overlap")
      ? [node.id, ...node.atom.terms]
      : node.atom.terms;
    const substScanned = scanned.map(t => substTerm(t, subst));
    const mentions: string[] = [];
    for (const t of substScanned) collectVarNames(t, mentions);

    // For Assert: any variable first seen here gets a fresh id atom.
    // (Ask is rewritten to Assert(`_choose`) by `rewriteAskToChoose`
    // before this pass runs, so Ask never appears here.)
    if (node.tag === "Assert") {
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
    const atom = substAtom(node.atom, subst);

    for (const v of mentions) seen.add(v);

    // previousVars: push ids of original Match/Before/Overlap nodes (which
    // have non-Atom ids). Former positives converted to Match by
    // pruneAndConvert have positive-id Atom ids and must not push — idExpand
    // didn't push them in the pre-expand pass.
    const bindsId = node.tag === "Match" || node.tag === "Before" || node.tag === "Overlap";
    if (bindsId && !isPositiveIdAtom(node.id)) {
      previousVars.push(node.id);
    }

    // Aggregate children are scoped to the fold — don't descend.
    const children = node.tag === "Aggregate"
      ? node.children
      : node.children.map(walk);

    return { ...node, atom, children };
  }

  return { ...rule, children: rule.children.map(walk) };
}

function countMatchNodes(tree: Tree): number {
  if (tree.tag === "Equal" || tree.tag === "Ask") return 0;
  const self = (tree.tag === "Match" || tree.tag === "Before" || tree.tag === "Overlap") ? 1 : 0;
  return self + tree.children.reduce((acc: number, c: Tree) => acc + countMatchNodes(c), 0);
}

function cloneWithConstraints(tree: Tree, constraints: MatchConstraint[], pos: { i: number }): Tree {
  if (tree.tag === "Equal" || tree.tag === "Ask") return tree;
  const children = tree.children.map((c: Tree) => cloneWithConstraints(c, constraints, pos));
  if (tree.tag === "Match" || tree.tag === "Before" || tree.tag === "Overlap") {
    return { ...tree, constraint: constraints[pos.i++]!, children };
  }
  return { ...tree, children };
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
  const bodyPatterns = patterns.filter((p): p is BodyTree => p.tag !== "Equal");
  const expanded = bodyPatterns.flatMap(expand).map(rewriteUnboundAssertVars);
  return expanded.flatMap(generateDeltaVariants);
}

