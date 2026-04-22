# Eliminate `expandTerm` from web.ts

## Insight

`expandTerm(ref, hc)` recursively materializes a shared Ref graph into a tree
of `Atom`s. In the hashcons store, one `Ref` can appear many times across the
DAG; `expandTerm` walks each occurrence, so its cost is the size of the
unshared tree — exponential in the depth of sharing.

Every downstream consumer (`renderTerm`, `compressTerms`, display modules) is
then O(expanded-size), and the expanded string/DOM it produces is itself
exponential. None of this is needed: the hashcons already encodes perfect
sharing. Walking it as a DAG (memoizing per Ref id) is O(distinct refs).

**Rule**: `web.ts` must never call `expandTerm`. It walks the `refToAtom` map
directly, visits each Ref at most once.

## Current call sites

| # | Location | Purpose | Fix |
| - | - | - | - |
| 1 | `renderTerm` line 562 (gated on `expandRefsEl.checked`) | Inline-expand shared Refs in the rendered HTML | Share-aware lazy unfold: first occurrence inlines, subsequent occurrences print `*id` |
| 2 | `assertClick` lines 444–445 | Build shareable `= V… / + is …` source text from two clicked ids | Fuse with `compressTerms` — see below |
| 3 | `handleDisplayClick` lines 88–89 | Same as `assertClick`, from a display-module click | Share fused helper |
| 4 | `DisplayAPI` lines 45, 75 | Exposes `expandTerm` to external display modules (`data/ttt.js` etc.) | Replace API surface with `peek(ref, hc) → Atom \| undefined` (one-level lookup) and migrate `ttt.js` |
| 5 | `getSourceInfo` | (already fixed — uses `refToAtom.get` directly) | — |

## Fused share-aware compression (sites 2 and 3)

Replace `compressTerms(expandedAtoms)` with `compressRefs(roots, hc)` that
walks the hashcons DAG directly.

### Signature

```ts
// roots are Terms as they appear in the tree (typically Ref, occasionally Atom
// or Symbol for the degenerate case).
function compressRefs(roots: Term[], hc: HashconsState): {
  bindings: string[];   // ["= V1 (id r1 id2)", "= V2 (id r2 id6 V1)", ...]
  results: string[];    // one string per root, using V-vars where shared
}
```

### Algorithm

1. **Reference-count pass.** Depth-first walk starting from `roots`. For every
   `Ref` encountered, `refCount[id]++`. Recurse into `refToAtom.get(id)` only
   the *first* time a Ref is seen (memoize by id). A Ref's sub-terms in
   `refToAtom` are already one-level hashconsed — nested `Atom`s don't occur.
   O(distinct Refs). No string-keyed counting.

2. **Select shared set.** `shared = { id | refCount[id] ≥ 2 } ∪ { rootRefIds }`.
   (Roots become explicit bindings even if referenced once, matching current
   `compressTerms` behavior for top-level atoms.)

3. **Assign V-numbers.** Topological order: a Ref `r` gets a lower number than
   any Ref that references it. Because `refId` in the hashcons is allocated
   bottom-up (`hashconsTerm` recurses first, then emits its own id), sorting
   shared ids ascending gives a valid topological order for free — no separate
   toposort needed.

4. **Render each binding.** For each shared id in order:

   ```ts
   function renderInner(t: Term): string {
     if (t.tag === "Ref") {
       if (varMap.has(t.id)) return varMap.get(t.id)!;
       // Non-shared Ref: single reference, inline its body once. Because
       // refCount[t.id] === 1 at this point, each non-shared Ref is rendered
       // in exactly one place — total work stays linear in distinct Refs.
       const stored = hc.refToAtom.get(t.id)!;
       return `(${stored.terms.map(renderInner).join(" ")})`;
     }
     return formatTerm(t);
   }

   const stored = hc.refToAtom.get(sharedId)!;
   bindings.push(`= ${varMap.get(sharedId)} (${stored.terms.map(renderInner).join(" ")})`);
   ```

5. **Render roots.** Each root runs `renderInner` directly. If a root is a
   Ref, `renderInner` returns its V-var. If a root is a bare Atom/Symbol,
   format it.

### Why this is linear

Every Ref's body is expanded in exactly one output location:
- `refCount ≥ 2` → expanded once inside its own `= V…` binding, all other
  references become `V…`.
- `refCount === 1` → inlined once at the sole reference site.

Total characters written ≈ sum over distinct Refs of the size of their stored
atoms (one-level). No subtree is visited twice.

### Output equivalence

For ground atoms with no sharing, output matches today's `compressTerms`
(only top-level atoms get a V-var). For shared atoms, output is also the
same *set* of bindings (the hashcons ids identify the same subterms that
`formatTerm`-keying identified before), just derived in O(distinct refs)
instead of O(expanded size).

One minor ordering difference: today's code sorts shared keys by the length
of their formatted string; the fused version uses Ref id order, which is
bottom-up allocation order. Both are valid topological orders of the
sharing DAG — V-numbers may renumber. If stable numbering matters, sort by
`(stored-atom depth, id)` instead; otherwise take the simpler form.

## Share-aware `renderTerm` (site 1)

Thread a `Set<number> seen` through the render:

```ts
function renderTerm(term: Term, seen: Set<number>, isPredicate = false): string {
  if (term.tag === "Ref") {
    if (!expandRefsEl.checked || !lastHc || seen.has(term.id)) {
      return `<span class="lit-ref">*${term.id}</span>`;
    }
    const stored = lastHc.refToAtom.get(term.id);
    if (!stored) return `<span class="lit-ref">*${term.id}</span>`;
    seen.add(term.id);
    return `(${stored.terms.map((t) => renderTerm(t, seen)).join(" ")})`;
  }
  // ...existing Symbol / Variable / Atom / Wildcard branches (Atom branch
  // still recurses, but atoms inside hashconsed trees are one-level by
  // construction)
}
```

`renderNode` creates a fresh `seen` per node-render (or per `run()` if we
want sharing to span the whole result panel — worth deciding; per-node is
simpler and still linear).

Remove the top-level `expandTerm` call entirely.

## DisplayAPI (site 4)

External display modules (`data/ttt.js`) pass a Ref to `expandTerm` and then
inspect the resulting Atom's head. They only need one-level unwrapping. Replace
the exported helper:

```ts
interface DisplayAPI {
  peek: (ref: Term, hc: HashconsState) => Atom | null; // one-level; null for non-Ref or missing
  formatTerm: typeof formatTerm;
  addStyles: (css: string) => void;
}
```

`peek` is:
```ts
function peek(term: Term, hc: HashconsState): Atom | null {
  if (term.tag !== "Ref") return null;
  return hc.refToAtom.get(term.id) ?? null;
}
```

Migrate `data/ttt.js`:
- `peanoToInt`: replace `let t = term.tag === "Ref" ? expandTerm(term, hc) : term;` with
  ```js
  let terms;
  if (term.tag === "Symbol" && term.name === "z") return 0;
  if (term.tag === "Ref") { const stored = peek(term, hc); if (!stored) return null; terms = stored.terms; }
  else if (term.tag === "Atom") { terms = term.atom.terms; }
  else return null;
  ```
  Recurse on `terms[1]` via the same helper — each step unwraps exactly one
  level, so total cost is linear in Peano depth (same as today, but without
  ever materializing a duplicate).
- `extractBoard`: the `terms.map(t => t.tag === "Ref" ? expandTerm(t, hc) : t)`
  pattern becomes `terms.map(t => t.tag === "Ref" ? peek(t, hc) ?? t : t)` —
  the result is either the stored one-level atom or the original term.
  Downstream checks (`expanded[0].tag === "Symbol"`, `expanded[1].atom.terms`)
  need to be rewritten to walk through the one-level atom's `.terms` rather
  than assuming a fully materialized tree. For ttt.js this is straightforward
  — the shapes are shallow (cell R C, fill (cell R C) M).

## Removing the import

After sites 1–4 land, `web.ts` no longer imports `expandTerm`. Add a lint rule
(or a comment at the import) forbidding re-introduction:

```ts
// Do not import expandTerm into web.ts — it materializes the full unshared
// tree of a hashcons Ref, which is exponential in sharing depth. Use
// hc.refToAtom.get(refId) for one-level peeks, or compressRefs for
// share-aware serialization. See plans/web-no-expand-term.md.
```

## Rollout

Single PR, in order:
1. Add `compressRefs` (replaces `compressTerms`). Update sites 2–3.
2. Share-aware `renderTerm`. Remove the `expandRefsEl`-gated `expandTerm` call.
3. DisplayAPI migration: add `peek`, remove `expandTerm` from the API,
   migrate `data/ttt.js`.
4. Delete the `expandTerm` import from `web.ts`, add the forbidden-import
   comment.

Each step is independently testable in the browser on `data/ttt.sl`, which
already exhibits the problematic sharing patterns.

## Non-goals

- Do **not** change `hashcons.ts` — `expandTerm` is still valid for consumers
  that genuinely need a full tree (e.g. equality testing against a literal
  Atom from parse, which was its original role).
- Do **not** change the derp engine. This is purely a UI/export-layer fix.
