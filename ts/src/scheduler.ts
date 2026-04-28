import type { Term, NodeId } from "./types.js";
import type { HashconsState } from "./hashcons.js";
import { idKey, prior, type NodeRow, type RefStore } from "./refstore.js";
import { collectPausedAggregates, type AggInstance } from "./aggregate-fold.js";

// One "_choose <chooseId> A B ..." row whose tail still has unresolved
// variables. Per-term resolution: a term is resolved iff some "is T v" row
// pins it (`tokenOfId(T) === tokenOfId(term)`), independently of its
// siblings. The row stays the schedulable unit (its node id determines
// `prior` ordering); `unresolvedTerms` carries the still-active positions
// for option enumeration in step 2.
export interface UnresolvedChoice {
  row: NodeRow;
  chooseId: Term;
  unresolvedTerms: Term[];
}

// Walk ref.index.get("_choose"); for each row partition terms[1..] by
// membership in the resolved-token set built from "is" rows. Emit rows
// whose unresolved subset is non-empty.
export function collectUnresolvedChoices(ref: RefStore, hc: HashconsState): UnresolvedChoice[] {
  const resolved = new Set<NodeId>();
  for (const row of ref.index.get("is") ?? []) {
    const terms = row.node.atom.terms;
    if (terms.length < 3) continue;
    resolved.add(idKey(terms[1]!, hc));
  }

  const out: UnresolvedChoice[] = [];
  for (const row of ref.index.get("_choose") ?? []) {
    const terms = row.node.atom.terms;
    if (terms.length < 2) continue;
    const tail = terms.slice(1);
    const unresolvedTerms = tail.filter((t) => !resolved.has(idKey(t, hc)));
    if (unresolvedTerms.length === 0) continue;
    out.push({
      row: row.node,
      chooseId: row.node.id,
      unresolvedTerms,
    });
  }
  return out;
}

export type Schedulable =
  | { kind: "agg"; row: NodeRow; nodeId: NodeId; instance: AggInstance }
  | { kind: "choice"; row: NodeRow; nodeId: NodeId; choice: UnresolvedChoice };

// Combined view over paused aggregates and unresolved choice rows.
export function collectSchedulables(ref: RefStore, hc: HashconsState): Schedulable[] {
  const out: Schedulable[] = [];
  for (const instance of collectPausedAggregates(ref, hc)) {
    out.push({
      kind: "agg",
      row: instance.row,
      nodeId: idKey(instance.row.id, hc),
      instance,
    });
  }
  for (const choice of collectUnresolvedChoices(ref, hc)) {
    out.push({
      kind: "choice",
      row: choice.row,
      nodeId: idKey(choice.row.id, hc),
      choice,
    });
  }
  return out;
}

// Scheduling uses `prior` (= before ∪ contains⁻¹) rather than `before`: a
// nested aggregate must close first so the outer fold observes its
// `_agg-result`, and a choice nested under a paused agg must wait for it.
// Heterogeneous over agg + choice — both flavours are compared on their
// row's node id.
//
// "Earliest tier" = the prefix of the prior-sorted list whose first
// element is `prior` to nothing else. Items prior-incomparable to the
// first remain in the tier; anything strictly after the first is dropped.
export function selectEarliestTier(
  ref: RefStore,
  hc: HashconsState,
  items: Schedulable[],
): Schedulable[] {
  if (items.length === 0) return [];
  if (items.length === 1) return items;

  const sorted = [...items].sort((a, b) => {
    if (prior(ref, a.nodeId, b.nodeId)) return -1;
    if (prior(ref, b.nodeId, a.nodeId)) return 1;
    return 0;
  });

  const earliest: Schedulable[] = [sorted[0]!];
  const firstId = sorted[0]!.nodeId;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (prior(ref, firstId, next.nodeId)) break;
    earliest.push(next);
  }
  return earliest;
}
