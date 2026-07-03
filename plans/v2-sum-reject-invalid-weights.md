# Reject invalid `sum` weights (v2)

Make the v2 `sum` aggregate raise a clear runtime error when a contributing
weight is not an integer, instead of silently mis-parsing it (`3.5` → `3`,
`3abc` → `3`) or silently dropping it (`foo`, compound atoms). This restores
the behavior the original aggregate design documented — see
`plans/aggregates.md` ("Runtime errors: `sum` on non-numeric symbol").

## Background — two silent-failure paths

`sum` is folded by `aggregateOver` in `ts/src/v2/scheduler.ts`. Each group's
weights are folded at `scheduler.ts:281-286`:

```js
let acc = aggregator.zero;
for (const c of group) {
  try { acc = aggregator.fold(acc, c.terms[arity - 1]!); } catch { /* skip */ }
}
```

The aggregator (`ts/src/aggregators.ts:30-41`) folds with `parseIntTerm`
(`aggregators.ts:10-19`), which uses `parseInt(t.name, 10)`.

Two distinct ways an invalid weight is hidden today:

1. **Silent mis-parse (no throw at all).** `parseInt` accepts leading-numeric
   junk and floats: `"3.5" → 3`, `"3abc" → 3`, `" 3" → 3`. The fold succeeds
   with a wrong value, so the `catch` never even fires. Result: a quietly
   wrong total.
2. **Silent skip (throw swallowed).** A fully non-numeric symbol (`"foo"`)
   makes `parseInt` return `NaN` → `parseIntTerm` throws; a compound-atom
   weight hits the `t.tag !== "Symbol"` throw at `aggregators.ts:11`. In both
   cases the `catch { /* skip */ }` drops that candidate from the sum with no
   diagnostic. The careful error messages in `parseIntTerm` are effectively
   dead code on the `sum` path.

The `catch` only ever affects `sum`: `count`/`bool` ignore their arg and
`last` returns it — none of them throw. So narrowing/removing the `catch`
changes only `sum`'s behavior.

## Goal

A `sum`-typed query whose contributing weight column contains a non-integer
(float, junk-suffixed symbol, non-numeric symbol, or compound atom) is a
program error and must surface as a runtime error naming the offending value
and the aggregate's head symbol — not a silently wrong or short total.

## Design decisions

- **Hard runtime error, not filter-and-continue.** Consistent with the
  original design and with how other malformed input is handled. A typo in a
  weight should be loud. (`last` may still legitimately carry compound-atom
  values; rejection stays `sum`-specific because it lives in `parseIntTerm`,
  which only `sum` calls.)
- **Strict integer grammar:** `^-?\d+$`. Accepts negatives (e.g. `test.t`
  sums `-1` and `12`), rejects floats, signs-only, whitespace, and
  junk-suffixed values. No existing v2 program relies on the old lax behavior
  (only `ts/data/v2/test.t` uses `sum`, with valid integers).
- **Error carries context.** Include the head symbol and a rendered form of
  the offending term so the message points at the source fact.

## Changes

### 1. `ts/src/aggregators.ts` — strict `parseIntTerm`

Replace the `parseInt`-based body with an explicit integer-grammar check:

- If `t.tag !== "Symbol"`: throw, reporting the actual tag (already the case;
  keep, but improve the message to mention "compound term"/the tag).
- If `!/^-?\d+$/.test(t.name)`: throw `sum: expected integer symbol, got
  "<name>"`.
- Otherwise `Number(t.name)` (safe given the grammar).

Keep the message prefix `sum:` so the head-symbol context is added by the
caller (see change 2).

### 2. `ts/src/v2/scheduler.ts` — eliminate the swallowing `catch`

In `aggregateOver`'s fold loop (`scheduler.ts:281-286`), **remove the
`try/catch` entirely** and fold directly:

```js
let acc = aggregator.zero;
for (const c of group) {
  acc = aggregator.fold(acc, c.terms[arity - 1]!);
}
```

This is safe because only `sum` can throw from `fold` — `count` builds an
Atom, `last` returns its arg, `bool` returns a constant. The `catch` existed
solely to swallow `sum`'s `parseIntTerm` errors, so removing it just lets
those errors propagate. `parseIntTerm` already names the offending value in
its message (change 1), so no extra context-wrapping is needed.

Trade-off accepted: the message won't name *which* `sum` node fired when a
program has several. If that proves annoying in practice, wrap with a
re-throw that prepends `headTerm.name`; not doing so up front to keep the
change minimal.

### 3. Confirm propagation

`aggregateOver` is called from `closeDoAgg` → the scheduler/fixpoint loop.
Verify the thrown error propagates out of `runFixpoint` rather than being
caught somewhere upstream; if there is an upstream catch around aggregate
closing, ensure it surfaces (rethrows or records) the error rather than
hiding it. Trace `closeDoAgg` callers before finalizing.

## Tests

Add to `ts/src/tests/v2_constrain_agg.test.ts` (or `v2_eval.test.ts`,
wherever sum fixtures already live):

1. **Float weight rejected:** `+ score a 3.5` under a `sum` schema →
   `runFixpoint` throws, message mentions the value.
2. **Junk-suffixed weight rejected:** `+ score a 3abc` → throws (regression
   guard against `parseInt` returning `3`).
3. **Non-numeric symbol rejected:** `+ score a foo` → throws (previously
   silently skipped).
4. **Compound-atom weight rejected:** weight position holding `(s z)` or
   similar → throws (previously silently skipped).
5. **Negative integers still sum:** reuse `ts/data/v2/test.t` shape
   (`-1` + `12` → `11`) to prove the strict grammar doesn't break negatives.
6. **Existing valid-sum tests still pass** (`a → 8`, `b → 4`).

Use a `assert.throws(() => runFixpoint(ok(src)), /sum|integer/)` helper for
the rejection cases.

## Files

| File | Change |
|------|--------|
| `ts/src/aggregators.ts` | Strict integer grammar + clearer message in `parseIntTerm` |
| `ts/src/v2/scheduler.ts` | Remove the swallowing `try/catch` in the fold loop |
| `ts/src/tests/v2_constrain_agg.test.ts` | Rejection + negative-int regression tests |

## Out of scope

- Float/precision beyond `2^53` (sums still use JS `number`).
- Changing `last`/`count`/`bool` semantics.
- Surfacing the error as a structured editor diagnostic vs. a thrown
  `Error` — a plain throw matches current conventions; revisit if the web
  editor needs a softer presentation.
