import type { NodeId, Term, Tree } from "./types.js";
import { newTrail, trailLookup, vari } from "./types.js";
import type { HashconsState } from "./hashcons.js";
import { hashconsTerm } from "./hashcons.js";
import { idKey, type NodeRow, type RefStore } from "./refstore.js";
import { walkTermDeep } from "./fringe.js";
import { unifyTree } from "./unify.js";
import type { UnresolvedChoice } from "./scheduler.js";

// Output of the lift+run pass for a single connected component of the
// constraint graph. `activeTerms` is sorted by hashcons-token id for
// deterministic option ordering; each `options[i]` is a tuple of the same
// length, giving one valid joint binding for the active terms.
export interface ComponentOptions {
  activeTerms: Term[];
  options: Term[][];
}

export type ComputeComponentsResult =
  | { kind: "ok"; components: ComponentOptions[] }
  | { kind: "empty-fringe-error"; choice: UnresolvedChoice; choiceTerm: Term };

// Build resolvedMap (idKey of a choice term → resolved value), the active
// term set (from the active-tier choices), and the unresolvedSet over every
// `_choose` row in the store. Single pass per index bucket.
function gatherChoiceContext(
  ref: RefStore,
  hc: HashconsState,
  activeChoices: UnresolvedChoice[],
): {
  resolvedMap: Map<NodeId, Term>;
  activeSet: Set<NodeId>;
  unresolvedSet: Set<NodeId>;
  termByKey: Map<NodeId, Term>;
} {
  const resolvedMap = new Map<NodeId, Term>();
  for (const row of ref.index.get("is") ?? []) {
    const ts = row.node.atom.terms;
    if (ts.length < 3) continue;
    resolvedMap.set(idKey(ts[1]!, hc), ts[2]!);
  }

  const activeSet = new Set<NodeId>();
  for (const c of activeChoices) {
    for (const t of c.unresolvedTerms) activeSet.add(idKey(t, hc));
  }

  const unresolvedSet = new Set<NodeId>();
  const termByKey = new Map<NodeId, Term>();
  for (const row of ref.index.get("_choose") ?? []) {
    const ts = row.node.atom.terms;
    for (let i = 1; i < ts.length; i++) {
      const term = ts[i]!;
      const k = idKey(term, hc);
      if (resolvedMap.has(k)) continue;
      unresolvedSet.add(k);
      termByKey.set(k, term);
    }
  }

  return { resolvedMap, activeSet, unresolvedSet, termByKey };
}

// Find the unresolved choice term keys mentioned anywhere (recursively)
// inside `row.atom`. Used both to build the bipartite term/row adjacency
// and to drive BFS frontier expansion.
function unresolvedTermsTouched(
  row: NodeRow,
  unresolvedSet: Set<NodeId>,
  hc: HashconsState,
): NodeId[] {
  const found = new Set<NodeId>();
  for (const t of row.atom.terms) {
    walkTermDeep(t, hc, (sub) => {
      const k = idKey(sub, hc);
      if (unresolvedSet.has(k)) found.add(k);
    });
  }
  return [...found];
}

interface RawComponent {
  members: Set<NodeId>;
  rows: NodeRow[];
}

// BFS over the bipartite (unresolved-term ↔ Constrain-row) graph.
// Singleton terms with no constrain row form components with rows = [].
function buildComponents(
  ref: RefStore,
  hc: HashconsState,
  unresolvedSet: Set<NodeId>,
): RawComponent[] {
  // termKey → Constrain rows that touch it; rowIdKey → unresolved term keys
  // it touches. Single store walk to populate both.
  const termToRows = new Map<NodeId, NodeRow[]>();
  const rowToTerms = new Map<NodeId, NodeId[]>();
  for (const row of ref.nodes.values()) {
    if (row.tag !== "Constrain") continue;
    const touched = unresolvedTermsTouched(row, unresolvedSet, hc);
    if (touched.length === 0) continue;
    rowToTerms.set(idKey(row.id, hc), touched);
    for (const u of touched) {
      const list = termToRows.get(u) ?? [];
      list.push(row);
      termToRows.set(u, list);
    }
  }

  const visited = new Set<NodeId>();
  const components: RawComponent[] = [];
  for (const start of unresolvedSet) {
    if (visited.has(start)) continue;
    const members = new Set<NodeId>([start]);
    const rows: NodeRow[] = [];
    const seenRows = new Set<NodeId>();
    let frontier: NodeId[] = [start];
    while (frontier.length > 0) {
      const next: NodeId[] = [];
      for (const u of frontier) {
        const incident = termToRows.get(u);
        if (!incident) continue;
        for (const r of incident) {
          const rk = idKey(r.id, hc);
          if (seenRows.has(rk)) continue;
          seenRows.add(rk);
          rows.push(r);
          for (const u2 of rowToTerms.get(rk)!) {
            if (!members.has(u2)) {
              members.add(u2);
              next.push(u2);
            }
          }
        }
      }
      frontier = next;
    }
    for (const k of members) visited.add(k);
    components.push({ members, rows });
  }
  return components;
}

// Lift a component to a Match-pattern Tree, run it via `unifyTree`, and
// collect the joint bindings of active terms as deduped option tuples.
function runComponent(
  ref: RefStore,
  hc: HashconsState,
  comp: RawComponent,
  activeSet: Set<NodeId>,
  resolvedMap: Map<NodeId, Term>,
  termByKey: Map<NodeId, Term>,
): ComponentOptions {
  // Stable orderings for deterministic var-name assignment and option-tuple
  // alignment. activeTerms order is part of the public output.
  const activeKeys = [...comp.members].filter((k) => activeSet.has(k)).sort((a, b) => a - b);
  const existentialKeys = [...comp.members].filter((k) => !activeSet.has(k) && !resolvedMap.has(k)).sort((a, b) => a - b);

  const activeVarByKey = new Map<NodeId, Term>();
  const activeVarNames: string[] = [];
  activeKeys.forEach((k, i) => {
    const name = `_V_choice_${i}`;
    activeVarNames.push(name);
    activeVarByKey.set(k, vari(name));
  });
  const existVarByKey = new Map<NodeId, Term>();
  existentialKeys.forEach((k, i) => {
    existVarByKey.set(k, vari(`_V_exist_${i}`));
  });

  // Substitute choice/resolved terms inside an arbitrary Term, recursing
  // through Refs and Atoms. A Ref whose body needs rewriting is unwrapped
  // into a fresh Atom; the unifier's Atom-vs-Ref logic handles match-time
  // expansion against the store side.
  function rewrite(term: Term): Term {
    const k = idKey(term, hc);
    const av = activeVarByKey.get(k);
    if (av) return av;
    const ev = existVarByKey.get(k);
    if (ev) return ev;
    const rv = resolvedMap.get(k);
    if (rv) return rv;
    if (term.tag === "Ref") {
      const atom = hc.refToAtom.get(term.id);
      if (!atom) return term;
      const rewrittenTerms: Term[] = [];
      let changed = false;
      for (const t of atom.terms) {
        const r = rewrite(t);
        if (r !== t) changed = true;
        rewrittenTerms.push(r);
      }
      if (!changed) return term;
      return { tag: "Atom", atom: { terms: rewrittenTerms } };
    }
    return term;
  }

  const children: Tree[] = comp.rows.map((row) => ({
    tag: "Match",
    constraint: "any",
    id: { tag: "Wildcard" },
    atom: { terms: row.atom.terms.map(rewrite) },
    children: [],
  }));

  const root: Tree = {
    tag: "Match",
    constraint: "any",
    id: { tag: "Wildcard" },
    atom: { terms: [] },
    children,
  };

  const seen = new Set<string>();
  const options: Term[][] = [];
  // Iteration count of `Number.MAX_SAFE_INTEGER` so every row passes the
  // any/delta/old generation check — the lifted query is read-only and
  // mustn't filter rows by generation.
  unifyTree(root, ref, newTrail(), Number.MAX_SAFE_INTEGER, hc, (trail) => {
    const tuple: Term[] = [];
    const key: number[] = [];
    for (const name of activeVarNames) {
      const bound = trailLookup(trail, name);
      if (bound === undefined) return;
      const canonical = bound.tag === "Atom" ? hashconsTerm(bound, hc) : bound;
      tuple.push(canonical);
      key.push(idKey(canonical, hc));
    }
    const skey = key.join(",");
    if (seen.has(skey)) return;
    seen.add(skey);
    options.push(tuple);
  });

  const activeTerms = activeKeys.map((k) => termByKey.get(k)!);
  return { activeTerms, options };
}

// Top-level entry called by fixpoint when it pauses on active choices.
// Builds the component partition, applies the empty-fringe short-circuit,
// and runs the lifted query for each kept component.
export function computeComponents(
  ref: RefStore,
  hc: HashconsState,
  activeChoices: UnresolvedChoice[],
): ComputeComponentsResult {
  const { resolvedMap, activeSet, unresolvedSet, termByKey } =
    gatherChoiceContext(ref, hc, activeChoices);

  const components = buildComponents(ref, hc, unresolvedSet);

  // Keep only components that touch at least one active term — non-active
  // components carry only existentials and don't need a query at this pause.
  const kept = components.filter((c) => {
    for (const k of c.members) if (activeSet.has(k)) return true;
    return false;
  });

  // Empty-closure guard: any active term in a component with no Constrain
  // rows is unconstrained — programmer error. Short-circuits even if other
  // components are non-empty.
  for (const c of kept) {
    if (c.rows.length > 0) continue;
    for (const k of c.members) {
      if (!activeSet.has(k)) continue;
      const choiceTerm = termByKey.get(k)!;
      const owningChoice = activeChoices.find((ch) =>
        ch.unresolvedTerms.some((t) => idKey(t, hc) === k),
      );
      if (owningChoice === undefined) {
        throw new Error("computeComponents: active term has no owning UnresolvedChoice");
      }
      return { kind: "empty-fringe-error", choice: owningChoice, choiceTerm };
    }
  }

  const results = kept.map((c) =>
    runComponent(ref, hc, c, activeSet, resolvedMap, termByKey),
  );
  return { kind: "ok", components: results };
}

