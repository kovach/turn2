# Modular Display System

## Status: IMPLEMENTED

Current state: TTT display works but code is inline in web.ts. This plan extracts it to a modular system.

## Goal
- Move TTT-specific code to `ts/data/ttt.js` (plain JS, alongside `ttt.sl`)
- web.ts dynamically loads display modules based on frontmatter
- New games work by dropping in `some-game.sl` + `some-game.js`

## Design

### 1. Display module interface

Display modules are plain JS files that export a `create` function:

```javascript
// ts/data/ttt.js
export function create(api) {
  return {
    render(root, hc) {
      // Returns { element: HTMLElement, clicks: Map<HTMLElement, ClickIntent> } or null
    }
  };
}
```

The `api` object provides utilities from web.ts:
```typescript
interface DisplayAPI {
  expandTerm(term: Term, hc: HashconsState): Term;
  formatTerm(term: Term): string;
  addStyles(css: string): void;  // injects a <style> element (idempotent per module)
}
```

### 2. Click handling abstraction

Display modules don't directly manipulate the editor. Instead, `render` returns click intents:

```typescript
interface ClickIntent {
  askId: Term;
  targetId: Term;
}

interface RenderResult {
  element: HTMLElement;
  clicks: Map<HTMLElement, ClickIntent>;
}

interface DisplayModule {
  render(root: Tree, hc: HashconsState): RenderResult | null;
}
```

web.ts iterates the `clicks` map and wires up handlers that call `handleBoardClick(intent.askId, intent.targetId)`.

### 3. Dynamic loading in web.ts

```typescript
let currentDisplayModule: DisplayModule | null = null;
let currentDisplayName: string | null = null;

async function loadDisplay(name: string): Promise<DisplayModule | null> {
  if (!name) return null;
  
  // Cache: don't reload if same module
  if (name === currentDisplayName && currentDisplayModule) {
    return currentDisplayModule;
  }
  
  try {
    // Display JS files live alongside .sl files in /data/
    const module = await import(`/data/${name}`);
    const api: DisplayAPI = { expandTerm, formatTerm };
    currentDisplayModule = module.create(api);
    currentDisplayName = name;
    return currentDisplayModule;
  } catch (e) {
    console.warn(`Failed to load display module: ${name}`, e);
    return null;
  }
}
```

In `run()`:
```typescript
async function run() {
  const { frontmatter, body } = parseFrontmatter(patternsEl.value);
  // ... parse and fixpoint ...
  
  const display = await loadDisplay(frontmatter.display);
  if (display) {
    const result = display.render(root, hc);
    if (result) {
      displayEl.innerHTML = "";
      displayEl.appendChild(result.element);
      
      // Wire up clicks
      for (const [el, intent] of result.clicks) {
        el.addEventListener("click", () => {
          handleBoardClick(intent.askId, intent.targetId);
        });
      }
      
      displayPaneEl.style.display = "flex";
      rightColumnEl.classList.add("has-display");
    }
  }
}
```

### 4. File structure

```
ts/data/
  ttt.sl          # Game rules
  ttt.js          # Display module (plain JS)
  some-game.sl    # Another game
  some-game.js    # Its display

ts/src/
  web.ts          # Loads displays dynamically, handles clicks
  display.d.ts    # Type definitions for display modules (optional)
```

### 5. ttt.js implementation

Move from web.ts to `ts/data/ttt.js`:

```javascript
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
```

### 6. Update ttt.sl frontmatter

Change from `display: ttt.ts` to `display: ttt.js`:
```
---
display: ttt.js
---
```

### 7. Server: serve .js files from /data/

The server already serves files from `ts/data/`. Ensure `.js` files get `Content-Type: application/javascript`.

## Implementation Order

1. Create `ts/data/ttt.js` with the display code
2. Update `ts/data/ttt.sl` frontmatter to `display: ttt.js`
3. Remove TTT-specific code from web.ts (`peanoToInt`, `extractBoard`, `renderTTTBoard`)
4. Add dynamic import logic to web.ts
5. Refactor click handling to use returned `clicks` map
6. Test that ttt.sl still works
7. Verify server serves .js with correct MIME type

## Design Decisions

1. **Ask node selection**: The display module (e.g., `ttt.js`) determines which `? ask` node to use. TTT chooses the most recent one encountered during tree traversal.

2. **CSS injection**: Each display injects its own styles. Use `api.addStyles(css)` or inline element styles. No shared classes in index.html (except layout).

3. **Module lifecycle**: `create(api)` is called once when the `.sl` file is opened for editing. The module is cached until a different file is loaded.

4. **Sync render**: `render()` is synchronous. No async support.

5. **Error handling**: If `import()` fails or `render()` throws, show the error message in the display pane. Don't hide failures silently.

6. **API surface**: Start minimal (`expandTerm`, `formatTerm`, `addStyles`). Atom matching helpers will be needed — document as followup work.

## Followup Work

- `api.matchAtom(node, pattern)` — declarative pattern matching for atoms
- `api.walkTree(root, visitor)` — standard tree traversal helper
- Type definitions (`.d.ts` or JSDoc) for `Tree`, `Term`, `HashconsState`

## Notes

- Plain .js means no build step for display modules — true drop-in
- Display modules run in browser context, have access to DOM
- The `api` parameter provides access to slide internals without tight coupling
