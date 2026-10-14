# v3: Turn compiled to episode procedures

Follow-up to `discussions/procedural-turn.md` (§9 next steps 1–3). The
implementation lives in `ts/src/v3/` and reuses the v2 parser; nothing in
`ts/src/v2/` changes.

## Goal

An evaluator for Turn programs that runs rules as *procedures* fired by
events, not as Datalog rules re-joined to a fixpoint:

- a rule is a chain of compiled steps (CPS closures); its first match is a
  root *listener*, and an emitted tuple is *dispatched* to listeners once;
- every other match is a **lookup** (scan the tuples that exist) plus, only
  when static analysis says more can arrive inside the rule's scope, a
  **subscription** (a listener scoped to the frame whose end is the rule's
  window end);
- an episode is a **frame**; a frame ends when no work is pending inside it
  (structured concurrency), and a continuation whose window start becomes
  an unfinished frame's end waits for it (`~>p`, `;`, `>p`);
- `#acc` relations are computed at the moment they are read, never blocked:
  by construction everything at or below a running continuation's moment
  has already executed;
- choices surface at quiescence, as in v2; v3 resumes in place after an
  answer instead of re-running the program.

The semantics are v2's (non-lattice), exactly where feasible, so v2 can be
used as an oracle.

## Moments

Every moment is created by subdividing the running window `(XL, XR)`:
`pred = XL`, `succ = XR` (an episode's `r` has `pred = l`). With the window
invariant `XR ∈ succChain(XL)` (holds for every anchor step), the order is
characterized by

    u ≤ v  iff  some s on succChain(u) is a pred-tree ancestor-or-self of v

`succChain(u)` is `u` plus the enclosing scope ends (frame nesting depth).
Ancestor tests use an Euler tour of the pred tree kept in an
order-maintenance list (Dietz–Sleator labels), so `≤` costs O(depth).

## Pieces

1. `terms.ts` — interned ground terms (ints), fresh ids, choice ids, patterns.
2. `moments.ts` — moments, order-maintenance list, `le/lt/max/min/lub`.
3. `analyze.ts` — relation kinds, static scopes, spawn graph, which matches
   need a subscription; the per-rule report (`v3-cli --report`).
4. `compile.ts` — rule bodies → CPS steps (match, `>p`, acc read, `not`,
   js, `=`, emits `+ ^ ~ ~>`, `?`, `!`, sub-groups, exceptions).
5. `acc.ts` — acc rules evaluated at a moment (strata, recursion, ops),
   cached per moment.
6. `choices.ts` — constraints, components per ask moment, option
   enumeration, dead choices.
7. `runtime.ts` — store, frames, task queue, listeners, frame ends,
   exception decisions at quiescence, choice surfacing and resolution.
8. `v3-cli.ts` — run a file, answer choices by policy, print state/report.
9. `diff.ts` — lockstep v2/v3 driver: same choice policy (by fresh-id
   descriptors), compare facts, acc rows at each choice and option sets.
10. `data/v3/` — ttt and wolf-sheep rewritten in the procedural idioms
    (no subscriptions left except `is` awaits).

## Deliberate differences / limits

- No lattice mode.
- Exception defaults are decided at quiescence (once no gate or unanswered
  choice is below the tuple) with the contexts registered by then; the
  emitter runs on, its later reads waiting for the decision.
- Saved v2 `^ is` rows (Skolem ids) are ignored; v3 takes answers through
  its API.

## Outcome (26/10/13)

Implemented as planned, with three corrections the v2 oracle forced:

1. **Awaits are lazy, reads force.** First version: `~>p` waited for `p` to
   end. v2 instead continues at once (the continuation's moments are after
   `r_p` regardless) and only *reads* wait for the moment walk. At a choice
   v2 therefore already has every fact derivable without the answer (SI:
   `energy-delta` after `~>gain-card` with a card choice pending). v3 now
   runs ahead: a continuation carries the unended frames it passed
   (`deps`, *gates*); `#acc`/`not` reads and lookups that do not listen wait
   for them (`whenComplete`), and so does a frame spawned past them (work
   from the earlier frame can still reach it).
2. **Unanswered choices block like frames.** A moment above an unanswered
   `?` is not settled (the `is` row will start below it), so point reads,
   exception decisions and frame ends wait for choices below them too.
3. **Exception scope follows v2's renaming order** (`applyExceptions`): an
   exception does not intercept its own right-hand side, its own host rule,
   or host rules/right-hand sides after it — an emit-site *barrier*. An
   unconditional `{draw => ~pre-draw; ~draw}` would otherwise loop.

Also: root listeners must exist before the first emit (rules that start
by listening start first), since a late catch-up lookup could enter a
frame that already ended (`warnLate` reports it; never seen after the fix).

Verification: lockstep diff (facts, acc rows at every choice, options) on
the corpus, 35 SI spirit variants × 2 seeds and 9 full si-game games (all
match; two variant combinations of mine don't parse in either engine).
Speed: 3–23x one v2 run; v2's harness re-runs per answer, v3 resumes.

Plan written by Claude Opus 5.5 (claude-opus-5-5).
