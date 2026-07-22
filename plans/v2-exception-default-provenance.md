# exception default-case provenance

Goal: a tuple re-emitted by an exception's *default* rule should be
attributed (in `store.tupleSource`, hence the db/timeline `data-source-line`
linking) to the source line that asserted the original, pre-rewrite tuple —
not to the exception's line. Example:

```
~x

y, {x => ~z}
```

The final `x` tuple is produced by the generated `<rule>_default1` rule and
today carries line 3 (the exception's span). It should carry line 1. The
exception case is intentionally unchanged: `z` tuples come from the user's
own RHS fragment (`exc.right`), whose atoms keep their original spans
(line 3) — correct attribution for a rewritten result.

## Current state

- Provenance is per-tuple: `store.tupleSource[i]: Span | undefined`
  (`ts/src/v2/store.ts:30`), set by `addTuple` from the static span of the
  Emit atom that fired (`evalEmit`, `ts/src/v2/eval.ts:198`).
- `applyExceptions` (`ts/src/v2/expand.ts:351`) renames emitting `p`
  occurrences to `_<p>_prime<k>` across the program — those emit atoms keep
  their own spans, so **prime tuples already carry the original assertion
  line** — and generates a default rule
  (`match p' W.. , aggregate p_exn _.. -> 0 , anchor p W..`,
  `expand.ts:463-475`) whose atoms are all built with `span = exc.span`.
  That static span is what mis-attributes the re-emitted tuple.

## Approach: static prime links + post-fixpoint span fixup

No evaluator / decompose / renderer changes. `applyExceptions` records the
link between each default rule's emitted head and the prime relation it
matches; after the fixpoint, a fixup pass rewrites `tupleSource` entries by
following those links to the stored prime tuple.

This works because of a structural invariant of the generated default rule:
the rule starts at the full anchor, its only user-level match is `p' W..`
(so the running anchor becomes exactly the prime tuple's interval), and the
final `anchor p W..` re-emits at that anchor with the same `W` bindings.
The re-emitted tuple therefore has **identical argument terms and identical
endpoints** to its prime tuple — differing only in head symbol and the
trailing per-firing universal id slot (every Emit appends one;
`decomposeMatch`'s comment at `expand.ts:1107-1109`). This holds through
the `_do-agg`/`_agg-result` split: `closeDoAgg` re-emits at the blocked
row's endpoints (`scheduler.ts:191`). Prime tuples stay in the store
(hidden from display only by the `_` name prefix) with their correct spans,
so the original line is recoverable by lookup.

### Gotcha: links must be derived *after* all rewriting

Recording "default rule emits `p` from `prime1`" at generation time goes
stale: a later exception on the same `p` renames **earlier default rules'
emits** too — `rewriteEmitHeads` covers the `anchor` marker
(`expand.ts:583`) — turning default1's emit of `x` into `_x_prime2`.
Instead, track the generated default rules (e.g. collect the Rule objects
in a local array), and at the end of `applyExceptions` derive each link by
reading the rule's *final* body: match-head = prime name, emit-head =
current head, arity = LHS arity. Chains then fall out for free:

- default2: `match _x_prime2 … anchor x` → link `x → _x_prime2`
- default1: `match _x_prime1 … anchor _x_prime2` → link `_x_prime2 → _x_prime1`

and resolution follows the map transitively, so the original assertion
line survives any number of stacked exceptions.

## Step 1 — record links in `applyExceptions` (`ts/src/v2/expand.ts`)

- Collect each generated default Rule in a local `defaultRules: Rule[]`
  (push alongside `S.push` in step 7 of the pass).
- After the main loop, derive
  `provLinks: { head: string; prime: string; arity: number }[]` from each
  default rule's final body: first `Atom` with marker `match` gives the
  prime name; the trailing `anchor` Atom gives the head; arity =
  `terms.length - 1`.
- `Program` (`ts/src/v2/types.ts:248`) gains an optional field
  `provLinks?: ProvLink[]`; `applyExceptions` returns
  `{ ...program, rules: S, provLinks }`. The second invocation of
  `applyExceptions` (inside `expand`) early-returns on
  `pending.length === 0`, and its spread copy carries the field through
  unchanged either way.

## Step 2 — fixup pass (new function in `ts/src/v2/fixpoint.ts`)

Lives in fixpoint.ts (its only caller; keeps store.ts free of
exception-specific logic), importing `candidatesByHead` from store.ts.

`resolveExceptionProvenance(store: Store, links: ProvLink[]): void`
— mutates `store.tupleSource` in place; no-op when `links` is empty.

- Build `byHead: Map<string, ProvLink[]>` keyed by `head` — a plain
  `Map<string, ProvLink>` is wrong: two exceptions on the *same relation
  name at different arities* (`{x => e}` and `{x A => e}`) produce two
  default rules both emitting `x`, i.e. two links sharing a head. (Same
  *name and arity* can't collide: a later exception's `rewriteEmitHeads`
  renames the earlier default's emit, so at most one final default rule
  emits any given head at a given arity.) Select the link whose `arity`
  matches the tuple (`terms.length === arity + 2`, counting head + id
  slot); no arity match → leave the tuple alone.
- For each stored tuple whose head symbol is in `byHead` (iterate via
  `candidatesByHead` per linked head rather than scanning all tuples):
  follow the chain: look among `candidatesByHead(store, link.prime)` for a
  tuple with
  - same arity (`terms.length` equal to the source tuple's),
  - equal argument terms `terms[1 .. n-2]` — i.e. after the head and
    **excluding the trailing universal id slot**, compared by hashcons
    token,
  - equal endpoints `l`/`r` (hashcons token equality).
  If found, recurse from the prime tuple (its head may itself be linked).
  Take the span of the deepest tuple reached whose `tupleSource` is
  defined (an undefined entry deeper in the chain — possible only for
  tuples inserted without a span, e.g. test fixtures — falls back to the
  nearest defined ancestor in the chain, ultimately the starting tuple's
  own span). Chains cannot cycle: link targets are freshly minted
  `_<p>_prime<k>` names.
- No match at any step → leave the span alone. This is the correct
  fallback for `p` tuples emitted by atoms that escaped renaming (weighted
  emits, off-arity emits — `expand.ts:584-588`).

## Step 3 — invoke from `runFixpoint` (`ts/src/v2/fixpoint.ts`)

`runFixpoint` already calls `applyExceptions` at `fixpoint.ts:42`; keep the
returned program's `provLinks`. Apply
`resolveExceptionProvenance(store, links)` to every `FixpointResult` return
path — including the gas-exhausted ones, since partial stores also feed the
views. Simplest: a small local `finish(result)` wrapper around the existing
return sites (the try/catch has several).

## Step 4 — tests

New `ts/src/tests/v2_exception_provenance.test.ts`:

- The three-line example: run `runFixpoint`, find the `x` tuple, assert
  `store.tupleSource[idx]?.line === 1`; in a variant where the exception
  fires (`y` present, RHS produces `z`), assert `z`'s line is the RHS
  atom's line (unchanged behavior).
- Two assertion sites: `~x` on two different lines feeding one exception —
  each surviving `x` tuple carries its own originating line (or, where
  dedup collapses them, a line from one of the asserting sites — see
  limitation below).
- Chained exceptions: two `{x => …}` blocks, default path both times —
  attribution still the original assertion line (exercises transitive
  resolution and post-rename link derivation).
- Invariant pin: for the simple example, assert the re-emitted `x` tuple's
  argument terms (sans id slot) and endpoints equal its `_x_prime1`
  tuple's — this is the structural invariant the whole approach rests on;
  a future change to the default rule's shape should fail here loudly
  rather than silently mis-attribute.
- No-match fallback: a weighted `+p .. -> w` emit alongside an exception
  on unweighted `p` — its tuple keeps its own span.
- Mixed arities: `{x => …}` and `{x A => …}` in one program, both taking
  the default path — each `x` tuple resolves through the link of its own
  arity (exercises the `ProvLink[]` bucketing in step 2).

Run via `./run-tests.sh` (sandbox fallback: `node --import tsx`).

## Step 5 — docs

- `ts/src/v2/overview.md`: amend the `applyExceptions` entry (records
  `provLinks` derived from the final default-rule bodies) and the
  store/fixpoint notes (`tupleSource` of exception-rewritten heads is
  fixed up post-fixpoint by `resolveExceptionProvenance`). Mention the new
  test module if overview lists tests.

## Known limitations (accepted)

- Dedup: `addTuple` dedups identical tuples. Two prime tuples with the
  same args and endpoints (asserted on different lines; distinct only in
  id slot) produce one re-emitted `x` tuple, and the fixup's first match
  wins — attribution to *one* of the asserting lines. Same class of
  ambiguity exists today for all duplicate emissions.
- Post-hoc matching is structural, not causal: an identical `p` tuple
  emitted independently at the same interval would be re-attributed to
  the matching prime tuple's line. Since dedup collapses such tuples into
  one row anyway, attribution was already ambiguous for that case.

## Alternative considered: dynamic span forwarding

Forward the matched tuple's span through the evaluator (flag atoms in the
default rule as `record`/`forward`, thread through decompose/splitRule,
carry a `provSpan` slot in eval `Ctx`). Causal rather than structural, but
touches types/expand/eval including the eval hot path, and must reason
about the `_do-agg`/`_agg-result` split hop-by-hop. Rejected in favor of
the static approach; revisit if the default rule ever stops preserving
args/endpoints (the step-4 invariant test guards this).

---
plan by: Claude Fable 5 (claude-fable-5)
