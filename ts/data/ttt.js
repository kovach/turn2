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
  const { expandTerm, addStyles } = api;
  addStyles(CSS);

  function peanoToInt(term, hc) {
    let t = term.tag === "Ref" ? expandTerm(term, hc) : term;
    if (t.tag === "Symbol" && t.name === "z") return 0;
    if (t.tag !== "Atom") return null;
    const terms = t.atom.terms;
    if (terms.length !== 2) return null;
    if (terms[0]?.tag !== "Symbol" || terms[0].name !== "s") return null;
    const inner = peanoToInt(terms[1], hc);
    return inner === null ? null : inner + 1;
  }

  function extractBoard(root, hc) {
    const cells = new Map();
    let askId = null;

    function walk(node) {
      if (node.literal.literalType === "Ask") {
        askId = node.id;
      }

      if (node.literal.literalType === "Assert") {
        const terms = node.literal.atom.terms;
        const expanded = terms.map(t => t.tag === "Ref" ? expandTerm(t, hc) : t);

        // Match: cell R C
        if (expanded[0]?.tag === "Symbol" && expanded[0].name === "cell" && expanded.length === 3) {
          const r = peanoToInt(expanded[1], hc);
          const c = peanoToInt(expanded[2], hc);
          if (r !== null && c !== null) {
            const key = `${r},${c}`;
            if (!cells.has(key)) {
              cells.set(key, { row: r, col: c, mark: null, cellId: node.id });
            }
          }
        }

        // Match: fill (cell R C) M
        if (expanded[0]?.tag === "Symbol" && expanded[0].name === "fill" && expanded.length === 3) {
          const cellArg = expanded[1];
          const markArg = expanded[2];
          if (cellArg?.tag === "Atom" && markArg?.tag === "Symbol") {
            const cellTerms = cellArg.atom.terms;
            if (cellTerms[0]?.tag === "Symbol" && cellTerms[0].name === "cell") {
              const r = peanoToInt(cellTerms[1], hc);
              const c = peanoToInt(cellTerms[2], hc);
              if (r !== null && c !== null) {
                const key = `${r},${c}`;
                const cell = cells.get(key);
                if (cell) cell.mark = markArg.name;
              }
            }
          }
        }
      }

      node.children.forEach(walk);
    }

    walk(root);
    return { cells: [...cells.values()], askId };
  }

  return {
    render(root, hc) {
      const { cells, askId } = extractBoard(root, hc);
      if (cells.length === 0) return null;

      const clicks = new Map();

      const container = document.createElement("div");
      container.className = "ttt-board";

      const grid = document.createElement("div");
      grid.className = "ttt-grid";

      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const cell = cells.find(cs => cs.row === r && cs.col === c);
          const cellEl = document.createElement("div");
          cellEl.className = "ttt-cell";

          if (cell) {
            if (cell.mark) {
              cellEl.textContent = cell.mark;
              cellEl.classList.add(`ttt-mark-${cell.mark}`);
            } else if (askId) {
              cellEl.classList.add("ttt-empty");
              clicks.set(cellEl, { askId, targetId: cell.cellId });
            }
          }
          grid.appendChild(cellEl);
        }
      }

      container.appendChild(grid);
      return { element: container, clicks };
    }
  };
}
