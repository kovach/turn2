# v2 rule names and `#` commands

## Goal

Introduce a general `#<command> ...` line syntax for top-level
directives, with two commands to start:

- `#def <name>` — name the rule that follows.
- `#acc <relation> -> <aggregator>` — schema declaration (replaces the
  current `% ...` syntax).

Also: rule auto-naming (`r1`, `r2`, …) becomes a post-parse pass over
unnamed rules, and duplicate explicit names produce a parse error.

## Surface syntax

```
#acc fills -> count

#def activate
- foo
  + bar
```

- A `#`-prefixed line at column 0 is a *command*. The first
  whitespace-delimited token after `#` is the command name; the rest
  of the line is the command's argument text.
- Unknown command name → `ParseError` (`"unknown command '#xyz'"`).
- `#def <name>`: name the next rule. Must be the first non-blank,
  non-comment line of a rule chunk. Anything after `<name>` on that
  line is a parse error. `<name>` is a single token (same lexical class
  as a `Symbol`: not upper-case, not `_`-prefixed, no
  `(`/`)`/`,`/`.`/whitespace). A name matching `/^r\d+$/` is rejected
  so it cannot collide with the auto-naming scheme. The `#def` line
  itself contributes no `RuleAtom`.
- `#acc <relation> -> <aggregator>`: schema declaration; replaces the
  legacy `% ...` syntax. Argument text is parsed by the existing
  schema-text logic. Like the old `%`, it is a top-level statement
  (not inside a rule body) and is not legal inside a sub-block.

## Command ADT

Introduce a small ADT representing a parsed command, kept private to
`parse.ts` (it is consumed and discarded inside `parseProgram` — it
does not show up in `Program`):

```ts
type Command =
  | { kind: "def"; name: string; line: number }
  | { kind: "acc"; decl: SchemaDecl };
```

Adding a future `#foo` command is then a new variant + a new dispatch
arm in the tokenizer/parser.

## AST change

`Rule` gains an optional explicit-name slot, kept distinct from the
final resolved name so the auto-pass has something to fill in:

```ts
export interface Rule {
  name: string;           // resolved name (filled in by name-resolution pass)
  explicitName?: string;  // set iff source had `#def <name>`
  body: RuleAtom[];
  span: Span;
  ...
}
```

During `parseProgram`, rules are pushed with `name: ""` and
`explicitName` set when present. The name-resolution pass (below) fills
`name` for every rule before `parse()` returns.

## Tokenizer change (`parse.ts`)

Replace the existing `{ tag: "schema"; text; line }` branch (which
fires on a leading `%`) with a single `{ tag: "command"; name: string;
argText: string; line }` branch that fires on a leading `#` at the
start of an atom position (column 0 of a rule-start line, same place
`%` is recognised today).

- Lex: when `atomStart && ch === "#"`, take everything after `#` on
  the line, split off the first whitespace-delimited word as `name`,
  and the remainder (trimmed) as `argText`. Emit one `command` token
  and advance `pos` to end-of-line.
- Drop the old `schema` token entirely.

Note: the `blankPending`/`ruleEnd` machinery is unchanged — a `command`
token simply sits at the boundary between rules (for `#acc`) or as the
first token of a rule (for `#def`).

## Parser change (`parseProgram`)

The top-of-loop dispatch on `command` tokens parses one `Command`
value:

- `name === "def"`: parse `argText` as exactly one symbol token; reject
  empty / multi-token / wrong-shape / `/^r\d+$/`. The next non-`ruleEnd`
  content begins a rule, and that rule receives `explicitName`. If the
  immediate next thing is another `command` or end-of-input, error
  (`"'#def' must precede a rule"`).
- `name === "acc"`: parse `argText` with the existing
  `parseSchemaText`; insert into `schema` exactly as today (including
  the duplicate-relation check). Must appear at top level (not inside
  a body) — same constraint that the old `%` had.
- Unknown name: `ParseError`.

A `#def` token appearing mid-rule (i.e. after any body token of the
current rule) is a parse error: `"'#def' must be the first line of a
rule"`.

The `Rule` push site becomes:

```ts
rules.push({ name: "", explicitName, body: desugared, span: { line: startLine } });
```

## Name resolution pass

After `parseProgram` finishes (still inside `parse`), before returning
the `Program`:

1. Walk `rules` once and collect every `explicitName` into a `Map<name,
   line>`. On duplicate, return `ParseError { line: secondLine,
   message: "duplicate rule name '<name>'" }`.
2. Walk `rules` again with a counter `n = 1`. For each rule:
   - If `explicitName` is set, `rule.name = explicitName`.
   - Else, pick the next `r${n++}` that is not in the explicit-name
     set (the `/^r\d+$/` rejection at parse time already prevents
     collisions, so this is just `r${n++}`).

This keeps the auto-counter independent of explicit names: adding `#def
foo` to a rule does not shift the `rN` of other rules — they keep their
positional index. (If we instead wanted "skip consumed numbers", the
reserved-`r\d+` rule already makes it safe; positional is simpler and
matches the old behavior for unnamed rules.)

## Tests (`ts/src/tests/v2-parse.test.ts` or equivalent)

- `#def foo\n- a` → rule named `foo`.
- Two rules, both `#def foo` → parse error on the second.
- `#def foo bar` (two tokens) → error.
- `#def _foo`, `#def Foo`, `#def r3`, `#def 42` → error.
- `#def foo` not at first line of rule → error.
- A mix of named + unnamed rules: unnamed rules retain `r1`, `r2`, …
  by source position regardless of named rules interleaved.
- Round-trip via the v2 printer reproduces the `#def` line (if the
  printer emits rule names today — confirm in `print.ts` and add an
  emission line if not).
- `#acc rel -> count` parses identically to the old `% rel -> count`
  (port any existing `%`-based schema tests to `#acc`).
- `#xyz ...` (unknown command) → parse error.
- All `.t` fixtures under `ts/data/v2/` that use `% ...` are updated
  to `#acc ...` in the same change. `%` is no longer recognised.

## What this does not change

- `RuleAtom`, body desugaring, hashconsing, or any downstream stage.
- The shape of generated id terms in `expand.ts` — `rule.name` is still
  a plain string by the time `expand` sees it.
