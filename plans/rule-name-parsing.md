# Rule name parsing

## Goal

Let users give each rule an explicit, source-level name via a new `:`
prefix line. Today rules are anonymous in the source; `parsePatterns`
auto-assigns `r1`, `r2`, … as a positional name that gets baked into
positive id atoms by `idExpand` (`parse.ts:360`, `expand.ts:5`). The
auto-generated names are awkward to refer to in diagnostics and shift
whenever a rule is added or reordered. With named rules, error messages,
trace output, and any future cross-rule references can use a stable
human-readable handle.

## Surface syntax

```
: rule-name
- foo
  + bar
```

- `:` is a new top-level prefix, peer of `-`, `+`, `?`, `<`, `,`, `!`,
  `#`, `=`.
- At most one `:` line per rule. Must be the first non-blank,
  non-comment line of the rule chunk (rules are already chunked by
  blank lines in `parsePatterns`, `parse.ts:334`).
- `: name` carries no children; an indented child line below `:` is a
  parse error (same shape as `Equal`/`Ask`).
- If absent, the rule keeps the existing auto-gen name (`r{N}`).

## Current shape

- `parsePatterns(input, ruleNamePrefix = "r")` splits `input` on blank
  lines, parses each chunk into a `Tree`, and calls
  `idExpand(expanded, \`${ruleNamePrefix}${ruleIndex++}\`)` for each
  non-empty chunk (`parse.ts:346-361`).
- `idExpand` writes the rule name into every positive id atom as the
  second symbol: `(id <name> id<N> …previousVars)` (`expand.ts:34`,
  `expand.ts:16`).
- `prefixToTag` (`parse.ts:168`) is the literal-prefix dispatcher;
  `LiteralTag` is its return type. There is no concept of "non-tree
  metadata line" at the parse layer today — every non-blank line
  becomes a `Tree` node.

## Target shape

- New literal prefix `:` recognised by the lexer, but it does **not**
  produce a `Tree` node — it is parser metadata, peeled off the chunk
  before `parse()` runs. `parsePatterns` threads the name into
  `idExpand` in place of the auto-generated rule name.
- Rules without `:` continue to use the auto-gen scheme. The default
  prefix moves from `"r"` to `"_r"` so that auto names live in the
  reserved `_`-prefix namespace and cannot collide with any
  user-writable name. Id-atom bodies are not semantically observable
  outside the engine, so the byte-level change is safe.
- The auto-counter is independent of explicit names — an
  explicitly-named rule does not consume a number from the auto
  sequence. Adding `: foo` to rule 5 doesn't shift the names of
  rules 6+.
- The `ruleNamePrefix: string` parameter on `parsePatterns` becomes
  `nameSegments: string[]`. Final rule names are formed by joining
  the caller's segments with the rule name (explicit or auto) using
  `#` as a separator: `["namespace"]` + `some-name` →
  `"namespace#some-name"`. User-explicit names must not contain `#`
  (parser rejects `:` lines whose name contains `#`). Multi-batch
  callers can therefore namespace freely (`["batch-a"]`,
  `["batch-b"]`) without worrying about user-side collisions.
- Before `idExpand` runs on any rule, `parsePatterns` validates that
  all explicit rule names are unique within the call. (User-vs-auto
  collisions are ruled out by the `_r` prefix; cross-batch
  collisions are ruled out by distinct segment lists.) Duplicate name
  → `ParseError` pointing at the `:` line of the second occurrence.

## Implementation steps

1. **Tokenise `:` lines.** In `_parseNodes` (`parse.ts:22`), add a
   branch *before* the `prefixToTag` dispatch that recognises `:` as
   the first character of `afterIndent`. Validate:
   - Indentation is 0 (rule names live at chunk top level).
   - This is the first node emitted for the chunk (`roots.length === 0
     && stack.length === 0`).
   - The remainder parses as exactly one symbol-shaped token (see
     §"Name lexical class" below).

   On success, stash the name on the chunk and `continue` — do not
   push a `Tree`.

2. **Plumb the name out of `_parseNodes`.** Either:
   - (a) Change `_parseNodes`'s return to
     `{ nodes: Tree[]; name?: string } | ParseError`, and update
     `parse()` (the single caller) accordingly, or
   - (b) Keep `_parseNodes` as-is and do the `:`-stripping in a
     pre-pass inside `parsePatterns` chunk processing, before calling
     `parse(text)`.

   Prefer (b): `parse()` is also the public entry point used by tests
   and tools that consume single-tree input. Pre-stripping in
   `parsePatterns` keeps `parse()`'s signature stable and confines the
   new metadata to the rule-batch layer where it belongs.

3. **Replace the prefix parameter.** Change
   `parsePatterns(input, ruleNamePrefix = "r")` to
   `parsePatterns(input, nameSegments: string[] = ["_r"])`. Build
   the final name passed to `idExpand` as
   `[...nameSegments, baseName].join("#")`, where `baseName` is the
   explicit `:` name if present, else the auto-gen counter
   (`String(ruleIndex)`). Increment `ruleIndex` only when no explicit
   name was given.

4. **Uniqueness check.** Build the list of explicit rule names
   (pre-join, post-`#`-rejection) in a first pass over the chunks.
   On duplicate, return a `ParseError` whose `line` points at the
   `:` line of the duplicate.

5. **Round-trip in `formatTree`.** Attach `ruleName?: string` to the
   synthetic chunk-root `Match` node that `parse()` already wraps
   (`parse.ts:13-19`); `formatTree` already special-cases that root
   (`parse.ts:383-390`), so emitting a leading `: ${ruleName}\n` for
   chunks that have one is a localised change.

## Name lexical class

Rule names are user-facing identifiers that get embedded as a `Symbol`
inside id atoms. To avoid surprises:

- Allow the same character set as `Symbol` tokens: anything the
  tokenizer (`parse.ts:201`) produces, minus reserved shapes.
- Reject names that:
  - Start with `_` (matches the `checkReservedTokens` rule,
    `parse.ts:207`). Auto-gen names `_r1`, `_r2`, … live in this
    reserved space, so the user can never write a name that collides
    with them.
  - Match `/^\d+$/` (collides with auto-id detection, `parse.ts:370`).
  - Contain `#` (reserved as the segment separator in
    `nameSegments` joining; see step 3).

## Tests

Add to `ts/src/tests/parse.test.ts`:

- `: foo` followed by a body produces a tree whose positive id atoms
  carry symbol `foo` in the rule-name slot.
- Two chunks with the same `:` name produce a `ParseError` on the
  second.
- `:` at non-top indent → error.
- `:` not as first line of chunk → error.
- `:` with a child line → error.
- `:` with zero or multiple tokens → error.
- A reserved-shape name (`_foo`, `42`, `foo#bar`) → error.
- Round-trip: `parsePatterns` then `formatTree` reproduces the `:`
  line.

## What this does not change

- The shape of id atoms themselves. The rule-name slot is already
  there (`expand.ts:34`); we are only changing what string fills it.
- The `Tree` constructor list (`Match`, `Assert`, etc.). `:` is parser
  metadata, not a node.
- Macro expansion or any post-parse pipeline stage. By the time
  `idExpand` runs, the name is just a string.

## Open questions / ambiguities

(none remaining)
