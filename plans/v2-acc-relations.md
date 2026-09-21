# `#acc` — aggregate relations computed at moment resolution

Section: `# further refactoring of reactive/agg` in notes/overview.md.

An **acc relation** is a relation whose rows are *computed*, not asserted:
a separate kind of rule (`body / head`) derives its contributions from the
state alive at a moment, a declared per-column aggregation folds them, and
the result is written as point rows at that moment when the moment walk
resolves it. Ordinary rules read an acc relation like any other, and the
read samples the value at the start of the rule's running anchor. Ordinary
rules never assert into an acc relation.

This is the successor to `#reactive` and, eventually, `#agg`. Neither is
removed in this change; both keep working unchanged alongside `#acc`
(§10 lists the migration).

Where it sits: the moment walk (plans/v2-moment-walk.md) already runs the
non-monotone part of a program at the minimal unresolved moments and marks
them resolved. `#acc` adds one step to *marking*: the moment's acc rows are
computed from the settled state and written, then the inner loop runs so
readers can fire. notes/moment-views.md sketched this as "Option 1,
rule-shaped views"; this plan is that option with a declared type per
relation and the fold attached to a column rather than to a `#reactive`
line.

## 1. Surface syntax

### 1.1 Declaration

```
#acc damage   : e @sum
#acc at       : e (@last location)
#acc occupancy : location @count
#acc crowded  : location
#acc distance : location location @min
#acc min-path : location location (@arg-min location)
```

`#acc <name> : <col>…` — `name` is a lower-case Symbol token; the `:` must
be a standalone token (whitespace on both sides — `:` is also a legal
character inside predicate names, `card:name`). Each column is one of:

- a **base type**: a Symbol (`e`, `location`, `nat`). Documentation only in
  this pass; no static or runtime type checking. It counts as a **key
  column**.
- an **aggregation**: `@sum`, `@count`, `@last`, `@min`, `@arg-min`, either
  bare or as a group `(@op base)` where `base` is the (documentary) type of
  the aggregated values. This is the relation's **agg column**.

At most **one** agg column per relation (a second is a parse error naming
the relation: "one aggregation column per acc relation"). It may sit at any
position; the examples put it last. A relation with **no** agg column is
**boolean**: its rows are the set of derived key tuples.

Ops, in brief (the defining table is §2.2): `@sum` and `@count` give one
number per key; `@min` gives the least nat per key; `@last` gives the
value(s) of the temporally latest contributions, `@arg-min` the `(pair A N)`
row(s) attaining the least `N` — both zero or more per key; no `@` column
means presence. The op set is the registry in acc-ops.ts (§5.5), which is
also where a new op is added.

Parse-time checks: unknown `@op` → error; `#acc` name already a `#agg` /
`#reactive` schema key, a `#js` function, a `#js-def` relation or a macro →
error (and the converse checks in the existing disjointness code); duplicate
`#acc` → error.

### 1.2 Acc rules

```
hit X A / damage X (@sum A)
move A B / at A B
at _ X / occupancy X ()
occupancy X (s (s (s _))) / crowded X

edge A B / distance A B (s z)
edge A B, distance B C L / distance A C (s L)

edge A B / min-path A B (pair B (s z))
edge A B, min-path B C (pair _ L) / min-path A C (pair B (s L))
```

(The section writes `1` where these read `(s z)`. `@min` and `@arg-min` are
Peano-only — §2.2 — so until plans/v2-nat-syntax.md makes `1` parse to
`(s z)` the numeral is a domain error there.)

A rule containing a top-level `/` token is an acc rule: `body / head`.

- **`/` token.** The tokenizer emits a `slash` token for a `/` at paren
  depth 0 that is preceded by whitespace (or starts the atom text) and
  followed by whitespace or end of line — the same "standalone" rule `=`
  uses. `do/rest` and `do/fight` (dungeon.t) stay Symbols. A `slash` inside
  a `(`-group, inside a `[`, in an exception block, or more than once in a
  rule is a parse error.
- **Body**: the same `BodyItem` grammar as an ordinary rule restricted to
  match atoms (unmarked or `-`), `=` atoms, and dot notation (which
  desugars to matches). Anything else — `+ ~ ^ ? !` markers, `(...)`
  subs, `;`, `[...]`, `{...}`, a `-> weight` read of a `#agg` relation — is
  a parse error ("acc rule bodies contain only matches and `=`"). A
  `-> weight` read of a **`#reactive`** relation is allowed (§4.3).
- **Head**: exactly one unmarked atom after the `/`. Its head Symbol must
  name a declared acc relation and its arity must equal the declaration's
  column count. Every Variable in the head must be bound by the body
  (range restriction; a Wildcard or unbound Variable in the head is an
  error). `@js(...)` is allowed in head terms (§4.2).
- **Agg column term**: the contribution. For `@count` it must be `()` or
  `(@count)` (count's η takes no argument — the op's `arity` is 0 in the
  registry, §5.5). For the others it is either a bare term (`at A B`,
  `distance A B (s z)`, `min-path A B (pair B (s z))`) or the same term wrapped as
  `(@op T)`; a wrapper naming a different op than the declaration is an
  error. Algebraically the wrapper names η, the injection of one
  contribution into the op's monoid (§2.2); writing it is optional because
  the declaration already fixes which column's η applies. Key columns take
  any term.

The section's `occupancy X N, gt N 2 / crowded X` needs `gt` to be a
relation the program defines (a `#js-def gt +A +B`, or a stored relation);
with `@count` producing Peano nats the pattern form
`occupancy X (s (s (s _)))` is the direct way to write a threshold.

Acc rules may be `#def`-named like ordinary rules; unnamed ones get the
auto `r<k>` names from the same counter.

### 1.3 Reading an acc relation

In an ordinary rule an acc relation is read with a plain match atom:

```
check, crowded X, ^warn X
report, damage X D, ^damage-report X D
turn, at me L, ...
```

The read samples the relation **at the left endpoint of the running
anchor** — the value at the start of the current episode, or at the start
of the run for a rule-initial read — and the rule cannot fire until the
walk has resolved that moment. The anchor is unchanged by the read. There
is no `->` weight: the aggregated column is an ordinary argument position
(a `-> weight` on an acc relation is a compile error, as is any non-match
marker on one).

## 2. Semantics

**State at a moment.** For a moment `m`, the stored tuples alive at `m`
are those whose interval contains `[m, m]` (`intervalContains`, exactly
as `aggregateOver` and the bracket join define it).

**Acc rows at `m`.** Let `S` be the acc rules. A rule `body / head` fires
at `m` for each binding of `body` against (the stored tuples alive at `m`,
the acc rows at `m` of the relations its body reads); each firing yields a
**contribution** to `head`'s relation: the key-column terms, the agg-column
term (if any), a **firing identity** (rule name plus the identities of the
matched rows) and a **moment** (§2.1). The acc rows at `m` are the least
fixpoint of: for each relation, `fold(decl, contributions)` (§2.2). The
engine evaluates this fixpoint by stratifying the acc relations over their
read dependencies and iterating each recursive component to convergence
(§5.2). Per the section: *the engine assumes the fixpoint is well-defined
and does not verify it*. Algebraically it is well-defined exactly when
every op on the recursive component is idempotent (§2.2); a component that
keeps growing hits a round cap (§5.4) and the run fails with a message
naming the moment and relation.

**When.** Acc rows at `m` are computed **when the walk resolves `m`** —
after a round at the frontier with no progress anywhere (every `#agg` /
`#reactive` / bracket fold at `m` closed, every same-moment `^` chain
drained) and with no choice blocked at `m`. They are then written as point
rows at `[m, m]`, which is progress, so the inner loop runs and ordinary
rules reading them at `m` fire. The moment is already marked, so what those
rules emit at `m` (`^`-tuples on `[m, XR]`, fresh moments above `m`) does
**not** re-open `m`: the acc value at `m` is a snapshot of the state at `m`
as of resolution, computed exactly once. A `^` emitted in reaction is alive
on `[m, XR]` and so is seen by the acc computation at every later moment in
that range, and by ordinary rules as usual. This is what removes the
"two values at one point" hazard the reactive strata work around.

**Reading.** An acc read in an ordinary rule matches the `[m, m]` row with
`m` pinned to the anchor's left endpoint. Until `m` is resolved no row
exists and the rule does not fire; when the rows land, the semi-naive delta
on the relation's head wakes it.

**Absent groups.** A keyed relation has no row for a key with no
contributions: `damage X D` does not fire for an undamaged `X`, and there is
no negation through an acc read (use `#agg` or a boolean acc relation whose
rule states the positive condition). A **keyless** `@sum` / `@count`
relation gets its zero row (`0` / `z`) at every moment; keyless `@last`,
`@min`, `@arg-min` and boolean get nothing. This mirrors `aggregateOver`.

### 2.1 Contribution moment

Each contribution carries a moment: the least upper bound of the left
endpoints of the stored tuples its body matched and of the moments of the
acc rows it matched. A contribution matching nothing stored (a body of only
`=` and js) has moment `bot`. All matched tuples are alive at `m`, so `m`
is an upper bound; if `leastUpperBound` returns `null` (the order is not a
lattice there — notes/moment-insertion.md) the contribution's moment is
`m`. Only `@last` consumes this; `@last` selects the contributions whose
moment is maximal within the key group (incomparable maxima each yield a
row), the same rule `aggregateOver` applies to `last`.

Each derived row also records a moment for downstream `@last` folds: the
lub of the moments of the contributions the fold selected (`@min`,
`@arg-min`, `@last`: the winners; `@sum`, `@count`, boolean: all of the
group's contributions).

### 2.2 The algebra of an op

Every op is a commutative monoid `(M, ⊕, e)` together with two maps, and
the relation is what you get by reading out the monoid value per key:

```
contributions ──η──▶ M  ──⊕ (fold)──▶ M  ──ρ──▶ set of value terms
```

η is the unit of the free commutative monoid on values (insert one
generator); ⊕ applied to η-images is the unique monoid homomorphism out of
that free monoid, which is why contributions form a *bag*. ρ is a
**readout** from the carrier to value terms. It is not a counit of
anything — the letter is neutral on purpose.

| stage | meaning | `@sum` | `@count` | `@min` | `@last` | `@arg-min` | boolean |
|---|---|---|---|---|---|---|---|
| η (inject) | head term → monoid element | a | 1 | a | {(t, a)} | {(a, n)} | true |
| ⊕ (combine) | commutative, associative | + | + | min | ∪, keep temporal maxima | ∪, keep minimal n | ∨ |
| e (identity) | | 0 | 0 | ∞ | ∅ | ∅ | false |
| ρ (readout) | monoid element → value terms | {s} | {n} | {v}; ∞ ↦ ∅ | the set | the set | true ↦ {()}; false ↦ ∅ |
| idempotent? | a ⊕ a = a | no | no | yes | yes | yes | yes |

Here `t` is the contribution's moment (§2.1) and `a`, `n` are the head's
terms. Reading the table:

- **Single- vs multi-valued is a property of ρ, not of the op.** `@sum`,
  `@count` and `@min` have singleton ρ, so they look functional. `@last` and
  `@arg-min` are monoids on *sets* (the free join-semilattice on
  (moment, value) pairs modulo temporal domination; sets of pairs modulo
  "a smaller `n` exists"), and ρ is the identity on those sets. "Zero or
  more rows" is the readout of one set-valued element. There is one
  coercion in the design and it is ρ; naming it keeps every op on the same
  footing.
- **Identities without a term.** `@min`'s identity ∞ and boolean's `false`
  have no term, so ρ sends them to ∅ — the same shape as `@last`'s and
  `@arg-min`'s empty set. The **keyless zero row** of §2 is `ρ(e)`: `{0}`
  and `{z}` for `@sum` and `@count`, nothing for the rest. It is not a
  special case.
- **Keyed absent groups.** `ρ(e)` for a key that no contribution mentions
  would be a row for `@sum`/`@count`, but the key domain is not enumerable,
  so no key gets a row without a contribution. This finite-support
  compromise is the one place the relation diverges from the algebra; it
  is standard (and what `aggregateOver` does today).
- **ρ must be canonical.** ρ is a function of the monoid element, never of
  the order in which contributions were combined. For the current ops this
  is automatic once each op has a single value representation (below):
  equal nats are token-equal, so a `@min` tie is one element and one row.
  The law stays in the op contract (§5.5) for a future op whose carrier
  admits several spellings of one value; such an op's ⊕ must pick a
  canonical representative (smaller hashcons token is the convention)
  rather than let ρ emit both.
- **One number representation per op.** `@sum` works on numeric Symbols
  (the existing `sum` aggregator); `@count`, `@min` and `@arg-min` work on
  Peano nats `z` / `(s X)` (the existing `count` aggregator's output and
  the section's `(s Length)` / `(s (s (s _)))` idioms). η rejects the other
  spelling — `@min` on `1` is a domain error whose message points at
  plans/v2-nat-syntax.md, which will make `1` parse to `(s z)` and so end
  the split without touching any op. Bridging the two inside an op
  (accepting both and comparing by value) was considered and rejected: it
  produces hybrids like `(s 1)`, forces ρ to break spelling ties, and every
  future numeric op would repeat it.
- **Contributions are a bag; the relation is a set.** A contribution is
  identified by `(key tokens, value token, moment token, firing identity)`
  where the firing identity is the rule name plus the ids of the matched
  rows. Two `hit x 3` facts are two contributions and both reach `@sum`'s
  ⊕. For the idempotent ops the extra identity is harmless — that is what
  idempotence means — so the framework dedups every op the same way and
  never consults the flag for it.
- **Recursion has a least fixpoint iff ⊕ is idempotent.** Then `(M, ⊕)` is a
  semilattice, the fold is monotone in the contribution set, and iterating
  a recursive stratum to convergence computes its least fixpoint (shortest
  paths through `@min`/`@arg-min`, reachability through boolean). `@sum`
  and `@count` are not idempotent and a recursive stratum containing them
  has no such guarantee — the section's "assumes well-defined" case. The
  `idempotent` flag in the registry (§5.5) is what a future static warning
  would read (§10).
- **Domain errors are η's.** `@sum` on a non-numeric Symbol, `@min` on a
  non-Peano term, `@arg-min` on something other than `(pair A N)` with `N`
  Peano: η throws with a message naming the relation, op and offending
  term. `natValue` reads `z` → 0 and `(s X)` → 1 + natValue(X), and returns
  `null` for anything else (including numeric Symbols).

Per key group the engine computes `ρ(⊕ᵢ η(cᵢ))` over the deduplicated
contributions `cᵢ` and emits one row `name k… v` per `v ∈ ρ(…)` (`name k…`
for boolean, whose value column does not exist). Each row's moment (§2.1)
comes from ρ when the op selects (the winners' lub) and defaults to the lub
of the whole group otherwise.

## 3. Types and IR

types.ts:

```ts
import type { AccOp } from "./acc-ops.js";   // keyof the op registry (§5.5)
export type AccColumn =
  | { kind: "key"; type: string }
  | { kind: "agg"; op: AccOp; type?: string };
export interface AccDecl {
  relation: string;
  columns: AccColumn[];
  aggIndex: number | null;   // index into columns of the agg column
  span: Span;
}
export interface AccRule {
  name: string;
  explicitName?: string;
  body: RuleAtom[];          // pre-expand: Atom(match) and Equal only
  head: Atom;                // [Symbol relation, col1, ..., coln]
  span: Span;
}
```

`Program` gains `accDecls: Map<string, AccDecl>` and `accRules: AccRule[]`.
Every constructor/copy site carries them: `parseProgram`, `expand` (the
return object), `expandMacros` / `applyExceptions` (spread `program`), the
test fixtures that build a `Program` by hand (`ok()` helpers use `parse`,
so mostly untouched), and `renderProgram` in print-ir.ts (prints acc
declarations and rules after the ordinary rules, in the `--stage parse`
dump).

Two post-expand `RuleAtom` variants, used only in lowered acc rules:

```ts
| { tag: "AccMatch"; relation: string; atom: Atom; moment: Term; span: Span }
  // atom = [Symbol relation, pat...] (no trailing id slot); `moment` is a
  // fresh Variable bound to the matched local row's moment.
| { tag: "AccContribute"; relation: string; terms: Term[]; moments: Term[]; span: Span }
  // terms = the head's columns (agg column included, `()` for count);
  // moments = the `_l_k` / AccMatch moment Variables of the body, for the
  // contribution's lub; the firing identity is the `_id_k` Variables (§4.1).
```

print-ir.ts renders both (`AccMatch at:distance ?A ?B ?L @?_am_3`,
`AccContribute distance ?A ?C (s ?L)`).

## 4. Expansion (expand.ts)

### 4.1 Lowering an acc rule — `decomposeAccRule`

Exported from expand.ts, reusing `DecState`, `collectVarsTerm`,
`decomposeJsRel`, `lowerJsCall`, and the anchor-variable machinery. Anchor:
a single Variable `_acc_m` standing for the moment; the lowered body is
evaluated per moment with `Equal(_acc_m, m)` prepended (§5.3).

Per body atom, in order:

- **Ordinary match** (head not acc, not js-def, no weight):
  `Match [head, pat…, _id_k] at (_l_k, _r_k)` — the trailing slot is a
  fresh Variable `_id_k` (not a Wildcard) so the stored tuple's id is bound
  and enters the firing identity; then `Le _l_k _acc_m` and `Le _acc_m _r_k`
  (containment of the point). No `Max`/`Min`: the anchor is the point and
  never moves. `lLit`/`rLit` (`@l`/`@r` endpoint literals) are rejected.
- **Acc match** (head ∈ `accDecls`): `AccMatch` with a fresh moment
  Variable `_am_k`; the pattern's arity must equal the declaration's column
  count (else error). A `-> weight` here is an error.
- **Reactive read** (head ∈ `reactive`, has weight): `Match [_aggval, head,
  pat…, weight, _] at (_acc_m, _acc_m)` — `decomposeReactiveRead` with
  `XL = _acc_m`. The reactive handler has folded at `m` before resolution,
  so the row exists.
- **`#agg` read** (weight, head in `schema` but not reactive): error
  ("demand aggregates cannot be read inside an acc rule; declare the
  relation `#acc` or `#reactive`").
- **js-def relation**: `decomposeJsRel` as today (`JsIterate`), modes
  resolved by `resolveJsModes` over the lowered body.
- **`=`**: as today (including `@js(...)` on one side per
  plans/v2-js-in-equal.md).

Then the head: each column term is rewritten by a strict variant of
`emitBindingsAndRewrite` — a Variable must already be in `state.seen`
(else error "head variable not bound by the body"), a Wildcard is an
error, `@js(...)` lowers through `lowerJsCall` (pushing `JsCall` atoms),
compounds recurse. For `@count` the agg column becomes the unit Atom `()`.
Finally push `AccContribute { relation, terms, moments: [every _l_k and
_am_k minted above] }`. The `_id_k` variables are recovered by the
evaluator from the trail by name pattern — simpler: `AccContribute` also
lists them in an `ids: Term[]` field.

No `splitRule`, no `pruneChains`, no delta variants: acc rules are
evaluated naively to a local fixpoint (§5).

### 4.2 Static checks on acc rules (in `decomposeAccRule` / parse)

- head relation declared, arity matches, agg column term shape (§1.2);
- range restriction (§4.1);
- an acc relation may not appear as an exception LHS, inside `!(...)`, or
  as a `[...]` query item in ordinary rules (errors in `applyExceptions`,
  `buildConstrainRowAtom`, `aggCompOutCols`, mirroring the js-relation
  checks). Both are follow-ups (§10), not silent misbehaviour.

### 4.3 Reading an acc relation in an ordinary rule — `decomposeAccRead`

In `decomposeBody`, before `decomposeJsRel`: a match-marker atom whose head
names an acc relation with no weight lowers to

```
Match [name, pat…, _]  at (XL, XL)
```

with the anchor unchanged — `decomposeReactiveRead`'s shape without the
`_aggval` wrapper and weight; user variables enter the chain via
`collectVarsTerm`. A weight → error; any other marker (`+ ~ ^ ? !`) → error
("`name` is an acc relation: computed by `/` rules, never asserted").
Arity must match the declaration.

`collectProgramSymbols` adds the acc relation names (fresh-name minting
must avoid them).

## 5. Evaluation — `acc.ts` (new)

### 5.1 Compile

```ts
export interface CompiledAcc {
  decls: Map<string, AccDecl>;
  strata: { relations: string[]; rules: Rule[]; recursive: boolean }[];
}
export function compileAcc(program: Program, jsRels): CompiledAcc
```

Lowers every acc rule (§4.1) and runs `resolveJsModes` on the lowered
bodies. Builds the dependency graph over acc relations (edge `r → s` when a
rule with head `s` has an `AccMatch` on `r`), takes SCCs (Tarjan), orders
them topologically, and groups each SCC's relations with the rules whose
heads are in it. A relation with no rules is its own stratum with no rules
(it produces nothing, or its keyless zero row).

### 5.2 Compute at a moment

```ts
export interface AccRow { terms: Term[]; moment: Term }   // terms hashconsed, no head
export function computeAccAt(store, compiled, m, jsFuncs, jsRels): Map<string, AccRow[]>
```

For each stratum in order:

1. `contribs := ∅` (keyed by the dedup signature of §2.2).
2. Evaluate every rule of the stratum (§5.3) against the store at `m`, the
   rows of earlier strata (fixed), and the stratum's own current rows
   (initially empty). Each firing adds a contribution to `contribs`.
3. Fold every relation of the stratum from `contribs` (§2.2) → new rows.
4. If the stratum is recursive and the row set changed (compared by the
   set of row-token signatures), go to 2; else the stratum is done.

Contributions accumulate across iterations of a recursive stratum; the fold
is always over the whole accumulated set. When every op in the stratum is
idempotent this is the standard monotone least fixpoint (§2.2); otherwise
it is whatever the program means — the section's "assumes well-defined"
clause. Non-recursive strata are evaluated exactly once against settled
inputs, so `@sum`/`@count` over ordinary relations or over lower strata are
exact.

Step 3 is generic over the registry (§5.5): for each relation, group the
contributions by key, fold `acc = op.combine(acc, op.inject(value, moment))`
from `op.identity`, and turn `op.readout(acc)` into rows. No op-specific
code lives in acc.ts.

### 5.3 Evaluating a lowered acc rule (eval.ts)

`evaluateRule` gets an optional `acc?: AccEvalCtx` on `Ctx`:

```ts
export interface AccEvalCtx {
  rows(relation: string): readonly AccRow[];
  contribute(relation: string, terms: Term[], moment: Term, firing: string): void;
}
```

- `evalAccMatch`: for each row of `ctx.acc.rows(relation)`, unify
  `a.atom` against `[relation, ...row.terms]` and `a.moment` against
  `row.moment` on the trail; continue; unwind. Throws if `ctx.acc` is
  undefined (an acc IR atom reached an ordinary rule).
- `evalAccContribute`: substitute `terms`; compute the moment as
  `leastUpperBound(store, moments substituted) ?? m`; build the firing
  identity string from the rule name and the tokens of the substituted
  `ids`; call `contribute`.
- The body is run as `[Equal(_acc_m, m), ...lowered]` — an array spread per
  rule per iteration. `ruleIdx = -1` (no stats), and the existing
  `evalMatch` gen filter is inactive (no `constraint`).

`renderRuleAtom` gains the two cases; `evalSeq`'s exhaustive switch gains
them; the `Atom | Sub | Exception` throw is unchanged.

### 5.4 Bounds

A recursive stratum iterates at most `ACC_ROUND_CAP = 1000` times per
moment; exceeding it throws
`acc: stratum {relations} did not converge at moment <m> after 1000 rounds`
(surfaced like other run errors). Rows written to the store count against
`tupleGas` as usual; the local contribution set is bounded only by the cap.

### 5.5 The op registry — `acc-ops.ts` (new)

One file holds every op as data structured by the table in §2.2. It
depends only on term.ts, hashcons.ts, store.ts (moment order, `tokenOf`)
and aggregators.ts (reusing `sum`/`count`'s term encodings), so types.ts
can import the `AccOp` type from it without a cycle.

```ts
// acc-ops.ts
export interface AccOpDef<M> {
  // The `@name` used in declarations and head wrappers.
  name: string;
  // Head arity: 1 if η takes the agg-column term, 0 if the head writes
  // `()` (count) or has no agg column at all (boolean). Parse checks it.
  arity: 0 | 1;
  // Whether rows carry a value column. False only for boolean.
  column: boolean;
  // η: one contribution → monoid element. `value` is the head's agg-column
  // term (hashconsed; the unit Atom for arity 0), `moment` the
  // contribution's moment (§2.1). Throws on a term outside the domain.
  inject(value: Term, moment: Term, store: Store): M;
  // e.
  identity: M;
  // ⊕: must be associative and commutative; if the carrier admits several
  // spellings of one value, must keep a canonical one (§2.2).
  combine(a: M, b: M, store: Store): M;
  // ρ (readout): the value terms of the rows, each with the moment of the
  // contribution(s) that produced it when the op selects; `moment`
  // omitted means "lub of the whole group" (acc.ts fills it in).
  readout(a: M, store: Store): { value: Term; moment?: Term }[];
  // a ⊕ a = a. Read by the recursion criterion (§2.2) and by tests.
  idempotent: boolean;
  // Not nameable as `@name` in source (boolean).
  internal?: boolean;
}

export const ACC_OPS = {
  sum:       ..., // M = { n: number }
  count:     ..., // M = { n: number }
  min:       ..., // M = { n: number; term: Term; moments: Term[] } | INF
  last:      ..., // M = { moment: Term; value: Term }[]  (an antichain)
  "arg-min": ..., // M = { n: number; byA: Map<number, { pair: Term; moments: Term[] }> } | INF
  bool:      ..., // M = boolean; internal
} as const satisfies Record<string, AccOpDef<unknown>>;

export type AccOp = keyof typeof ACC_OPS;
export function accOp(name: string): AccOpDef<unknown> | undefined;
export function natValue(t: Term, store: Store): number | null;
```

Sketch of the entries:

- `sum`: `inject` parses a numeric Symbol (via `parseIntTerm`-style
  check, throwing otherwise); `combine` adds; `readout` → `sym(String(n))`.
- `count`: `inject` → 1; `combine` adds; `readout` → the Peano numeral
  built with the `count` aggregator's `fold` from `z`.
- `min`: `inject` → `{ n: natValue(a), term: a, moments: [t] }`, throwing
  when `natValue` is `null`; `combine` keeps the smaller `n` (equal `n`
  means token-equal terms — unions the moments); `readout` → one
  `{ value: term, moment: lub(moments) }`, nothing for ∞.
- `last`: `inject` → `[{ moment: t, value: a }]`; `combine` unions (dedup
  by (moment, value) tokens) and drops every entry whose moment is
  strictly below another entry's (`lessEq` and not `lessEq` back, as
  `aggregateOver`'s `last`); `readout` → each entry with its own moment.
- `arg-min`: `inject` requires `(pair A N)` with `natValue(N)` non-null, →
  `{ n, byA: {tok(A) ↦ { pair, moments: [t] }} }`; `combine` keeps the
  smaller `n`, on equal `n` merges `byA` (per `A` the pairs are token-equal;
  moments union); `readout` → one entry per `A` with `lub(moments)`.
- `bool`: `inject` → true; `combine` ∨; `readout` → `[{ value: UNIT }]` for
  true (acc.ts drops the column because `column` is false), `[]` for false.

**Adding an op** (this goes verbatim into the acc-ops.ts header and, in
short form, into overview.md):

1. Fill in a row of the §2.2 table for it: what η injects, what ⊕ does,
   what e is, what ρ reads out, whether ⊕ is idempotent. If you cannot
   write ⊕ as a commutative associative operation, it is not an acc op —
   consider whether it is a *relation* computed by an acc rule instead.
   Pick **one** term representation for the op's domain and reject the
   rest in η; do not accept two spellings of one value.
2. Add the entry to `ACC_OPS`. `AccOp` widens automatically; parse.ts and
   the head-shape check read `arity` and `column`, so no parser change.
   `inject` must throw on out-of-domain terms with a message that names
   the term; if the carrier can hold several spellings of one value,
   `combine` must keep a canonical one (the smaller hashcons token is the
   convention); `readout` must not depend on combination order. Set
   `idempotent` truthfully — it is what decides whether recursion through
   your op is meaningful.
3. Add sample contributions for it to the law harness in
   `v2_acc.test.ts` (§7, item 12). The harness checks, for every registry
   entry: identity (`combine(e, x) = x`), commutativity and associativity
   on the samples, `readout(e)` being empty or the documented zero,
   canonicality (reading out the fold of a permutation gives the same
   tokens), that `idempotent` agrees with `combine(x, x) = x`, and that
   `inject` throws on the listed out-of-domain samples.
4. Add the op to the tutorial's op list. `@max` / `@arg-max` are the
   obvious first additions: `min`/`arg-min` with the comparison reversed
   and e = −∞.

### 5.6 The handler

`MomentHandler` (moment-walk.ts) gains an optional hook:

```ts
// Called once for each moment the walk marks resolved, after marking, in
// the same step. May add tuples at `m`; returns true iff it did. Runs after
// every `run` round at `m` has settled, so it sees the final state at `m`.
resolve?(store: Store, m: Term): boolean;
```

and `export function resolveMoments(store, handlers, toks): boolean` runs
every handler's `resolve` at every marked moment and ORs the results.

`accHandler(compiled, jsFuncs, jsRels): MomentHandler` — `run` returns
`{progress: false, blocked: false}`; `resolve(store, m)` calls
`computeAccAt`, and for every relation and row writes

```
name k… v <id>      at [m, m]     id = (*acc name k… v m)
```

via `addTuple` (boolean rows have no `v`); returns whether any row was new.
The id is deterministic so a repeated resolution (it cannot happen — a
moment is marked once — but idempotence is cheap) dedups.

fixpoint.ts `runLoop`, the no-progress branch:

```ts
markResolved(store, toMark);
if (resolveMoments(store, handlers, toMark)) {
  store.iteration++; swapHeads(store);
  continue;            // back to the inner loop: readers of the new rows fire
}
round = runWalkRound(store, handlers);
```

`runFixpoint` builds `compileAcc(expanded, …)` once and appends
`accHandler` to the handler list (order among handlers is irrelevant for
`resolve`; acc is the only one implementing it). `store.resolved` and the
frontier logic are unchanged. The strict-order cycle fallback resolves a
cycle as a unit; acc is computed at each member.

## 6. Parser (parse.ts)

- Tokenizer: `slash` token per §1.2. `Token` gains `{ tag: "slash"; line }`.
  The atom-text reader breaks at a standalone `/` at depth 0 (check the
  characters before and after, like the `=` rule).
- `#acc` command: `parseCommand` → `parseAccDeclText(argText, line)`:
  tokens via `tokenizeTermText` (which already spaces out parens); expect
  `name`, `:`, then columns; a `(` opens a group `(@op base)`; a bare
  `@op` is an agg column with no `type`; anything else starting with `@`
  is "unknown aggregation `@x`" (the check is `accOp(name)` against the registry, excluding `internal` entries); at most one agg column.
- `parseProgram`: on a `slash` token inside `parseBodyItems` at depth 0 in
  a non-fragment body, stop and return the items with a flag; the program
  loop then parses the head as one atom (through `parseBodyItems` too, so
  dot-desugaring and arity saturation apply to it, then checks it is a
  single unmarked atom with no weight), builds the `AccRule`, and pushes to
  `accRules`. Body validation: only `atom` items with marker `match` and
  `equal` items after desugaring (a `sub`, `aggcomp`, `exception`, or other
  marker → error). `#def` before an acc rule names it.
- Post-loop validations (with line numbers): every acc rule head declared
  and of the right arity; agg column term shape (§1.2); acc names disjoint
  from schema / js / js-def / macro names; a `slash` in a fragment (exception
  RHS) or inside a group → error.
- `validateBoolWeights` and `saturateArity` run over acc bodies and heads
  as well.
- `resolveRuleNames` covers acc rules (shared counter, distinct names).

autocomplete.ts: acc relation names join the relation-name completion set
if it derives names from `schema`/rule heads (check `collectRelationNames`
or equivalent; small).

## 7. Tests

New `ts/src/tests/v2_acc.test.ts`:

1. **Parse.** All six declaration forms; errors: unknown `@op`, two agg
   columns, missing `:`, undeclared head, head arity mismatch, unbound head
   variable, `@count` with an argument, `(@sum A)` on an `@last` column,
   `+` into an acc relation, `-> W` on an acc read, a `+` marker inside an
   acc body, a `slash` inside a group. `do/rest` still parses as a Symbol.
2. **Sum, sampled at the anchor start.** `#acc damage : e @sum`,
   `hit X A / damage X (@sum A)`; hits in a sequence `~a; ~b; ~c` with reads
   at `b`'s and `c`'s starts see the running totals; an undamaged key has
   no row.
3. **Last, keyed.** `move A B / at A B` over sequential moves → the latest;
   two moves from sibling firings (incomparable) → two rows for that key at
   the join moment; a read before either sees the earlier position.
4. **Count and threshold.** `at _ X / occupancy X ()` counts distinct tuples
   under a wildcard; `occupancy X (s (s (s _))) / crowded X`; keyless
   `#acc n : @count` gives `n z` at `bot`.
5. **Stratification in one moment.** `at → occupancy → crowded` computed
   together at one resolution: a reader at that moment sees consistent
   values, exactly one row per key per relation.
6. **Recursion.** Shortest paths with `@min` on a graph containing a cycle
   (`a→b→c→a`, `a→c`): `distance a c` is `(s z)`, `distance a a` is
   `(s (s (s z)))`; the run is `done`. `@arg-min` with two `A`s attaining
   the minimum yields two `(pair A Nmin)` rows. A `@min` contribution of a
   numeric Symbol `1` is a domain error naming the relation and term.
7. **Snapshot.** A rule reads `crowded X` at `m` and `^`-emits `at`
   contributors alive at `m`: `occupancy` at `m` is unchanged (one row); at the
   next moment it reflects them.
8. **Blocking.** An acc read anchored above a pending `you` choice does not
   fire (`active-choices`, no acc rows at or above the choice moment); with
   `?[rng]` it fires and every moment resolves.
9. **js in bodies and heads.** A `#js-def` relation in an acc body; `@js`
   in a head term and in an `=`.
10. **Reactive read inside an acc body.** `#reactive hp -> sum` read by an
    acc rule at `m` matches the `_aggval` row at `m`.
11. **Non-convergence.** `#acc n : nat`, `n X / n (s X)` seeded by one
    contribution → the round-cap error names the stratum and moment.
12. **Op laws.** A harness iterating `ACC_OPS` with per-op sample
    contributions (a table in the test keyed by op name; a registry entry
    without samples fails the test, so a new op cannot skip it): identity,
    commutativity, associativity, `readout(identity)`, canonicality under
    permutation, `idempotent` agreeing with `combine(x, x) = x`, and
    `inject` rejecting the op's listed out-of-domain samples.
    `last`'s samples use a hand-built store with a diamond so incomparable
    maxima are exercised.
13. **Store-level handler test** (mirroring reactive test 1): a hand-built
    store with two incomparable contributors and a join; drive the walk
    with `driveWalk` extended to call `resolveMoments`; assert rows at
    `bot`, `m1`, `m2`, `j`.

Existing suites must pass unchanged (`v2_reactive_aggregate`,
`v2_stratification`, `v2_dungeon`, `v2_ttt`, choices, brackets,
exceptions): `#agg`/`#reactive` semantics are untouched, and a program with
no `#acc` declarations pays one no-op `resolve` per marked moment.
`v2_overview` requires a `# acc.ts` heading. `ts/data/v2/test.t` gets an
`#acc` twin of its `at`/`occ` rules, checked by hand through `v2-cli`.

## 8. Files

- **new** `ts/src/v2/acc-ops.ts` — `AccOpDef`, `ACC_OPS`, `AccOp`, `accOp`,
  `natValue`; header carries the "adding an op" checklist (§5.5).
- **new** `ts/src/v2/acc.ts` — `compileAcc`, `computeAccAt`, the generic
  fold over the registry, `accHandler`, `ACC_ROUND_CAP`.
- `ts/src/v2/types.ts` — `AccColumn`, `AccDecl`, `AccRule` (importing
  `AccOp` from acc-ops.ts);
  `Program.accDecls` / `accRules`; `AccMatch` / `AccContribute` atoms.
- `ts/src/v2/parse.ts` — `slash` token, `#acc` command, acc-rule parsing and
  validation (§6).
- `ts/src/v2/expand.ts` — `decomposeAccRead` in `decomposeBody`;
  `decomposeAccRule` (exported); acc names in `collectProgramSymbols`; the
  owned-relation errors; `expand` carries the new `Program` fields.
- `ts/src/v2/eval.ts` — `AccEvalCtx`, `evalAccMatch`, `evalAccContribute`.
- `ts/src/v2/moment-walk.ts` — `MomentHandler.resolve?`, `resolveMoments`.
- `ts/src/v2/fixpoint.ts` — compile acc once, append the handler, call
  `resolveMoments` after marking.
- `ts/src/v2/print-ir.ts` — render the two atoms, declarations and rules.
- `ts/src/v2/autocomplete.ts` — acc names in completions (if applicable).
- `ts/src/tests/v2_acc.test.ts` — §7; `v2_reactive_aggregate.test.ts`'s
  `driveWalk` helper calls `resolveMoments` (no behaviour change there).

## 9. Docs

- `ts/src/v2/overview.md`: new `# acc.ts` and `# acc-ops.ts` sections (the
  latter reproducing the §2.2 table and the four-step checklist for a new
  op); update types.ts
  (`Program` fields, IR atoms), parse.ts (`#acc`, `/` rules, the standalone
  `/` rule), expand.ts (`decomposeAccRead`, `decomposeAccRule`), eval.ts
  (`AccEvalCtx` and the two atoms), moment-walk.ts (`resolve` hook and
  when it runs), fixpoint.ts (the marking step now resolves then re-enters
  the inner loop on progress), scheduler.ts (a sentence pointing to acc as
  the successor of `#reactive`).
- `discussions/turn-tutorial.md`, Aggregates section: a subsection on
  `#acc` — declaration, `/` rules, reading at the anchor start, snapshot
  semantics, no negation through keyed reads, the shortest-path example,
  and a user-facing version of the op table (what you write in the head,
  what rows you get, whether recursion through it is meaningful).
- notes/overview.md: `plan: plans/v2-acc-relations.md`.

## 10. Not in this change

- **Migration.** Rewriting `ts/data/v2/*.t` and the tests from `#reactive`
  / `#agg` to `#acc`, then deleting `#reactive` (the reactive handler,
  `_aggval`, `computeAggStrata`, `decomposeReactiveRead`). `#agg` stays
  longer: bracket aggregation and `!(...)` constrain rows are built on the
  demand path, and negation-by-default-zero (`downs Q -> 0`) has no acc
  equivalent yet (a boolean acc relation states the positive condition;
  "no contribution" needs an explicit `@count` zero or a `none`-style op).
- `@max` / `@arg-max` (one registry entry each, §5.5), `@none` as an
  explicit op (its ⊕ would have to observe *absence*, which the fold over
  contributions cannot; it belongs to the negation follow-up above).
- Acc relations inside `[...]` queries and `!(...)` blocks (they need the
  bracket join and constraint-query to read point rows at the component's
  moment).
- Static well-definedness: a warning when a non-`idempotent` op (registry
  flag) lies on a recursive stratum, or when an acc relation is read by a
  rule that `^`-emits into one of its contributors
  (notes/moment-views.md §4).
- Row-count compression: computing acc only at moments some reader can be
  anchored at, or value-change rows with a maximal-row read.
- Timeline rendering of point rows and of `store.resolved`. (Point rows:
  done since, display only — plans/v2-acc-timeline-display.md.)
- Numeral sugar (plans/v2-nat-syntax.md) so `1` parses to `(s z)` and the
  section's `distance A B 1` becomes legal for `@min` as written. Until
  then `@sum` (numeric Symbols) and the Peano ops cannot feed each other.

---
plan author: Claude Fable 5.1 (claude-fable-5-1), 2026-09-20
