# bool aggregate

Add a fourth aggregator kind, `bool`, alongside `count` / `sum` / `last`.
Declared `#acc p <args> -> bool`. Semantically: the result is `1` iff
at least one fact `p Arg -> 1` has been asserted under the query's
moment range, otherwise `0`. Isomorphic to `count`'s "zero vs nonzero"
distinction, but the carrier is `0`/`1` instead of peano `z`/`(s _)`.

## Surface rules

- Schema decl: `#acc p t1 ... tn -> bool` (existing syntax, just a new
  aggregator token).
- Assertion: `+p Arg -> 1`, `^p Arg -> 1`, `~p Arg -> 1`. Anything
  other than the literal symbol `1` after `->` is a *parse-time* error
  on a bool-declared relation. In particular `-> 0` is rejected (rather
  than silently behaving as a no-op): asserting "false" has no
  monotone meaning, so the syntax is reserved.
- Query: `p Arg -> 1`, `p Arg -> 0`, or `p Arg -> X` (free variable).
  The query unifies the trailing weight against the aggregator's
  result; a Variable binds to whichever of `0`/`1` the fold returns.
  A bound non-`{0,1}` symbol on the query side is rejected at parse.

## Aggregator registry

In `ts/src/aggregators.ts` add:

```typescript
["bool", {
  zero: sym("0"),
  fold: (_acc, _x) => sym("1"),
  commutative: true,
}]
```

`fold` ignores both arguments — every contribution is `1`, and any
nonempty group folds to `1`. Empty-group handling already falls through
to `aggregator.zero` in `aggregateOver` (scheduler.ts:257), giving the
`0` result.

## Parser

`parseSchemaText` (parse.ts:587) currently whitelists `sum | count |
last`. Add `bool` to the accepted set:

```typescript
if (!(aggregator === "sum" || aggregator === "count"
      || aggregator === "last" || aggregator === "bool")) {
  return { line, message: `unknown aggregator '${aggregator}'` };
}
```

No other parser changes for the decl side; the rest of the schema
machinery is aggregator-agnostic.

## Weight validation pass

`bool` adds two assertions the rest of the pipeline doesn't already
enforce:

1. **Assertions must be `-> 1`.** A `+p ... -> 0` (or `-> X` with a
   variable, or any non-`1` symbol) is rejected.
2. **Queries must be `-> 0` or `-> 1`.** A bound non-`{0,1}` weight on
   the query side is rejected.

These can't live entirely inside `parseAtomText` because that function
doesn't have access to the program-wide schema map (schema decls and
rule bodies are interleaved). Add a single post-parse validation pass
in `parse.ts` (or its own small file, `validate-bool.ts`):

- Iterate over each rule's body. For every `Atom` with `weight !==
  undefined` whose head is a Symbol `h`:
  - Look up `schema.get(h)`. If it is `"bool"`:
    - If `marker === "aggregate"` (i.e., a weighted *query*): allow
      any Variable, or require the Symbol to be `0` or `1`. Atoms /
      other Symbols error.
    - Otherwise (`fact` / `episode` / `anchor` / `ask`; constrain is
      handled below): require `weight` to be `sym("1")`. `-> 0`
      specifically errors with message `bool relation '<h>' cannot be
      asserted as 0; '-> 0' is reserved for queries`.
- Iterate over `subAtoms` for `marker === "constrain"` atoms the same
  way: `kind === "agg"` sub-atoms are queries (weight in trailing
  position of `atom.terms`); apply the query rule.

Errors collected here go through the same `ParseError` channel the
rest of the parser uses so they surface at the same layer as schema
errors.

## Evaluator

No changes. `closeDoAgg` / `aggregateOver` already dispatch on
`aggregator.zero` and `aggregator.fold` through the registry. The
shape of stored bool facts (head + keys + weight + id) matches the
existing sum/count layout, so `aggregateOver`'s candidate matching,
grouping by `_free` positions, and empty-group zero-row emission all
just work.

Sanity check on each existing branch in `aggregateOver`:

- `aggName === "last"` short-circuits → bool skips it. ✓
- Empty groups + no free key positions → emits a single
  `(filled, weight=zero)` row → bool returns `0`. ✓
- Empty groups + free key positions → no result → no `p _ -> 0` row
  fabricated for unknown keys. This is the right semantics: a query
  `p X -> 0` over an unknown `X` should fail (no such binding), not
  succeed for every Term in the universe.
- Nonempty group → fold returns `sym("1")`. ✓

## Tests

Add `ts/data/v2/bool-aggregate.t` with cases:

1. Single relation, single assertion: `+p a -> 1` plus `p a -> 1`
   succeeds; `p a -> 0` fails.
2. No assertion: `p a -> 0` succeeds; `p a -> 1` fails. (Only when
   the query has all key positions ground — see free-position caveat
   above.)
3. Multiple assertions of the same `p a -> 1` fold to `1` (not `2`,
   not `(s (s z))`).
4. Free key position: `+p a -> 1`, `+p b -> 1`, query `p X -> 1`
   yields two bindings `X = a`, `X = b`.
5. Parse error: `#acc p -> bool` then `+p a -> 0` → reject at parse
   with the reserved-syntax message.
6. Parse error: `+p a -> X` on a bool relation → reject (non-literal
   weight on assertion).
7. Parse error: `p a -> 2` query on a bool relation → reject.
7b. Free-variable query: `+p a -> 1`, query `p a -> X` binds `X = 1`;
    with no fact, `p a -> X` binds `X = 0`.
8. Parse error: unknown aggregator name still errors (regression
   guard on the existing whitelist).
9. Interaction with `~` retract: `+p a -> 1` then `~p a -> 1` then
   `p a -> 0` succeeds (the interval no longer covers the query
   moment).

## File touch list

| File                              | Change                                   |
|-----------------------------------|------------------------------------------|
| `ts/src/aggregators.ts`           | Register `bool`                          |
| `ts/src/v2/parse.ts`              | Accept `bool` in schema decl whitelist; add post-parse weight validation pass (or extract to new file) |
| `ts/data/v2/bool-aggregate.t`     | New test cases                           |

No changes needed to `expand.ts`, `scheduler.ts`, `eval.ts`,
`fixpoint.ts`, or `types.ts`.

## Design notes

- **Why reject `-> 0` on the assertion side rather than treat it as
  a no-op?** The aggregator is monotone — facts only add positive
  evidence. A user writing `+p a -> 0` almost certainly intends to
  retract or to express absence, neither of which this machinery
  models. Failing loud avoids silent surprises.
- **Why not collapse `bool` into `count`?** Distinct surface syntax
  (`0`/`1` vs `z`/`(s _)`) is more ergonomic for predicates whose
  arity-of-evidence doesn't matter, and downstream `=` / pattern
  matching against `1` reads naturally where `(s _)` does not.
- **No `commutative: false` worry**: bool's fold is idempotent and
  commutative; the scheduler's "runtime error on incomparable
  orderings" path (used for `last`) is irrelevant.
