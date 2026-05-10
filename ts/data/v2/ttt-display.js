// v2 ttt display module. Reads `cell R C` and `filled (cell R C) M` rows
// from the store and renders a 3x3 grid; for each component whose active
// term resolves to a single cell, registers a click per option whose
// ClickIntent carries the active term and the chosen option tuple. The
// host (web-v2.ts) compresses the intent into source-form `= V… (…)` +
// `^ is L R` lines and inserts at the textarea cursor.

const CSS = `
.ttt-board { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ttt-grid { display: grid; grid-template-columns: repeat(3, 60px); grid-template-rows: repeat(3, 60px); gap: 2px; background: #333; padding: 2px; }
.ttt-cell { background: #1e1e1e; display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: bold; }
.ttt-empty { cursor: pointer; }
.ttt-empty:hover { background: #2a2a2a; }
.ttt-mark-x { color: #4ade80; }
.ttt-mark-o { color: #f87171; }
`;

export function create(api) {
  const { peek, addStyles } = api;
  addStyles(CSS);

  function termsOf(term, store) {
    const a = peek(term, store);
    return a ? a.terms : null;
  }

  function peanoToInt(term, store) {
    if (term.tag === "Symbol" && term.name === "z") return 0;
    const ts = termsOf(term, store);
    if (!ts || ts.length !== 2) return null;
    if (ts[0]?.tag !== "Symbol" || ts[0].name !== "s") return null;
    const inner = peanoToInt(ts[1], store);
    return inner === null ? null : inner + 1;
  }

  // Token equality: hashconsed Refs share id; Symbols share name.
  function tokensEq(a, b, store) {
    if (a.tag === "Ref" && b.tag === "Ref") return a.id === b.id;
    if (a.tag === "Symbol" && b.tag === "Symbol") return a.name === b.name;
    return false;
  }

  function extractBoard(store) {
    const cells = new Map();
    const cellByCellTerm = new Map(); // ref-id -> {row, col}
    const cellRows = store.byHead.get("cell") ?? [];
    for (const idx of cellRows) {
      const t = store.tuples[idx];
      const ts = t.atom.terms;
      // Stored tuples carry a trailing universal id slot; user terms occupy
      // the leading positions. `cell R C` → 4 terms (head, R, C, id).
      if (ts.length !== 4) continue;
      const r = peanoToInt(ts[1], store);
      const c = peanoToInt(ts[2], store);
      if (r === null || c === null) continue;
      const key = `${r},${c}`;
      if (cells.has(key)) continue;
      // The cell-term is the hashconsed `(cell R C)` atom; build it from the
      // tuple's atom Ref. We pass the whole Atom term as the cell id.
      cells.set(key, { row: r, col: c, mark: null, atomTerms: ts });
    }

    const filledRows = store.byHead.get("filled") ?? [];
    for (const idx of filledRows) {
      const t = store.tuples[idx];
      const ts = t.atom.terms;
      // `filled Cell P` → 4 stored terms (head, Cell, P, id).
      if (ts.length !== 4) continue;
      const cellTerm = ts[1];
      const inner = termsOf(cellTerm, store);
      if (!inner || inner.length !== 3) continue;
      if (inner[0]?.tag !== "Symbol" || inner[0].name !== "cell") continue;
      const r = peanoToInt(inner[1], store);
      const c = peanoToInt(inner[2], store);
      if (r === null || c === null) continue;
      const key = `${r},${c}`;
      const cell = cells.get(key);
      if (!cell) continue;
      const mark = ts[2];
      if (mark?.tag === "Symbol") cell.mark = mark.name;
    }

    return [...cells.values()];
  }

  // Find the hashconsed Ref for `(cell R C)` matching the option term.
  // The engine's options come back as hashconsed terms (typically Refs);
  // we compare by Ref id when possible.
  function optionMatchesCell(opt, cell, store) {
    // opt is e.g. Ref to (cell z z). cell.atomTerms is the cell row terms.
    // Compare by reconstructing the cell's atom Ref id from the row's
    // index isn't directly available; instead, walk opt's body and check
    // if it's `(cell R C)` with matching peanos.
    const ts = termsOf(opt, store);
    if (!ts || ts.length !== 3) return false;
    if (ts[0]?.tag !== "Symbol" || ts[0].name !== "cell") return false;
    const r = peanoToInt(ts[1], store);
    const c = peanoToInt(ts[2], store);
    return r === cell.row && c === cell.col;
  }

  // Pick a single-active-term component whose options are cells.
  function pickCellComponent(ctx, store) {
    for (const comp of ctx.components) {
      if (comp.activeTerms.length !== 1) continue;
      // Sniff: is at least one option a `(cell …)` term?
      const hasCellOpt = comp.options.some((tup) => {
        const o = tup[0];
        if (!o) return false;
        const ts = termsOf(o, store);
        return ts && ts.length === 3 && ts[0]?.tag === "Symbol" && ts[0].name === "cell";
      });
      if (hasCellOpt) return comp;
    }
    return null;
  }

  return {
    render(store, ctx) {
      const cells = extractBoard(store);
      if (cells.length === 0) return null;

      const cellComp = pickCellComponent(ctx, store);
      const clicks = new Map();

      const container = document.createElement("div");
      container.className = "ttt-board";

      const grid = document.createElement("div");
      grid.className = "ttt-grid";

      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const cell = cells.find((cs) => cs.row === r && cs.col === c);
          const cellEl = document.createElement("div");
          cellEl.className = "ttt-cell";

          if (cell) {
            if (cell.mark) {
              cellEl.textContent = cell.mark;
              cellEl.classList.add(`ttt-mark-${cell.mark}`);
            } else if (cellComp) {
              const opt = cellComp.options.find((tup) => optionMatchesCell(tup[0], cell, store));
              if (opt) {
                cellEl.classList.add("ttt-empty");
                clicks.set(cellEl, { activeTerms: cellComp.activeTerms, optionTuple: opt });
              }
            }
          }
          grid.appendChild(cellEl);
        }
      }

      container.appendChild(grid);
      return { element: container, clicks };
    },
  };
}
