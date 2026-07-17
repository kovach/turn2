# Arity from `:` count + auto `_` insertion

Source: `# arity + auto `_` insertion` in notes/overview.md.

Goal: make predicate arity a lexical property of the head symbol — the number
of `:` characters it contains — and use it to auto-fill missing trailing
arguments with wildcards. This turns a convention we already follow (`turn`
unary, `player:hand` binary) into part of the language and gives a shorthand
for unary temporal predicates whose single argument we usually don't care
about.

## Motivating examples (from the source note)

```
turn, (~draw; ~play)      -- expands to:  turn _, (~draw _; ~play _)
play, ~do-something       -- play _, ~do-something _
play E, some-predicate P, ^played:card E P   -- already saturated; unchanged
```

## The arity rule

For an atom whose **head term is a Symbol** with name `h`:

```
arity(h)  = (number of ':' in h) + 1
expected atom.terms.length = arity(h) + 1 = (colons in h) + 2
```

So `turn` (0 colons) → arity 1 → `[turn, arg]`; `player:hand` (1 colon) →
arity 2 → `[player:hand, arg1, arg2]`; `card:cost` → arity 2; etc.

Consequence: **there are no nullary predicates** anymore. Every Symbol-headed
atom carries at least one argument. Bare heads like `turn` / `setup` / `draw`
that were effectively nullary are promoted to arity 1 — exactly the note's
"cases we are now ok promoting to arity 1".

Atoms whose head is **not** a Symbol (a Variable, `Wildcard`, or compound
head), and `Equal` (`=`) atoms, have no lexical arity and are left untouched.
`*`-headed and `_`-prefixed heads never reach this path (the former is
rejected at parse; the latter parses as a Variable head).

## Auto-fill (the core feature)

When a Symbol-headed atom has **fewer** args than its arity, append trailing
`Wildcard` terms until it is saturated:

```
turn          -> turn _
~draw         -> ~draw _
player:hand X -> player:hand X _
```

Wildcards are already fully supported in both positions the fill can land in
(see `ts/src/v2/expand.ts`):

- **Match position** — a `Wildcard` becomes a match-anything slot
  (`expand.ts:804`, the existing trailing-wildcard trick), so `turn _` matches
  any stored `[turn, <id>]`.
- **Emit position** (`~`/`+`/`^`) — `emitBindingsAndRewrite` (expand.ts:710)
  turns a `Wildcard` into a fresh anonymous id template, so each `~draw _`
  emission gets a unique episode identity. This is the intended reading: an
  emitted episode we don't name still gets its own handle.

Because the same surface fill lands on both the emitting and matching
occurrences, a `~draw _` emit (fresh id) and a `turn _` / `draw _` match
(match-any) interoperate: the wildcard match sees the fresh-id tuple.

## Over-arity: DECIDED — non-strict, auto-fill only

**Decision (2026-07-16):** auto-fill only. An atom carrying *more* args than
its lexical arity is **not** an error; it is left as written. We ship the
shorthand and keep the whole corpus working; a strict over-arity check is a
possible follow-up (see below).

Rationale: arity is set by `:` count in the head, but the existing corpus uses
many colon-free binary/n-ary relations (dot-notation also threads an implicit
linking var into an argument slot, e.g. `turn.actor Y` ⇒ `turn V, actor V Y`,
making `actor` binary though written with 0 colons). A strict check would
reject all of these. Leniency costs nothing for the auto-fill feature and
avoids a corpus-wide migration.

## Potential follow-up: strict arity check

If we later want arity to be enforced (error when args > `colons+1`), the
measured fallout across the current corpus is:

- **`.t` data files:** ~145 over-arity occurrences, 23 distinct relations,
  across 7 programs (choice-test, demo, dominion, minidom, spirit-island,
  test, ttt; `src/tests/fixtures/ttt.t` duplicates ttt).
- **inline programs in `ts/src/tests/*.test.ts`:** ~171 over-arity
  occurrences across 13 files — and many of those tests also assert on
  rendered/expand output, so the *expected* strings churn too, not just the
  program text. ~316 edits combined, a floor (the scan skipped
  `${...}`-interpolated programs).
- Relations needing **1 colon** (binary): `move`, `score`, `value`, `at`,
  `link`, `adjacent`, `cell`, `filled`, `won`, `other`, `target`, `type`,
  `forgot`, `here`, `actor`, `index`, `is`, `it`, plus test throwaways.
  Needing **2+ colons**: `adj`, `huh` (3 args), `vector` (**5 args → 4
  colons**).
- **Engine-coupled blocker:** `is` and `at` are hard-coded binary relations in
  engine source — `is` in `constraint-query.ts` / `scheduler.ts` /
  `timeline.ts` (`SIDEBAR_HEADS`), `at` in `default-display.ts` (built as
  `[at, _free, _free]`). A strict rule can't be a pure `.t` migration for
  these; it needs either renaming them through the engine or a **built-in
  binary exemption list** (`is`, `at`, likely `it`) that the strict check
  skips. Recommended shape for a future strict pass: exemption list + migrate
  everything else.

## Ordering: auto-fill runs AFTER dot-desugaring

Dot-notation (`desugarBody` in parse.ts) splices a threaded var after the head
of the right atom and appends the same var to the anchor. That var is a real
argument, so the fill must run on the **post-dot** term counts, otherwise the
counts are wrong and padding fights the dot machinery:

- `turn.actor Y` → dot gives `turn [turn,V]`, `actor [actor,V,Y]`. Fill sees
  `turn` already at arity 1 (no pad), `actor` at 2 args (over arity 1, left
  as-is under the lenient rule). Correct.
- `turn,` alone → no dot → `[turn]` → fill pads → `[turn,_]`. Correct.

So auto-fill is a post-pass over the desugared `RuleAtom[]`, not a step inside
`parseTerms`/`parseAtomText`.

## Implementation

Add a saturation pass invoked from `parseProgram` (parse.ts) right after
`desugarBody` produces the rule's final `RuleAtom[]` and before the rule is
pushed. Keep it in `parse.ts` (it is surface desugaring, same layer as the dot
pass); no new file, so `ts/src/v2/overview.md` need not change — but refresh
the `parse.ts` summary's "dot-notation desugaring" bullet to mention arity
saturation.

`saturateArity(body: RuleAtom[]): void` walks the tree and mutates in place:

- `tag === "Atom"`:
  - Skip if `subAtoms !== undefined` — this is the constrain-block placeholder;
    handle its `subAtoms` instead (see below).
  - Let `head = atom.terms[0]`. If `head?.tag !== "Symbol"` or
    `head.name.startsWith("*")`, skip.
  - `want = colonCount(head.name) + 2`. While `atom.terms.length < want`,
    push `{ tag: "Wildcard" }`. (Weight lives in the separate `weight` field,
    so aggregate atoms `foo X -> W` pad `[foo, X]` and never touch `W`.)
- `tag === "Sub"` / `tag === "Exception"` (`.right`): recurse into the body.
- `tag === "Equal"`: skip.

Constrain sub-atoms (`SubConstrain`) are relation applications too and should
saturate for consistency, but the `agg` shape stores the weight as the **last**
term of `atom.terms` (`[...headTerms, weight]`, parse.ts:1074). So for `agg`
subs, insert wildcards **before** the final term; for `plain` subs, append.
Decision: fold this into the same pass by special-casing the two sub kinds.
(If we prefer to keep the first cut minimal, constrain saturation can be a
follow-up — flag in Open questions.)

Exception LHS (`Exception.left`, a bare `{terms}` pattern on the suppressed
predicate) — saturate it the same way so a suppression pattern `{turn => ...}`
matches the promoted `turn _`. Confirm against plans/v2-exceptions.md that the
LHS is a plain match pattern (it is: single unmarked Symbol-headed atom).

Helper: `colonCount(s)` = count of `:` in the string.

## Tests

Add to `ts/src/tests/parse.test.ts` (surface → IR shape) and, where behavior
matters, `ts/src/tests/expand.test.ts` / `fixpoint.test.ts`:

1. Bare unary pads: `turn` → `[turn, _]`; `~draw` → `[draw, _]` (episode).
2. Binary head under-supplied: `player:hand X` → `[player:hand, X, _]`.
3. Saturated atoms unchanged: `played:card E P`, `player:hand X H`.
4. Non-Symbol / compound / Variable head: untouched.
5. `Equal` atom untouched.
6. Aggregate weight untouched: `foo X -> W` pads head to arity, `W` stays the
   weight (not padded into the head).
7. Dot interaction: `turn.actor Y` yields `turn V`, `actor V Y` with no extra
   pad on `turn` (already arity 1) — regression guard for the ordering choice.
8. End-to-end: the demo.t `turn, (~draw; ~play)` program runs and the emitted
   `draw`/`play` tuples carry a fresh-id argument; a downstream `draw _` /
   `turn _` match still binds them.

Run `./run-tests.sh parse expand fixpoint` (per the sandbox note, or
`node --import tsx <file>`). Also re-run the full default sweep, since every
existing v2 program now emits/matches promoted-arity tuples — watch for any
program that silently depended on a nullary tuple.

## Risks / semantic changes to watch

- **Nullary → unary is a store-level change.** Previously `[turn]`; now
  `[turn, id]`. Any place that hard-codes a nullary head (engine seeds, tests
  comparing rendered tuples, display modules keying on bare heads) must be
  reviewed. Grep for literal nullary heads in `default-display.ts`, `ttt.t`,
  and the timeline/render tests.
- **Fresh-id per emit changes dedup granularity** for previously-nullary
  emits. Two firings of `~draw` now produce two distinct ids rather than
  possibly-coincident nullary tuples. Usually harmless (intervals already
  differ) but confirm on ttt.t / dominion.t.
- **Reserved internal relations** (`_choose`, `_do-agg`, `_agg-result`,
  `_constrain`, `_aggval`, `is`, `at`, `icon`) are emitted by the compiler,
  not parsed from source, so the pass never touches them. Double-check none
  are authored in source with a bare head that would now get padded (`icon T`,
  `at X -> L` in demo.t: `icon` arity 1, `at` arity 1 — `icon hand` already
  saturated; `at X -> hand` pads head `[at, X]`? `at` arity 1, already 1 arg,
  no pad — good).

## Resolved decisions

1. **Over-arity: lenient (auto-fill only).** DECIDED 2026-07-16 — see above.
2. **Dot-threaded var counts toward arity.** DECIDED — it is a real argument,
   so auto-fill runs *after* dot-desugaring on the post-dot counts.
3. **Constrain sub-atoms and Exception LHS:** include in the first cut for
   consistency (`agg`-sub inserts before the trailing weight term).
