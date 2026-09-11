# Exceptions: key the suppression flag by the intercepted tuple

Amends `plans/v2-exceptions.md` (step 1 / steps 5–7) and
`plans/v2-exception-watchers.md`.

## Problem

```
~setup
  ^bird x
  ^bird y
  ^peng y

bird X, ^flies X

peng X, { flies X => }
```

suppresses `flies x` as well as `flies y`. Cause: the flag relation
`_flies_exn1` carries the payload `Ve = (vars(e) ∩ vars(prefix(R))) \ vars(t̄)`,
which is empty here, so the flag is an arity-0 `bool` keyed only by time.
The watcher correctly raises it only when it sees `flies' y` (`X` rides the
ctx payload and re-unifies), but the default rule
`match flies' W, aggregate _flies_exn1 -> 0, anchor flies W` asks "is the
flag raised anywhere on this tuple's interval?" — and `flies' x` and
`flies' y` share the `setup` interval. The original plan documents this as
intended ("the payload only transports bindings, it doesn't gate";
watchers plan, test 17: "value-level discrimination within one moment is
out of scope"). That is the wrong semantics: bound LHS variables must
influence *which* tuples are suppressed, not only *when*.

## Decision

The flag is keyed by the intercepted tuple. Corrected payload:

```
Ve := (vars(e) ∩ vars(prefix(R)))  ++  t̄°
```

where `t̄°` is the LHS argument terms `t1..tn` with each `Wildcard`
replaced by a fresh variable `_t<i>`. Using the LHS *terms* rather than
`vars(lhs)` is the same thing when every `ti` is a variable, and is the
right generalization otherwise: `{flies (s X) => }` must suppress
`flies (s z)` but not `flies z`, which a flag keyed on `X` alone cannot
express from the default rule's side (it holds the tuple as `W`, not
`X`). A constant LHS such as `{flies x => }` keys the flag on `x`. Since
the flag now contains the whole tuple, two `p'` tuples at one moment get
distinct flags, and the default rule reads the one for *its* tuple.

The transport role of the `vars(e) ∩ vars(prefix)` part is unchanged.
The ctx payload `U = Vt ∪ Ve_old` and the watcher's re-unification of
prefix-bound LHS vars are unchanged — they decide *whether* the flag is
raised; the new key decides *for which tuple*.

## Constraint discovered while reviewing the plan (26/08/27)

`scheduler.ts:391-396` (`aggregateOver`): a sum/count/bool read whose key
has **free positions** (wildcards / unbound vars) and **no contributions**
yields *no result* — the default zero row is produced only when every key
position is bound. Consequence: the default rule must read the flag with
every key column bound, or it never fires when nothing was intercepted.

This is already broken today whenever `m > 0`. Verified:

```
~setup; ~later
setup
  ^ctx a
  ^p x
later, ^p y
setup, ctx C, {p X => ^e C X}      -- Ve = {C}, m = 1
```

evaluates to `e a x` but **no `p y`** — `r_default1` reads
`aggregate _p_exn1 _ -> 0`, the free column has no groups, no result, the
default never re-emits. The `m = 0` control (`{p X => ^e X}`) gives
`e x, p y` as expected. So the transport payload must not live in the
flag key at all.

## Decision, revised

Two relations with distinct jobs:

- **flag** `p_exn t̄°` — `bool`, keyed by the intercepted tuple *only*.
  Decides *which* `p'` tuples are intercepted (by value and by time).
- **ctx** `p_ctx U̅` — already exists (watchers plan); carries the
  transport set `C = vars(e) ∩ vars(prefix(R))` (and `Vt`). The
  exception rule re-joins it to recover `C` instead of reading it off the
  flag.

So `Ve` as a flag payload disappears: the flag's key is `t̄°` and nothing
else; `C` rides `U` on the ctx tuple (it already does — `U = Vt ∪ Ve`).

`t̄°` = the LHS argument terms with each `Wildcard` replaced by a fresh
variable `_t<i>` (single running counter over a pre-order walk of `t̄`,
so nested wildcards get distinct names). Using the LHS *terms* rather
than `vars(lhs)` is equivalent when every `ti` is a variable and is the
right generalization otherwise: `{flies (s X) => }` must suppress
`flies (s z)` but not `flies z`, which a flag keyed on `X` alone cannot
express from the default rule's side (it holds the tuple as `W̄`, not
`X`). A constant LHS such as `{flies x => }` keys the flag on `x`.

## Generated rules (per `{p t̄ => e}` in rule `R`)

4. Host rule `R`: unchanged — `anchor p_ctx U̅`.
5. Watcher `R_watch j`:
   `match p_ctx U̅, match p' t̄°, anchor p_exn t̄° -> 1`
   (`t̄°` in the match so the freshened wildcards are bound for the emit;
   `Vt` vars in `U` re-unify with the tuple as before).
6. Exception rule `R_exn j` (skipped for empty RHS):
   `match p' t̄°, aggregate p_exn t̄° -> 1, match p_ctx U̅, e`
   — the flag read has every key bound (`t̄°` came from the match), the
   ctx match binds `C` for `e` and re-checks `Vt` against the tuple. The
   anchor is `tuple ∩ ctx`, which is the interval the flag was raised over.
   With several ctx tuples over one `p'` tuple `e` runs once per ctx —
   same as the old once-per-flag-group behavior.
7. Default rule `R_default j`:
   `match p' W̄, aggregate p_exn W̄ -> 0, anchor p W̄`
   — no wildcards; `W̄` is bound by the match, so the zero row is
   produced when this tuple was not intercepted. This is the line that
   fixes both the reported bug and the `m > 0` bug above.

Schema: `p_exn : bool` unchanged. Chaining (`rewriteEmitHeads` over `S`;
the default's `anchor p W̄` is the next exception's rename target) and
`provLinks` (derived from default-rule match / anchor heads) are
unaffected. `Vt` and `U` computations are unchanged; `V` (old `Ve`) is no
longer needed as a separate set except as an input to `U`.

## Implementation (`ts/src/v2/expand.ts`, `applyExceptions`)

- After computing `tTerms`, build `tFresh` by walking `tTerms` and
  replacing each `Wildcard` with `{tag:"Variable", name:"_t<n>"}` (`n`
  from a per-exception counter). `_`-prefixed so `print.ts:tupleBindings`
  treats them as non-user vars and user code in `e` cannot capture them.
- Watcher: second match uses `tFresh`; the `p_exn` emit's args are
  `tFresh` (drop `vars(V)`).
- Exn rule: match uses `tFresh`; aggregate read `[sym(exnName), ...tFresh]`
  with weight `1`; insert `{marker:"match", atom:[sym(ctxName), ...vars(U)]}`
  before `...exc.right`.
- Default rule: aggregate read `[sym(exnName), ...W]`; delete `flagWilds`.
- Update the step-1 comment block and the module doc comment; `V` can be
  folded into the `U` computation.
- No changes to parse.ts, eval.ts, fixpoint.ts, scheduler.ts, or the
  post-expand pipeline. Constructor terms as `bool` keys are already
  supported (`downs Q` keys on user terms; 18b below covers it).

## Tests (`ts/src/tests/v2_exceptions.test.ts`)

- New **18 (same-moment discrimination)**: the Problem program; assert
  `flies x` present, `flies y` absent, `_flies_exn1 y` raised. Variant
  with a non-empty RHS `{flies X => ^swims X}`: `flies x`, `swims y`.
- New **18b (compound / constant LHS)**: `{flies (s X) => }` with
  producers `flies z`, `flies (s z)` in one moment → only `flies z`
  survives. `{flies x => }` → only `flies y` survives.
- New **18c (wildcard LHS)**: `{move X _ => ^nope}` with `X` prefix-bound
  to `a`, producers `move a b`, `move a c`, `move d e` in one moment →
  `move d e` survives, two `nope`s.
- New **19 (default fires with transport, regression for the `m > 0`
  bug)**: the program in the Constraint section; assert `e a x` *and*
  `p y`.
- Structural tests **4, 5, 8**: flag atoms carry `t̄°` only; exn rules
  gain the `match p_ctx U̅` atom; default rules read `p_exn W̄`.
- Test **2 (context transport)**: keep its assertion; it now exercises
  the ctx re-join path.
- Test **17**: keep both assertions; retire the "value-level
  discrimination … out of scope" caveat. Test 9's containment note
  likewise: mutual exclusion is now per-tuple by value *and* time.
- Characterization tests 12–14: re-run; CHAR lines may change where two
  tuples previously shared a flag — record the new behavior.

## Docs

- `plans/v2-exceptions.md` and `plans/v2-exception-watchers.md`: add an
  "Amended by [[v2-exception-tuple-keyed-flags]]" header line.
- `ts/src/v2/overview.md` `applyExceptions` entry: flag keyed by the
  intercepted tuple; transport via the ctx re-join; default reads its
  own tuple's flag.
- `discussions/turn-tutorial.md`: exceptions are not covered yet; a short
  section would be worthwhile now that `{p X => }` means what it reads as.

## Resolved questions

- *Keep `\ vars(t̄)` in the transport set?* Moot: the transport set is no
  longer a flag key. `U` is computed as before.
- *Wildcard naming*: one running counter per exception, pre-order.

— Claude Fable 5 (claude-fable-5), 2026-08-24; revised 2026-08-27
