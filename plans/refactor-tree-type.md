# Refactor Tree type: merge Tree, Literal, LiteralType

## Goal

Today the data describing a single tree node is split across three nested
shapes:

```ts
type LiteralType =
  | { tag: "Match"; constraint: MatchConstraint }
  | { tag: "Before"; constraint: MatchConstraint }
  | { tag: "Overlap"; constraint: MatchConstraint }
  | { tag: "Assert" }
  | { tag: "Ask" }
  | { tag: "Constrain" }
  | { tag: "Aggregate"; info: AggregateInfo }
  | { tag: "Equal" };

interface Literal { literalType: LiteralType; atom: Atom; }

interface Tree {
  id: Term;
  literal: Literal;
  children: Tree[];
  macroInvocation?: MacroInvocation;
  span?: Span;
  gen?: number;
}
```

Every `Tree` carries exactly one `LiteralType`, and the only thing
`Literal` adds beyond `LiteralType` is the atom. So the three layers
collapse cleanly into a single tagged union — one `Tree` case per current
`LiteralType` case, with the per-case payload (constraint, info) hoisted
to the top level alongside `id`, `atom`, `children`.

Note: `Atom` itself stays. It is referenced by `Term` (`{ tag: "Atom";
atom: Atom }`) and is the unit consumed by `unifyAtoms` / `substAtom`, so
removing it is a separate refactor.

## Target shape

```ts
interface TreeBase {
  id: Term;
  atom: Atom;
  children: Tree[];
  macroInvocation?: MacroInvocation;
  span?: Span;
  gen?: number;
}

export type Tree =
  | (TreeBase & { tag: "Match"; constraint: MatchConstraint })
  | (TreeBase & { tag: "Before"; constraint: MatchConstraint })
  | (TreeBase & { tag: "Overlap"; constraint: MatchConstraint })
  | (TreeBase & { tag: "Assert" })
  | (TreeBase & { tag: "Ask" })
  | (TreeBase & { tag: "Constrain" })
  | (TreeBase & { tag: "Aggregate"; info: AggregateInfo })
  | (TreeBase & { tag: "Equal" });
```

`isPositive` / `isNegative` are exported in two flavors. The tag-only
form is the primitive; the `Tree`-taking form is a thin wrapper:

```ts
export const isPositiveTag = (tag: Tree["tag"]): boolean =>
  tag === "Assert" || tag === "Ask" || tag === "Constrain" || tag === "Aggregate";
export const isNegativeTag = (tag: Tree["tag"]): boolean => !isPositiveTag(tag);
export const isPositive = (t: Tree): boolean => isPositiveTag(t.tag);
export const isNegative = (t: Tree): boolean => isNegativeTag(t.tag);
```

Call sites inside a `switch (node.tag)` use the tag form; everywhere
else uses the `Tree` form. The actual logic — "Match | Before | Overlap
| Equal are negative, the rest are positive" — is unchanged.

The order of the `Tree` union cases is held to the existing
`LiteralType` order: Match / Before / Overlap / Assert / Ask /
Constrain / Aggregate / Equal. `Equal` stays at the end (no regrouping
of negatives) so the diff against today is minimal.

## Field-access translation

Every site that today reads `node.literal.literalType.tag` becomes
`node.tag`. Every site that reads `node.literal.atom` becomes `node.atom`.
Per-case payload moves up a level:

| before                                          | after                |
|-------------------------------------------------|----------------------|
| `node.literal.literalType.tag`                  | `node.tag`           |
| `node.literal.literalType.constraint`           | `node.constraint`    |
| `node.literal.literalType.info`                 | `node.info`          |
| `node.literal.atom`                             | `node.atom`          |
| `node.literal.atom.terms`                       | `node.atom.terms`    |

The `Literal` interface and `formatLiteral(literal: Literal)` keep their
public shape only if call sites still want them; otherwise `formatLiteral`
becomes `formatNode(node: Tree)` and reads `node.tag` / `node.atom`
directly. Same for `unifyNodes` in `unify.ts` (already takes `Tree`s).

## Constructors

The factory helpers in `types.ts` adjust 1:1:

```ts
export const node = (id: Term, terms: Term[], children: Tree[] = []): Tree =>
  ({ tag: "Match", constraint: "any", id, atom: { terms }, children });

export const fact = (id: Term, terms: Term[], children: Tree[] = []): Tree =>
  ({ tag: "Assert", id, atom: { terms }, children });

export const root = (children: Tree[]): Tree =>
  ({ tag: "Match", constraint: "any",
     id: { tag: "Variable", name: "0" },
     atom: { terms: [] },
     children });
```

The standalone `match() / before() / overlap() / assert_() / ask() /
constrain() / aggregate(info) / equal()` exports that produce a bare
`LiteralType` are dropped — every caller is constructing a `Tree` and
just needs the right top-level fields. `parse.ts:tagToLiteralType` and
`expand.ts`'s several places that build `{ literalType: match(), atom: ... }`
all switch to building a `Tree` directly.

## Touched files

Discovery (`grep -l "literalType\\|\\.literal\\b\\|LiteralType\\|Literal\\b"`):
- `src/types.ts` — type & helper rewrite (this is the bulk).
- `src/parse.ts` — `tagToLiteralType`, `formatLiteral`, `literalTypeToPrefix`,
  the spots that build `{ literal: { literalType, atom } }` for parsed nodes.
- `src/expand.ts` — heaviest consumer; many places today build a copy of
  a node with a different literal type via
  `{ ...node, literal: { ...node.literal, literalType: match() } }`. After
  the refactor these MUST NOT spread `node` to produce a different-tag
  result (see "No spread across tag boundaries" below). Each such site
  becomes an explicit `Tree` literal naming every field, or a call to a
  `retag` helper that destructures only the `TreeBase` fields from the
  source node and accepts the new tag's payload as a separate argument.
- `src/unify.ts` — `unifyNodes` and the several places reading
  `pat.literal.literalType.tag` / `pat.literal.atom.terms`.
- `src/step.ts` — preserves literal+atom when copying a positive into the
  reference; becomes preserving `tag` / per-case payload / `atom`.
- `src/fixpoint.ts` — root-tree construction.
- `src/tree.ts`, `src/aggregate-fold.ts`, `src/macros.ts`, `src/web.ts`,
  `src/refstore.ts`, `src/hashcons.ts` — read sites only, mechanical.
- Tests: `parse`, `expand`, `unify`, `tree`, `fixpoint`, `macros`. Most
  use the constructor helpers; the few that build `Tree` literals inline
  need rewriting.

## No spread across tag boundaries

A hard rule for this refactor: **a `Tree` value of one tag is never
constructed by spreading a `Tree` value of a different tag.** That
includes both the obvious form
`{ ...node, tag: "Match", constraint: "any" }` and the variant where the
spread happens through an intermediate object. The reason is that TS
permits stale per-case fields to ride along (e.g. an `info` field
inherited from an `Aggregate` source onto a `Match` result), and excess
properties through spread are not flagged. The current Literal/LiteralType
nesting hides this risk behind whole-subobject replacement; the flat
union exposes it.

Two acceptable forms remain:

1. **Same-tag spread.** Copying a `Tree` and tweaking universal fields
   (`children`, `span`, `atom`, `id`) without changing `tag` is fine —
   the per-case payload is by construction still valid, e.g.
   `{ ...node, children: newChildren }`. This stays.

2. **Cross-tag construction via explicit literal or helper.** When the
   result has a different tag from the source, every field must be named
   explicitly. Either inline:

   ```ts
   const out: Tree = {
     tag: "Match",
     constraint: "any",
     id: node.id,
     atom: node.atom,
     children: node.children,
     macroInvocation: node.macroInvocation,
     span: node.span,
     gen: node.gen,
   };
   ```

   or via a single shared helper in `types.ts`:

   ```ts
   type RetagPayload<T extends Tree["tag"]> =
     Omit<Extract<Tree, { tag: T }>, keyof TreeBase | "tag">;

   export function retag<T extends Tree["tag"]>(
     base: Tree,
     tag: T,
     payload: RetagPayload<T>,
   ): Tree {
     const { id, atom, children, macroInvocation, span, gen } = base;
     return { tag, ...payload, id, atom, children, macroInvocation, span, gen } as Tree;
   }
   ```

   The destructure of `base` is the point: it pulls only `TreeBase`
   fields from the old node and drops `constraint`, `info`, and the old
   `tag` outright. The `payload` argument carries exactly the new tag's
   case-specific fields.

In `expand.ts` specifically, every site that today reads
`{ ...node, literal: { ...node.literal, literalType: match() } }` falls
into the cross-tag bucket and must use form (2) — there are several of
these and a single `retag` helper is the readable option. Tests should
also avoid cross-tag spread when they construct expected `Tree` values
inline.

## Migration approach

The refactor is mechanical and must land in a single commit (the type
change forces the entire codebase to compile against the new shape). The
sequence inside that commit:

1. Rewrite `types.ts`: new `Tree` union, `TreeBase`, updated
   `isPositive` / `isNegative`, updated constructor helpers. Remove
   `Literal`, `LiteralType`, the `match()`/`assert_()`/etc helpers.
2. Walk through each consumer file in dependency order and translate
   field accesses per the table above. The TypeScript compiler is the
   driver — fix every error before moving on.
3. Run `bun test` (or whichever runner is configured); the behavior is
   isomorphic, so any test failure is a translation bug, not a semantic
   change.

A scratch helper such as

```ts
const litType = (t: Tree): Tree["tag"] => t.tag;
const litAtom = (t: Tree): Atom => t.atom;
```

is *not* needed — the rewrite is straightforward enough that introducing
shims just creates more cleanup later.

## Non-goals

- No new fields, no removed cases, no semantic change.
- `Atom` stays a wrapper; flattening it into a bare `Term[]` on every
  `Tree` is a separate, possibly-undesirable refactor (it would force
  `unifyAtoms` and `substAtom` to switch signatures or wrap on the fly).
- No change to `Term`, `Trail`, `Span`, `MacroInvocation`,
  `AggregateInfo`, `MatchConstraint`.
- No serialized-format change. `parse.ts` and `formatTree` produce/accept
  the same on-disk syntax.

## Ambiguities

(None outstanding — see resolved decisions in the body: keep `Atom`,
drop `Literal`/`LiteralType`, export both `isPositive` and
`isPositiveTag`, keep current union case order, no cross-tag spread.)
