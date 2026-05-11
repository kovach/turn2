# v2 — natural-number numeral syntax (parse + display)

## Goal

Let users write `0`, `1`, `2`, … in v2 source and see them rendered the
same way in printer output, while *internally* representing those values
as the unary `z` / `(s z)` / `(s (s z))` chain that `ts/data/v2/ttt.t`
already uses. Underlying tuples are unchanged — this is purely a surface
sugar layer.

Beyond just nats, define a `TermSugar` interface so future "objects"
(lists, pairs, strings, …) can add a parser + pretty-printer pair the
same way. Per the overview, we keep this **static**: one interface
definition plus a single hard-coded list of instances in the compiler.
No `registerSugar()` call, no module-load side effects, no dynamic
mutation — adding a new sugar means appending a literal to that list.

## The interface and the list

New file `ts/src/v2/sugar.ts`:

```ts
export interface TermSugar {
  name: string;                                // for diagnostics
  // Parse hook: called for each leaf token inside a term during
  // `parseTerms`. Return a Term to substitute, or undefined to pass.
  parseToken?(token: string): Term | undefined;
  // Print hook: called by `renderTerm` / `renderTermShallow` *before*
  // the default per-tag rendering. Return a string to substitute, or
  // undefined to pass.
  print?(term: Term, ctx: PrintCtx): string | undefined;
}

export interface PrintCtx {
  store: Store;
  recur(t: Term): string;          // recurse using the same printer mode
}

// The full list of sugars active in the compiler. Order = priority
// (first match wins). Append new entries here.
export const sugars: readonly TermSugar[] = [
  natSugar,
];
```

`natSugar` is defined in the same file (or a sibling `sugar-nat.ts` —
either way, it's referenced from the literal above, no run-time
registration). Parse / print sites import `sugars` and iterate.

## Nat sugar

Parse direction:

- `parseToken(tok)`: if `tok` matches `/^[0-9]+$/` and parses to a
  non-negative integer `n`, build the term `s^n z`:
  - `n === 0` → `Symbol("z")`
  - `n > 0`   → `Atom { terms: [Symbol("s"), recur(n - 1)] }`
  - Plain *Atom*, never *Id* (data, not identity — see
    `notes/v2-design.md`).
- Cap `n` at some sanity limit (e.g. 2^16) and report a `ParseError`
  past it — the unfolded form is linear in the AST and the hashcons
  store. Cap value is arbitrary; see open questions.

Print direction:

- `print(term, ctx)`: detect `(s ... (s z))` at the head.
  - `Symbol("z")` (or `Ref` to such) → `"0"`.
  - `Atom { terms: [Symbol("s"), inner] }` (or `Ref` to such) → walk
    inward, counting `s` layers; if every layer matches and the
    bottom is `z`, return the decimal string. If anything deviates
    midway, return `undefined` (not our shape).
  - Cap walk depth (e.g. 256) to avoid printer hangs on pathological
    chains; past the cap, return `undefined` and fall back to default
    rendering.

## Wiring into parse.ts

`parse(input, sugars = defaultSugars)` accepts the sugar list and
threads it into `parseProgram` → per-rule loop → `parseAtomText` /
`parseEqualText` → `parseTerms`. In `parseTerms`
(`ts/src/v2/parse.ts:326+`), the leaf branch currently classifies
tokens as `Wildcard`, `Variable` (uppercase or `_`-prefixed), or
`Symbol`. Insert sugar dispatch *after* Wildcard / Variable (those
are spec-defined syntax that sugars must not shadow), *before* the
`Symbol` fallback:

```ts
} else {
  let pushed = false;
  for (const s of sugars) {
    if (!s.parseToken) continue;
    const t = s.parseToken(tok);
    if (t !== undefined) { terms.push(t); pushed = true; break; }
  }
  if (!pushed) terms.push({ tag: "Symbol", name: tok });
}
```

## Wiring into print.ts

Each printer entry point (`renderTerm`, `renderTermShallow`,
`renderAtom`, `renderAtomShallow`, `compressRefs`) gains an optional
`sugars: readonly TermSugar[] = defaultSugars` trailing parameter and
forwards it to recursive calls (and to `PrintCtx.recur`, which closes
over the active list). Before the existing `switch (t.tag)`, run
sugars in list order; first non-`undefined` result wins; otherwise
fall through to current behaviour.

For `compressRefs`'s `renderInner`: dispatch sugars before the
`varMap` lookup, so a literal `(s (s z))` prints as `2` even when its
Ref is shared. The sharing-bypass is fine for nats (output stays
short); a future sugar with large output may want a per-sugar opt-out
flag, but that's deferred.

Other consumers (web-v2.ts, timeline, constraint-query) funnel through
these renderers and pick up the new behaviour with no per-call-site
changes.

## Tests (add to `ts/src/tests/v2_parse.test.ts`)

- `parse("+ n 0")` produces an atom whose second term is `Symbol("z")`.
- `parse("+ n 3")` produces `(s (s (s z)))`.
- `parse("+ n 12345")` round-trips through `renderAtom` to `"n 12345"`.
- `-1` and `1.5` parse as Symbols (no numeric form), preserving
  current behaviour.
- A program substituting `0` / `1` / `2` for `z` / `(s z)` / `(s (s z))`
  in `ttt.t` produces the same fixpoint result as the original.
- Print: a hashconsed Atom whose body is `(s (s z))` renders as `"2"`.

- Negative test: pass `sugars: []` to `parse` and confirm
  `parse("+ n 0", [])` produces `Symbol("0")`, proving the sugar is
  the only thing doing the conversion.

## Migration of `ts/data/v2/ttt.t`

Optional follow-up: rewrite the `n z`, `(s z)`, `(s (s z))` literals
in `ttt.t` as `0`, `1`, `2`. Confirm equivalence under
`v2_ttt.test.ts`. Could be deferred.

## Non-goals

- Arithmetic on numerals.
- Bignum: `Number` is fine for the cap.
- Display in info-panel / timeline labels beyond what falls out of
  `renderTerm` automatically.
- Dynamic registration / per-file or per-object scoped sugars (the
  overview explicitly opts out of dynamism).

## Open questions / ambiguities

1. **Numeric-literal cap (parse) and depth cap (print).** Both
   arbitrary. Pick once we see real usage.
2. **Bare `+ 0` as a top-level atom.** Parses to `Atom { terms: [Symbol("z")] }`,
   same shape as today's `+ z`. Worth flagging because numerals make
   it more visible, but unchanged behaviour.
3. **Negative / hex / decimal forms.** Plan only handles `[0-9]+`. If
   we want `-3` or `0xff` later, that's another `TermSugar` instance
   added to the list; not blocking.
4. **Shared-ref pretty-printing inside `compressRefs`.** Plan calls
   sugars before the varMap lookup. Right for numerals; a future
   list/string sugar with large output might want a per-sugar
   `bypassSharing: false` flag.
5. (resolved) Entry points are parameterised: `parse`, `renderTerm`,
   `renderTermShallow`, `renderAtom`, `renderAtomShallow`, and
   `compressRefs` all accept an optional
   `sugars?: readonly TermSugar[]` parameter, defaulting to the
   canonical `sugars` list from `ts/src/v2/sugar.ts`. Tests can pass
   `[]` (no sugars) or a subset to exercise specific sugars in
   isolation. Internal helpers (`parseTerms`, `parseAtomText`,
   `parseEqualText`, `renderInner` inside `compressRefs`) thread the
   list as a positional arg so the dispatch site sees the same list
   the caller asked for.
