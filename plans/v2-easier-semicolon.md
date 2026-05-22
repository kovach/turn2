# Easier semicolon syntax

## Goal

Let users write a bare `;` in a rule body to implicitly wrap the
left-hand content (on the current line, within the current paren
frame) into a sequence sub. Today the only way to introduce a
sequence sub is the explicit `(... );` form.

The desugaring is left-associative and line-local:

```
foo
  bar; baz; quux
```
desugars to
```
foo
  ((bar); baz); quux
```

Two `;` on one line wrap left-to-right: the second `;` re-wraps the
sub produced by the first.

Across lines, `;` only wraps content emitted on the current line in
the current frame. Items already on the frame from earlier lines stay
outside the wrap. Inside an explicit `(...)` opened on a different
line, the inner frame's `wrapStart` still resets line-by-line per the
same rule.

## Files touched

Only `ts/src/v2/parse.ts`. No IR / evaluator changes — the existing
`Sub` body item with `sequence: true` is exactly what we produce.

## Implementation

### 1. Tokenizer

Add a new token tag:

```ts
| { tag: "semi"; line: number }
```

In `tokenize` (ts/src/v2/parse.ts:78), recognize `;` as a top-level
separator alongside `,`. Two cases share the source character:

- `);` — the existing path at parse.ts:88 already consumes `;` as
  part of the `close`. Leave that untouched.
- bare `;` (not directly after `)`): emit `{ tag: "semi", line }` and
  advance one char, with `atomStart = true`.

The atom-content scanner at parse.ts:142 currently breaks on `,`,
`)`, `.`. Add `;` to that set so a glued `foo;bar` splits cleanly.

### 2. Parser

In `parseProgram` (parse.ts:209), per-frame state extends from just
the body-items array to a small object so we can carry `wrapStart`.
Replace `stack: BodyItem[][]` with something like:

```ts
type Frame = { items: BodyItem[]; wrapStart: number; lastLine: number };
const stack: Frame[] = [{ items: body, wrapStart: 0, lastLine: startLine }];
```

Helper to access the current frame's items list (same shape used by
every existing push).

#### Line-change reset

Before pushing any non-`ruleEnd` token, compare `tok.line` against
the top frame's `lastLine`. If different, set
`top.wrapStart = top.items.length` and update `lastLine`. This
realises "local to the line": a `;` only wraps content emitted since
the last line break in this frame.

#### Sub open / close

- `open`: push a new frame `{ items: inner, wrapStart: 0, lastLine: tok.line }`.
- `close`: pop the frame; do not adjust the outer frame's
  `wrapStart`. The closed sub is appended to the outer frame's items
  as a single new item; if the next token is on a new line the
  line-change reset above will jump `wrapStart` past it.

#### Semi handling

On a `semi` token in `parseProgram`:

- If `depth == 0` and `body.length == 0` and `top.wrapStart == 0` →
  error: `"';' before any content"`.
- If the top frame has a pending dot (last item is a `dot` BodyItem
  with no following atom) → error: `"';' after '.' is not allowed"`.
  (Mirror the message style used for trailing `.`.)
- If `top.items.length === top.wrapStart` → error:
  `"';' with no content on this line"`. (Covers `;;`, `a; ;`, and
  `; b` at line start.)
- Otherwise: splice
  `wrapped = top.items.splice(top.wrapStart, top.items.length - top.wrapStart)`
  and push a single Sub item:
  ```ts
  top.items.push({
    kind: "sub",
    inner: wrapped,
    sequence: true,
    span: { line: tok.line },
  });
  ```
  Leave `top.wrapStart` unchanged: subsequent items on the same line
  follow the wrap, and the next `;` will rewrap everything from
  `wrapStart` (i.e. the wrap-sub plus what came after).

`openSubs` is only used to patch span/sequence at the matching close
paren. Synthetic `;` subs are fully built at creation time, so they
do not enter `openSubs`.

### 3. Desugar pass

`desugarBody` (parse.ts:421) handles `kind: "sub"` uniformly already.
A synthetic semi-sub is structurally identical to an explicit
`(... );` sub, so no change is needed.

One gotcha: the `incomingPending` dot path. A `.` immediately before
a `;` should already be rejected by the "pending dot" check above.
A `.` immediately after a `;` is a dot whose left-of is the
synthetic sub — and `desugarBody` already requires the right of `.`
to be a plain atom, so `foo;.bar` works the same as `(foo;).bar`
does today (which is allowed). Spot-check the existing test
`spirit-island.t` — none of its lines start with `.` after a `);`,
so this path is not exercised today; the change does not regress it.

## Tests

Add a new module under `ts/test/v2/` (model on existing
`parse-*.test.ts`). Cases:

1. Single semicolon at top level: `a; b` parses to the same IR as
   `(a); b`.
2. Chained semicolons: `a; b; c` parses to the same IR as
   `((a); b); c`.
3. Line-local scoping: a rule whose first line is one atom and whose
   second line is `b; c` only wraps `b`, leaving the first-line atom
   outside.
4. Inside parens: `(a; b)` parses to the same IR as `((a); b)`.
5. Mixed with comma: `a, b; c` wraps `[a, b]` into the sequence sub
   (commas don't reset wrapStart).
6. Errors: `;` at line start; `;;`; `a. ;`; `(;)`.

Re-run the full v2 test suite — existing programs that already use
`);` should be untouched (those continue to flow through the
explicit-close path).

## Out of scope

- No change to formatter / printer; emitting `;` is a user-side
  convenience.
- No change to v1 parser (`ts/src/parse.ts`).
- No semantic change to sequence subs themselves — only the surface
  syntax used to introduce them.
