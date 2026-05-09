# v2 stats tracker

A diagnostic counter bundle for surfacing perf hotspots in turn programs.
All counters are O(1)-per-event; the tracker is opt-in (off by default) so
the hot path stays branch-light when stats aren't requested.

## Goals

- Per-rule-variant: `invocations`, `skipped`, `firings`, `tuplesEmitted`,
  `tuplesDeduped`, `wallMs`, plus a candidate funnel
  (`scanned → genFilter → overlap → literal → unify → bound`).
- Per-head-symbol: `scanCount` (number of times a `byHead` bucket was
  iterated by `evalMatch`).
- Top-N summarisation hooks for CLI / web rendering.

## Shape

New file `ts/src/v2/stats.ts`:

```ts
export interface RuleStats {
  ruleIdx: number;            // index in expanded.rules
  name: string;
  invocations: number;
  skipped: number;            // empty-delta short-circuit hits
  firings: number;            // body reached final continuation
  tuplesEmitted: number;
  tuplesDeduped: number;
  wallMs: number;
  // Funnel — summed across all evalMatch calls within this rule.
  candScanned: number;
  candPassedGen: number;
  candPassedOverlap: number;
  candPassedLiteral: number;
  candPassedUnify: number;
}

export interface HeadStats {
  head: string;
  scanCount: number;
  // Cheap to also expose:
  bucketSize: number;         // store.byHead.get(head).length at end-of-run
  peakBucketSize: number;     // tracked on insert
}

export interface StatsTracker {
  enabled: boolean;
  rules: RuleStats[];         // dense, indexed by rule index
  heads: Map<string, HeadStats>;
  iterations: IterStats[];    // per-fixpoint-round snapshot
}

export interface IterStats {
  iter: number;
  tuplesAdded: number;
  dupes: number;
  rulesRan: number;
  rulesSkipped: number;
}

export function createTracker(enabled: boolean, ruleCount: number): StatsTracker;
export function topRules(tr: StatsTracker, by: keyof RuleStats, n: number): RuleStats[];
export function topHeads(tr: StatsTracker, by: keyof HeadStats, n: number): HeadStats[];
export function formatReport(tr: StatsTracker): string;  // human-readable dump
```

## Wiring

1. **Store** gets one extra field:
   ```ts
   stats: StatsTracker;
   ```
   `createStore` takes an optional `enabled` flag (default `false`) and
   constructs a tracker with no rules slotted yet.

2. **Expand**: after `expand()` produces `Program.rules`, call
   `tracker.rules = rules.map((r, i) => emptyRuleStats(i, r.name))`. Either
   do this in `runFixpoint` after `expand()` (cleanest), or expose
   `tracker.attachRules(rules)`.

3. **Eval**:
   - `evaluateRule(rule, store, schema, ruleIdx?)`: add an optional
     `ruleIdx` param (or stash it on the rule, since we own that struct).
     On entry: `s.invocations++` and `t0 = performance.now()`. On exit:
     `s.wallMs += performance.now() - t0`.
   - Pass `ruleIdx` down to `Ctx` so `evalMatch` and `evalAssert` can
     attribute increments.
   - In `evalMatch` (eval.ts:118), bump `headStats.scanCount++` once per
     loop entry, then per-iteration: `candScanned++`; after the gen filter:
     `candPassedGen++`; after overlap: `candPassedOverlap++`; after the
     literal checks: `candPassedLiteral++`; after `unifyAtoms`:
     `candPassedUnify++`. Increment uses `if (tracker.enabled)` guards or a
     no-op tracker.
   - In the rule's terminal continuation (the one that runs after the
     last body atom, currently the bottom of the CPS chain): `firings++`.

4. **addTuple** (store.ts:136): currently increments `tupleDupes` on
   reject. Add a `sourceRuleIdx?: number` param so it can update
   `rules[idx].tuplesEmitted` / `tuplesDeduped`. Source threading: the
   evaluator already knows `ctx.ruleIdx`; pass it through every call site
   inside `evalAssert` / `closeDoAgg`. Calls from outside the eval loop
   (test fixtures, parser smoke paths) pass `undefined` and only bump the
   global `tupleDupes`. Also update `peakBucketSize` for the head bucket
   at insert time.

5. **Fixpoint** (fixpoint.ts):
   - Bump `s.skipped` in the inner-loop short-circuit branch.
   - At end of each inner-loop sweep, push an `IterStats` row using the
     before/after deltas already computed in `storeSize` plus `rulesRan` /
     `rulesSkipped` counters maintained over the for-loop.

## Reporting

`formatReport(tr)` returns a few tables:

```
Top rules by wallMs (top 5):
  r4  cell C, fill C M    inv=1240 skip=120 fire=18 emit=18 dup=0   ms=42
  r2  ...
  ...

Funnel for r4:
  scan=3800 → gen=600 → overlap=120 → lit=120 → unify=18 → emit=18

Top heads by scanCount (top 5):
  cell        scan=3800   bucket=42   peak=42
  fill        scan= 950   bucket= 8   peak=12
  ...

Per-iteration:
  iter   tuples  dupes  ran  skipped
   1       42      0     14     0
   2       18      6      9     5
  ...
```

Make `formatReport` print only when the tracker is enabled and at least
one rule fired, so it stays out of the way of normal runs.

## Surfaces

- CLI/test diagnostic: extend the v2_click console.log to optionally call
  `formatReport` when an env var is set (e.g. `V2_STATS=1`).
- Web v2: thread a `stats` field into the eval-result payload; render the
  three tables in a collapsed panel.
- Tests can assert against specific counters (e.g. "this rule's
  `tuplesDeduped` is 0 once prefix expansion lands").

## Roll-out

Phase 1 (this plan):
- `stats.ts` with the interfaces, `createTracker`, `formatReport`.
- Wire `invocations`, `skipped`, `wallMs`, `firings`, `tuplesEmitted`,
  `tuplesDeduped`, candidate funnel, head `scanCount`/`peakBucketSize`,
  per-iteration row.

Phase 2 (deferred — not in this plan):
- Order-graph counters (`lessThanCalls`, `bfsExpansions`,
  `lessThanCacheHits`).
- Aggregate-close timing per `_do-agg` row.
- Choice-row blocked-rounds histogram.
- Hashcons table sizes.

## Ambiguities

- **Runtime cost when disabled.** Even with `if (tracker.enabled)`
  guards, the branch test runs in the inner candidate loop. Two options:
  (a) one branch at the top of `evalMatch` that selects between two
  versions of the loop body; (b) a no-op `Stats` interface implementation
  whose method calls JIT-inline to nothing. (b) is cleaner but relies on
  V8 monomorphism. Default to (a) initially.

- **Funnel attribution per match position.** Right now the plan sums all
  positions of a rule into one funnel. To diagnose *which match* is the
  bottleneck we'd need per-atom counters (`RuleStats.matches[i].scanned`
  ...). Worth it eventually but bigger; deferred.

- **Wall-time noise.** `performance.now()` per `evaluateRule` call is
  fine for hotspot identification but noisy at sub-µs scale. Acceptable;
  document that absolute ms is approximate and ratios between rules are
  the signal.

- **Source rule for tuples emitted by `closeDoAgg`.** Aggregate-result
  rows aren't emitted by any rule body. Either attribute them to a
  synthetic "agg-close" pseudo-rule or skip them in `tuplesEmitted`.
  Recommend: synthetic pseudo-rule named `*agg <relation>`, allocated
  once per aggregator on first close. (Lets users see how much is
  agg-driven vs rule-driven.)

- **Tracker lifetime across `runLoop` re-entries.** `runLoop` may
  re-enter `innerLoop` after a `closeDoAgg`. The counters should
  accumulate across re-entries (single tracker per `runFixpoint` call) —
  the `iterations` array reflects that naturally.

- **Where the tracker lives.** Putting it on `Store` means tests that
  construct stores directly automatically have one. Alternatively, attach
  it to `FixpointResult`. Slight preference for `Store` since `addTuple`
  needs access without passing it through every call site.

- **Per-head `scanCount` vs per-rule funnel double-counting.** Both
  count entries pulled from `byHead`. That's intentional: the same
  number aggregates differently along two axes. Document it.
