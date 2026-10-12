# Attribute namespaces from a lightweight type system

## Goal

A leading-colon head `:attr` names an attribute of the object in its first
slot, and the object's *type* supplies the namespace. With

```
#is-type foo hand card turn
```

in the file, writing

```
foo X, X.:score S            -- foo:score X S
foo.:hand.:card C            -- foo F, foo:hand F H, hand:card H C
~turn.^:actor me             -- turn T, ^turn:actor T me
```

is resolved by the parser into the ordinary `namespace:attr` relations that
the rest of the pipeline already understands. The rule is symmetric: a head
is a sequence of colon-separated *segments*, segment `i` goes with argument
`i`, and an empty segment is filled in from the type of its argument. So a
trailing-colon fragment resolves its attribute from the last argument, and a
head with several colons resolves each gap on its own:

```
card C, X.hand: C            -- hand:card X C        (attr from C's type)
foo.hand:.card:name N        -- foo F, hand:card F H, card:name H N
A.: B                        -- t:u A B, from A's and B's types
buy:: X Y Z                  -- buy:t:u X Y Z, from Y's and Z's types
```

Nothing after the parser changes. A fragment that cannot be resolved is a
parse error, so a mismatch between writer and reader can never hide behind
a relation with an empty segment.

Today a leading-colon head *is* a relation of its own (`:actor T P`), and the
tutorial describes it as "an attribute with no namespace". That reading goes
away: after this change every relation the engine sees is a head whose
segments are all non-empty. (The tokenizer already yields `foo:`, `:` and
`hand:` as single symbol tokens; checked.)

## Types

A type is a symbol declared with `#is-type` (below). Only declared symbols
are types; this is *strict*. Every variable in a rule gets a set of types
from the atoms it appears in: all the evidence below is collected, then
filtered to the declared types. Sets, not single types, because `card C,
item C` with both declared is a legitimate program and a variable may be
several things at once.

Strictness is what keeps ordinary predicates out of the way. In
`player P, active P, P.:hand H` the filter `active` is not a type, so
`P : {player}` and the fragment resolves to `player:hand`. Likewise
`card:owner C P, player P, P.:hand H`: the last-slot evidence `owner` is
dropped, `P : {player}`. And a rule whose only evidence is undeclared,
`active P, P.:hand H`, errors instead of silently reading `active:hand`.

### `#is-type`

```
#is-type player card hand turn
#is-type
  player card
  hand turn
```

A list of symbols, on the command line or in the indented block form shared
with `#type`/`#acc` (step 3b). File-scoped and position-free, like `#acc`.
Each name is a lower-case symbol with no `:` (a type is a namespace).
Declaring a name twice is harmless; a type need not name any relation.

### Where a variable's types come from

All evidence is collected per rule over the desugared, arity-saturated body,
descending into `Sub` bodies, `Exception` right-hand sides and `!(...)`
sub-atoms. Emits count as much as matches: `+card C` types `C`
as surely as `card C` does. Order within the rule does not matter. A symbol
of evidence that is not a declared type is dropped.

1. **Positional.** Split the head on `:` into segments `s0:s1:…:sn`. Its
   lexical arity is `n + 1` (this is what `saturateArity` already computes).
   For an atom *at* its lexical arity, each non-empty
   segment `si` types argument `i`. So `foo X` gives `X : foo` (the
   existence marker of the entity–attribute idiom), `inventory:gold In G`
   gives `In : inventory` and `G : gold`, `foo:hand F H` gives `H : hand`,
   and `a:b:c X Y Z` gives all three.
   An empty segment types nothing; it is what is being resolved.
   The last-slot case is what makes `foo.:hand.:card` work: the fresh var
   after `:hand` is a `hand`, provided `hand` is declared. It is a naming
   convention — the attribute name doubles as the type of its value — and
   with strict types it only applies where the attribute is named after a
   declared type.
   An atom *not* at its lexical arity types nothing positionally: `move It To`
   says nothing about `It`, and `#acc` relations with extra columns are
   covered by their declaration.
   A `not` atom reads an `#acc` relation, so it types only through rule 2.
   That is sound: `not fallen Q` with `#acc fallen / pin` says `Q` is a pin
   that has not fallen, not that it is no pin.
2. **Declarations.** `#acc at / e (@last location)` types the arguments
   of every `at It To` atom by column: a key column types its argument, a
   parenthesized `(@op T)` column types its argument `T`, and a bare `@op`
   column (`@sum`, `@count`) types nothing; an `(@arg-min T)` argument is a
   `pair …` term, not a variable, so nothing either. The new `#type`
   command (below) does the same for any other relation. A declared
   relation gets its types from the declaration only; rule 1 is switched
   off for it at every argument count, so a declaration can also *remove*
   a type the convention would have given.
   Column symbols in `#acc` and `#type` need not be declared with
   `#is-type`. They stay documentation and are dropped like any other
   undeclared evidence: `#acc at / e (@last location)` with only `location`
   declared types `To` but not `It`.
3. **`=` and `is`.** `X = Y` between two variables, and `is P X` (a choice
   term and its value), union their type sets (a union-find over the rule's
   variables). `?P, !card P, is P C, C.:cost N` gives `C : {card}`.
   `X = (f Y)` and other compound equalities contribute nothing.

Dot-fresh variables are not special. After `desugarBody` the fresh var of
`foo.` sits in the last slot of `foo _dot1`, so rule 1 types it like any
other variable. Consequently `foo X.:bar` does *not* resolve: `foo X F` is
over its lexical arity and nothing says what `F` is. Write `foo X F, F.:bar`
with a typed `F`, or name the relation `x:foo`.

### `#type` declarations

```
#type card:owner / card player      -- card:owner C P  gives  C : card, P : player
#type hits / _ pin                  -- `_` leaves a column untyped
#type at / e location               -- more columns than the lexical arity is fine
```

Same shape as `#acc name / col…` without the `@` column: the relation name,
a standalone `/`, then one symbol or `_` per argument. Column symbols are plain symbols; they
need not be declared types (rule 2), and they need not name a relation.
Several declarations can share one command by indenting them under a bare
`#type`:

```
#type
  card:owner / card player
  hits       / _ pin
  at         / e location
```

**The separator becomes `/`, for `#acc` too.** (User decision, after
Prolog's `name/arity` declarations.) Today `#acc at : e @last` puts a
standalone `:` between the name and the columns; next to `#type
card:owner : card player` that colon reads like part of the colon-segmented
names this plan is about. Both commands become `name / col…`, and both take
the block form. The `/` must be standalone (whitespace on both sides), the
same rule `isStandaloneSlash` applies to the acc-rule separator: `/` is a
legal character inside a symbol (`do/rest`), so a glued `at/e` is one token,
read as the relation name `at/e` with the separator missing, and errors
(`'#acc at/e' needs ' / ' between the name and the columns`). Command
lines never reach the rule tokenizer (`argText` is split on whitespace), so
the standalone `/` cannot be mistaken for an acc-rule `/`. A standalone `:`
where the `/` belongs is an error pointing at the new syntax (`'#acc' now
separates name and columns with '/': '#acc at / e @last'`), so old files
fail loudly rather than reading `:` as a column type. The declaration applies to atoms whose
argument count equals the column count (it does not change `saturateArity`,
which still pads to the lexical arity). Rules:

- A relation is declared at most once, by `#type` or `#acc`, not both
  (`#acc` already carries column types). `#js-def` relations may carry a
  `#type`.
- The head must be a full name, no empty segments.
- Declaration order is free: `#type` may follow its users, as `#acc` may.

This is the escape hatch for the naming convention, now needed less often:
strictness already drops `owner`, so `card:owner C P, player P, P.:hand H`
works without it. It is for rules where nothing else names the type:
`#type card:owner / card player` lets `card:owner C P, P.:hand H` resolve to
`player:hand` with no `player P` match. It is also the way to give a
variable a type that no relation in the rule implies, e.g. a `#type` on an
`is`-like relation of one's own.

Nothing is inferred from `@js` calls or across rules.

### Resolving a fragment

A *fragment* is an atom whose head has at least one empty segment: `:attr`,
`ns:`, `:`, `a::c`, `::c`, and so on. For each fragment:

- The atom must be at its lexical arity (saturation guarantees this for
  under-arity heads; an over-arity fragment is an error).
- For each empty segment `i`, argument `i` must be a variable with a
  non-empty type set, otherwise: error
  `':actor' needs a typed variable in slot 1` (wolf-sheep.t:48
  `turn, :actor _ wolf` becomes `turn.:actor wolf`) or
  `'X' has no declared type in this rule; cannot fill ':attr'`. When `X`
  had undeclared evidence, the message names it as a hint (`(seen: active;
  declare with #is-type?)`).
- Each gap's variable must have exactly one type. Several: error listing
  them, `'C.:cost' is ambiguous: C is a card and an item — write card:cost
  or item:cost`. Splice the types into the head.

The leading-colon case `X.:attr` and the trailing-colon case `X.attr: C` are
the same procedure with the gap at index 0 or index 1.

Resolution depends on nothing outside the rule except the file's `#is-type`,
`#acc` and `#type` declarations. In particular it never looks at which
relations other rules happen to use: adding or removing a rule elsewhere
cannot change what a fragment means or whether it parses. Filling a gap
adds no type evidence — types come from non-empty segments only — so each
rule is one typing pass followed by one resolution pass, in any order.

This is the whole type system: a declared set of type symbols, sets of
them per variable, unions, and a lookup. There is no subtyping, no
unification of compound terms. It is deliberately not a checker — a
variable of type `{card, item}` is fine until a fragment needs to know
which.

## Acc-rule separator: `->`

With `/` now separating a declaration's name from its columns, acc rules
stop using it. (User decision.) `body / head` becomes `body -> head`:

```
#acc spirit:land / spirit land
spirit:presence S P, at P L
  -> spirit:land S L

#acc distance / location location @min
edge A B -> distance A B 1
```

- **Standalone only**, by the rule `isStandaloneSlash` applies today
  (`parse.ts:396`): whitespace or a line boundary on both sides. `-` is a
  marker character, so this keeps the tokenizer's decision local: a
  standalone `->` becomes the separator token (today's `slash` token,
  renamed `arrow`), checked before marker parsing; anything glued stays
  atom text.
- **`->` is free.** It was the `-> weight` syntax, removed in 51ab3b1; the
  only uses left are the `findTopArrow` checks (`parse.ts:953, 1379, 1417,
  1484, 1528`) that reject it inside atom text. They stay, for a `->`
  inside parentheses, a `!(...)` or an exception, with a new message:
  `'->' separates an acc rule's body from its head; it is not allowed
  here`. `REMOVED_AGG` (`parse.ts:433`) still spells the old syntax
  (`#acc rel : col… @op`, `body / rel …`); update it to `/` and `->`.
- **The old `/` errors.** A standalone `/` in rule position is still
  tokenized, only to report `acc rules now separate body and head with
  '->'`. The existing errors (`an acc rule has exactly one '/'`, `'/' is
  not allowed in an exception block`, `… inside a sub-rule`, `… exactly
  one atom after '/'`) are reworded for `->`. `slashLine` becomes
  `arrowLine`.
- **No clash with `=>`** (exception blocks) or `>p` (continue after): the
  acc head is exactly one plain atom, so `-> >p` is already rejected as a
  marked head.
- `renderAccRule` (`print-ir.ts:161`) prints `  -> head`. `rename.ts`
  already skips `->` as a non-identifier.

## `#set-option`

A general switchboard, with one switch for now:

```
#set-option elaborator.fragment-expand false
```

`#set-option <name> <value>`: the name is a dotted symbol, the value is
`true` or `false` for a boolean option. `elaborator.fragment-expand`
defaults to `true`. When `false`, neither `collectTypes` nor
`resolveFragments` runs on the file: a head with an empty segment is a
relation of its own, exactly as today (`:actor T P` reads `:actor`), so an
existing program can opt out with one line while it is migrated. `#type`
and `#is-type` declarations still parse and are validated (duplicate,
`#acc` clash, fragment head, colon in a type name) but have no effect
under `false`.

Scope and ordering follow every other declaration-like command:

- **File-scoped and position-free.** The option applies to the whole file
  regardless of where the line sits; a `#set-option` after the rules it
  affects is fine, as `#acc` may follow its users. There is no
  lexical scoping and no `set-option … in` form — a rule cannot be half-way
  through a switch.
- **At most once per option.** A second `#set-option` for the same name is
  an error (`duplicate '#set-option elaborator.fragment-expand'`), like a
  duplicate `#acc`. Position-free means "last wins" has no natural reading,
  and two settings in one file are a mistake either way.
- **Unknown option, missing or non-boolean value** are errors at the command
  line: `unknown option 'elaborator.fragment-expnad'`,
  `'#set-option elaborator.fragment-expand' takes true or false`.
- `#exit` still truncates: a `#set-option` after `#exit` is dropped with
  everything else after it, as the loop breaks there today.

Options live on `Program.options: ProgramOptions` (`{ fragmentExpand:
boolean }`, defaulted), so `renderProgram` can round-trip a non-default
setting and future options have a home. Nothing downstream reads it yet.

## Syntax

No new rule syntax. `.:attr` is existing dot sugar into a leading-colon
head, and `:attr X …` written directly resolves the same way. The forms
that work because of the recent dot changes (plans/v2-dot-notation.md
addendum):

```
X.:score S                   -- lone variable on the left
foo.:hand.:card C            -- chain through fresh vars
card C, X.hand: C            -- trailing colon: attr from the last slot
turn .(:actor P) .(:fuel F)  -- sibling subs share the fresh var
~turn .(^:actor me)          -- any marker on the right
```

`In:gold G` (a variable in the namespace slot) is not adopted; it tokenizes
as one token today and stays unused.

## Decisions

1. **An unresolved fragment is an error, never a relation with an empty segment.**
   The alternative — leave `:attr` as its own relation when the
   variable is untyped — means `~turn.^:actor me` writes `turn:actor` while
   `(:actor T P)` somewhere else reads `:actor`, and the reader silently
   sees nothing. The corpus has one such site (dessert.t:40) and it is a
   bug under the new reading anyway.
2. **Positional typing only, no special case for dot-fresh vars.**
   It keeps one rule and matches the user's examples.
3. **Multi-typed variables are allowed; a fragment on one is an error.**
   No heuristic: not "first type wins" (match order should not pick a
   relation) and not "whichever relation exists elsewhere" (a rule's meaning
   should not depend on other rules). The author spells the namespace.
4. **`#type` declarations are part of this plan.** They are the escape
   hatch when nothing in a rule names a variable's type, and they let a
   declaration replace positional typing for a relation entirely.
   Parser-only, like everything else here; nothing downstream sees them.
5. **`#set-option` is file-scoped, not positional.** The only
   position-sensitive commands today are `#def` (attaches to the next rule)
   and `#exit` (drops the rest of the file); `#js-def` clause order matters
   only relative to other clauses of the same name. Every other command
   collects into a map and is consulted after the loop. A file-wide switch
   belongs with the latter group; a positional one would be the first
   command whose meaning depends on the surrounding rules.
6. **Types are declared, strictly (`#is-type`).** (User decision.) Without
   it, every unary filter (`active P`, `selected C`) and every attribute
   name in a last slot is a type, so fragments on filtered variables are
   ambiguous and fragments whose only evidence is a filter silently pick
   the filter's namespace. A tie-breaker variant (consult declarations only
   on ambiguity) was rejected: it keeps the silent `active:hand` case.
   Cost: one `#is-type` line per program.
7. **`#acc`/`#type` column symbols are not implicitly types.** (User
   decision.) They may name undeclared symbols, which remain documentation;
   only `#is-type` makes a type, so there is one source of truth.
8. **`is P X` unions types like `=`.** (User decision.) Otherwise the
   standard choice-unwrapping idiom leaves the value untyped.

9. **Acc rules use `->`, declarations use `/`.** (User decision.) `/`
   reads as Prolog's `name/arity` in a declaration; an acc rule is a
   derivation, and `->` is the arrow for it. Both are standalone tokens, so
   `do/rest` and glued `->` keep their meaning as atom text.

## Steps

1. **Collector** — new `ts/src/v2/attr-types.ts` (DOM-free, parser-side):
   `collectTypes(body: RuleAtom[], decls): Map<string, Set<string>>`
   implementing rules 1–3 and the `#is-type` filter, walking every nesting
   that `saturateArity` walks (`parse.ts:1281`). `decls` bundles
   `accDecls`, `typeDecls` and the declared type set. Keep the undeclared
   evidence per variable too, for the error hint. Export
   `headSegments(name): string[]` (split on `:`; empty strings are gaps)
   for reuse; lexical arity is its length.
2. **Resolver** — same file: `resolveFragments(body, types): ParseError | null`.
   Rewrites `atom.terms[0]` in place; errors carry the atom's `span.line`.
   Acc rules (`AccRule.body` / `head`) are included.
3. **Wire it in** — run the two passes over `Program.rules` and `accRules`
   after the parse loop, since `#acc`, `#type` and `#is-type` may follow
   their users. They must run before the `#acc` checks and
   `validateAccRule` (`parse.ts:673–685`), which look up head names.
   `resolveRuleNames` does not read heads and may stay where it is.
3a. **`#is-type` command** — `parseCommand` gains `is-type`: whitespace-
   separated symbols, block form as in 3b. Each must pass `isSymToken` and
   contain no `:`; otherwise `'#is-type' names must be symbols without ':'
   (got 'card:owner')`. Collect into a parser-local `Set<string>`; repeats
   are fine. An `#is-type` with no names is an error.
3b. **`#type` command** — `parseCommand` (`parse.ts:437`) gains `type`,
   reusing `parseAccDeclText`'s column reader with `@` rejected and `_`
   allowed; result `TypeDecl {relation, columns: (string | null)[], span}`
   in a parser-local `typeDecls: Map<string, TypeDecl>`. Errors: duplicate
   declaration, name also declared `#acc`, fragment head, non-symbol column.
   Column symbols are not checked against `#is-type`.
   Whether to expose `typeDecls` and the type set on `Program` is left to
   the implementer; nothing needs them yet.
   *Block form.* The generic command branch (`parse.ts:331`) consumes one
   line. Give `#type`, `#acc` and `#is-type` the continuation rule `#js`
   already has for its indented body (`parse.ts:277`), minus the closing
   `}`: after the command line, collect
   comment-stripped lines that are indented or blank until the first
   column-0 line; no closing brace. The command token grows a
   `decls: {text, line}[]` (the command line's own text first, if
   non-empty) so each declaration reports its own line. Today an indented
   line after a command is silently parsed as a new column-0 rule (checked:
   `#acc at : e` today, followed by an indented `foo X`, yields a rule), so
   claiming those lines loses nothing; a rule indented under a command was
   never intended.
   *`/` separator.* `parseAccDeclText` (`parse.ts:1322`) requires a
   standalone `/` where it now requires `:` (`tokens[1] === "/"`), with the
   two errors above for `:` and for a relation token containing `/` followed
   by no separator. The `#type` reader shares it. `renderProgram`
   (`print-ir.ts:163`) emits `#acc name : cols` today; emit
   `#acc name / cols` there too, or round-tripped programs stop parsing.
   The migration is mechanical: `s/^(\s*#acc \S+) : /\1 \/ /` (and the
   same inside test strings).
   Migrate the 55 `#acc` declarations in `ts/data/v2/*.t` (si-game 38,
   acc-demo 7, verse-inventory 4, spirit-island 3, foo 3) and the ones in
   `v2_acc`, `v2_acc_view`, `v2_after`, `v2_builtins`, `v2_rename`,
   `v2_timeline_layout` tests, plus the tutorial's "Acc relations" section
   and the `#acc` line in `ts/src/v2/overview.md`'s parse section. Check
   `ts/data/pres/*.pres` for `#acc` and report rather than edit.
3c. **`#set-option` command** — `parseCommand` gains `set-option`: split
   `argText` on whitespace into exactly `name value` (the generic branch at
   `parse.ts:331` keeps the rest of the line as raw text, so the dot in
   `elaborator.fragment-expand` never meets the tokenizer). A table
   `OPTIONS: Record<string, { kind: "bool"; key: keyof ProgramOptions }>`
   maps the name; the loop records into a parser-local `options` with a
   `seen` set for the duplicate error. Add `ProgramOptions` to `types.ts`,
   `options` to `Program` (and to the empty-program constructor in
   `expand.ts:63`), and gate the step-3 passes on
   `options.fragmentExpand`. `renderProgram` (print-ir.ts) emits
   `#set-option` lines for non-default values before the declarations.
   `rename.ts` treats a `#set-option` line like `#def`: its words are not
   relation names (today its regex scan would offer to rename an
   `elaborator` relation there). `#is-type` names *are* offered for rename
   as symbols, so renaming `turn` also renames its `#is-type` entry.
3d. **`->` for acc rules** — in the tokenizer (`parse.ts:132`) a
   standalone `->` yields the separator token in place of the standalone
   `/`, which now yields the migration error; rename `slash` → `arrow`
   through `parseProgram` and `buildAccRule`, reword the errors listed in
   *Acc-rule separator*, update `findTopArrow`'s callers' messages and
   `REMOVED_AGG`, and `renderAccRule`. Migrate every acc rule: the corpus
   (`ts/data/v2/*.t`, si-game.t holding most), the tests (`v2_acc` most),
   the tutorial ("Aggregates and negation", "Acc relations") and
   `ts/src/v2/overview.md`. Do it with a throwaway script rather than sed:
   `#js` bodies and comments contain `/`. The script rewrites a standalone
   `/` only outside comments and `#js`/`#js-def` bodies, then checks each
   `.t` file by parsing it before (old parser, at HEAD) and after (new
   parser) and comparing `renderProgram` output, which is identical once
   the separator is normalized. Test strings are migrated by hand and
   checked by the suite. Report `ts/data/pres/*.pres` acc rules rather
   than edit.
4. **Arity** — `saturateArity` pads `:attr X` to `:attr X _` before
   resolution; filling a segment never changes the colon count, so nothing
   needs re-saturating. A gap filled from a padded wildcard is an error
   (`foo: X` → `foo: X _` → slot 1 is not a variable). Add assertions in a
   test.
5. **Corpus** — add an `#is-type` line to every `ts/data/v2/*.t` that uses
   a fragment, run every file, and fix what errors:
   - `wolf-sheep.t:48,54`: `turn, :actor _ wolf` → `turn.:actor wolf`.
   - `dessert.t`: `summon, :it I, :type minion` (line 40) has untyped `I`;
     and the attribute names do not match the types they hold
     (`attack:creature A C, :ap C AP` types `C : creature`, while
     `summon:it` would type the same kind of object `it`). Rename the
     summon attribute to `:creature` so both paths give `creature:ap`, and
     write `summon.:creature I`.
   - `demo.t:33`: `( ~activate, ^:card Card)` writes `:card Card _`, the
     card in slot 0, while its reader `activate.:card.card:name call`
     (line 110) expects the episode there; and `Card` is only typed via
     `is X Card`. Rewrite as `~activate.^:card Card` (the user agreed
     demo.t may be rewritten freely).
   - `colors.t`, `hex.t`, `spirit-island.t` need only their `#is-type`
     line (`turn:actor`, `turn:fuel`, `activate:card`, `strike:target`,
     `target-power:source`, `gather:to`, `gather:it`, `draw:card`, …) —
     verify by comparing first surfaced choices against HEAD, as done for
     the components-by-moment migration.
   - `ts/data/pres/defense.pres` has two `:attr` sites; report, do not edit
     (the user's deck).
   - Test programs in `ts/src/tests/*.test.ts` that use `:attr` heads
     (grep `[ .(^~+?!]:[a-z]`).
6. **Docs** — tutorial §"Data modeling": replace the "attribute with no
   namespace" paragraph with `#is-type`, the typing rules and the three
   forms above, and a short "Options" note for `#set-option` next to the
   other commands; `ts/src/v2/overview.md`: new `# attr-types.ts` section
   (the overview test requires one per file), a line in the parse section,
   and `#is-type`/`#set-option` in the commands list with the file-scoped
   rule; this plan's "As implemented" section; `notes/overview.md` entry.

## Tests

`ts/src/tests/v2_attr_types.test.ts`, parse-level, checking the resolved
head text:

- each evidence rule alone: unary match, unary emit, colon-head first slot,
  colon-head last slot, a `not` atom typing only by its `#acc` columns, a
  three-segment head typing all three arguments, `#acc` key column,
  `(@last T)` column, bare `@sum` column typing nothing, `=` between
  variables, `is P X`, an `=` chain `X = Y, Y = Z`; an over-arity atom
  types nothing;
- strictness: `player P, active P, P.:hand H` with `#is-type player hand`
  → `player:hand`; `active P, P.:hand H` errors and the message mentions
  `active`; `card:owner C P, player P, P.:hand H` → `player:hand` without
  any `#type`; a file with no `#is-type` errors on every fragment;
- `#acc at / e (@last location)` with `#is-type location` but not `e`:
  the declaration parses, `To` is typed, `It` is not;
- `#is-type`: block form; repeats are fine; `card:owner` as a name errors;
  an empty `#is-type` errors; placed after its users still applies;
- order independence (`X.:score S, foo X` and the reverse);
- the chain `foo.:hand.:card C` → `foo:hand`, `hand:card`;
- trailing colon `card C, X.hand: C` → `hand:card`; the chain
  `foo.hand:.card:name N` → `hand:card` filled from the *next* atom's typing;
- both gaps `x A, card C, A.: C` → `x:card`; multi-colon `buy:: X Y Z` with
  `Y`, `Z` typed → `buy:t:u`; a head with one gap of three `a::c`;
- a fragment whose gap slot is a padded wildcard errors;
- sibling subs `turn .(:actor P) .(:fuel F)` and markers `~turn .(^:actor me)`;
- lone variable `foo X, X.:score S`;
- `foo X.:bar` is an error (binary no-colon head types nothing);
- ambiguity: `card C, item C, C.:cost X` with both declared errors, naming
  both types, and still errors when `card:cost` is used by another rule (no
  dependence on other rules);
- non-variable first slot errors; untyped variable errors; line numbers;
- an acc rule body using `.:attr`; an acc rule whose head is a fragment
  passes `validateAccRule` under its resolved name;
- `#type` block form: three declarations under one `#type`, with a comment
  and a blank line inside the block; an error on the third line reports the
  third line; the same block form for `#acc`; in either command a
  standalone `:` instead of `/`, a missing separator, and a glued `at/e`
  are errors;
- `#type`: a declaration overrides the convention (`#type card:owner /
  card player`, then `card:owner C P, P.:hand H` → `player:hand`); `_` columns;
  a declaration with more columns than the lexical arity applies only at
  that argument count, and switches rule 1 off at the lexical arity too;
  `#type` after its users in the file; duplicate `#type`, `#type` on an
  `#acc` relation, and a fragment head all error;
- acc-rule `->`: one-line and continuation-line (`  -> head`) forms parse
  to the same `AccRule`; a standalone `/` in a rule errors with the
  migration hint; two `->` error; `->` inside a sub-rule, an exception
  block and `( … )` error; `do/rest` and `a->b` stay atom text (the
  latter hits the `findTopArrow` error); `renderAccRule` round-trips;
- arity: `:attr X` → `t:attr X _`.
- `#set-option elaborator.fragment-expand false`: `turn T, :actor T P` keeps
  the head `:actor` and `turn.:actor P` desugars to `turn T, :actor T P`;
  the option placed *after* the rules still applies; `true` is the same as
  omitting it; a `#type` or `#is-type` under `false` parses but changes
  nothing; duplicate option, unknown option, missing value, and a value
  other than `true`/`false` are errors at the command's line;
  `renderProgram` emits the line for `false` and nothing for the default.

End-to-end: `v2_choice`/`v2_ttt`-style runs of colors, hex, wolf-sheep after
migration produce the same first choice as HEAD. The existing `v2_parse`
dot tests must keep passing (none uses a leading-colon head with an untyped
left side — verify).

## Risks

- **Forgotten declarations.** A program that uses fragments without listing
  its types gets an error at every fragment. Loud and local, and the hint
  names the undeclared evidence, so the fix is one word on the `#is-type`
  line.
- **Convention leakage, now opt-in.** The last-slot typing still means an
  attribute named after a declared type types its value: if `card` is
  declared, `hand:card H C` makes `C` a card. Programs that store different
  kinds of object under an attribute named after one type get surprising
  namespaces or ambiguities; `#type` on that relation is the remedy.
- **Silent meaning change for fragment readers written without a dot.**
  `(:actor T P)` with `T` typed resolves correctly; with `T` untyped it is
  now an error rather than a match on `:actor`. Errors are the intended
  outcome (Decision 1), and the corpus sweep in step 5 finds them all.
- **Rename splits relations.** `rename.ts` is lexical and whole-token.
  Renaming `turn` renames `turn T` and the `#is-type` entry, so `.:actor`
  then resolves to `round:actor`, but explicit `turn:actor` tokens are a
  different identifier and keep their name. Renaming `turn:actor` misses
  `.:actor` sites. This is a known limitation, not fixed here; the pieces
  that disagree afterwards are usually caught by an ambiguity or a reader
  that sees nothing.
- **Saved `^ is` rows** are unaffected: choice term identities embed rule
  names, lexical positions and endpoint chains, not relation names.
  Regenerate anyway if a migrated program's rules were reordered.
- **Implementation caveat.** Only `atom.terms[0]` is a head. The `:P`-style
  symbols that `variableToSymbol` puts inside id templates (read by
  `web-v2.ts:391`), and any colon-bearing user
  data, are terms and are never touched; `*`-heads are skipped.
- **Performance** is a non-issue: one pass over each rule body plus a
  union-find over its variables.

Claude Fable 5.1 (claude-fable-5-1); revised after review (strict
`#is-type`, `is` unions, pass ordering, `#acc` columns, demo.t, `/` and
`->` separators, removal of the stale weight/`#agg` references) by Claude
Opus 5.5 (claude-opus-5-5).
