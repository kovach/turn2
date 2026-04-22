# Seminaive Evaluation for Tree Unification

## Problem
The fixpoint algorithm (overview.md lines 307-318) runs **all** pattern trees against the **entire** reference tree each iteration. Most patterns won't produce new results if the relevant parts of the tree haven't changed.

## Core Idea
Track which nodes are **delta** (newly added last iteration) via generation numbers. Generate delta variants of each pattern that partition the search space, ensuring each derivation happens exactly once.

## Generation Numbers

Each tree node gets a generation number:

```ts
interface TreeNode {
  id: Term
  atom: Atom
  children: TreeNode[]
  gen: number  // iteration when this node was inserted
}
```

At iteration i:
- **delta**: `node.gen === i - 1`
- **old**: `node.gen < i - 1`
- **any**: `node.gen < i` (strictly before the current iteration)

Initial nodes get `gen = 0`. Nodes inserted during iteration i get `gen = i`.

Trace:
```
initial nodes: gen = 0
i = 1:  delta = gen 0 (all initial), old = gen < 0 (none), any = gen < 1
i = 2:  delta = gen 1, old = gen 0, any = gen < 2
i = 3:  delta = gen 2, old = gen < 2, any = gen < 3
...
```

Nodes inserted during iteration i have `gen = i`, so they're invisible that iteration under every constraint — including `any`. They become delta in iteration i+1.

**Why `any` must be strict.** Rules run sequentially within an iteration, and earlier rules may insert facts (with `gen = i`) that later rules in the same iteration would otherwise see. If `any` allowed `gen === i`, the same `(premise_A @ gen_x, premise_B @ gen_i)` tuple would be matched both by the variant with `A=delta, B=any` at iteration `i` *and* by the variant with `A=old, B=delta` at iteration `i+1`, re-deriving the same output. Restricting `any` to `gen < i` keeps the seminaive partition disjoint, at the cost of delaying each derivation by one iteration.

## Delta Variants

For a pattern with k match (`-`/`<`) nodes, generate k delta variants. Variant j (0-indexed) has constraints:

| position | constraint |
|----------|------------|
| < j      | old        |
| = j      | delta      |
| > j      | any        |

This partitions all combinations exactly once:

Example with 2 match nodes:
- δ₀: [delta, any] — covers (new, old), (new, new)
- δ₁: [old, delta] — covers (old, new)
- (old, old) — already derived in previous iterations

Example with 3 match nodes:
- δ₀: [delta, any, any]
- δ₁: [old, delta, any]
- δ₂: [old, old, delta]

### Pattern Root Wrapper

Every parsed rule is wrapped in a synthetic root whose `literalType` is `Match` with an empty atom (see `parse()` in `parse.ts`). That wrapper **is counted as a match node** and participates in the delta partition: its constraint is assigned from position 0 of the variant's constraint list, and `unifyTree` checks the wrapper's constraint against the reference root's `gen` before proceeding.

The reference root is initialized with `gen = 0` and is never re-inserted, so:
- `wrapper = delta` passes only at iteration 1.
- `wrapper = old`   passes from iteration 2 onward.

Counting the wrapper is what prevents a rule's j=0 variant from being `[any, any, …]` (which would fire unconstrained every iteration); instead the real first premise ends up at position 1, and the genuinely unconstrained "any" slots only appear at positions ≥ 2. The wrapper's constraint is never satisfied in two iterations simultaneously, so no variant fires repeatedly on unchanged premises.

A rule with no user match nodes (e.g. pure assertion `+ foo`) still has `matchCount = 1` via the wrapper and generates a single variant `[delta]` that fires exactly once at iteration 1 — no 0-match special case is needed.

### Data Structure

```ts
type MatchConstraint = 'delta' | 'old' | 'any'

interface DeltaVariant {
  pattern: Tree
  constraints: MatchConstraint[]  // one per match node, in traversal order
}

function generateDeltaVariants(pattern: Tree): DeltaVariant[] {
  const matchCount = countMatchNodes(pattern)
  const variants: DeltaVariant[] = []
  
  for (let j = 0; j < matchCount; j++) {
    const constraints: MatchConstraint[] = []
    for (let pos = 0; pos < matchCount; pos++) {
      if (pos < j) constraints.push('old')
      else if (pos === j) constraints.push('delta')
      else constraints.push('any')
    }
    variants.push({ pattern, constraints })
  }
  
  return variants
}
```

## Pipeline

Delta variant generation happens AFTER expansion:

```
source patterns
    ↓ idExpand
patterns with ids
    ↓ expandAll (compute prefixes, convert + to - before head)
expanded patterns (each has final set of match nodes)
    ↓ generateDeltaVariants (for each expanded pattern)
delta variants
```

Delta variants are computed **once at startup**, not per iteration.

## Modified Matching

### Constraint Checking

```ts
function passesConstraint(
  node: TreeNode,
  constraint: MatchConstraint,
  iteration: number
): boolean {
  const gen = node.gen ?? 0
  switch (constraint) {
    case 'any':   return gen < iteration
    case 'delta': return gen === iteration - 1
    case 'old':   return gen < iteration - 1
  }
}
```

`unifyTree` applies this to the reference root using the pattern wrapper's constraint before enumerating candidates; if the wrapper doesn't pass, the variant produces no matches that iteration.

### Integration with matchSubtree

The matcher traverses match nodes in some order. Track which match node we're on:

```ts
function matchSubtree(
  patternNode: TreeNode,
  candidates: TreeNode[],
  matchIndex: number,          // which match node is this (0, 1, 2, ...)
  constraints: MatchConstraint[],
  iteration: number,
  // ... other params
) {
  const constraint = constraints[matchIndex]
  
  for (const candidate of candidates) {
    if (!passesConstraint(candidate, constraint, iteration)) {
      continue  // skip candidates that don't meet the constraint
    }
    // ... rest of unification logic
  }
}
```

## Fixpoint Algorithm

```ts
function fixpoint(patterns: Tree[], tree: Tree): void {
  // Expansion and variant generation (once)
  const expanded = expandAll(patterns)
  const allVariants: DeltaVariant[] = []
  for (const p of expanded) {
    allVariants.push(...generateDeltaVariants(p))
  }
  
  // Initial nodes
  for (const node of tree.allNodes()) {
    node.gen = 0
  }
  
  let iteration = 1
  
  while (true) {
    const beforeCount = tree.nodeCount()
    
    for (const variant of allVariants) {
      step(variant.pattern, tree, variant.constraints, iteration)
      // step() assigns gen = iteration to any inserted nodes
    }
    
    if (tree.nodeCount() === beforeCount) break
    iteration++
  }
}
```

## Interaction with Sym-Index

The sym-index (plans/unify-index.md) filters candidates by leading symbol. Generation filtering happens after index lookup:

```ts
function getCandidates(
  sym: Symbol,
  constraint: MatchConstraint,
  iteration: number
): TreeNode[] {
  const fromIndex = symIndex.get(sym) ?? []
  
  if (constraint === 'any') return fromIndex
  
  return fromIndex.filter(node => passesConstraint(node, constraint, iteration))
}
```

Alternatively, maintain generation-bucketed indexes for faster filtering, but the simple filter is likely sufficient since delta sets are small after warmup.

## Complexity Analysis

**Space:** One integer per node (negligible).

**Time per iteration:**
- Naive: O(patterns × nodes^k) where k = max match nodes per pattern
- Seminaive: O(patterns × k × delta × nodes^(k-1))

After warmup, delta << nodes, so each iteration is much cheaper. First iteration equivalent to naive (all nodes are delta).

**Variant overhead:** k variants per pattern with k match nodes. Linear increase in pattern count, but each variant does less work.

## Prerequisite Refactor: LiteralType as ADT

Currently `LiteralType` is a string union and `aggregateInfo` is an optional field on `Tree`. Refactor to an algebraic data type so each variant carries its own data:

### Current (types.ts)
```ts
type LiteralType = "Match" | "Before" | "Assert" | "Ask" | "Constrain" | "Aggregate" | "Equal";

interface Tree {
  // ...
  literal: Literal;
  aggregateInfo?: AggregateInfo;  // only relevant when literalType === "Aggregate"
}
```

### After Refactor
```ts
type MatchConstraint = "delta" | "old" | "any";

type LiteralType =
  | { tag: "Match"; constraint: MatchConstraint }
  | { tag: "Before"; constraint: MatchConstraint }
  | { tag: "Assert" }
  | { tag: "Ask" }
  | { tag: "Constrain" }
  | { tag: "Aggregate"; info: AggregateInfo }
  | { tag: "Equal" };  // no constraint: Equal unifies terms, doesn't enumerate tree nodes

interface Tree {
  // ...
  literal: Literal;
  gen?: number;  // generation number (reference trees only, not patterns)
  // aggregateInfo removed — now inside LiteralType
}
```

### Benefits
1. **Seminaive constraints co-located**: Each Match/Before node carries its own constraint, no separate array to keep in sync
2. **Aggregate info co-located**: No optional field that's only valid for one variant
3. **Exhaustive switching**: TypeScript enforces handling all cases

### Migration Steps

1. **Update type definitions** in `types.ts`:
   - Change `LiteralType` to tagged union
   - Add `MatchConstraint` type
   - Add `gen?: number` to `Tree` (used by reference trees for seminaive)
   - Remove `aggregateInfo` from `Tree`
   - Update helper functions (`literal`, `node`, `fact`, `root`)

2. **Update `isNegative`/`isPositive`**:
   ```ts
   const isNegative = (t: LiteralType): boolean =>
     t.tag === "Match" || t.tag === "Before" || t.tag === "Equal";
   ```

3. **Update parser** (`parse.ts`):
   - When parsing `-`, emit `{ tag: "Match", constraint: "any" }`
   - When parsing `<`, emit `{ tag: "Before", constraint: "any" }`
   - When parsing `@`, emit `{ tag: "Aggregate", info: ... }` with info inline
   - Other literal types get simple `{ tag: "..." }`

4. **Update pattern expansion** (`expand.ts`):
   - `generateDeltaVariants` clones the pattern tree k times (for k Match/Before nodes), setting constraint on each Match/Before node according to its position in that variant

5. **Update unification** (`unify.ts`):
   - `matchSubtree` reads constraint from `patternNode.literal.literalType.constraint`
   - Switch on `literalType.tag` instead of comparing strings

6. **Update all switch/if statements** that check `literalType`:
   - Change `literalType === "Match"` to `literalType.tag === "Match"`
   - Access `literalType.info` for aggregates instead of `tree.aggregateInfo`

7. **Update tests** to use new constructors

### Traversal Order Convention

Match/Before nodes are numbered in **pre-order depth-first** order (matching textual order). This is the order used when:
- Generating delta variants (assigning constraints)
- Traversing during unification (reading constraints)

```
- foo        ← match 0
  - bar      ← match 1
  - baz      ← match 2
    + result
```

## Edge Cases

### Patterns with 0 user match nodes
A pattern like `+ foo` (no `-`/`<` nodes) has `matchCount = 1` via the wrapper. It produces one variant `[delta]` on the wrapper; since the reference root's gen is 0, this fires exactly at iteration 1 and never again. No special case required.

### Patterns with 1 user match node
`matchCount = 2` (wrapper + the one user match). Variants:
- δ₀: `[delta, any]` → wrapper=delta (iter 1 only), user match=any. Fires iter 1 if the premise already exists with `gen < 1`.
- δ₁: `[old, delta]` → wrapper=old (iter 2+), user match=delta. Fires in the iteration after the premise was first derived.

### Self-unifying patterns
Pattern `- foo X Y / - foo Y X / + bar X Y` where both matches could bind to the same node. The old/delta partitioning handles this correctly — if the same delta node satisfies both positions, only δ₀ fires (since δ₁ requires position 0 to be old).
