# unification perf - index

## Overview

Index reference tree nodes by the leading symbol of their atom, so `matchSubtree` can skip candidates that cannot possibly unify.

## Motivation

Currently `matchSubtree` (line 199 of `unify.ts`) iterates over all candidates for every pattern node. For a reference tree with N nodes and a pattern with M match nodes, this is O(N*M) unification attempts.

Most atoms start with a symbol (e.g., `foo X Y`, `card C`, `move A B`). When the pattern also starts with a symbol, we can use an index to only consider nodes whose first symbol matches.

## 1. Index structure

In `unify.ts`, define the index type:

```ts
type SymbolIndex = Map<string, Candidate[]>;
```

Build it once from the candidate list:

```ts
function buildSymbolIndex(candidates: Candidate[]): SymbolIndex {
  const index: SymbolIndex = new Map();
  for (const c of candidates) {
    const firstTerm = c.node.literal.atom.terms[0];
    if (firstTerm?.tag === "Symbol") {
      const key = firstTerm.name;
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(c);
    }
  }
  return index;
}
```

Nodes whose first term is not a symbol are not indexed (they're rare and will be matched via fallback).

## 2. Pass index through search

Update `SearchState` to carry the index:

```ts
interface SearchState {
  deepest: number[];
  subst: Substitution;
  root: Tree;
  index: SymbolIndex;
  allCandidates: Candidate[];  // fallback for non-symbol patterns
}
```

Build once in `unifyTree`:

```ts
export function unifyTree(pattern: Tree, reference: Tree): Substitution[] {
  // ... existing root check ...
  const candidates = collectNodes(reference, []);
  const index = buildSymbolIndex(candidates);
  return matchChildren(pattern.children, {
    deepest: [],
    subst: rootSubst,
    root: reference,
    index,
    allCandidates: candidates,
  }).map((s) => s.subst);
}
```

## 3. Use index in matchSubtree

Replace the current loop in `matchSubtree`:

```ts
function matchSubtree(
  pat: Tree,
  state: SearchState,
  anchor: number[]
): SearchState[] {
  const results: SearchState[] = [];
  const isBefore = pat.literal.literalType === "Before";
  
  // Determine which candidates to check
  const firstTerm = pat.literal.atom.terms[0];
  const candidates = (firstTerm?.tag === "Symbol")
    ? (state.index.get(firstTerm.name) ?? [])
    : state.allCandidates;
  
  for (const { path, node } of candidates) {
    if (isBefore) {
      if (!isTemporallyBefore(path, anchor)) continue;
    } else {
      if (!isStrictDescendant(state.deepest, path)) continue;
    }
    const s = unifyNode(pat, node, state.subst);
    if (s === null) continue;
    const childResults = matchChildren(pat.children, {
      ...state,
      deepest: path,
      subst: s,
    });
    results.push(...childResults);
  }
  return results;
}
```

When pattern starts with a symbol, we only iterate indexed candidates. When pattern starts with a variable or atom, we fall back to all candidates.

## 4. Update call sites

Remove `candidates` parameter from all three functions since it's now on `state`:

- `matchChildren(patChildren, state)` — drop `candidates`
- `matchChildrenFrom(patChildren, idx, state)` — drop `candidates`  
- `matchSubtree(pat, state, anchor)` — drop `candidates`

In `matchChildrenFrom`:
```ts
const headResults = matchSubtree(head, state, anchor);
```

In `matchSubtree`:
```ts
const childResults = matchChildren(pat.children, { ...state, deepest: path, subst: s });
```

## 5. Handle non-indexed reference nodes

Reference nodes whose first term is not a symbol (e.g., `(id ...) X Y`) won't be in the index. If a pattern could match them, we need the fallback path.

For correctness: when pattern starts with a symbol, indexed lookup is complete—a ref node with different/non-symbol first term cannot unify. When pattern starts with a variable, must scan all.

Edge case: empty atoms. The root node has an empty atom (no terms). It's matched specially in `unifyTree` before `matchChildren`, so it doesn't need indexing.

## Expected speedup

For tic-tac-toe with ~100 nodes and ~10 distinct leading symbols, index lookup reduces candidate set by ~10x on average. The improvement is larger for bigger trees with more distinct symbols.

## Testing

Run existing tests—behavior should be identical. Profile `ttt.sl` to verify reduction in unification attempts.

## Not in scope

- Multi-term indexing (first two symbols)
- Indexing by id term
- Persistent index across fixpoint iterations (rebuild each `unifyTree` call for simplicity)
