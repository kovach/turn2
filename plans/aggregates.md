# Aggregate predicates

Plan for implementing the `#` aggregation syntax described in
`notes/overview.md` → "Temporal semantics of aggregate nodes".

## Core idea

Each `#` node compiles into three ordinary rules using reserved predicate
names (`agg-instance`, `agg-binding`, `agg-result`). The fold itself is a
post-fixpoint pass that closes each `agg-instance` into an `agg-result`.
The public `fixpoint` iterates inner-fixpoint + fold-pass until neither
produces change.

## Syntax

```
# name term* -> outTerm
  local-pattern...
```

The local-pattern is an indented subtree. Variables bound in the outer
context are available; variables bound only in the local-pattern do not
escape. Only `outTerm` (on the RHS of `->`) is visible to subsequent
nodes.

## Compilation example

Given this pattern:

```
- foo
  ...
  # sum X -> N
    - t X
- bar
  + note N
```

Compilation produces three rules. Let `lexId` be a fresh symbol and `Id`
be the id-term allocated by `idExpand` (treating `#` like `+`).

### Rule 1 — prefix / emitter

```
- foo
  ...
  +[Id] agg-instance lexId
```

Places a landmark at every match of the prefix context.

### Rule 2 — query rule

```
- foo
  ...
  -[Id] agg-instance lexId
    - t X
    + agg-binding lexId Id X
```

The local-pattern (`- t X`) and the `+ agg-binding` are children of the
`agg-instance` match. This ensures that `<` markers in the local-pattern
check for nodes temporally before the agg-instance position, which is the
correct semantics.

### Rule 3 — consumer / suffix

```
- foo
  ...
  - agg-result lexId Id N
- bar
  + note N
```

The suffix replaces `agg-instance` with `agg-result`, binding `N` to the
folded output.

## idExpand

Treat `#` nodes like `+` nodes: allocate an id-term via the standard
`(id ruleName idN ...previousVars)` pattern. The same id-term appears in
all three generated rules — `expand` ensures this by generating the rules
from a single `#` node that already carries its id-term.

Note: `isPositive("Aggregate")` must return `true` so id allocation works.

## expand

When `expand` encounters a `#` node at pre-order index `i`:

1. **Rule 1 (emitter)**: Build prefix ending at `i`. Replace the `#` node
   with `+[Id] agg-instance lexId` (no children).

2. **Rule 2 (query)**: Build prefix ending at `i`. Replace the `#` node
   with `-[Id] agg-instance lexId`. Make the local-pattern children and
   `+ agg-binding lexId Id ...args` children of the agg-instance node.
   This ensures `<` markers check for nodes before the agg-instance.

3. **Rule 3+ (suffix rules)**: For each positive node `j > i` in the
   original pattern, build a prefix ending at `j`. In this prefix, the
   `#` node becomes `- agg-result lexId Id outTerm`.

The existing `pruneAndConvert` logic handles converting earlier `+` nodes
to `-`. The new behavior: when converting a node that was originally a
`#` (now an `agg-instance`), replace it with `- agg-result lexId Id outTerm`
instead of `- agg-instance lexId`.

### Fresh names during expand

- `lexId`: Generate a fresh symbol when expanding the `#` node. Used in
  all three rules.
- `agg-binding` id: The `+ agg-binding` node in Rule 2 is a positive node
  and needs an atom id. Generate during expand.
- `agg-result` id: The `+ agg-result` node inserted by the fold pass
  needs an atom id. Derive it from the instance: `(id agg-result lexId Id)`.
  Since `lexId` and `Id` together uniquely identify the aggregate instance
  being closed, this is deterministic and unique.

Since `idExpand` does not include positive atom ids in `previousVars`,
downstream patterns won't reference these synthetic ids — they only match
on `lexId` and the original `Id` from the `#` node.

## Fresh names

Both `lexId` symbols and id-expand variables should draw from a shared
counter passed through the expansion pipeline. Consolidate existing
counters into a single `FreshNames` generator.

## Post-fixpoint fold pass

After each inner fixpoint settles:

1. Collect every `agg-instance lexId` node, noting its id `Id` and parent.

2. For each `(lexId, Id)` pair with no matching `agg-result lexId Id _`:
   a. Gather all `agg-binding lexId Id ...args` nodes (both `lexId` and
      `Id` must match).
   b. Sort bindings by temporal order (see below). Runtime error if any
      pair is incomparable.
   c. Fold: `acc = zero`; for each binding, `acc = fn(acc, ...args)`.
   d. Insert `+ agg-result lexId Id <acc>` as a sibling of the
      `agg-instance` node (same parent).

3. If step 2 inserted anything, re-run inner fixpoint so consumer rules
   fire. Loop until nothing new is produced.

### Ordering

Define `binding1 < binding2` iff the `agg-binding` node for `binding1` is
temporally before the node for `binding2` in the reference tree.

Temporal order on nodes: if A and B are siblings with A appearing before
B in the child list, then A < B. If C is a descendant of A and A < B,
then C < B. This is the transitive closure.

## Fold functions

Each aggregate function provides:
- `zero: Term` — result when no bindings are collected
- `fold: (acc: Term, ...args: Term[]) => Term`

Initial registry:

| Name    | Zero          | Fold behavior                          |
|---------|---------------|----------------------------------------|
| `count` | `sym("0")`    | Increment counter, ignore args         |
| `sum X` | `sym("0")`    | Parse X as integer, add to acc         |
| `last A`| `sym("none")` | Return the final arg                   |

Runtime errors:
- `sum` on non-numeric symbol
- Unknown aggregator name
- Arg count mismatch with fold signature

## Types

Add `"Aggregate"` to `LiteralType` and update `isPositive` to return
`true` for it.

Add to `types.ts`:

```typescript
export interface AggregateInfo {
  funcName: string;      // e.g. "sum", "count", "last"
  args: Term[];          // terms before "->"
  out: Term;             // term after "->"
}
```

Store `AggregateInfo` on the Tree node as an optional field (present only
for `#` nodes). The info is consumed during `expand` and does not appear
in the expanded rules. `lexId` is generated during expand, not stored in
`AggregateInfo`.

## Parser changes

Recognize `#` as a prefix character. After `#`, parse:
- `name`: lowercase identifier (the aggregator function)
- `term*`: zero or more terms (fold arguments)
- `->`: literal arrow
- `term`: output binding

Children of the `#` line (indented below it) form the local-pattern,
parsed as a normal subtree.

## File structure

| File                      | Purpose                                    |
|---------------------------|--------------------------------------------|
| `ts/src/types.ts`         | Add `Aggregate` literal type, `AggregateInfo` |
| `ts/src/parse.ts`         | Parse `#` syntax                           |
| `ts/src/expand.ts`        | Generate three rules per `#` node          |
| `ts/src/aggregators.ts`   | Registry of `{ zero, fold }` functions     |
| `ts/src/aggregate-fold.ts`| `closeAggregates(ref): boolean`            |
| `ts/src/fixpoint.ts`      | Wrap loop: inner fixpoint → fold → repeat  |

## Tests

1. Parse round-trip: `# sum X -> Total` with local-pattern parses and
   formats correctly
2. Example 1 from overview: `count` over moves → 3, then 2
3. Example 2: `sum` inside `foo a` → 4; inside `foo b` → 0
4. Example 3: two `#` nodes, `last` yields different values at each
5. Error case: bindings that can't be totally ordered → runtime error
6. Error case: non-numeric symbol passed to `sum` → runtime error
7. Edge case: no bindings collected → zero value returned

## Design decisions

1. **`agg-result` placement**: The fold pass inserts `agg-result` as a
   sibling of `agg-instance` (same parent). This satisfies the path
   condition in Rule 3.

2. **Nested `#`**: A `#` inside another `#`'s local-pattern is a
   compile-time error until semantics are specified.

3. **Interaction with `<` (Before)**: The local-pattern can use `<` to
   constrain matches to temporally-earlier nodes. The `<` marker in the
   query rule handles temporal constraints; the fold pass just orders
   whatever bindings were produced.
