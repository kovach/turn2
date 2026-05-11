# v2 — `.` dot-notation join sugar

## Goal

Add a purely syntactic shorthand `foo . bar` that desugars to a binary
join through a fresh variable: `foo X1, bar X1`. The dot is *only* a
parser-level rewrite — no later pass (expand, decompose, scheduler,
eval) sees a dot. It is an alternative to `,` for the common pattern
"thread the next atom's first arg through the previous atom's last arg."

Examples (from `notes/overview.md`):

```
foo X . bar y Z              -> foo X X1, bar X1 y Z
player . score -> S          -> player P, score P -> S
player .hand .top-card C     -> player P, hand P H, top-card H C
player.hand.top-card C       -> player P, hand P H, top-card H C
turn .(actor A) .(index I) -> turn T, (actor T A), (index T I)
turn .(actor.name N) .foo F -> turn T, (actor T A, name A N), foo T F
```

The general model (see *Desugar pass* below): walk the chain with an
**anchor stack**. Each anchor frame is an atom plus a lazily-allocated
fresh variable. A plain `.` consumes that fresh var (appending to the
anchor's terms, prepending to the next atom's terms after its head)
and then advances the anchor to the right-hand atom. A `(` pushes a
new frame whose *incoming* anchor is the outer frame (so a dot
immediately before the `(` threads the outer anchor's fresh var into
the sub's first atom); `)` pops, restoring the outer anchor unchanged.
Consecutive `.(...)` siblings therefore reuse the same outer fresh
var, while `a . b . c` rotates through one fresh var per step.

## Approach

Two stages, matching the user's instruction in overview.md ("introduce a
new temp IR that the parser produces containing dots; then we rewrite
into the current IR with the fresh variables inserted; nothing later
changes"):

1. **Lex `.` as a real separator.** Tokenization yields a new token
   `{ tag: "dot", line }` wherever a `.` appears between atoms (with
   or without surrounding whitespace; see *Lexing* below).
2. **Build a temp body IR.** `parseProgram`'s per-rule loop accumulates
   into a temp body whose entries are either a `RuleAtom` or a
   `DotJoin` separator (a single bit between two adjacent atoms). The
   temp IR exists only in `parse.ts`.
3. **Rewrite to the current IR.** Before returning the rule, a
   `desugarDots` pass walks the temp body with an anchor stack and
   threads fresh variables per the model above (full algorithm in
   *Desugar pass*). Output is a plain `RuleAtom[]`, identical in
   shape to today's parser output.

Nothing downstream changes — `expand.ts`, `eval.ts`, `print.ts`,
`scheduler.ts`, etc. continue to see ordinary comma-joined atoms.

## Lexing

In `tokenize` (`ts/src/v2/parse.ts:50+`), `.` is currently swallowed by
the atom-body scanner because none of the special chars `, ( ) %` match
it. Three lexical forms to support, in priority order:

1. **Spaced dot, `foo X . bar y Z`.** At the top of the
   per-character loop, after the whitespace-skip, if `pos < raw.length`
   and `raw[pos] === '.'` and the previous emitted token in this rule
   is an `atom`/`equal`/`close` (i.e. we are between atoms), emit
   `{ tag: "dot", line }`, advance one char, set `atomStart = true`,
   continue. This mirrors how `,` is handled (`parse.ts:89`).
2. **Leading-dot atom, `player .hand`.** When scanning the atom body
   (`parse.ts:101+`), if the very first non-whitespace char of an atom
   is `.`, emit `{ tag: "dot", line }` first, advance past the `.`,
   then continue reading the atom text normally from the next char.
   Equivalent to inserting a space: `.hand` becomes `. hand`.
3. **Glued dot, `player.hand.top-card`.** Inside the atom-body scan
   loop at `parse.ts:102+`, treat top-level `.` (i.e. `depth === 0`
   `.`) as a token boundary the same way `,` is. When such a `.` is
   hit: stop the current atom-text accumulation at this `.`, push the
   atom token, then push a `dot` token, advance past the `.`, and
   resume scanning a new atom from there. This handles the `a.b.c`
   chain in one pass.

All three are the same `dot` token; the three rules are about *where*
in the existing scanner state machine to detect it.

Disambiguations:
- `.` is never legal at the start of a rule body — emit `ParseError`
  ("dot must follow an atom").
- `.` inside `(...)` term-syntax (e.g. `foo (a . b)`) is not allowed
  in this plan; the `.` lexer rules above only fire when `depth === 0`
  in the atom-body scanner, and inside a `Sub` block (between `open`
  and `close` rule-level parens) `.` between sub-atoms is allowed and
  behaves identically. If a `.` appears inside *term-level* parens
  (depth > 0 in the atom-body scan), it is consumed as part of the
  atom text (current behaviour), so a token like `foo.bar` *as a
  Symbol inside a term* would still glue. We don't currently need
  that case — flag as an open question.
- No decimal-literal carve-out is needed: the language has no
  decimal-point numeric literals and identifiers/vars can't start
  with a digit, so depth-0 `.` is unambiguously a separator. Tests
  pin this behaviour.

## Temp IR in `parse.ts`

Add a local type, not exported:

```ts
type BodyItem =
  | { kind: "atom"; atom: RuleAtom }
  | { kind: "dot"; line: number };
```

The per-rule loop (around `parse.ts:158+`) currently pushes
`RuleAtom`s onto a `RuleAtom[]` and the `Sub` stack. Replace those
stacks with `BodyItem[]` stacks. When a `dot` token is consumed:

- It is an error if the immediately-previous `BodyItem` in the current
  stack frame is not an `atom`, or if it is an `atom` whose tag is
  `Equal` (an `=`-atom can't dot-chain — its term count is fixed at
  two). Return `ParseError`.
- Otherwise push `{ kind: "dot", line }`.

When closing a `Sub` (`parse.ts:181+`), the inner `BodyItem[]` is
desugared *before* being stored on the parent's `Sub.body`, so the
`Sub` carries a plain `RuleAtom[]` as today. The outer body is
desugared once at end-of-rule, just before
`rules.push({ name, body, span })`.

## Desugar pass

```ts
function desugarDots(items: BodyItem[], usedNames: Set<string>): RuleAtom[] | ParseError;
```

`Sub`-block bodies are recursively desugared first (so the outer walk
sees plain `RuleAtom[]` inside each `Sub.body`), and we pre-walk the
whole rule once to populate `usedNames` with every `Variable` name
that appears anywhere in the rule's terms — generated names avoid
collisions by skipping any name already in the set.

**State during the walk.** A small stack of *anchor frames*:

```ts
type Frame = {
  anchor: RuleAtomAtom | null;    // the current "left" atom; null only
                                  //   right after `(` until the first
                                  //   atom of the sub arrives
  freshVar: Variable | null;      // lazily allocated on first use
  pendingDot: boolean;            // a `.` was just consumed; the next
                                  //   atom is the right-hand side
};
```

A fresh name is minted by `nextName(usedNames)`: try `_dot1`, `_dot2`,
… skipping any name already in `usedNames`; on mint, add the result to
`usedNames` so subsequent calls keep skipping.

**Walk rules.** Push an initial frame `{ anchor: null, freshVar: null,
pendingDot: false }` for the outer body. For each `BodyItem` in order:

1. *Atom item* (a `RuleAtom` with `tag === "Atom"`; `Equal` and `Sub`
   handled below).
   - Let `top` be the current frame.
   - If `top.pendingDot`:
     - The right-hand side is this atom.
     - Ensure `top.freshVar` is allocated (mint via `nextName` and
       *append* to `top.anchor.atom.terms` exactly once — if
       `freshVar` was already allocated by an earlier sibling dot,
       skip the append; the var is already on the anchor).
     - Splice `top.freshVar` into the right atom's terms at index 1
       (after the head symbol).
     - Clear `top.pendingDot`.
     - **Advance the anchor:** set `top.anchor = right`,
       `top.freshVar = null`. The right atom is now the local
       anchor with its own (not-yet-allocated) fresh var.
   - Else (no pending dot): this atom simply becomes the current
     anchor of the frame (`top.anchor = atom`, `top.freshVar = null`).
2. *Dot item*. If `top.pendingDot` is already true → error
   ("consecutive dots"). If `top.anchor === null` → error ("dot must
   follow an atom" — covers `(. b)` and bare `. foo`). Otherwise set
   `top.pendingDot = true`.
3. *Open* (`(` — encoded as a `Sub` `BodyItem` whose body has already
   been desugared *recursively but with a connector*; see below).
   The connector handling is: if the outer `top.pendingDot` is true,
   the sub's first atom needs the outer frame's fresh var prepended
   *and* the outer anchor's terms need the fresh var appended (once).
   Then `top.pendingDot` is cleared but the outer anchor does **not**
   advance — that's what distinguishes `.(sub)` from `. atom`.

   Because the sub's body is its own anchor-stack walk, we need to
   pass the "incoming dot" flag *into* the recursion. Refactor:
   `desugarBody(items, usedNames, incomingAnchor?: Frame)`. When the
   recursion sees its very first atom, if `incomingAnchor` was
   supplied, treat it as a virtual outer frame with `pendingDot =
   true` — i.e. allocate/append the outer fresh var, prepend to the
   sub's first atom, then proceed normally with that first atom as
   the sub's local anchor.

The outer walk's final output is the items in order, minus the dots
(they've been consumed), with mutated term lists. `Sub` items pass
through with their already-desugared bodies.

**Worked examples** (all match the goal section):

- `foo X . bar y Z`:
  frame anchor=`foo X`, dot → pendingDot=true; see `bar y Z` → mint
  `T1`, append to `foo X` (→ `foo X T1`), splice into right (→
  `bar T1 y Z`), advance anchor to `bar T1 y Z`. Output: `foo X T1,
  bar T1 y Z`.
- `player .hand .top-card C`:
  anchor=`player`, dot, atom `hand` → mint `T1`, `player T1`, `hand
  T1`, advance. Anchor=`hand T1`, dot, atom `top-card C` → mint
  `T2`, `hand T1 T2`, `top-card T2 C`. Output: `player T1, hand T1
  T2, top-card T2 C`.
- `turn .(actor A) .(index I)`:
  outer anchor=`turn`, dot → pendingDot. See `(`: recurse with
  `incomingAnchor = outer`. Inside the sub, first atom `actor A`:
  mint outer's `T1`, append to `turn` (→ `turn T1`), prepend `T1`
  to `actor A` (→ `actor T1 A`). Sub has no more dots. Pop. Back in
  outer: pendingDot cleared, anchor still `turn` (with `T1` already
  appended), freshVar still `T1` (NOT cleared — `.(sub)` doesn't
  advance the anchor and doesn't burn the fresh var). Next: dot →
  pendingDot. See `(`: recurse again with same outer frame; sub's
  first atom `index I` gets `T1` prepended (no second append to
  `turn` because `freshVar` is already allocated). Output: `turn
  T1, (actor T1 A), (index T1 I)`.
- `turn .(actor.name N) .foo F`:
  outer anchor=`turn`, dot, `(`: recurse. Inside sub: `actor.name N`
  is itself a dot chain. Incoming anchor=outer→ mint outer `T1`,
  append to `turn`, prepend to `actor` (→ `actor T1`). Sub-local
  frame: anchor=`actor T1`, dot, atom `name N` → mint sub-local
  `A1`, append to `actor T1` (→ `actor T1 A1`), prepend to `name N`
  (→ `name A1 N`), advance to `name A1 N`. Pop. Back in outer:
  anchor still `turn`, `freshVar = T1` (preserved). Dot, atom `foo
  F` → pendingDot=true; allocate? `T1` already allocated; splice
  into `foo` (→ `foo T1 F`); advance to `foo T1 F`. Output: `turn
  T1, (actor T1 A1, name A1 N), foo T1 F`. ✓

**The role of `(` / `)`.** They are the *only* construct that lets a
dot fan out without advancing the anchor. Without them, every dot
rotates the anchor forward. This is what makes the model compose:
plain dot = "consume and advance"; `.(sub)` = "consume and branch".

Edge cases the pass must handle:
- Weight on the right: `player . score -> S`. The `weight` lives on
  the right atom already; only its `atom.terms` is touched, weight is
  untouched.
- Markers: left/right markers (match/fact/episode/anchor/etc.) are
  preserved. `~foo . bar` desugars to `~foo T1, bar T1`; `+foo .
  bar` desugars to `+foo T1, bar T1`. Whether mixed markers across a
  dot make semantic sense is the rule author's problem — the sugar
  is syntactic.
- Wildcards: the fresh var is always a `Variable`, never a Wildcard.
- Hashcons: parser doesn't hashcons (per file-header comment); the
  Variable is plain.
- An anchor with no following dot is left untouched (no fresh var
  allocated, no terms appended). The plan only mutates when a dot
  fires.
- `Equal` and `Sub` items cannot serve as the *anchor* on either side
  of a dot (they have no head symbol whose terms we can splice).
  Encountering one with `pendingDot` true, or trying to `.` after
  one, is a `ParseError`.

## Wiring summary

Files touched:

- `ts/src/v2/parse.ts`
  - new `Token` variant `{ tag: "dot"; line }`
  - lexer changes per *Lexing* section
  - new local `BodyItem` type and `desugarDots` helper
  - per-rule and per-`Sub` accumulators retyped to `BodyItem[]`
  - rule-finalize and sub-close sites call `desugarDots`

Nothing else changes. No new exported types; no IR types in
`ts/src/v2/types.ts`; no expand/scheduler/eval touch.

## Tests (add to `ts/src/tests/v2_parse.test.ts`)

Round-trip parse → render (using existing `renderAtom`) to verify the
desugared form:

- `parse("foo X . bar y Z")` produces two `Atom` rule-atoms:
  `foo X _dot1` and `bar _dot1 y Z`.
- `parse("player . score -> S")` produces `player _dot1` and an
  aggregate `score _dot1 -> S`.
- `parse("player .hand .top-card C")` produces `player _dot1`,
  `hand _dot1 _dot2`, `top-card _dot2 C`.
- `parse("player.hand.top-card C")` matches the previous test
  exactly.
- Counter resets across rules: two consecutive rules each starting
  with a dot chain both use `_dot1`.
- **Sibling-sub sharing:** `parse("turn .(actor A) .(index I)")`
  produces `turn _dot1`, a `Sub` with `actor _dot1 A`, and a `Sub`
  with `index _dot1 I` (single `_dot1`, used in all three; only one
  copy appended to `turn`).
- **Nested-and-then-continued:** `parse("turn .(actor.name N) .foo
  F")` produces `turn _dot1`, a `Sub` with `actor _dot1 _dot2` and
  `name _dot2 N`, then `foo _dot1 F`.
- **Name-collision avoidance:** `parse("foo X _dot1 . bar Y")`
  generates `_dot2` (not `_dot1`) for the fresh var because `_dot1`
  is already used in the rule. (`usedNames` pre-walk.)
- `parse(". bar")` → ParseError ("dot must follow an atom").
- `parse("foo X . = a b")` → ParseError (right side of dot can't be
  an `=`-atom).
- `parse("foo X . , bar Y")` → ParseError (consecutive dot/comma
  with no right-hand atom).
- `parse("foo X . . bar")` → ParseError (consecutive dots).
- `parse("foo -> W . bar")` → ParseError (aggregate atom can't be
  the left of a dot); but `parse("player . score -> S")` parses
  cleanly with `score` as the aggregate on the right.
- Inside a `Sub`: `parse("(player . score)")` desugars inside the
  sub-body, producing a `Sub` with two atoms.
- End-to-end equivalence: write a small `.t` program once with dots
  and once without, run `evaluate` on both, assert identical final
  store / output. Good candidate: a rewrite of a few `ttt.t` joins.

## Migration of `ts/data/v2/ttt.t`

Optional follow-up: rewrite obvious join chains in `ttt.t` using dot
notation, confirm `v2_ttt.test.ts` is green. Defer until the sugar
ships and we've stared at it for a while.

## Non-goals

- Dot inside term-level parens (`foo (a . b)`) — flagged as open
  question; not implemented in this plan.
- N-ary dot with explicit slot indices (e.g. `foo X .2 bar`).
- Right-associative or left-anchored variants. The desugaring is
  uniformly "append to left, prepend-after-head on right."
- Mixing `.` with `,` inside a single chain in a way that produces
  weird scoping — `,` is just a separator with no fresh-var
  semantics, so `foo X, bar . baz` desugars to `foo X, bar _dot1,
  baz _dot1` and that's fine.
- Dynamic / per-file enabling/disabling. Always on.

## Open questions / ambiguities

1. (resolved) **Identifier-glued dot and numeric literals.** The
   language has no decimal-point numeric literals, and terms/vars
   must not start with a digit. So depth-0 `.` is *always* a
   separator — no digit-context lookaround needed. The `Lexing`
   section's rule 3 simplifies accordingly.

2. (resolved) **`_dotN` name collisions.** Before desugaring,
   pre-walk the rule's terms (including inside `Sub` bodies) to
   collect a `Set<string>` of every `Variable` name in use, then
   mint fresh `_dotN` names skipping anything already in the set.
   `desugarDots` takes the set as a parameter; each mint adds its
   result so later mints keep skipping. Tests cover both the
   colliding and non-colliding case.

3. **Dot from a sub onto a following atom.** `(bar Y) . baz` — does
   the closing `)` "expose" the sub's last atom as an anchor? The
   anchor-stack model as written says no: after `)` we pop back to
   the *outer* frame, which had a `Sub` as its current item, and a
   `Sub` is not a valid anchor. So `(bar Y) . baz` is a
   `ParseError`. The reverse direction (`foo . (bar)`) *is*
   supported and is the whole point of `.(sub)`. Revisit only if
   real programs want post-sub chaining.

4. (resolved) **Aggregate left side.** `foo -> W . bar` is a
   `ParseError` ("aggregate atom cannot appear on the left of `.`").
   Reading `-> W` as belonging to `foo` and then mutating `foo`'s
   arity via the dot is too easy to misread; we reject it at the
   parser. (Aggregate on the *right* of a dot is fine — `player .
   score -> S` — because the dot only splices into the right atom's
   terms, leaving the weight alone.) Concretely: when a `dot` token
   is consumed, if the immediately-preceding `BodyItem` is an atom
   with `marker === "aggregate"` (or, equivalently, with a `weight`
   set), error. Tests pin both the rejection and the right-side OK
   case.

5. **Error messages.** `ParseError`s for dot-related errors should
   reference the dot's line, not the surrounding rule's start. The
   `dot` token carries `line`; mechanical.
