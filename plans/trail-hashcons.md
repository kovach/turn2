# Invariant: Trail bindings are never raw Atoms

## Motivation

`substTerm` (unify.ts:33) recursively descends into `Atom`-valued terms and
remaps each sub-term through the trail. When a `Variable` is bound to a raw
`Atom`, every future `substTerm` call that reaches that variable re-walks the
entire bound atom from scratch. Because bound atoms can reference other bound
variables (e.g. `= V4 (id r2 id11 V1 V2 V2)` references `V2` twice), the work
compounds multiplicatively per level of `=` nesting — Θ(k^n) substTerm calls
for n levels with k occurrences each (see `ts/data/ttt.sl` lines 75–79).

If instead the trail always holds a `Ref`, `substTerm` bottoms out immediately
on the `Ref` and never descends through its body. The cost of materializing
the substituted atom is paid **once** at bind time, when the `Ref` is
constructed, and amortized across every subsequent lookup.

## Invariant

> Any `Term` stored via `trailPush` as a variable's value has
> `tag ∈ {Symbol, Variable, Ref, Wildcard}` — never `Atom`.

## Where the invariant can be violated today

1. **`unifyTerms` (unify.ts:71–80)** — the two `trailPush` sites. When the
   non-variable side is a raw `Atom` (pattern-side `Equal`, e.g. the RHS of
   `= V1 (id r1 id2)`), it is pushed verbatim.
2. **`expand.ts:23`** — `idExpand` builds a local trail, pushes a raw `Atom`
   id, calls `substAtom` once, discards the trail. Out of scope for fixpoint
   matching; see "Exemptions" below.

Bindings produced while unifying a pattern atom against a hashconsed reference
atom are **already safe**: `hashconsAtom` is bottom-up, so every sub-term of a
reference atom is a non-Atom, and a `Variable ← sub-term` push naturally lands
in the invariant.

## Changes

### 1. `unify.ts` — hashcons at bind time

Add a helper that converts a bind-target into invariant-safe form:

```ts
function bindable(t: Term, trail: Trail): Term {
  if (t.tag !== "Atom") return t;
  if (!_hcState) throw new Error("unify: hashcons state required to bind Atom");
  const substituted = substAtom(t.atom, trail);
  assertGround(substituted, trail);
  return hashconsTerm({ tag: "Atom", atom: substituted }, _hcState);
}
```

`assertGround` walks `substituted` and throws if any `Variable` remains
unbound after resolving through the trail. Binding an atom with free
variables means the program's `Equal` / unification structure is ill-ordered
(a later-defined variable referenced before it was bound). This is an
incorrect-program condition, not a dev-only sanity check — throw in all
builds.

Apply at both `trailPush` sites in `unifyTerms`:

```ts
if (sa.tag === "Variable") {
  if (sb.tag === "Variable" && sa.name === sb.name) return true;
  trailPush(trail, sa.name, bindable(sb, trail));
  return true;
}
if (sb.tag === "Variable") {
  trailPush(trail, sb.name, bindable(sa, trail));
  return true;
}
```

Notes:
- `substAtom` before `hashconsTerm` resolves any inner `Variable`s that are
  already bound, so the resulting `Ref` is the canonical form of the fully
  substituted atom at this moment.
- If any `Variable` is still unbound after substitution, `assertGround`
  throws. Freezing an unbound variable into a `Ref` would silently miscompute
  the atom once the variable later binds, so we refuse at the bind site.

### 2. `resolveVar` — dev assertion (optional)

```ts
function resolveVar(term: Term, trail: Trail): Term {
  let t = term;
  while (t.tag === "Variable") {
    const bound = trailLookup(trail, t.name);
    if (bound === undefined) break;
    // invariant: trail-bound terms are never raw Atoms
    if (process.env.NODE_ENV !== "production" && bound.tag === "Atom") {
      throw new Error(`trail invariant violated: ${t.name} → raw Atom`);
    }
    t = bound;
  }
  return t;
}
```

Cheap, catches any future caller that bypasses `bindable`.

### 3. `substTerm` — unchanged

`substTerm` still recurses into `Atom`-tagged terms. With the invariant, this
path is only entered for atoms passed in from the outside (pattern literals in
`step.ts:53`, `expand.ts`, `computeAnchor`), never for trail-bound bodies. The
work is bounded by pattern atom depth, not by bound-variable chain depth.

### 4. Exemption: `expand.ts` `idExpand`

`idExpand` runs at parse time with no `HashconsState`. The trail it builds
lives for exactly one `substAtom` call on line 24 and is then discarded — no
repeated-substTerm pathology is possible. Leave it alone and document:

```ts
// Exempt from the trail-hashcons invariant (unify.ts bindable): this trail
// lives for a single substAtom call and never participates in fixpoint
// matching, and there is no HashconsState available at parse time.
trailPush(t, node.id.name, newId);
```

### 5. Other trail users

- `aggregate-fold.ts`: does not `trailPush`. No change.
- `step.ts`, `fixpoint.ts`: consume trails via `substTerm`; neither pushes
  Atoms. No change.

## Correctness of downstream code

`step.ts:53–55` becomes:

```ts
const rawAtom = substAtom(posNode.literal.atom, trail);   // descends pattern
const rawId   = substTerm(posNode.id,   trail);
const newAtom = hashconsAtom(rawAtom, hc);                // freezes result
```

With the invariant:
- `substAtom`'s recursion into terms hits `Variable`s bound to `Ref`s; those
  return immediately as `Ref`.
- Any `Atom` sub-term it encounters comes from the pattern literal itself
  (e.g. `(cell R C)` in a `+ value (cell R C)`), and is bounded by pattern
  atom depth.
- `hashconsAtom` then canonicalizes the result as before.

Output shape is identical; only the intermediate traversal shortens.

## Binding an atom with free variables is an incorrect program

If `bindable` sees an atom that still references unbound `Variable`s after
substitution, `assertGround` throws in all builds. Freezing such an atom
would produce a `Ref` whose body references a `Variable` that may later be
bound — the `Ref` identity wouldn't change, so downstream `substTerm` calls
would return a stale, pre-binding body.

The intended use cases are already well-ordered:
- `Equal` literals (`= V1 ...`) are processed left-to-right in
  `matchChildrenFrom`; any earlier-defined variable that a later RHS uses is
  already bound when the later `unifyTerms` fires.
- `unifyAtoms`-descending binds only happen against hashconsed reference
  sub-terms, which are already `Ref`s.

A program that violates this ordering (e.g. uses a variable in an `Equal`
RHS before it's been defined or unified) is ill-formed; we surface that at
the bind site with a hard throw rather than letting a wrong `Ref` propagate.

## Tests

1. **Existing tests pass unchanged.** `substStr` / `substTerm`-based
   assertions in `unify.test.ts` produce the same materialized result
   regardless of whether the intermediate binding was `Atom` or `Ref`.
2. **New unit test in `unify.test.ts`**:
   - Unify `V1` with `(id r1 id2)` via `Equal`; inspect trail entry; assert
     `tag === "Ref"`.
   - Unify `V2` with `(id r2 id6 V1)` after V1 is bound; assert V2's stored
     `Ref` expands (via `expandTerm`) to the fully substituted atom.
3. **Invariant fuzz**: wrap `trailPush` in dev mode with an assertion that
   `term.tag !== "Atom"`; run the full test suite and `data/ttt.sl` fixpoint
   to confirm no violations.
4. **Benchmark**: in `profile-ttt.ts`, record `unifyStats.c` (substAtom
   counter) before and after. Expect a large drop on ttt.sl — every `Equal`
   binding pays exactly one substAtom at bind time instead of one per
   downstream reference.

## Rollout

One commit, ~30 LOC of code + ~20 LOC of test. Files touched:
- `ts/src/unify.ts` — `bindable`, two `trailPush` sites, optional
  `resolveVar` assertion.
- `ts/src/expand.ts` — exemption comment.
- `ts/src/unify.test.ts` — new invariant test.

No API changes outside `unify.ts`.
