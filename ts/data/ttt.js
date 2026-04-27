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

  // One-level peek: returns the stored terms array for a Ref or Atom term,
  // or null. Never materializes a full subtree — each step costs O(1).
  function atomTerms(term, hc) {
    if (term.tag === "Ref") {
      const stored = peek(term, hc);
      return stored ? stored.terms : null;
    }
    if (term.tag === "Atom") return term.atom.terms;
    return null;
  }

  function peanoToInt(term, hc) {
    if (term.tag === "Symbol" && term.name === "z") return 0;
    const terms = atomTerms(term, hc);
    if (!terms || terms.length !== 2) return null;
    if (terms[0]?.tag !== "Symbol" || terms[0].name !== "s") return null;
    const inner = peanoToInt(terms[1], hc);
    return inner === null ? null : inner + 1;
  }

  function extractBoard(root, hc) {
    const cells = new Map();
    let askId = null;

    function walk(node) {
      if (node.tag === "Ask") {
        askId = node.id;
      }

      if (node.tag === "Assert") {
        const terms = node.atom.terms;

        // Match: cell R C
        if (terms[0]?.tag === "Symbol" && terms[0].name === "cell" && terms.length === 3) {
          const r = peanoToInt(terms[1], hc);
          const c = peanoToInt(terms[2], hc);
          if (r !== null && c !== null) {
            const key = `${r},${c}`;
            if (!cells.has(key)) {
              cells.set(key, { row: r, col: c, mark: null, cellId: node.id });
            }
          }
        }

        // Match: fill (cell R C) M
        if (terms[0]?.tag === "Symbol" && terms[0].name === "fill" && terms.length === 3) {
          const cellInner = atomTerms(terms[1], hc);
          const markArg = terms[2];
          if (cellInner && markArg?.tag === "Symbol") {
            if (cellInner[0]?.tag === "Symbol" && cellInner[0].name === "cell") {
              const r = peanoToInt(cellInner[1], hc);
              const c = peanoToInt(cellInner[2], hc);
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
