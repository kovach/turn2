# Refactor Tree type pt 2: simplify NodeRow

Follow-up to `plans/refactor-tree-type.md`. Two coupled changes:

1. Always start the reference store empty. Move "initial state" out of an
   explicit `initial: Tree` argument and into the pattern list itself.
2. Narrow `NodeRow` from eight cases to three (`Assert | Ask | Constrain`).

## Background

After pt 1, `NodeRow` is a flat tagged union mirroring `Tree`. Empirically,
the only NodeRow tags that ever appear at runtime are:

- `Assert` — bulk of inserts (via `step.ts` and `aggregate-fold.ts`).
- `Ask` — `?` positives.
- `Match` — only the synthetic root row, and only because `nilTree()` is
  Match-rooted; the root's tag/constraint are never consulted by any read
  path.
- (theoretically) `Constrain` — `isPositive` admits it, but no rule in the
  codebase emits one.

The wide NodeRow union also forces `nodeRowPayloadOf` / `treePayloadOf`
shims in `refstore.ts` and a per-case `unifyNode` filter that's mostly
dead code.

`Aggregate` *would* be positive too, but `expandAll` rewrites every
Aggregate node into Assert (`agg-instance`) and Match form before
`step.ts` ever sees it. We accept this as a runtime invariant in this
plan; promoting it to a type-level invariant is a separate refactor.

## Part 1: drop the initial-tree argument

### `nilTree` becomes Assert-rooted

```ts
export function nilTree(): Tree {
  return {
    tag: "Assert",
    id: { tag: "Symbol", name: "root" },
    atom: { terms: [] },
    children: [],
    gen: 0,
  };
}
```

The root's tag never gates behavior, but Assert keeps the eventual NodeRow
union tight to {Assert, Ask, Constrain}.

### `emptyRefStore` replaces `buildRefStore`

`buildRefStore(initial: Tree, hc)` walks an input tree and turns each node
into a NodeRow. After this refactor, the store is always seeded with one
synthetic root row, so the walk goes away:

```ts
export function emptyRefStore(hc: HashconsState): RefStore {
  const rootId: Term = { tag: "Symbol", name: "root" };
  const hashedId = hashconsTerm(rootId, hc);
  const rootRow: NodeRow = {
    tag: "Assert",
    id: hashedId,
    atom: { terms: [] },
    gen: 0,
  };
  const key = idKey(hashedId, hc);
  // …assemble Maps with the single root row…
  return { rootId: hashedId, nodes, children, parentOf, parentChild,
           parentsOf, beforeAfter, afterBefore, index };
}
```

`buildRefStore` is deleted. `nilTree` stays exported (tests + helpers may
still build a Tree with that shape for other reasons), but it's no longer
on the fixpoint path.

### Concatenating pattern lists

Tests today thread an "initial state" through the second argument of
`fixpoint`. Re-express that state as additional patterns and concat
inline at the call site:

```ts
fixpoint([...initialFacts, ...rules]);
```

No named helper — the spread is short enough to be self-documenting.

### `fixpoint` signature change

Current:
```ts
export function fixpoint(rawPatterns: Tree[], initial: Tree, gas = 20): …
export function fixpoint0(patterns: Tree[], gas = 20) {
  return fixpoint(patterns, nilTree(), gas);
}
```

Target:
```ts
export function fixpoint(patterns: Tree[], gas = 20): …
```

`fixpoint0` is removed (its raison d'être was "fixpoint with nilTree" — now
that's just `fixpoint`).

The body simplifies — no `setGenRecursive(initial, 0)`, no
`buildRefStore(initial, hc)`. Just `const ref = emptyRefStore(hc)`.

### Migrating test call sites

Every test that does:

```ts
const ref = parseOne("-\n  + foo\n  + bar");
const rules = parseRules("- foo\n  + baz");
const { result } = fixpoint(rules, ref);
```

becomes:

```ts
const facts = parseRules("+ foo\n\n+ bar");
const rules = parseRules("- foo\n  + baz");
const { result } = fixpoint([...facts, ...rules]);
```

The translation rule: a parsed reference tree of shape `-\n  + …\n  + …`
(outer Match wrapper, only `+` children) maps to one parsed-pattern entry
per child. `parseRules` produces one pattern per blank-line-separated
chunk, so each `+ foo` line becomes its own one-shot fact-rule.

Files to walk: `fixpoint.test.ts`, `expand.test.ts`, `macros.test.ts`.

A handful of tests parse references that contain nested children (e.g.,
`+ a\n  + b\n  + c`). Those translate to a single multi-line pattern
chunk:

```
+ a
  + b
  + c
```

— still one chunk, still one pattern; the structure is preserved because
the pattern's own indentation is what `parsePatterns` consumes.

### `collectMatches` (unify.ts)

`collectMatches(pattern, reference, iteration?)` is the test-only helper
that backs `unify.test.ts`. It currently calls `buildRefStore(reference,
hc)`. Keep the helper but rebuild internals: construct an
`emptyRefStore`, then walk the *children* of the input reference Tree
(ignoring its outer wrapper) and `insertChild` each into the store
recursively.

Pattern-side `root([...])` stays Match-tagged — `unifyTree` requires
that:
```ts
if (pattern.tag !== "Match" || pattern.atom.terms.length !== 0) return;
```
So `root` is unchanged; only the *reference-side* consumption of it
changes. The walker discards `reference.tag` entirely; whatever
`root([...])` returns gets descended-into without being copied as a
row.

The walker only needs to handle the tags `unify.test.ts` actually puts
on reference nodes — today only `Assert` (via `fact()`). After Part 2
the walker's per-row construction is constrained by the narrowed
NodeRow union to `Assert | Ask | Constrain`.

## Part 2: narrow NodeRow

After Part 1, the three insert paths are:

1. `emptyRefStore` — seeds an Assert root.
2. `step.ts:48` — `nodeRowFromTree(posNode, …)` where `posNode.tag ∈
   {Assert, Ask, Constrain, Aggregate}`. Aggregate is rewritten by
   `expandAll` and never actually arrives here.
3. `aggregate-fold.ts:162` — hardcoded Assert.

So the union shrinks to three cases:

```ts
interface NodeRowBase { id: Term; atom: Atom; gen: number; span?: Span; }

export type NodeRow =
  | (NodeRowBase & { tag: "Assert" })
  | (NodeRowBase & { tag: "Ask" })
  | (NodeRowBase & { tag: "Constrain" });
```

`Constrain` is kept (no per-case payload, parallel to Assert/Ask) because
upcoming work plans to use it.

### `nodeRowFromTree`

```ts
export function nodeRowFromTree(
  template: Tree,
  fields: { id: Term; atom: Atom; gen: number; span?: Span },
): NodeRow {
  if (template.tag !== "Assert"
   && template.tag !== "Ask"
   && template.tag !== "Constrain") {
    throw new Error(`nodeRowFromTree: cannot project tag ${template.tag} into a NodeRow`);
  }
  return { tag: template.tag, ...fields };
}
```

The throw is a runtime guard against a future regression in `expand`
that lets an Aggregate slip through. It costs nothing and is louder than
the current silent cast.

### `refstore.ts` cleanup

- Delete `nodeRowPayloadOf` and `treePayloadOf`.
- Delete `buildRefStore` (replaced by `emptyRefStore`).
- `refStoreToTree` simplifies — every row's tag is in the narrow union,
  no per-case projection needed:

  ```ts
  function buildTreeFromRow(store: RefStore, id: Term, hc: HashconsState): Tree {
    const row = store.nodes.get(idKey(id, hc));
    // …error path…
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
  ```

  The result Tree is `Assert | Ask | Constrain`-tagged throughout — no
  Match nodes anywhere, including the root. `web.ts` and tests already
  do `tree.children.flatMap(...)` from the root and never inspect the
  root's tag, so this is a non-event for consumers. Worth a grep to
  confirm.

### `unify.ts` cleanup

`unifyNode` currently does:
```ts
if (refTag !== "Assert" && refTag !== "Ask") return false;
```
Under the narrowed NodeRow, this becomes just:
```ts
if (refTag === "Constrain") return false;
```
or stays as-is for defense-in-depth. Recommend keeping the explicit
filter — it documents that Constrain rows are not unification targets
even when they're insertable.

## Order of operations

Land as two separate commits:

1. **Part 1** — `nilTree` → Assert, `buildRefStore` → `emptyRefStore`,
   `fixpoint` signature change, `concatPatterns` helper, all test
   migrations, `collectMatches` rewrite. Behavior must be unchanged.
2. **Part 2** — narrow `NodeRow`, drop the projection helpers, clean up
   `refStoreToTree` and `unifyNode`. Pure type narrowing on top of Part
   1's runtime behavior.

If Part 2 trips, Part 1's behavior is already validated against the full
test suite.

## Non-goals

- `Aggregate` stays in `isPositive`. Its inability to reach `step.ts:48`
  is a runtime invariant guaranteed by `expandAll`, not a type-level
  claim. A future refactor moves Aggregate out of the positive bucket.
- No change to `expand.ts`, `step.ts` insert loop semantics, or
  aggregate-fold.
- No change to `Tree`'s shape — that landed in pt 1.

## Ambiguities

(All resolved — recorded in body.)

- gen of initial facts: don't pre-verify; only investigate if tests fail.
- multi-pattern test inputs: fine (same end state, different firing
  order).
- pattern-side `root([...])` stays Match-tagged; the change only
  touches reference-side consumption (collectMatches walker discards
  the reference's outer wrapper).
- no `concatPatterns` helper — call sites use `[...a, ...b]`.
