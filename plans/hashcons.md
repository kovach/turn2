# hashcons for ids

## Overview

Add a `Ref` term type and hashcons all atom terms occurring in output tree nodes. This flattens nested structure so unification can compare refs by identity rather than recursing into atoms.

## Motivation

Currently, nested atom terms like `(id r1 (id r1 x y) z)` are stored as-is. Unification must recursively descend into atoms to compare them. With hashconsing:
- `(id x y)` → `ref(1)`
- `(id r1 (id r1 x y) z)` becomes `(id r1 ref(1) z)` → `ref(2)`

Key invariant: atom terms in the output tree never contain other atom terms (only refs and symbols). This means:
- Equal atoms always have equal refs
- Unequal refs point to distinct atoms
- Unification can compare refs by numeric id, no recursion needed

## 1. Add `Ref` term type

In `types.ts`:

```ts
export type Term =
  | { tag: "Symbol"; name: string }
  | { tag: "Variable"; name: string }
  | { tag: "Atom"; atom: Atom }
  | { tag: "Wildcard" }
  | { tag: "Ref"; id: number };
```

Add constructor:
```ts
export const ref = (id: number): Term => ({ tag: "Ref", id });
```

## 2. Hashcons state

New file `hashcons.ts`:

```ts
export interface HashconsState {
  atomToRef: Map<string, number>;  // canonical string → ref id
  refToAtom: Map<number, Atom>;    // ref id → original atom
  nextId: number;
}

export function createHashcons(): HashconsState {
  return { atomToRef: new Map(), refToAtom: new Map(), nextId: 1 };
}
```

The string key is a canonical representation of the flattened atom (after inner atoms are already refs).

## 3. Hashcons a term

```ts
export function hashconsTerm(term: Term, state: HashconsState): Term {
  if (term.tag !== "Atom") return term;

  // First, hashcons all children
  const flatTerms = term.atom.terms.map(t => hashconsTerm(t, state));
  const flatAtom: Atom = { terms: flatTerms };

  // Compute canonical key
  const key = canonicalize(flatAtom);
  if (state.atomToRef.has(key)) {
    return { tag: "Ref", id: state.atomToRef.get(key)! };
  }

  const id = state.nextId++;
  state.atomToRef.set(key, id);
  state.refToAtom.set(id, flatAtom);
  return { tag: "Ref", id };
}
```

Canonicalization: serialize terms to a string that compares equal iff the atoms are structurally equal. Simple approach: JSON.stringify each term with deterministic key order.

## 4. Update insertion in step

In `step.ts`, when inserting a positive node into the output tree:
1. Apply substitution to get the concrete id and atom
2. Hashcons the id term
3. Hashcons each term in the atom
4. Create the node with hashconsed terms
5. Insert into tree

The hashcons state lives on the output tree or is passed through fixpoint.

## 5. Update unification

In `unify.ts`, add case for `Ref` and handle Atom-vs-Ref comparison:

```ts
if (sa.tag === "Ref" && sb.tag === "Ref") {
  return sa.id === sb.id ? subst : null;
}

// Atom vs Ref: look up the ref to get the stored atom, then unify
if (sa.tag === "Atom" && sb.tag === "Ref" && _hcState) {
  const refAtom = _hcState.refToAtom.get(sb.id);
  if (refAtom) return unifyAtoms(sa.atom, refAtom, subst);
}
```

**Key insight**: Patterns contain Atom ids (from `idExpand`), but the reference tree contains Ref ids (after hashconsing). When matching a pattern against the reference, we must look up what each Ref points to. Use a module-global `_hcState` set via `setUnifyHashcons(hc)` before calling `unifyTree`.

## 5b. Update tree.ts termEq

The `findPath` function uses `termEq` to locate nodes by id. It also needs Atom-vs-Ref comparison:

```ts
let _hcState: HashconsState | null = null;
export function setTreeHashcons(hc: HashconsState | null): void { _hcState = hc; }

function termEq(a: Term, b: Term): boolean {
  // ... same-tag cases ...
  // Cross-type: Atom vs Ref
  if (_hcState) {
    if (a.tag === "Atom" && b.tag === "Ref") {
      const refAtom = _hcState.refToAtom.get(b.id);
      return refAtom ? atomEq(a.atom.terms, refAtom.terms) : false;
    }
    // symmetric case...
  }
  return false;
}
```

Call `setTreeHashcons(hc)` in `step` alongside `setUnifyHashcons(hc)`.

## 6. Update term formatting and parsing

In `parse.ts` `formatTerm`:
```ts
case "Ref": return `*${term.id}`;
```

In `parseTerms`, add ref parsing (using `*` prefix since `#` is for aggregates):
```ts
} else if (/^\*\d+$/.test(tok)) {
  terms.push({ tag: "Ref", id: parseInt(tok.slice(1), 10) });
}
```

This allows refs to round-trip through formatting and parsing, which is needed for click interactions that insert node ids into pattern text.

## 7. Update web rendering

In `web.ts` `renderTerm`:
```ts
case "Ref": return `<span class="lit-ref">*${term.id}</span>`;
```

## 8. Thread hashcons state through fixpoint

The `HashconsState` should be created once at the start of `fixpoint` and passed to each `step` call. It accumulates across all iterations.

```ts
export function fixpoint(rawPatterns: Tree[], initial: Tree, gas = 20) {
  const patterns = expandAll(rawPatterns);
  const hashcons = createHashcons();
  // ... loop: step(pattern, reference, hashcons)
}
```

## Migration notes

- Tests filtering by `n.id.tag === "Atom"` must change to `n.id.tag === "Ref"`
- Tests expecting nested Atom structures (e.g., Peano numerals) now get Refs
- The hashcons dictionary is forward-only (no garbage collection)

## Implementation status

Done:
- `Ref` term type in `types.ts`
- `hashcons.ts` with `createHashcons`, `hashconsTerm`, `hashconsAtom`
- `step.ts` hashconses ids and atoms before insertion
- `unify.ts` handles Ref-vs-Ref and Atom-vs-Ref via `setUnifyHashcons`
- `tree.ts` handles Atom-vs-Ref in `termEq` via `setTreeHashcons`
- `fixpoint.ts` creates and threads `HashconsState`
- `aggregate-fold.ts` hashconses agg-result nodes
- `parse.ts` and `web.ts` format/render Refs as `#N`
- All tests updated and passing

## Not in scope

- Garbage collection of unreferenced atoms
- Serialization/deserialization of hashcons state
- Using hashcons for deduplication during parsing (patterns stay as-is)
