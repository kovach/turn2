# Eager moment-order closure (behind a flag)

## Motivation

`lessThanTok` (`ts/src/v2/store.ts`) currently answers `a < b?` by DFS over
`orderFwd`, with a partial cache (`ltPos`, `ltNeg`). The DFS is hot — every
`intervalsOverlap` / `intervalContains` / `lessEq` / `comparable` call inside
`evalMatch`, the scheduler, and `constraint-query` ultimately funnels through
it. Each `addOrder` also blows the negative cache (`ltNeg.clear()`).

Eagerly maintaining the forward transitive closure converts queries to a
single `Set.has` and removes the cache-invalidation thrash. We want to do
this without removing the existing path, so we can A/B and roll back cheaply.

## Strategy: option 2 (forward closure + thin back-edges)

Maintain:

- `gt: Map<number, Set<number>>` — full forward closure. `gt[a] = { b | a < b }`.
- `orderBwd: Map<number, Set<number>>` — *immediate* predecessors only (not
  closure). Used solely at insert time to enumerate ancestors of `a` so we
  can update their `gt` sets.

We do **not** maintain a backward closure (`lt`). Nothing in the evaluator
queries it, and skipping it halves the memory footprint of the closure.

`bot` and `top` stay as sentinels and are **not** enrolled in `gt` /
`orderBwd` — they're handled in the query shortcuts to avoid pinning every
node into a giant set.

### addOrder(a, b) under eager mode

```
if a == b or a == bot or b == top: return
if b ∈ gt[a]:   return                  -- already implied, no-op
if a ∈ gt[b]:   throw "moment cycle"    -- contradicts strict order

B = gt[b] ∪ {b}
ancestors = { a } ∪ back-DFS from a via orderBwd      -- includes a itself
for x in ancestors:
  gt[x] = (gt[x] ?? new Set()).addAll(B)
orderBwd[b].add(a)
```

Cost: O(|ancestors(a)| + |ancestors(a)| · |B|) per inserted edge. The
ancestor walk is unavoidable since each ancestor's `gt` row needs `B`
unioned in.

### Query under eager mode

```
lessThanTok(a, b):
  if a == b: false
  if a == bot and b != bot: true
  if b == top and a != top: true
  if a == top or b == bot: false
  return gt.get(a)?.has(b) ?? false
```

`lessEq`, `comparable`, `intervalsOverlap`, `intervalContains` are unchanged
above the `lessThanTok` boundary.

## Flag-gated coexistence

Add a module-level enum flag at the top of `ts/src/v2/store.ts`:

```ts
export const ORDER_STRATEGY: "old" | "eager" = "old";
```

(Or `OrderStrategy.Old` / `OrderStrategy.Eager` as a string-union — pick
whichever the codebase prefers.)

### Behavior contract

- **`ORDER_STRATEGY === "old"` (default for now).** Behavior is byte-identical
  to today. The eager structures (`gt`, `orderBwd`) **must not be allocated,
  populated, or mutated**. No eager bookkeeping in `addOrder`. `lessThanTok`
  uses the existing DFS+`ltPos`/`ltNeg` path.

- **`ORDER_STRATEGY === "eager"`.** The eager structures are maintained;
  `addOrder` does the closure update; `lessThanTok` reads `gt` directly. The
  legacy `orderFwd`, `ltPos`, `ltNeg`, and `edgeSet` are not used and may be
  left unallocated. Equivalently, we just don't touch the legacy path at
  all — same shape, opposite branch.

The flag is intentionally a `const` at module scope so the dead branch is
trivial for V8 to eliminate after the first read; no per-call overhead. We
do **not** plumb the flag through `Store` or read it dynamically — flipping
it requires a recompile, which is the right granularity for a strategy
choice.

### Store shape

`Store` carries fields for both strategies, but each strategy only touches
its own:

```ts
interface Store {
  // ...existing fields...

  // Old-path fields (used iff ORDER_STRATEGY === "old"):
  orderFwd: Map<number, Set<number>>;
  ltPos:    Map<number, Set<number>>;
  ltNeg:    Map<number, Set<number>>;
  edgeSet:  Set<string>;

  // Eager-path fields (used iff ORDER_STRATEGY === "eager"):
  gt:       Map<number, Set<number>>;
  orderBwd: Map<number, Set<number>>;
}
```

`createStore` (or whatever constructs `Store`) initializes both groups to
empty Maps unconditionally — cheap, and avoids `undefined` checks at use
sites. The flag controls *writes*; reads will only ever look at populated
maps because the flag also controls which read path runs.

## Code changes

1. `ts/src/v2/store.ts`:
   - Add `ORDER_STRATEGY` const at top of file.
   - Add `gt` and `orderBwd` to `Store` and its constructor.
   - In `addOrder`, branch on the flag:
     - `"old"`: existing body.
     - `"eager"`: cycle check, ancestor back-DFS, closure-update loop, append to `orderBwd[b]`. Do **not** touch `orderFwd` / `ltPos` / `ltNeg` / `edgeSet`.
   - In `lessThanTok`, branch on the flag:
     - `"old"`: existing body.
     - `"eager"`: bot/top shortcuts + `gt.get(aTok)?.has(bTok) ?? false`.
   - `lessEq`, `comparable`, `intervalsOverlap`, `intervalContains` need no
     changes — they sit above `lessThanTok` and pick up the new path for free.

2. No other module touches the order internals. `eval.ts`, `scheduler.ts`,
   `constraint-query.ts` see no API change.

## Validation

- Existing test suite (`./run-tests.sh`) must pass under both flag settings.
- Add a focused property test (or a debug-only "shadow" mode if cheaper):
  for a randomly generated sequence of `addOrder` calls and `lessThan`
  queries, results under the two strategies must match. This is the safety
  net before flipping the default.
- Once the property test is green and we've eyeballed a few real-program
  runs, flip the default to `"eager"`. Leave the old path in for one
  release before deletion.

## Cycle handling

The current code is silent on cycles (DFS just doesn't find `a < a`,
returns false). The eager path explicitly throws on `a ∈ gt[b]`. This is
strictly better — a moment-order cycle is a program bug — but call sites in
`eval.ts` should be skimmed to confirm none rely on cycle-tolerant
behavior. I doubt any do (every `addOrder` in `eval.ts` connects fresh
moments to anchor endpoints, which can't form cycles by construction), but
it's worth a grep before flipping the default.

## Memory / performance expectations

- Memory under eager: O(Σ_a |gt[a]|), the size of the forward closure.
  Slide2 moment graphs tend to be narrow temporal chains with occasional
  branching, so closure is roughly O(V · avg-depth), not O(V²).
- Per-`addOrder` cost rises from O(1) (today) to O(|ancestors(a)| · |B|)
  (eager). Insert frequency is bounded by the number of `+ episode/fact`
  atoms fired, which is much lower than query frequency.
- Per-`lessThanTok` cost drops from O(closure) DFS (worst case) to O(1).
- Removes the `ltNeg.clear()` invalidation that fires on every `addOrder`.

## Ambiguities / open questions

- **Flag location.** I've put it at the top of `store.ts` because that's
  where the order machinery lives. If we expect more such strategy flags,
  it might belong in a dedicated `flags.ts`. Default to `store.ts` unless
  the codebase already has a flags module I haven't found.
- **Const vs. let.** Using `const` makes branch elimination trivial but
  means flipping the flag requires editing source. If we want runtime
  toggling (e.g. for a test harness running both strategies in one
  process), the flag becomes `let` and we accept a per-call branch. The
  plan above assumes `const`; promoting to `let` is mechanical.
- **Equality edges.** `addOrder` is strict (`a < b`). If anything ever
  needs `a == b` in the order DAG (it shouldn't), neither strategy handles
  it directly — that would be a separate change.
- **Telemetry.** Worth instrumenting `addOrder` ancestor-walk size and
  `gt[a]` cardinality during the validation phase to confirm the memory
  estimates before flipping the default. Easy to add behind a third
  debug-only flag.
