# Mutable-Trail Substitution

## Problem

The linked-list `Substitution` (`SubstFrame | null`) allocates one small object per variable binding. At profile load the GC cost of these short-lived pairs dominates — each successful ttt iteration drops hundreds into the nursery. The structural sharing buys us nothing because no two search branches retain their substitutions past the leaf that consumes them.

## Goal

Replace per-binding allocation with a **single mutable array shared across the entire search**. Bind = push; backtrack = `array.length = mark`. V8 preserves backing capacity on length-truncation, so after warmup there should be zero allocations in the unifier hot path — remaining allocations are only at successful leaves (one new tree node per insert).

## Data Structure

In `types.ts`, replace the `Substitution`/`SubstFrame` API with:

```ts
export interface Trail {
  names: string[];   // variable names, in bind order
  terms: Term[];     // parallel: terms[i] is what names[i] is bound to
}

export const newTrail = (): Trail => ({ names: [], terms: [] });

export const trailLength = (t: Trail): number => t.names.length;

export function trailPush(t: Trail, name: string, term: Term): void {
  t.names.push(name);
  t.terms.push(term);
}

export function trailUnwind(t: Trail, mark: number): void {
  t.names.length = mark;
  t.terms.length = mark;
}

export function trailLookup(t: Trail, name: string): Term | undefined {
  const names = t.names;
  for (let i = names.length - 1; i >= 0; i--) {
    if (names[i] === name) return t.terms[i];
  }
  return undefined;
}
```

Two parallel arrays (`string[]`, `Term[]`) instead of an array of `{name, term}` objects — this avoids the per-entry wrapper allocation entirely. Arrays hold references into existing tables (variable names are already interned by the parser; terms are either primitives or references into the hashcons).

Lookup scans from the tail so shadowing is implicit (most-recent binding wins — same semantics as the linked list).

**Trail is O(depth) in size.** Typical depth ≤ ~10 per branch. Linear scan of a dense `string[]` with JIT-friendly reference equality should beat the current linked walk + per-node field loads.

## Control-Flow Refactor: CPS

A single mutable trail is incompatible with the current "return `SearchState[]`" pattern: once a branch unwinds its bindings, any previously returned state from that branch is stale. We convert the search to visitor/CPS style — each successful leaf invokes a callback *before* backtracking, and the callback uses the live trail immediately.

### unify.ts entry point

```ts
export function unifyTree(
  pattern: Tree,
  reference: Tree,
  iteration: number,
  visit: (trail: Trail) => void,
): void {
  const lt = pattern.literal.literalType;
  if (lt.tag !== "Match" || pattern.literal.atom.terms.length !== 0) return;
  if (!passesConstraint(reference, lt.constraint, iteration)) return;

  const trail = newTrail();
  if (!unifyTerms(pattern.id, reference.id, trail)) return;

  const candidates = collectNodes(reference, []);
  const index = buildSymbolIndex(candidates);
  const state: SearchState = {
    deepest: [], trail, root: reference, index, allCandidates: candidates, iteration,
  };
  matchChildren(pattern.children, state, () => visit(trail));
}
```

### Search functions: callbacks + trail marks

```ts
type Visit = () => void;

function matchChildrenFrom(
  patChildren: Tree[], idx: number, state: SearchState, visit: Visit,
): void {
  if (idx >= patChildren.length) { visit(); return; }
  const head = patChildren[idx]!;
  const ht = head.literal.literalType;

  if (ht.tag === "Equal") {
    const terms = head.literal.atom.terms;
    if (terms.length !== 2) return;
    const mark = trailLength(state.trail);
    if (unifyTerms(terms[0]!, terms[1]!, state.trail)) {
      matchChildrenFrom(patChildren, idx + 1, state, visit);
    }
    trailUnwind(state.trail, mark);
    return;
  }

  if (ht.tag !== "Match" && ht.tag !== "Before") {
    matchChildrenFrom(patChildren, idx + 1, state, visit);
    return;
  }

  const anchor = computeAnchor(patChildren, idx, state);
  matchSubtree(head, state, anchor, () => {
    matchChildrenFrom(patChildren, idx + 1, state, visit);
  });
}

function matchSubtree(pat: Tree, state: SearchState, anchor: number[], visit: Visit): void {
  // ... candidate filtering as before
  for (const { path, node } of candidates) {
    if (!passesConstraint(node, constraint, state.iteration)) continue;
    if (isBefore ? !isTemporallyBefore(path, anchor) : !isStrictDescendant(state.deepest, path)) continue;

    const mark = trailLength(state.trail);
    if (unifyNode(pat, node, state.trail)) {
      const prevDeepest = state.deepest;
      state.deepest = path;
      matchChildren(pat.children, state, visit);
      state.deepest = prevDeepest;
    }
    trailUnwind(state.trail, mark);
  }
}
```

Key points:
- Every choice point saves `mark = trailLength(trail)` before trying a branch, unwinds on return.
- `state.deepest` is mutated in place and restored — no more `{...state, deepest: path}` spread per branch (which allocates).
- `SearchState` is one long-lived record, not per-branch copies.

### unifyTerms / unifyAtoms / unifyNode: return boolean

```ts
function unifyTerms(a: Term, b: Term, trail: Trail): boolean {
  const sa = substTerm(a, trail);
  const sb = substTerm(b, trail);
  if (sa.tag === "Wildcard" || sb.tag === "Wildcard") return true;
  if (sa.tag === "Symbol" && sb.tag === "Symbol") return sa.name === sb.name;
  if (sa.tag === "Ref" && sb.tag === "Ref") return sa.id === sb.id;
  if (sa.tag === "Variable") {
    if (sb.tag === "Variable" && sa.name === sb.name) return true;
    trailPush(trail, sa.name, sb);
    return true;
  }
  if (sb.tag === "Variable") {
    trailPush(trail, sb.name, sa);
    return true;
  }
  if (sa.tag === "Atom" && sb.tag === "Atom") return unifyAtoms(sa.atom, sb.atom, trail);
  // ... Atom/Ref via hashcons, as before
  return false;
}

function unifyAtoms(pa: Atom, ra: Atom, trail: Trail): boolean {
  if (pa.terms.length !== ra.terms.length) return false;
  const mark = trailLength(trail);
  for (let i = 0; i < pa.terms.length; i++) {
    if (!unifyTerms(pa.terms[i]!, ra.terms[i]!, trail)) {
      trailUnwind(trail, mark);  // roll back partial bindings on mid-sequence failure
      return false;
    }
  }
  return true;
}
```

- `unifyTerms` either pushes 0 or 1 bindings, never leaves a partial state on failure.
- `unifyAtoms` pushes N and **must** unwind on mid-stream failure (otherwise subsequent lookups in the same trail see stale bindings).
- Callers of `unifyAtoms`/`unifyNode` also wrap in their own mark/unwind for the choice-point semantics — the inner unwind and outer unwind compose (the outer one is a no-op if inner already cleaned up).

### substTerm / substAtom

```ts
export function substTerm(term: Term, trail: Trail): Term {
  let t = term;
  while (t.tag === "Variable") {
    const bound = trailLookup(trail, t.name);
    if (bound === undefined) break;
    t = bound;
  }
  if (t.tag === "Atom") return { tag: "Atom", atom: substAtom(t.atom, trail) };
  return t;
}
```

Unchanged semantics. `substAtom` on a fully-resolved ground atom still allocates (to build the new `Atom`) but that's at leaf usage, not per binding.

## Callers

### step.ts — inline per-result work

```ts
export function step(pattern: Tree, reference: Tree, hc: HashconsState, iteration = 1): Tree | null {
  setUnifyHashcons(hc);
  setTreeHashcons(hc);
  const refCopy = cloneTree(reference);
  const positives = collectPositiveNodes(pattern);
  let anyInserted = false;

  unifyTree(pattern, reference, iteration, (trail) => {
    for (const posNode of positives) {
      // body identical to today, but reads `trail` instead of a Substitution
      const posPath = findPath(posNode.id, pattern)!;
      // ... substTerm(parent.id, trail), findPath, substAtom(..., trail), etc.
      anyInserted = true;
    }
  });

  return anyInserted ? refCopy : null;
}
```

The callback runs while the trail is live. `substTerm(posNode.id, trail)` resolves variables against the current bindings and returns a ground term (Ref / Symbol / Atom). That ground term is captured into the hashcons; the trail is unwound afterward but the Ref id is stable.

### expand.ts:21

One-off call with a single binding. Build an ad-hoc scratch trail:

```ts
const t = newTrail();
trailPush(t, node.id.name, newId);
const atom = substAtom(node.literal.atom, t);
```

Or add a convenience `substAtomWithOne(name, term, atom)` — but it's only one site, inline is fine.

## Test Impact

`unify.test.ts` currently does:

```ts
const results = unifyTree(pattern, reference);
assert.equal(results.length, 1);
assert.deepEqual(substStr(results[0]!), { A: "ra", B: "rb" });
```

With a live-trail API the tests must collect results inside the visitor. Introduce one test helper:

```ts
function collect(pattern: Tree, reference: Tree, iteration = 1): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  unifyTree(pattern, reference, iteration, (trail) => {
    const row: Record<string, string> = {};
    // trail.names can contain duplicates (shadowing) — walk tail-first and skip seen
    const seen = new Set<string>();
    for (let i = trail.names.length - 1; i >= 0; i--) {
      const k = trail.names[i]!;
      if (seen.has(k)) continue;
      seen.add(k);
      const v = trail.terms[i]!;
      row[k] = v.tag === "Symbol" ? v.name : v.tag === "Variable" ? v.name : "?";
    }
    out.push(row);
  });
  return out;
}
```

Rewrite each test to call `collect(...)` and assert on the returned array. Length assertions (`assert.equal(results.length, N)`) stay. `substStr(results[0])` becomes `results[0]` directly.

## Migration Order

1. Add the Trail API in `types.ts` alongside the existing Substitution API (no removal yet).
2. Port `unify.ts` wholesale: boolean-returning unify primitives, CPS search, `unifyTree(..., visit)`.
3. Port `step.ts` to the callback form.
4. Port `expand.ts:21` to a scratch trail.
5. Port `unify.test.ts` using the `collect` helper.
6. Delete `Substitution` / `SubstFrame` / `emptySubst` / `substBind` / `substLookup` / `substSize` / `substEntries` from `types.ts`.
7. Run tests + profile.

Keeping both APIs live during steps 1–5 avoids a big red-screen moment; the old API disappears only once nothing references it.

## Expected Performance

- **Per bind**: two `Array.push` onto arrays that (after warmup) already have capacity → ~0 allocation.
- **Per backtrack**: two `.length = n` assignments → 0 allocation, 0 work beyond a length update.
- **Per lookup**: linear scan of a small dense array — almost certainly faster than the linked walk *and* cache-friendlier than a Map.
- **Per leaf success**: whatever the callback allocates (a new tree node for step's insertion path). Proportional to *actual derived facts*, not to exploration steps.

Net: GC pressure should drop to near-zero in the unifier. `ttt.cpuprofile` should show the unifier's share of self-time shift from allocation/GC bars to actual comparison work.

## Gotchas

- **Callback must not retain the trail**. Document on `unifyTree`'s API. If a caller ever needs to keep a substitution past the visit (none today), add a `snapshot(trail): {names: string[], terms: Term[]}` helper.
- **Rollback on partial-unification failure** in `unifyAtoms` is mandatory — easy to forget; test with a pattern that fails on the last term of a multi-term atom.
- **`state.deepest` save/restore** in `matchSubtree` — must restore before falling through to the next candidate.
- **Variable shadowing**: bind pushes a fresh entry without checking for an existing one. Lookup walks tail-first so the new binding shadows. This matches the linked-list semantics. If the search ever rebinds a variable (it shouldn't under standard unification), the trail still unwinds correctly.
- **`state` is now mutated in place** across branches — any future change that adds fields to `SearchState` must think about save/restore just like `deepest`.

## Follow-Ups (Not In Scope)

- Intern variable names to integers (analogous to the hashcons symbol table) and use `Int32Array` for `trail.names`. Lookup becomes integer equality; arrays become denser.
- Per-variable last-binding index (`Map<string, number>`) for O(1) lookup if profiling shows trail scans are hot — only worth it if branches routinely push >30 bindings.
