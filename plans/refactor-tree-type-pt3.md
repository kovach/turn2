# Refactor Tree type pt 3: hoist body fields out of TreeBase

Follow-up to `plans/refactor-tree-type-pt2.md`. Move `id`, `atom`, and
`children` out of `TreeBase` and into per-case payloads. `Equal` opts out of
all three: its two unification terms move to explicit `lhs`/`rhs` fields, and
it carries no children.

## Background

After pt 2:

```ts
export interface TreeBase {
  id: Term;
  atom: Atom;
  children: Tree[];
  macroInvocation?: MacroInvocation;
  span?: Span;
  gen?: number;
}
```

These three "body" fields are universal in name only:

- `Equal` ignores `id` — the only read is `unify.ts:199` (`head.atom.terms`).
  Tests currently set `id: sym("eq")` as a stub.
- `Equal` uses `atom.terms[0]` and `atom.terms[1]` and runtime-checks
  `terms.length === 2`. Calling that an "atom" is misleading; it's just a
  binary equality.
- `Equal` has no semantic children. Tests pass `children: []`. No code path
  walks an Equal's children.

Hoisting these three fields into per-case payloads makes the actual data
shape match the type, deletes the runtime arity check, and lets `Equal`
own a `lhs`/`rhs` shape that the parser can validate up front.

## Target shape

```ts
export interface TreeBase {
  macroInvocation?: MacroInvocation;
  span?: Span;
  gen?: number;
}

interface TreeBody {
  id: Term;
  atom: Atom;
  children: Tree[];
}

export type Tree =
  | (TreeBase & TreeBody & { tag: "Match"; constraint: MatchConstraint })
  | (TreeBase & TreeBody & { tag: "Before"; constraint: MatchConstraint })
  | (TreeBase & TreeBody & { tag: "Overlap"; constraint: MatchConstraint })
  | (TreeBase & TreeBody & { tag: "Assert" })
  | (TreeBase & TreeBody & { tag: "Ask" })
  | (TreeBase & TreeBody & { tag: "Constrain" })
  | (TreeBase & TreeBody & { tag: "Aggregate"; info: AggregateInfo })
  | (TreeBase & { tag: "Equal"; lhs: Term; rhs: Term });
```

`TreeBase` retains only the bookkeeping fields. `TreeBody` is the body
intersection every non-Equal case mixes in.

## Why pick `lhs`/`rhs`

- The parser already knows the two-term arity (an `=` line with !=2 terms is
  malformed). Promoting that to a parse-time error replaces the silent
  `if (terms.length !== 2) return` in `matchChildrenFrom`.
- The unifier's call site becomes `unifyTerms(head.lhs, head.rhs, ...)` —
  exactly what it does conceptually.
- Tests stop carrying `{id: sym("eq"), atom: {terms: [...]}, children: []}`
  boilerplate.

Alternative considered: `terms: [Term, Term]`. Rejected — looks like a
generic atom, doesn't help the parse-time arity check, and reads worse at
the unifier.

## Field-by-field migration

### `id`

Every read of `tree.id` happens after the caller has already narrowed away
Equal (via tag check or by virtue of building a positive's id atom). Search
finds:

- `parse.ts` — sets `id` per case in the constructor; Equal branch drops it.
- `expand.ts:idExpand` — `node.id` read for non-Equal walk.
- `expand.ts:rewriteUnboundAssertVars` — `node.id` read; the bindsId guard
  already excludes Equal (`tag === "Match" | "Before" | "Overlap"`).
- `tree.ts:collectPositiveNodes` — node.id read on positives only.
- `aggregate-fold.ts`, `step.ts`, `unify.ts` — never see Equal at these
  sites.
- `refstore.ts` (rows) — Equal can't be a row (NodeRow already narrowed in
  pt 2).

Action: remove `id` from Equal's shape. The TS narrowing on
`node.tag !== "Equal"` is enough at every read site we found; if the
typechecker flags one, narrow there.

### `atom`

`unify.ts:matchChildrenFrom` is the one site that reads `Equal`'s body:

```ts
if (head.tag === "Equal") {
  const terms = head.atom.terms;
  if (terms.length !== 2) return;
  ...
  unifyTerms(terms[0]!, terms[1]!, state.trail, state.hc);
}
```

Becomes:

```ts
if (head.tag === "Equal") {
  ...
  unifyTerms(head.lhs, head.rhs, state.trail, state.hc);
}
```

The `terms.length !== 2` guard goes away — the parser enforces it.

`expand.ts:rewriteUnboundAssertVars` reads `node.atom.terms` after a tag-
based scanned-list build that already special-cases Aggregate and
Match/Before/Overlap. Equal falls into the default branch and reads
`node.atom.terms` blindly. Update to handle Equal explicitly: the scanned
terms become `[node.lhs, node.rhs]`. (Equal can introduce variable
bindings — `=  X foo` makes X visible to later siblings — so it must
participate in the seen-set, but it's not a positive so it doesn't get
rewritten.)

Other readers of `node.atom.terms` (`step.ts`, `aggregate-fold.ts`,
`tree.ts`, `web.ts`, `data/ttt.js`) only see body-bearing tags by
construction; verify with the typechecker after the union narrows.

### `children`

Every site that does `for (const child of node.children)` or
`node.children.flatMap(...)` is a candidate for breakage. Survey:

- `parse.ts:formatTree`: recursive — guard Equal (returns just the line).
- `parse.ts:adjustSpans`: walks children — guard Equal.
- `expand.ts:idExpand`'s walk: `node.children.map(walk)` — guard Equal.
- `expand.ts:pruneAndConvert`, `buildAggRule1`, `buildAggRule2`: walk
  children. Equal can appear as a sibling of these rule-bodies. Guard.
- `expand.ts:rewriteUnboundAssertVars`'s walk: walks children. Guard Equal.
- `expand.ts:countMatchNodes`, `cloneWithConstraints`: walk children. Guard
  Equal.
- `tree.ts:collectPositiveNodes`, `fringe`, etc.: walk children. Guard
  Equal.
- `macros.ts:expandMacros` walk: guard Equal.
- `web.ts:renderTree`: walks children. Guard Equal.
- `data/ttt.js:walk`: walks children. Guard Equal.

The "guard" idiom is uniform: when entering a walk function, if
`node.tag === "Equal"` return without recursing. Equal nodes are leaves.

Where a code path returns a transformed Tree (e.g. `walk` reconstructs the
node), Equal's case returns the node unchanged (or with whatever local
transform applies — none of the surveyed sites mutate Equal).

## Constructors

```ts
export const eq = (lhs: Term, rhs: Term): Tree => ({ tag: "Equal", lhs, rhs });
```

`fact`, `node`, `root`, `retag` continue to operate on body-bearing cases.
`retag`'s payload type widens the existing per-case payload to include
Equal's `{ lhs; rhs }` — a caller retagging *into* Equal must supply both,
and retagging *out of* Equal must supply `id`/`atom`/`children`. The
existing `retag` uses `Omit<Extract<Tree, { tag: T }>, keyof TreeBase | "tag">`
which already does the right thing once Tree's union is updated; verify by
typechecker.

## Parser change

`parse.ts` currently builds every node uniformly:

```ts
const node: Tree = {
  ...buildTreePayload(literalTag, aggregateInfo),
  id: explicitId ?? { tag: "Variable", name: String(lineno) },
  atom: { terms },
  children: [],
  ...
};
```

After the refactor the parser branches on `literalTag === "Equal"`:

- For Equal, parse `terms`, require length === 2, build
  `{tag: "Equal", lhs: terms[0], rhs: terms[1], span}`. Reject other arities
  with a parse error.
- For every other tag, build the body-carrying shape exactly as today.

The `buildTreePayload` helper is split or extended to return the right
shape per tag; the cleanest factoring is to make `buildTreePayload` return
the *whole* payload (including body fields when applicable) and have the
top-level parser just spread it.

`formatTree`'s Equal case becomes `= ${formatTerm(node.lhs)} ${formatTerm(node.rhs)}`.

## Order of operations

Two commits.

1. **Equal payload swap.** Change Equal's case in the union to
   `{tag: "Equal"; lhs: Term; rhs: Term}` (drop id/atom/children from
   Equal's shape; TreeBase still carries them for everyone else). Update:
   - parser to emit lhs/rhs and reject non-binary `=` lines
   - `unify.ts` Equal branch
   - `expand.ts:rewriteUnboundAssertVars` scanned-terms branch for Equal
   - every walker that recurses on `tree.children` — add an Equal guard
   - tests: `{tag: "Equal", lhs, rhs}` everywhere
   - `formatTree`'s Equal branch

   Behavior unchanged. Tests pass.

2. **Hoist body out of TreeBase.** Move `id`, `atom`, `children` into a
   shared `TreeBody` intersection mixed into every non-Equal case. Pure
   type narrowing on top of step 1 — every body read is already after a
   tag check or inside a tag-guarded walk. Tests pass.

If step 2 trips, step 1's behavior is already validated against the full
test suite.

## Non-goals

- No change to evaluation semantics. The unifier binds `lhs`/`rhs` exactly
  as it bound `atom.terms[0]/[1]`.
- No change to `NodeRow` (already narrowed in pt 2 — Equal can't be a row).
- No new type for Equal's pair. Two named scalar fields, no tuple.

## Ambiguities

(Resolve before coding.)

- **Equal can't have `gen`/`span`/`macroInvocation`?** TreeBase still
  carries them — Equal inherits them. Plan keeps that. Confirm.

  yes

- **Should `eq` constructor accept a span?** Current constructors
  (`fact`, `node`) don't; spans are parser-only. Plan keeps that.

  match them

- **Walker guards: throw or no-op for Equal?** Plan says no-op (Equal is a
  leaf). A throw would catch missed guards loudly but breaks any walker
  that reasonably expects to see Equal as a sibling without recursing into
  it (e.g. `formatTree` formats Equal's line, just doesn't descend).
  No-op chosen.

  yes, no op

- **`retag` covering Equal:** the existing type machinery should handle
  the new union without code change. If TS fails to infer
  `Payload<"Equal">` correctly, fall back to a discriminated overload.

  ok
