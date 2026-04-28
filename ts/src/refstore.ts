import type { Atom, NodeId, Span, Term, Tree } from "./types.js";
import { hashconsAtom, hashconsTerm, tokenOfId, type HashconsState } from "./hashcons.js";

export type { NodeId } from "./types.js";

// Relational storage for the reference tree (see plans/relational-storage.md
// and plans/temporal-relationships.md).
//
// A RefStore is the flat tuple set the fixpoint mutates. Each row is a
// NodeRow keyed by a numeric id (hashcons token). Structure lives entirely
// in the `parentChild` and `beforeAfter` relations — there is no `path`
// column. `children` is retained as a pure iteration index (insertion order)
// for fast "enumerate children of P"; consumers must not read temporal
// meaning from it.

// A node row. Children are NOT carried here; to walk the children of a row,
// query `store.children.get(tokenOfId(id))`. The store only ever stores rows
// for the two insert-target tags — Ask is rewritten to Assert(`_choose`) by
// `rewriteAskToChoose`, and Match/Before/Overlap/Equal/Aggregate are
// pattern-only constructs and never reach a row, so the union is narrowed
// here. See plans/refactor-tree-type-pt2.md and
// plans/constraint-tuples.md §0d.
interface NodeRowBase {
  id: Term;
  atom: Atom;
  gen: number;
  span?: Span;
}

export type NodeRow =
  | (NodeRowBase & { tag: "Assert" })
  | (NodeRowBase & { tag: "Constrain" });

// Build a NodeRow from a Tree node, overriding `id`, `atom`, and `gen`.
// Throws if `template` carries a tag that the narrowed NodeRow union forbids
// — a runtime guard so any future regression in `expand` (e.g. an Aggregate
// slipping past the agg-instance rewrite, or an Ask that didn't get
// rewritten to Assert(`_choose`)) fails loudly instead of silently inserting
// a row the unifier won't see.
export function nodeRowFromTree(
  template: Tree,
  fields: { id: Term; atom: Atom; gen: number; span?: Span },
): NodeRow {
  if (template.tag !== "Assert" && template.tag !== "Constrain") {
    throw new Error(`nodeRowFromTree: cannot project tag ${template.tag} into a NodeRow`);
  }
  return { tag: template.tag, ...fields };
}

// Candidate is just a NodeRow; kept as a named alias so call sites in
// unify.ts read naturally ("candidate" conveys intent that a concrete row
// is being considered for a match).
export interface Candidate {
  node: NodeRow;
}

export type SymbolIndex = Map<string, Candidate[]>;

export interface RefStore {
  rootId: Term;
  nodes: Map<NodeId, NodeRow>;
  // Ordered child lists, keyed by parent id token. For every row in `nodes`,
  // `children.get(idKey(row.id))` gives its (possibly empty) children, in the
  // order they were appended. Used as a *pure iteration index* under the
  // relational model — order here is a storage artefact; temporal order
  // lives in `beforeAfter`. See plans/temporal-relationships.md.
  children: Map<NodeId, NodeRow[]>;
  // Parent lookup by child token. Absent for the root. Kept in sync with
  // `children` by `buildRefStore` / `insertChild`. Single-parent for now,
  // promoted to a Set when multi-parent assertion syntax lands.
  parentOf: Map<NodeId, NodeId>;
  // parent:child relation (parent → children) and its inverse (child →
  // parents). Currently single-parent — parentsOf is always a singleton or
  // absent (root) — but carried as Set to future-proof the multi-parent
  // goal in plans/temporal-relationships.md.
  parentChild: Map<NodeId, Set<NodeId>>;
  parentsOf: Map<NodeId, Set<NodeId>>;
  // before:after relation (earlier → laters) and its inverse. Many-to-many
  // from day one: a node can be directly before multiple successors if
  // rules assert it, and vice versa.
  beforeAfter: Map<NodeId, Set<NodeId>>;
  afterBefore: Map<NodeId, Set<NodeId>>;
  index: SymbolIndex;
}

function addEdge(m: Map<NodeId, Set<NodeId>>, from: NodeId, to: NodeId): void {
  let set = m.get(from);
  if (set === undefined) { set = new Set(); m.set(from, set); }
  set.add(to);
}

export function idKey(term: Term, hc: HashconsState): NodeId {
  return tokenOfId(term, hc);
}

export function hasNode(store: RefStore, id: Term, hc: HashconsState): boolean {
  return store.nodes.has(idKey(id, hc));
}

export function getNode(store: RefStore, id: Term, hc: HashconsState): NodeRow | undefined {
  return store.nodes.get(idKey(id, hc));
}

export function getRoot(store: RefStore, hc: HashconsState): NodeRow {
  const row = store.nodes.get(idKey(store.rootId, hc));
  if (!row) throw new Error("RefStore has no root row");
  return row;
}

// Parent's id term, or null for the root. O(1).
export function parentIdOf(store: RefStore, id: Term, hc: HashconsState): Term | null {
  const parentKey = store.parentOf.get(idKey(id, hc));
  if (parentKey === undefined) return null;
  const parent = store.nodes.get(parentKey);
  return parent ? parent.id : null;
}

// Build an empty RefStore seeded with a single synthetic Assert-tagged root
// row. The root's tag is never consulted by any read path; Assert is chosen
// so the store rows stay within the narrow {Assert, Constrain} union.
export function emptyRefStore(hc: HashconsState): RefStore {
  const nodes = new Map<NodeId, NodeRow>();
  const children = new Map<NodeId, NodeRow[]>();
  const parentOf = new Map<NodeId, NodeId>();
  const parentChild = new Map<NodeId, Set<NodeId>>();
  const parentsOf = new Map<NodeId, Set<NodeId>>();
  const beforeAfter = new Map<NodeId, Set<NodeId>>();
  const afterBefore = new Map<NodeId, Set<NodeId>>();
  const index: SymbolIndex = new Map();

  // Use a sentinel symbol name unlikely to collide with anything a user (or
  // generated rule) writes: a normal `sym("root")` fact would otherwise hash
  // to the same id and overwrite the synthetic row.
  const rootId = hashconsTerm({ tag: "Symbol", name: "$root" }, hc);
  const rootAtom = hashconsAtom({ terms: [] }, hc);
  const rootRow: NodeRow = {
    tag: "Assert",
    id: rootId,
    atom: rootAtom,
    gen: 0,
  };
  const key = idKey(rootId, hc);
  nodes.set(key, rootRow);
  children.set(key, []);

  return {
    rootId,
    nodes,
    children,
    parentOf,
    parentChild,
    parentsOf,
    beforeAfter,
    afterBefore,
    index,
  };
}

// Insert a new row as a child of `parent`. `row` must already carry
// hashconsed id and atom. Mutation-during-iteration safety relies on the
// caller stamping `row.gen = iteration` so passesConstraint hides the fresh
// row from the live matching pass.
//
// Emits only `parent:child(parentId, row.id)`. Temporal sequencing is the
// caller's job: step.ts writes `before:after` edges explicitly via
// `addBeforeAfter` based on pattern source (see
// plans/temporal-relationships.md §Step.ts). Inserts whose ordering is
// genuinely unconstrained get no temporal edge — `children` is a pure
// iteration index and conveys no temporal meaning.
export function insertChild(
  store: RefStore,
  parentId: Term,
  row: NodeRow,
  hc: HashconsState,
): NodeRow {
  const parentKey = idKey(parentId, hc);
  if (!store.nodes.has(parentKey)) {
    throw new Error(`RefStore.insertChild: no parent with id token ${parentKey}`);
  }
  const siblings = store.children.get(parentKey) ?? [];
  const key = idKey(row.id, hc);
  store.nodes.set(key, row);
  siblings.push(row);
  store.children.set(parentKey, siblings);
  store.children.set(key, []);
  store.parentOf.set(key, parentKey);
  addEdge(store.parentChild, parentKey, key);
  addEdge(store.parentsOf, key, parentKey);

  const firstTerm = row.atom.terms[0];
  if (firstTerm?.tag === "Symbol") {
    let bucket = store.index.get(firstTerm.name);
    if (bucket === undefined) { bucket = []; store.index.set(firstTerm.name, bucket); }
    bucket.push({ node: row });
  }
  return row;
}

// Assert a `before:after(prev, next)` edge. Both nodes must already be in
// the store. Idempotent — re-asserting an existing edge is a no-op.
export function addBeforeAfter(store: RefStore, prevId: Term, nextId: Term, hc: HashconsState): void {
  const prevKey = idKey(prevId, hc);
  const nextKey = idKey(nextId, hc);
  addEdge(store.beforeAfter, prevKey, nextKey);
  addEdge(store.afterBefore, nextKey, prevKey);
}

// ----- Derived structural relations -----
//
// Implementations are naive (BFS per call). Memoisation / materialisation
// is flagged in plans/temporal-relationships.md §"Derived-relation costs"
// as a perf follow-up once profiles justify it.

// Reflexive-transitive closure of parent:child. `contains(A, A)` is true.
export function contains(store: RefStore, a: NodeId, b: NodeId): boolean {
  if (a === b) return true;
  const seen = new Set<NodeId>([a]);
  const stack: NodeId[] = [a];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = store.parentChild.get(cur);
    if (!kids) continue;
    for (const k of kids) {
      if (k === b) return true;
      if (!seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return false;
}

// `contains(a, b) && a !== b` — the check Match/Before do when descending
// from the parent-image into a candidate.
export function strictlyContains(store: RefStore, a: NodeId, b: NodeId): boolean {
  return a !== b && contains(store, a, b);
}

// All nodes that contain `n` (including `n` itself). Used by `before` so
// the same ancestor-set isn't walked twice per check.
function ancestorsOf(store: RefStore, n: NodeId): Set<NodeId> {
  const out = new Set<NodeId>([n]);
  const stack: NodeId[] = [n];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const parents = store.parentsOf.get(cur);
    if (!parents) continue;
    for (const p of parents) {
      if (!out.has(p)) { out.add(p); stack.push(p); }
    }
  }
  return out;
}

// `before(a, b)` = some ancestor-or-self of a reaches some ancestor-or-self
// of b by following one or more `before:after` edges. This is the transitive
// closure of the raw relation, lifted by containment on both ends — a
// sibling-chain `a→x→b` produces `before(a, b)` even if the raw edges only
// record the adjacent steps.
export function before(store: RefStore, a: NodeId, b: NodeId): boolean {
  const bAncestors = ancestorsOf(store, b);
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [];
  for (const x of ancestorsOf(store, a)) { seen.add(x); stack.push(x); }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const afters = store.beforeAfter.get(cur);
    if (!afters) continue;
    for (const next of afters) {
      if (bAncestors.has(next)) return true;
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return false;
}

// `prior(a, b)` = before(a, b) ∨ contains(b, a). Used by the aggregate fold
// when scheduling inner instances before outer ones (see the fold pass in
// aggregate-fold.ts).
export function prior(store: RefStore, a: NodeId, b: NodeId): boolean {
  return before(store, a, b) || (a !== b && contains(store, b, a));
}

// `overlap(a, b)` = ∃ c. contains(a, c) ∧ contains(b, c). The descent check
// for the Overlap (`,`) literal — see plans/temporal-relationships.md.
export function overlap(store: RefStore, a: NodeId, b: NodeId): boolean {
  if (a === b) return true;
  // Both contains()-sets include self, so containment in either direction
  // implies overlap (contains(a, b) ⇒ pick c=b; contains(b, a) ⇒ pick c=a).
  if (contains(store, a, b) || contains(store, b, a)) return true;
  // General case: shared descendant. Under single-parent this is
  // impossible for incomparable a/b, but multi-parent rules can produce it.
  const aDesc = new Set<NodeId>([a]);
  const stack: NodeId[] = [a];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = store.parentChild.get(cur);
    if (!kids) continue;
    for (const k of kids) {
      if (!aDesc.has(k)) { aDesc.add(k); stack.push(k); }
    }
  }
  const bStack: NodeId[] = [b];
  const seen = new Set<NodeId>([b]);
  while (bStack.length > 0) {
    const cur = bStack.pop()!;
    if (aDesc.has(cur)) return true;
    const kids = store.parentChild.get(cur);
    if (!kids) continue;
    for (const k of kids) {
      if (!seen.has(k)) { seen.add(k); bStack.push(k); }
    }
  }
  return false;
}

// Iterate every row in the store. Order is insertion order (initial tree
// pre-order, then appended rows in insertion order). Consumers MUST NOT
// assume pre-order; descendant / temporal-before filters apply per candidate.
export function* allCandidates(store: RefStore): Generator<Candidate> {
  for (const row of store.nodes.values()) {
    yield { node: row };
  }
}

// Result of materializing the store: a tree where every node mirrors a
// `NodeRow`. Tags are narrowed to `Assert | Constrain` (the only tags rows
// carry — see `NodeRow` above), `gen` is required (rows always populate it),
// and `children` recurses into the same narrowed type, so an `Equal`/`Ask`/
// pattern-only node can never appear anywhere in the result.
interface ResultTreeBase {
  id: Term;
  atom: Atom;
  gen: number;
  span?: Span;
  children: ResultTree[];
}
export type ResultTree =
  | (ResultTreeBase & { tag: "Assert" })
  | (ResultTreeBase & { tag: "Constrain" });

// Materialize the store as a nested ResultTree — used to hand the fixpoint
// result to existing consumers (tests, web display) that expect a recursive
// children-bearing tree. The store remains the source of truth during
// evaluation.
export function refStoreToTree(store: RefStore, hc: HashconsState): ResultTree {
  return buildTreeFromRow(store, store.rootId, hc);
}

function buildTreeFromRow(store: RefStore, id: Term, hc: HashconsState): ResultTree {
  const key = idKey(id, hc);
  const row = store.nodes.get(key);
  if (!row) throw new Error(`refStoreToTree: no row for id token ${key}`);
  const kids = store.children.get(key) ?? [];
  return {
    tag: row.tag,
    id: row.id,
    atom: row.atom,
    children: kids.map((c) => buildTreeFromRow(store, c.id, hc)),
    gen: row.gen,
    ...(row.span !== undefined ? { span: row.span } : {}),
  };
}

// ----- Integrity check -----

// Verify the invariants called out in plans/temporal-relationships.md
// §"Integrity check": node-set / symbol-index consistency, `parent:child`
// and inverse agreement, acyclicity of `parent:child` (the DAG invariant),
// and acyclicity of the `before`-relation (lifted `before:after` through
// containment on both ends). O(nodes + edges) per call.
export function checkIntegrity(store: RefStore, hc: HashconsState): void {
  const { nodes, children, index, parentChild, parentsOf, beforeAfter, afterBefore } = store;

  // 1. Root present and matches store.rootId.
  const rootKey = idKey(store.rootId, hc);
  if (!nodes.has(rootKey)) throw new Error("integrity: store.rootId has no row");
  if (store.parentOf.has(rootKey) || parentsOf.has(rootKey)) {
    throw new Error("integrity: root row has a parent entry");
  }

  // 2. parent:child / parentsOf / parentOf / children-cache agreement.
  for (const [parent, kids] of parentChild) {
    if (!nodes.has(parent)) {
      throw new Error(`integrity: parentChild has unknown parent token ${parent}`);
    }
    for (const kid of kids) {
      if (!nodes.has(kid)) {
        throw new Error(`integrity: parentChild(${parent}, ${kid}) points to unknown child`);
      }
      const parents = parentsOf.get(kid);
      if (!parents || !parents.has(parent)) {
        throw new Error(`integrity: parentsOf(${kid}) missing inverse edge from parent ${parent}`);
      }
    }
  }
  for (const [kid, parents] of parentsOf) {
    for (const p of parents) {
      const forward = parentChild.get(p);
      if (!forward || !forward.has(kid)) {
        throw new Error(`integrity: parentChild(${p}) missing forward edge to ${kid}`);
      }
    }
  }
  for (const [key, row] of nodes) {
    if (key === rootKey) continue;
    if (!parentsOf.has(key)) {
      throw new Error(`integrity: non-root row ${key} has no parent edge`);
    }
    // parentOf cache must point to one of the row's parents.
    const cached = store.parentOf.get(key);
    if (cached === undefined) {
      throw new Error(`integrity: parentOf cache missing entry for ${key}`);
    }
    if (!parentsOf.get(key)!.has(cached)) {
      throw new Error(`integrity: parentOf cache for ${key} points to ${cached} which is not in parentsOf`);
    }
    void row;
  }

  // 3. Children-cache agreement: every entry in `children.get(p)` is a
  //    parent:child edge, and every parent:child edge has the child present
  //    in the cache.
  for (const [p, kidList] of children) {
    if (!nodes.has(p)) {
      throw new Error(`integrity: children cache has unknown parent token ${p}`);
    }
    const forward = parentChild.get(p) ?? new Set<NodeId>();
    const seenKids = new Set<NodeId>();
    for (const kid of kidList) {
      const kidKey = idKey(kid.id, hc);
      if (!forward.has(kidKey)) {
        throw new Error(`integrity: children cache[${p}] contains ${kidKey} with no parent:child edge`);
      }
      if (seenKids.has(kidKey)) {
        throw new Error(`integrity: children cache[${p}] lists ${kidKey} twice`);
      }
      seenKids.add(kidKey);
    }
    for (const kid of forward) {
      if (!seenKids.has(kid)) {
        throw new Error(`integrity: parent:child(${p}, ${kid}) missing from children cache`);
      }
    }
  }

  // 4. before:after / afterBefore inverse agreement.
  for (const [from, tos] of beforeAfter) {
    if (!nodes.has(from)) {
      throw new Error(`integrity: beforeAfter has unknown source token ${from}`);
    }
    for (const to of tos) {
      if (!nodes.has(to)) {
        throw new Error(`integrity: beforeAfter(${from}, ${to}) points to unknown target`);
      }
      const inv = afterBefore.get(to);
      if (!inv || !inv.has(from)) {
        throw new Error(`integrity: afterBefore(${to}) missing inverse edge from ${from}`);
      }
    }
  }
  for (const [to, froms] of afterBefore) {
    for (const from of froms) {
      const fwd = beforeAfter.get(from);
      if (!fwd || !fwd.has(to)) {
        throw new Error(`integrity: beforeAfter(${from}) missing forward edge to ${to}`);
      }
    }
  }

  // 5. parent:child acyclicity (partial-order invariant).
  assertAcyclic(parentChild, "parent:child");

  // 6. before acyclicity: the lifted closure of before:after through
  //    containment must be a partial order. A cheap sufficient-but-not-
  //    necessary check is that beforeAfter itself has no cycle — lifting
  //    through containment can only add edges between nodes whose lifted
  //    closure is already implied, so a cycle in the lifted form requires
  //    a cycle traceable in the raw relation plus containment. For
  //    simplicity we verify both components are acyclic and leave the
  //    lifted-closure check as a TODO once multi-parent rules land.
  assertAcyclic(beforeAfter, "before:after");

  // 7. Symbol index consistency.
  for (const [sym, bucket] of index) {
    for (const cand of bucket) {
      const key = idKey(cand.node.id, hc);
      if (!nodes.has(key)) {
        throw new Error(`integrity: symbol index bucket '${sym}' references dropped row (token ${key})`);
      }
      const first = cand.node.atom.terms[0];
      if (first?.tag !== "Symbol" || first.name !== sym) {
        throw new Error(`integrity: row in bucket '${sym}' starts with a different term`);
      }
    }
  }
}

// Kahn's algorithm — throws on cycle. Relation is from → {to}.
function assertAcyclic(rel: Map<NodeId, Set<NodeId>>, name: string): void {
  const inDeg = new Map<NodeId, number>();
  const nodesInRel = new Set<NodeId>();
  for (const [from, tos] of rel) {
    nodesInRel.add(from);
    inDeg.set(from, inDeg.get(from) ?? 0);
    for (const to of tos) {
      nodesInRel.add(to);
      inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
    }
  }
  const queue: NodeId[] = [];
  for (const n of nodesInRel) if ((inDeg.get(n) ?? 0) === 0) queue.push(n);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const to of rel.get(cur) ?? []) {
      const d = inDeg.get(to)! - 1;
      inDeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  if (visited !== nodesInRel.size) {
    throw new Error(`integrity: ${name} has a cycle`);
  }
}
