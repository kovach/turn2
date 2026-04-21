# Source Spans for Pattern Nodes

## Goal
Given a line of input text, identify the output pattern node(s) it corresponds to. This enables the GUI feature described in overview.md: "when cursor is on a `+` line, highlight the set of corresponding assertions in the result."

## Current State
- Parser tracks `lineno` during parsing but discards it after creating node ids
- Tree nodes have no source location info
- Macro expansion and `idExpand` create new nodes without provenance

## Design

### 1. Add Span type
```typescript
// in types.ts
export interface Span {
  line: number;      // 1-indexed line in original input
  startCol?: number; // optional: column range for finer highlighting
  endCol?: number;
}
```

### 2. Add span to Tree
```typescript
export interface Tree {
  id: Term;
  literal: Literal;
  children: Tree[];
  aggregateInfo?: AggregateInfo;
  macroInvocation?: MacroInvocation;
  span?: Span;  // NEW: source location
}
```

### 3. Parser changes (parse.ts)

In `_parseNodes`, when creating each node:
```typescript
const node: Tree = {
  id: explicitId ?? { tag: "Variable", name: String(lineno) },
  literal,
  children: [],
  span: { line: lineno },  // ADD THIS
  ...(aggregateInfo && { aggregateInfo }),
  ...(macroInvocation && { macroInvocation }),
};
```

### 4. Propagate through transformations

#### macros.ts
When `expandMacros` creates nodes from macro invocations, copy the span from the macro invocation site:
```typescript
// expanded nodes inherit span from the @macro line
newNode.span = macroNode.span;
```

#### expand.ts
`idExpand` modifies existing nodes in place (just the id field), so spans are preserved automatically.

The `expand` function creates prefix trees. These should inherit spans from the original nodes they copy.

### 5. Build reverse mapping

For the GUI, we need both directions:
- **line → nodes**: given cursor line, find all Tree nodes from that line
- **node → line**: given a result node, find its source line

Create a helper in a new file or in `parse.ts`:
```typescript
export function buildSpanIndex(trees: Tree[]): Map<number, Tree[]> {
  const index = new Map<number, Tree[]>();
  function walk(t: Tree) {
    if (t.span) {
      const list = index.get(t.span.line) ?? [];
      list.push(t);
      index.set(t.span.line, list);
    }
    t.children.forEach(walk);
  }
  trees.forEach(walk);
  return index;
}
```

### 6. Connect to result nodes

Deferred. Result node ids already contain rule name and line info (e.g., `(id r1 1 ...)`). We'll add code later to parse this back to recover the source line.

## Implementation Order

1. Add `Span` type and `span?: Span` to `Tree`
2. Set `span` in `_parseNodes`
3. Preserve spans in `expandMacros`
4. Verify spans survive `idExpand` and `expand`
5. Add `buildSpanIndex` helper
6. Wire up in `web.ts`: on cursor line change, highlight matching result nodes

## Testing

Add test in `parse.test.ts`:
```typescript
test("spans are preserved", () => {
  const input = `- foo\n  + bar`;
  const result = parse(input);
  // root has no span (synthetic)
  expect(result.children[0].span).toEqual({ line: 1 });
  expect(result.children[0].children[0].span).toEqual({ line: 2 });
});
```

## Notes
- The synthetic root node created by `parse()` has no span (it doesn't correspond to any input line)
- Blank lines and comments have no nodes, so no span issues there
- For multi-pattern files (`parsePatterns`), line numbers are already adjusted by `startLine`
