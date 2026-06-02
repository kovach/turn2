# exceptions

*Exceptions* let a rule locally override what a predicate does. An
**exception expression** `{p t1..tn => e}` in a rule body means: in this
context, wherever `p t1..tn` would have been produced, do `e` instead.
The separator is `=>` (not `->`) so it doesn't clash with the aggregate
weight arrow.

- LHS `p t1..tn`: a single atom, no marker, not an aggregate (trailing
  `-> X` rejected). Head must be a `Symbol`.
- RHS `e`: an arbitrary rule-body fragment (atoms with any markers,
  dots, subs) that itself contains no exception expression.

Worked example (`notes/overview.md`):

```
activate.it.is misfits
  ~choose.it _X, !in-supply _X;
  is _X X
  ~play-card.it.^is X
    {move X _ => nope}
```

The feature is a **source-to-source transformation** run once before
expansion. No evaluator semantics change. The flag is a `bool` relation
(see [[v2-bool-aggregate]]) that also carries the context variables `e`
depends on.

## Desugaring

The transform maintains a **working set** `S` of rules. `S` is the
target of every rewrite and the place generated rules accumulate;
crucially, **a rule with any remaining Exception atom is *not* in `S`**.
Initially `S` = all rules that contain no exception expression. Rules
that do contain exceptions sit outside `S` until each of their
exceptions has been processed in turn, at which point they join `S`.

The two consequences worth keeping in mind:

- A rewrite (step 3 below) only ever touches rules in `S`. It never
  descends into a pending exception's `Exception.right` (`e`), because
  that fragment lives on a rule outside `S`. So a later exception
  cannot accidentally rewrite the head of `p` inside an earlier-pending
  exception's RHS, and vice versa — there is no "did A's rewrite walk
  into B's `e`?" ambiguity.
- The contents of `e` are first exposed to the set's rewrites only
  *after* their owning exception is processed and `e` has been spliced
  into the generated exception rule (step 5). From that point on, `e`'s
  `^p`s are rewritten by *future* exceptions in the normal way —
  exactly the chaining mechanism described below.

Process exceptions **in source order**. For each `{p t1..tn => e}` in
rule `R`, with two fresh symbols minted per-exception (call them `p'`
and `p_exn`; concrete name scheme below):

1. **Compute** `V1..Vm = (vars(e) ∩ vars(prefix(R))) \ vars(t1..tn)`,
   where `prefix(R)` is the pre-order traversal of `R`'s *current* body
   up to this Exception atom. Every variable occurrence binds, so
   `vars(atom) =` variables appearing in its terms. `V1..Vm` are the
   context bindings `e` depends on; they must be transported to the
   detached exception rule via the flag. (When a second exception in
   the same rule references vars bound by the first's in-place match
   `t1..tn`, this picks them up — per overview's V-scoping note.)

2. **Schema**: `schema.set(p_exn, "bool")`. (Surface form is
   `#acc p_exn v1..vm -> bool`; the `m` arg terms are ignored — the
   schema map only stores `name → aggregator`.)

3. **Rewrite** every positive (`fact`/`episode`/`anchor`/`ask`)
   occurrence of `p` to `p'` **across `S`**. Match / aggregate /
   constrain queries stay as `p`. (`S` already includes every
   exception/default rule from earlier-processed exceptions and every
   rule whose exceptions are all done; it never includes pending
   Exception RHS fragments.)

4. **Replace** this Exception atom in `R` (still outside `S`) with the
   two items `[ match p' t1..tn, anchor p_exn V1..Vm -> 1 ]`. The match
   recognizes the exceptional case (identifying a tentative `p'` as
   exceptional in `R`'s context); when it fires, the rule sets the flag
   over `R`'s anchor context.

5. **Add to `S` an exception rule** with body `match p' t1..tn,
   aggregate p_exn V1..Vm -> 1, <e spliced in>`. The flag query binds
   `V1..Vm` for `e`; `t1..tn`-vars are bound by the `p'` match.

6. **Add to `S` a default rule** with body `match p' W1..Wn,
   aggregate p_exn _.._ -> 0, anchor p W1..Wn`. Fresh `W1..Wn`
   (`n = p`'s arity), `m` wildcards for the unused flag payload. Matches
   any `p'`, fires when the flag is unset, re-emits the real `p`.

7. **If this was `R`'s last exception**, `R` is now in normal form;
   add `R` to `S`.

Step-3 happens before steps 4–6 add anything to `S`, so the `^p` and
spliced `e` join the set already containing literal `p`. A later
exception on the same `p` will then rewrite those `^p`s to its own
`p'` when its step 3 walks `S` — the chaining mechanism.

**Net effect**: a `p'` tuple runs `e` (with `R`'s context bindings
restored via the flag) when the flag is set within that tuple's moment
range; otherwise it's re-emitted as the real `p`. Mutual exclusion is
the moment-overlap of the two `bool` queries; the `V1..Vm` payload only
transports bindings, it doesn't gate. The default uses fresh `W1..Wn`
(not `t1..tn`) so it matches every `p'`, not just exception-shaped ones.

### Chaining example

For `{p => e1}` then `{p => e2}` (fresh `p1'`/`p1_exn`, `p2'`/`p2_exn`):

```
exc1:  p1' t.., p1_exn V.. -> 1, e1            -- ^p in def1 gets rewritten
def1:  p1' W.., p1_exn _.. -> 0, ^p2' W..        by step-3 of {p=>e2}
exc2:  p2' t.., p2_exn V.. -> 1, e2
def2:  p2' W.., p2_exn _.. -> 0, ^p   W..
```

Producers emit `p1'`; def1 forwards to `p2'` unless `e1` intercepts;
def2 forwards to `p` unless `e2` intercepts.

### Worked: two exceptions in one rule, V-scoping

Two exceptions on **different** predicates in the same rule, where the
second's RHS references a variable bound by the first's `t1..tn`:

```
#def r
  is _X X
  {p X => e1 X}
  is _Y Y
  {q Z => e2 X Z}
```

Process exc1 `{p X => e1 X}`. `V = vars(e1 X) ∩ vars(prefix) \ {X} =
∅`, so `m=0`. After steps 3–6, R becomes:

```
is _X X
match  p_prime1 X
anchor p_exn1 -> 1
{q Z => e2 X Z}
```

and S gains:

```
r_exn1:     match p_prime1 X, aggregate p_exn1 -> 1, e1 X
r_default1: match p_prime1 W, aggregate p_exn1 -> 0, anchor p W
```

Process exc2 `{q Z => e2 X Z}`. R's prefix up to this Exception now
binds `X` (via the just-inserted `match p_prime1 X`) and `Y`. So
`V = vars(e2 X Z) ∩ {X, Y} \ {Z} = {X}`, `m=1` — the flag transports
`X` to `e2`. After step 7 R joins S. Final R body:

```
is _X X
match  p_prime1 X
anchor p_exn1 -> 1
is _Y Y
match  q_prime1 Z
anchor q_exn1 X -> 1
```

Plus on S:

```
r_exn2:     match q_prime1 Z, aggregate q_exn1 X -> 1, e2 X Z
r_default2: match q_prime1 W, aggregate q_exn1 _ -> 0, anchor q W
```

Schema additions: `p_exn1: bool`, `q_exn1: bool` (arity 0 and 1
respectively for the `Vi` payload).

### Worked: two exceptions in one rule, same predicate

Intra-rule chaining on the same predicate. The key behavior: exc2's
step-3 walks S — which already contains `r_default1` — and rewrites
def1's positive `^move` to `^move_prime2`.

```
#def r
  is _X X
  {move X _ => nope}
  is _Y Y
  {move Y _ => boom}
```

After exc1, R has `match move_prime1 X _, anchor move_exn1 -> 1` and S
contains:

```
r_exn1:     match move_prime1 X _, aggregate move_exn1 -> 1, nope
r_default1: match move_prime1 W1 W2, aggregate move_exn1 -> 0,
            anchor move W1 W2
```

Processing exc2, step 3 rewrites positive `move` → `move_prime2`
across S. **This mutates `r_default1`'s tail** from `anchor move W1
W2` to `anchor move_prime2 W1 W2`. R's already-inserted `match
move_prime1 X _` is not touched: it's a `match` (so step 3 skips it
anyway), and its head is `move_prime1`, not `move`.

Final R body:

```
is _X X
match  move_prime1 X _
anchor move_exn1 -> 1
is _Y Y
match  move_prime2 Y _
anchor move_exn2 -> 1
```

Final generated rules:

```
r_exn1:     match move_prime1 X _,    aggregate move_exn1 -> 1, nope
r_default1: match move_prime1 W1 W2,  aggregate move_exn1 -> 0,
            anchor move_prime2 W1 W2          -- rewritten by exc2
r_exn2:     match move_prime2 Y _,    aggregate move_exn2 -> 1, boom
r_default2: match move_prime2 W1 W2,  aggregate move_exn2 -> 0,
            anchor move W1 W2
```

Producer flow: `^move A B` got rewritten by exc1's step 3 to
`^move_prime1 A B`. Then:

- if `move_exn1` is set within the tuple's moment (r fired with
  `X=A`), `r_exn1` runs `nope`;
- otherwise `r_default1` forwards `^move_prime2 A B`;
- if `move_exn2` is set (r fired with `Y=A`), `r_exn2` runs `boom`;
- otherwise `r_default2` forwards the real `^move A B`.

So source order = priority within a rule.

## Parsing (`ts/src/v2/parse.ts`)

**Tokenizer.** At `atomStart` on `{`, scan to the matching `}` (track
`{`/`}` depth) and emit `{ tag: "exception"; text; line }` (inner text,
braces stripped). Unterminated `{` or stray `}` is a tokenize error.

**Parsing the block.** Split inner text on the top-level `=>` (mirror
`findTopArrow` with a `=>` matcher).

- LHS: parse via `tokenizeTermText` + `parseTerms`. Errors: top-level
  `->` (no aggregate on LHS); non-Symbol head; leading marker char.
- RHS: parse as a body fragment using the same machinery as a normal
  rule body. Extract a `parseBodyFragment(text, line)` helper from
  `parseProgram` (or parse the RHS as a throwaway one-rule program and
  lift its body). Then walk the result, recursing into every
  `Sub.body`; if any element has `tag === "Exception"`, error
  ("exception RHS may not contain an exception").

Other errors: missing `=>`; either side empty.

Add the pre-expand-only `RuleAtom` variant to `ts/src/v2/types.ts`:

```typescript
| { tag: "Exception"; left: Atom; right: RuleAtom[]; span: Span }
```

Wrap it as a `BodyItem` of `kind: "atom"`.

**Plumbing.** `collectUsedNames` (parse.ts:463) descends into `left`
terms and `right`. `desugarBody` (parse.ts:536) treats `Exception` as
opaque: not a dot-left, not a dot-right (a `.` adjacent to a `{...}` is
a parse error — see *Future work*), not a frame anchor; pass it through
to the exceptions pass. Other structural walks switching on `a.tag` get
an `Exception` arm.

## Transformation pass (`ts/src/v2/expand.ts`)

`applyExceptions(program: Program): Program` runs at the top of
`expand` (expand.ts:15), before `decomposeRule`. `expand` is the sole
consumer of pre-expand programs (only call site: fixpoint.ts:32):

```typescript
export function expand(program: Program): Program {
  program = applyExceptions(program);
  ...   // existing body unchanged
}
```

Implementation = the **Desugaring** steps above, applied to each
Exception atom in source order. Concretely: build the working set `S`
by partitioning `program.rules` into has-exception and no-exception
(initial `S` is the no-exception partition). Collect Exception atoms
across the has-exception partition in source order (pre-order through
`Sub.body`), keeping mutable handles so step 4 can replace in place;
walks for step 3 traverse `S` only. After each exception, add the
generated rules to `S`; after a containing rule's last exception is
replaced, add the rule itself to `S` (step 7). Final `program.rules :=
S`. Return `program` unchanged if there are no exceptions.

Generated pre-expand atoms:

```
exception rule:                          default rule:
  match     p'    t1..tn                   match     p'    W1..Wn
  aggregate p_exn V1..Vm -> 1              aggregate p_exn _.._  -> 0
  <e spliced verbatim>                     anchor    p     W1..Wn
```

`aggregate` atoms: `{marker:"aggregate", atom:{terms:[sym(p_exn),
...args]}, weight: sym("1"|"0")}` — args are `V1..Vm` for the exception
rule, `m` `Wildcard` terms for the default. Downstream `decomposeRule`
/ `splitRule` / delta-variant passes handle these like hand-written
rules.

### Fresh symbols

Per exception, mint `<p>_prime<k>` and `<p>_exn<k>` with the smallest
`k ≥ 1` producing names unused in the program. (`p'` in the overview is
notation, not a literal — the suffix `_prime<k>` keeps names readable
and avoids the reserved `*`/`_` *prefix* rule at parse.ts:710.)

### Naming

`resolveRuleNames` runs at parse time (parse.ts:438), so every source
rule has a resolved `.name` when this pass runs. Set generated rules'
`.name` directly (not `""`). For containing rule `f`, number from 1:

```
#def f ... { e1 } ... { e2 } ...
  ⇒  f, f_exn1, f_default1, f_exn2, f_default2
```

Skip to the next free integer on collision.

## Future work

- **Exceptions in dot chains.** `notes/overview.md` shows future syntax
  like `foo . {bar => baz}`, `{card => foo} . action`,
  `action.it.is.{move To => move To'}`. This plan rejects all of these.
  Lifting requires deciding how the LHS atom participates in dot
  threading (does the threaded fresh var attach to LHS terms, to the
  flag terms, or both?) and how the exception rule inherits it.
- **Rule ordering** (overview's existing question): allowing the full
  rule set to be ordered so a rule later than exception `E` is not
  rewritten by it.

## Tests (`ts/data/v2/exceptions.t`)

1. Basic override (`m=0`): a producer in the exception context runs
   `e`; one in a disjoint moment range stays `p`.
2. Context-variable transport (`m>0`): `e` references a var bound
   earlier in `R`; the var reaches `e` via the flag.
3. Multi-atom RHS: `e` is e.g. `~foo X, bar Y`.
4. **V-scoping (intra-rule, different predicates)** — the *Worked:
   two exceptions in one rule, V-scoping* example. Parse the program
   and call `applyExceptions`; assert:
   - R's final body is the six atoms shown (alpha-equivalent),
     including `anchor q_exn1 X -> 1` (X transported, m=1).
   - S contains exactly `r`, `r_exn1`, `r_default1`, `r_exn2`,
     `r_default2` with the bodies shown.
   - `schema` gains `p_exn1 → "bool"` and `q_exn1 → "bool"`.
   - Behavior end-to-end: emit a producer of `p A` under R's anchor
     bound to X=A and confirm `e1 A` fires (not `p A`); emit one
     outside R's anchor and confirm `p` is preserved. Same shape for
     `q B` with the carried X.
5. **Same-predicate (intra-rule chaining)** — the *Worked: two
   exceptions in one rule, same predicate* example. Assert:
   - R's final body matches the six atoms shown.
   - `r_default1`'s tail is `anchor move_prime2 W1 W2`, **not**
     `anchor move W1 W2` (this is the load-bearing intra-rule rewrite
     — its absence means step 3 isn't walking S).
   - `r_default2`'s tail is `anchor move W1 W2`.
   - Behavior: with a producer of `^move a b`, run two variants of R's
     context — one with X=a (expect `nope`, no `move a b`), one with
     Y=a (expect `boom`, no `move a b`), one with neither (expect real
     `move a b`). Confirms source-order priority within a rule.
6. **Cross-rule chaining** (the existing *Chaining example*
   subsection): two exceptions on the same `p` in distinct rules each
   intercept their own context; a producer in neither stays `p`.
7. Wildcard `t_i` (`move X _`): override fires regardless of arg 2.
8. Naming: `#def f ... { e1 } ... { e2 }` yields `f`, `f_exn1`,
   `f_default1`, `f_exn2`, `f_default2`.
9. Reduced `misfits` example (exception as a plain body item nested in
   a dot-chain rule).
10. Errors: nested exception in RHS; aggregate on LHS
    (`{p a -> X => q}`); non-symbol head or marker on LHS; `.` adjacent
    to a `{...}` block.
11. No-exception program is unchanged through `applyExceptions`.

## File touch list

| File                       | Change                                                                 |
|----------------------------|------------------------------------------------------------------------|
| `ts/src/v2/types.ts`       | Add pre-expand `Exception` `RuleAtom` variant                          |
| `ts/src/v2/parse.ts`       | Tokenize `{`/`}`; parse exception block; `parseBodyFragment` helper; reject nested exception, LHS aggregate, dot-adjacent block; thread `Exception` through `collectUsedNames` / `desugarBody` |
| `ts/src/v2/expand.ts`      | `applyExceptions` pass at top of `expand`                              |
| `ts/data/v2/exceptions.t`  | New test cases                                                          |

No changes to `eval.ts`, `scheduler.ts`, `aggregators.ts`, `fixpoint.ts`.
