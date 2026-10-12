# Display kit: every visible entity explains itself

status: design + first implementation (26/10/12)

## Goal

A small component layer for game GUIs (`-- display:` modules such as
`ttt-display.js` and `si-display.js`). Every visible entity — a cell, a
piece, a land, a card, a track slot — gets:

- **a tooltip**: what it is, and the facts it is drawn from (the store rows,
  rendered as atoms, each with the line of the rule that emitted it);
- **a right-click menu** that leads into the code behind it: the rule that
  emitted each fact, all the rules that use its relations (the rule
  browser), the rows in the timeline, the choice it stands for.

Shift+right-click keeps the browser's own menu.

## The one idea: entities carry their rows

A display builds entities out of store rows. Today it reads the rows, keeps
the values, and drops where they came from. With the kit, the rows it reads
carry their tuple index, and an entity is declared with the rows it was
built from:

```js
export function create(api) {
  const { entity, rows } = api.kit;
  ...
  // rows(store, head, M?) → [{ idx, terms, l, r }], terms without the head
  // and the trailing id; with M only the rows alive at moment M
  for (const row of rows(store, "at", M)) { ... P.rows.push(row) ... }
  ...
  entity(g, {
    label: "Explorer in land 8",
    rows: P.rows,               // the facts it is drawn from
    choice: intent,             // optional: what clicking it commits
    notes: ["2 Damage"],        // optional extra tooltip lines
  });
}
```

Everything else is derived by the kit from the tuple indices:

- each row's atom (`renderTerm`), interval, and emitting span
  (`store.tupleSource`), i.e. the rule and source line that made it;
- the relations involved (row heads), for "rules using …";
- `#acc` rows have no span; their relation's acc rules stand in.

`entity` is cheap: the tooltip and menu are built on demand, so a display can
declare hundreds of entities per render.

## Menu

For an entity with rows `r1..rn` over relations `p1..pk`:

- **Emitted by line N** (one per distinct emitting span) → the Rules view,
  querying the row's relation, with the emitting rule's card pinned.
- **Rules using `p`** (one per relation) → the Rules view, query `p`.
- **Show in timeline** → highlights the rows' bars/db rows (the
  `data-tl-tuple` elements both outputs already stamp) and scrolls to the
  first.
- **Choose** (when `choice` is set) → commits it, like a click.
- Later, with tuple parents (plans/v2-rule-browser.md §5): **Causal past**
  → the rules whose firings led to these rows.

## Host interface

The kit is tracked code (`ts/src/v2/display-kit.ts`, DOM-only, no store
writes). The page creates it with hooks and hands it to display modules as
`api.kit`:

```ts
interface KitHost {
  store(): Store | null;
  renderTerm(store: Store, t: Term): string;
  sourceLine(line: number): string;      // for "emitted by" labels
  showRules(query: string, pinLine?: number): void;
  showTuples(idx: number[]): void;
  commit(intent: ClickIntent): void;
}
```

`RuleBrowser` gains `pinLine(line)`: pin the card of the segment holding a
source line.

## Use in the two displays

- **ttt-display.js**: cells (`cell R C` row + its `filled` row), with the
  choice for an empty cell.
- **si-display.js**: lands (`land:terrain`, `coastal`), pieces (`at`,
  `piece:kind`, `damage`, `presence-of`), cards, track slots, the invader
  board steps. Its native SVG `<title>`s go: the kit tooltip replaces them.

## Not now

- Automatic provenance (recording every row a render reads) instead of
  passing rows explicitly. Explicit rows are simpler, and a display already
  knows which facts make an entity.
- The default display (`default-display.ts`) could declare its icons the
  same way; it is a small follow-up.

Claude Opus 5.5 (claude-opus-5-5)
