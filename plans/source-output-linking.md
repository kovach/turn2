# Linking Source Code with Output

## Goal
When cursor is on a `+` line in the patterns editor, highlight the corresponding assertions in the result view.

## Current State
- Patterns are parsed with `span` info (line numbers) — done in source-spans.md
- Result nodes have structured ids like `(id r1 id1 X1 ...)` containing rule name and line info
- `web.ts` has `run()` which parses patterns, runs fixpoint, and renders result
- No cursor tracking or highlighting logic yet

## Design

### 1. Track cursor line in editor

Listen for `selectionchange` or use `keyup`/`click` on the textarea:
```typescript
let currentLine: number | null = null;

function updateCursorLine() {
  const pos = patternsEl.selectionStart;
  const before = patternsEl.value.slice(0, pos);
  currentLine = before.split("\n").length;
  highlightResultNodes();
}

patternsEl.addEventListener("keyup", updateCursorLine);
patternsEl.addEventListener("click", updateCursorLine);
```

### 2. Build pattern span index after parsing

After `parsePatterns`, build a map from line → pattern nodes:
```typescript
import { buildSpanIndex } from "./parse.js";

let patternSpanIndex: Map<number, Tree[]> = new Map();

function run() {
  const parsedPatterns = parsePatterns(patternsEl.value);
  if ("message" in parsedPatterns) { ... }
  
  patternSpanIndex = buildSpanIndex(parsedPatterns);
  // ... rest of run()
}
```

### 3. Extract rule/line info from result node ids

Result node ids have structure `(id <ruleName> <lineId> ...)`. Parse this to recover source info:
```typescript
function getSourceInfo(id: Term): { rule: string; lineId: string } | null {
  if (id.tag !== "Atom") return null;
  const terms = id.atom.terms;
  if (terms.length < 3) return null;
  if (terms[0]?.tag !== "Symbol" || terms[0].name !== "id") return null;
  if (terms[1]?.tag !== "Symbol") return null;
  if (terms[2]?.tag !== "Symbol") return null;
  return { rule: terms[1].name, lineId: terms[2].name };
}
```

### 4. Map lineId back to source line

The `lineId` is like `id1`, `id2`, etc. — it's the counter from `idExpand`. We correlate this with source lines by walking the expanded patterns (which preserve spans) and extracting their structured ids.

After `idExpand`, positive nodes get ids like `(id r1 id1 ...)`. Walk these and build `Map<string, number>` from `"r1:id1"` → source line:

```typescript
function buildIdToLineMap(expandedPatterns: Tree[]): Map<string, number> {
  const map = new Map<string, number>();
  
  function walk(node: Tree) {
    if (node.span && node.id.tag === "Atom") {
      const info = getSourceInfo(node.id);
      if (info) {
        map.set(`${info.rule}:${info.lineId}`, node.span.line);
      }
    }
    node.children.forEach(walk);
  }
  
  expandedPatterns.forEach(walk);
  return map;
}
```

### 5. Annotate result nodes with source line during render

Store the source line as a data attribute:
```typescript
function renderNode(tree: Tree): string {
  const sourceInfo = getSourceInfo(tree.id);
  const sourceLine = sourceInfo ? idToLineMap.get(`${sourceInfo.rule}:${sourceInfo.lineId}`) : null;
  const sourceAttr = sourceLine ? ` data-source-line="${sourceLine}"` : "";
  
  // ... existing render logic
  return `<span class="${cls}"${sourceAttr}>${body}</span>`;
}
```

### 6. Highlight on cursor change

```typescript
function highlightResultNodes() {
  // Clear previous highlights
  resultEl.querySelectorAll(".source-highlight").forEach(el => 
    el.classList.remove("source-highlight")
  );
  
  if (currentLine === null) return;
  
  // Check if current line has a positive pattern node
  const patternNodes = patternSpanIndex.get(currentLine) ?? [];
  const hasPositive = patternNodes.some(n => 
    n.literal.literalType === "Assert" || 
    n.literal.literalType === "Ask" || 
    n.literal.literalType === "Constrain" ||
    n.literal.literalType === "Aggregate"
  );
  
  if (!hasPositive) return;
  
  // Highlight matching result nodes
  resultEl.querySelectorAll(`[data-source-line="${currentLine}"]`).forEach(el =>
    el.classList.add("source-highlight")
  );
  
  // Scroll first highlighted node into view
  const first = resultEl.querySelector(".source-highlight");
  if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
```

### 7. Highlight source line on result hover (reverse direction)

When user hovers over a result node, highlight the corresponding source line in the editor.

```typescript
resultEl.addEventListener("mouseover", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (!target) { clearSourceHighlight(); return; }
  
  const line = parseInt(target.getAttribute("data-source-line")!, 10);
  highlightSourceLine(line);
});

resultEl.addEventListener("mouseout", (e) => {
  const target = (e.target as Element).closest("[data-source-line]");
  if (target) clearSourceHighlight();
});
```

Highlighting a line in a textarea requires a workaround since textareas don't support inline styling. Options:

**Option A: Overlay div** — position a transparent highlight div over the textarea at the correct line offset.

**Option B: Select the line** — temporarily select the source line text (simple but changes selection state).

**Option C: Mirror div** — use a hidden div that mirrors textarea content with highlighting, position it behind the textarea (complex).

Recommend **Option A** for minimal disruption:

```typescript
const sourceHighlightEl = document.createElement("div");
sourceHighlightEl.className = "source-line-highlight";
sourceHighlightEl.style.display = "none";
patternsEl.parentElement!.style.position = "relative";
patternsEl.parentElement!.insertBefore(sourceHighlightEl, patternsEl);

function highlightSourceLine(line: number) {
  const lineHeight = parseFloat(getComputedStyle(patternsEl).lineHeight);
  const paddingTop = parseFloat(getComputedStyle(patternsEl).paddingTop);
  
  // Account for scroll position
  const top = paddingTop + (line - 1) * lineHeight - patternsEl.scrollTop;
  
  sourceHighlightEl.style.display = "block";
  sourceHighlightEl.style.top = `${top}px`;
  sourceHighlightEl.style.height = `${lineHeight}px`;
}

function clearSourceHighlight() {
  sourceHighlightEl.style.display = "none";
}
```

### 8. CSS for highlighting

Add to `index.html` or a stylesheet:
```css
.source-highlight {
  background-color: rgba(59, 130, 246, 0.3); /* blue-ish */
  border-radius: 2px;
}

.source-line-highlight {
  position: absolute;
  left: 0;
  right: 0;
  background-color: rgba(59, 130, 246, 0.2);
  pointer-events: none;
  z-index: 0;
}
```

Note: textarea needs `background: transparent` for the highlight to show through.

## Implementation Order

1. Add `data-source-line` attribute in `renderNode` (needs `idToLineMap`)
2. Build `idToLineMap` from expanded patterns (need to get expanded patterns from `fixpoint0` or expand separately)
3. Add CSS for both highlight directions
4. **Source → Output direction:**
   - Add cursor tracking (`updateCursorLine`)
   - Store `patternSpanIndex` in `run()`
   - Implement `highlightResultNodes`
   - Wire up keyup/click listeners
5. **Output → Source direction:**
   - Create overlay highlight element
   - Implement `highlightSourceLine` / `clearSourceHighlight`
   - Wire up mouseover/mouseout listeners on resultEl
   - Make textarea background transparent

## Notes

- The expanded patterns are created inside `fixpoint0` via `expandAll`. May need to return them or call `expandAll` separately in `web.ts`.
- Aggregate nodes have different id structures — need to handle `agg-instance`, `agg-binding`, `agg-result` specially or skip them.
- Synthetic root node has no span — skip it in highlighting.
