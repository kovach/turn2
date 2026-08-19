# v2 editor — live values after click-to-rule

Goal: after clicking a tuple in the timeline or the database listing and
jumping to the rule that asserted it, show the *bindings* that were active
in that firing: a faint `X *17` annotation to the right of each source line,
listing the variables whose value is first bound on that line. Terms render
as their `*id` only (no expansion), so the annotations stay one short token
per variable.

Today the click path (`render-output.ts` → `source-link.ts` → `Editor.focusLine`)
carries only a `Span`. But the bindings themselves are already in the store:
the plan has three parts: decode them from the tuple, route the tuple
identity through the click, and draw the annotations.

## 1. Decode the binding environment from the tuple's id slot

No runtime recording is needed. `wrapEmit` (`expand.ts`) appends to every
emitted atom a trailing universal id slot

```
(*id <ruleName> <lexPos> (*chain t1 t2 …) [:var])
```

built by `chainTemplateWithHead` from `state.chain`, and `noteVar` / the
emit-var path push **every user variable** (in first-occurrence order) onto
the chain and mark it `essential`, so `pruneChains` never drops it. At emit
time the template is substituted, so the stored tuple carries the value of
every user variable bound before the emit, positionally. The names are
static: the expanded program's `Emit` atom for the same `(ruleName, lexPos)`
holds the unsubstituted template whose `*chain` lists the `Variable` terms in
the same order.

Add to `print.ts` (or a small new `bindings.ts`):

```
tupleBindings(store, expandedRules, tupleIndex): Binding[] | undefined
  Binding = { name: string; term: Term }
```

- take the tuple's last term; if it is not an `Id` headed `*id`, return
  `undefined` (seeds, `_agg-result`, `_choose`, constraint-query rows);
- read `ruleName` and `lexPos` from slots 1–2; find the expanded rule with
  that name and, in its body, the `Emit` whose trailing id template has the
  same `lexPos` (fall back to any `Emit` of the rule with that lexPos — the
  template is per-lexPos, not per-atom);
- zip the template's `*chain` terms against the stored `*chain` terms by
  position; keep entries whose template term is a `Variable` not starting
  with `_` (drops `_l_k`/`_r_k` endpoint slots, `_xl_/_xr_` anchors, `_dot<n>`,
  fresh-id templates for wildcards). Nested `*chain`s inside fresh-id values
  are left as opaque terms — they render as `*id` anyway;
- values are already hashconsed `Ref`s, so `renderTermShallow` gives the
  `*id` form.

The web page already has the expanded program in the `run()` closure
(`expandProgram` output is what the evaluator consumed); keep a reference
alongside the store for the click handler. Length mismatch between template
and stored chain (should not happen; guard anyway) → `undefined`.

This is a pure function of the store plus the expanded rules, so it works for
any tuple from the current run with no evaluator changes and no memory cost.

Semantics to state up front (so missing annotations aren't read as bugs):

- The chain is snapshotted *before* the emitting atom contributes, so a
  tuple carries only the variables bound earlier in its rule. For
  `foo X, +a X, bar Y, +b X Y` the `a` tuple yields `{X}` and the `b`
  tuple `{X, Y}`; clicking `a` leaves the `bar Y` line blank. That is the
  intended reading ("values active when *this* tuple was asserted").
- Variables the chain never carries get no annotation: existentials
  introduced inside a `!(...)` block (not `noteVar`'d by design), wildcards,
  and the desugaring-only `_dot<n>` names.
- If the id slot's `ruleName` has no pre-expand source rule (rules
  synthesized for exceptions, including the default-rule re-emits that
  `resolveExceptionProvenance` re-attributes), show nothing — there is no
  body to map names onto. The jump itself still uses `tupleSource`.
- The stored id slot is a hashconsed `Ref`; expand one level through
  `store.hash` to reach the `*chain` atom before zipping.

## 2. Map variables to source lines

Annotations live "at the line where the value is bound". Variables carry
no spans, but atoms do (pre-expand `Rule.body` atoms have `Span` with
columns). Add to `source-link.ts` (next to `collectPositiveSpans`):

```
collectVarLines(rules): Map<ruleName, Map<varName, {line, col}>>
```

keyed by the rule's `#def`/auto name (the same `r<n>` the id slot carries).
Walk each rule's body in source order (descending into subs / sequences /
`!(...)` blocks the way `autocomplete.ts:collectRuleVariables` does), and
record the span (`line`, `startCol`) of the *first* atom mentioning each
variable — atoms have spans, variables don't, so "the line of the atom"
is the resolution. That's the binding site for match vars; for vars first
appearing in an emit (fresh ids), it's the emit line, which is also right.
The column orders several variables on one line left-to-right.

The rule is identified directly from the id slot's `ruleName` (the expanded
rule name equals the pre-expand rule's `#def`/auto name `r<n>`), so no
span-containment lookup is needed; `tupleSource` is still what `focusLine`
uses for the jump.

## 3. Route tuple identity through the click

- `render-output.ts:emitRows` — stamp db rows with the **same attribute
  the timeline already uses**, `data-tl-tuple="<i>"`, next to
  `data-source-span`, so `source-link.ts` reads one attribute everywhere.
  Timeline fact labels and sidebar rows currently carry only the span; give
  them `data-tl-tuple` too so clicking a fact stub also annotates.
- `source-link.ts` click handler — after `editor.focusLine(...)`, if the
  target has a tuple index and `tupleBindings(store, expanded, i)` is
  defined, compute `{line → [{name, value: renderTermShallow(term)}…]}`
  (ordered by column) via `collectVarLines` and call
  `editor.setLineNotes(notes)`. Click only — `mouseover` keeps doing the
  range highlight and does not touch the notes. `attachSourceLink`
  needs the current store and expanded rules; pass a getter in `opts`
  (web-v2 holds both in the `run()` closure) and refresh on
  `link.update(rules)`.
- Clear notes on the next `run()` / edit (`input` event, since line numbers
  go stale) / `Escape`; clicking another tuple replaces them; clicking a
  tuple with no bindings clears them.

## 4. Draw the annotations in the `Editor`

No CodeMirror: the editor is a `<textarea>` with a sibling gutter and an
absolutely-positioned `.editor-line-highlight` overlay. Mirror that:

- `Editor.setLineNotes(notes: Map<number, {name: string; value: string}[]>)`
  creates (lazily) a
  `.editor-notes` overlay container inside `.editor-wrap`, `pointer-events:
  none`, one `.editor-note` div per annotated line positioned using the
  gutter row's `offsetTop`/`offsetHeight` (same as `repositionHighlight`)
  and `left = gutterWidth + (lineLength + 2) * chMetrics.width` so it sits
  just right of the line's text (`lineLength` counted after expanding tabs
  the way the textarea does, i.e. `tab-size`); `white-space: nowrap`; each
  pair renders as `<span class=name>X</span> <span class=val>*17</span>`,
  pairs separated by two spaces. The textarea must keep `white-space: pre`
  / no soft wrap (it already does — the highlight overlay relies on the
  same one-row-per-line assumption).
- Reposition on scroll and on `rebuildGutter` (the hooks the highlight
  already uses); `clearLineNotes()` removes them.
- Style in `styles/editor.css`: same font as the textarea, `opacity: .45`,
  color the gutter's muted color, italic off, small left padding; a
  `.editor-note .val` span for the `*id` so it can be a shade dimmer than
  the name.
- If a note would overflow the textarea's visible width, let it clip
  (`overflow: hidden` on the wrap is already the behaviour for the
  highlight); no wrapping.

## Tests (`./run-tests.sh`)

Pure-function tests, no DOM (there is no jsdom in the suite):

- `v2_tuple_bindings.test.ts` — parse+expand+run a small program (e.g. an
  inline `setup, n (s X), m Y, +pin X Y` plus a multi-line rule with a sub
  block), find a `pin` tuple, and assert `tupleBindings(...)` yields exactly
  the user names `[X, Y]` in first-occurrence order with `renderTermShallow`
  values of the `*id` form (and that expanding the `X` value gives the
  matched `(s …)` term); assert no `_`-prefixed names; assert an
  aggregate-closure tuple (`_agg-result`) and a seed tuple yield `undefined`;
  assert a tuple emitted from a consumer segment (after a rule split) still
  lists the prefix variables.
- extend `v2_source_link.test.ts` with `collectVarLines`: for a multi-line
  rule, each var maps to the line of its first occurrence, including vars
  introduced inside a sub-block and in the emit.

## Files

- modify: `ts/src/v2/print.ts` (`tupleBindings`),
  `ts/src/v2/render-output.ts` (`data-tuple-index`),
  `ts/src/v2/source-link.ts` (`collectVarLines`, click → notes),
  `ts/src/v2/editor.ts` (`setLineNotes`/`clearLineNotes`),
  `ts/styles/editor.css`, `ts/src/web-v2.ts` (pass store getter, clear on run)
- add: `ts/src/tests/v2_tuple_bindings.test.ts`
- update `ts/src/v2/overview.md`: print gains `tupleBindings` (chain
  decoding); editor gains line notes; source-link gains `collectVarLines`
  and the tuple-index hop.

## Out of scope / later

- Tuples re-attributed by `resolveExceptionProvenance`: their `tupleSource`
  points at the original assertion's line while the id slot names the
  default rule, so the name→line map and the bindings come from different
  rules. Use the id slot's rule for both (annotate the default rule) or show
  nothing; decide when implementing.
- Hovering a `*id` note to expand the term, or clicking it to jump to that
  tuple; the overlay is `pointer-events: none` for now.

---
Plan written by Claude Fable 5 (claude-fable-5).
