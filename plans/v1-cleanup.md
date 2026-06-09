# Plan: clean up v1

Goal (from `notes/overview.md` `# clean up v1`):
- move deprecated "v1" code to a `v1/` folder, keeping it complete and runnable
- make v2 free-standing: duplicate the lingering shared modules into `ts/src/v2/`
- ensure the main server application only accesses v2 functionality

## Current state (verified)

**v2 depends on exactly four top-level v1-era modules:**

| module | what v2 uses | notes |
|---|---|---|
| `types.ts` | `Term`, `Atom`, `Span` (type-only, 12 files); `Trail` + `newTrail`/`trailLength`/`trailUnwind` (runtime, `v2/eval.ts`) | also contains v1-only `Tree`, `Constraint`, `TurnExpr`, `MacroInvocation`, `AggregateInfo` |
| `hashcons.ts` | `HashconsState`, `createHashcons`, `hashconsTerm`, `hashconsAtom`, `tokenOfId`, `refTagOf`, `expandTerm` | 136 lines, depends only on `types.ts` |
| `unify.ts` | `resolveVar`, `substTerm`, `substAtom`, `unifyTerms`, `unifyAtoms` | the refstore/lower entanglement starts at `unifyConstraints` (line ~179); the functions v2 uses only need types + hashcons + trail |
| `aggregators.ts` | `aggregators` registry (`v2/parse.ts`), `getAggregator` (`v2/scheduler.ts`) | 66 lines, depends only on `types.ts` |

**v1-only modules** (no v2 imports anywhere): `aggregate-fold.ts`, `constraint-query.ts`, `expand.ts`, `fixpoint.ts`, `fringe.ts`, `lower.ts`, `macros.ts`, `parse.ts`, `refstore.ts`, `scheduler.ts`, `step.ts`, `tree.ts`, `web.ts`, `profile-ttt.ts`. None of them import from `v2/`.

**Top-level v2 entry points** (stay at `ts/src/`): `v2-cli.ts`, `web-v2.ts`, `v2-ascii-demo.ts`, `profile-ttt-v2.ts`. The first two import `./types.js` (type-only: `Atom`, `Term`).

**`pres/`** imports only from `v2/` — unaffected.

**Tests** (`ts/src/tests/`): 9 v1 suites (`enumerators`, `expand`, `fixpoint`, `lower`, `macros`, `order-robust`, `parse`, `tree`, `unify`) import `../<module>.js`; `fixtures/ttt.t` is shared by `order-robust.test.ts` (v1) and `v2_ttt.test.ts` (v2). `v2_overview.test.ts` enforces a 1:1 mapping between `v2/*.ts` files and `# <file>.ts` headings in `v2/overview.md` — new v2 files need overview sections.

**Build/serve**: `tsconfig.browser.json` includes `src/web.ts` (v1), `src/web-v2.ts`, `src/pres/main.ts`. `server.ts` is a pure static file server (no src imports); `index.html` is now just a links page (no v1 UI is reachable — nothing references `web.js`). `index-v2.html` → `/src/web-v2.js`; `index-pres.html` → `/src/pres/main.js`.

## Steps

### 1. Duplicate the shared layer into `v2/` (do this first, while everything still typechecks)

New files under `ts/src/v2/`:

- **`v2/term.ts`** — the core-term subset of `types.ts`: `Term`, `Atom`, `Span`, `NodeId`, `Trail` + `newTrail`/`trailPush`/`trailLength`/`trailLookup`/`trailUnwind`, and the constructors (`sym`, `vari`, `ref`, `atom`, `idTerm`, `isId`). Omit v1-only `Tree`/`TreeBase`/`TreeBody`/`retag`/`Constraint`/`TurnExpr`/`MacroInvocation`/`AggregateInfo`/`MatchConstraint` (v2 has its own `MatchConstraint` in `v2/types.ts`). Compile errors will flag anything the subset misses.
- **`v2/hashcons.ts`** — full copy of `hashcons.ts`, importing from `./term.js`.
- **`v2/unify.ts`** — trimmed copy of `unify.ts`: keep `unifyStats`/`resetUnifyStats`, `resolveVar`, `substTerm`, `substAtom`, `unifyTerms`, `unifyAtoms`; drop the refstore/lower imports, the `Candidate`/`SymbolIndex` re-exports, and `unifyConstraints`/`enumerateSize`/`unifyTree`/`collectMatches`.
- **`v2/aggregators.ts`** — full copy of `aggregators.ts`, importing from `./term.js`.

Then rewrite imports:
- in `v2/*.ts`: `../types.js` → `./term.js`, `../hashcons.js` → `./hashcons.js`, `../unify.js` → `./unify.js`, `../aggregators.js` → `./aggregators.js`
- in `v2-cli.ts` and `web-v2.ts`: `./types.js` → `./v2/term.js`

Run the v2 test suites + `npm run build` before proceeding; v2 must now compile with zero `../` escapes outside `v2/` (check: `grep -rn 'from "\.\./' ts/src/v2/` should only show nothing, or only `./`-local paths).

### 2. Move v1 to `ts/src/v1/`

`git mv` these 18 files into `ts/src/v1/`: the 14 v1-only modules above plus the original `types.ts`, `hashcons.ts`, `unify.ts`, `aggregators.ts` (v1 keeps its full, untrimmed copies so it remains complete and runnable).

All intra-v1 imports are `./`-relative, so they survive the move unchanged. `index.ts` (hello-world `npm run dev` stub) and `server.ts` stay at top level.

### 3. Update the v1 tests

In the 9 v1 test files, rewrite `../<module>.js` → `../v1/<module>.js`. They stay in `src/tests/` so `run-tests.sh` (globs `src/tests/*.test.ts`, accepts bare names) keeps working unchanged. `fixtures/` stays put.

### 4. Build & serve config

- `tsconfig.browser.json`: change `src/web.ts` → `src/v1/web.ts` in `include` (keeps the v1 browser bundle building, satisfying "we could go back and run v1"). No html page loads it today — `index.html` became a links page in commit 932a437 — so nothing else changes. If we later want a live v1 page, restore the old `index.html` from git history as `ts/v1.html` plus a `/v1` route in `server.ts` (optional, not required by the goal).
- `package.json`: no changes (`v2` script path unchanged; `serve`/`watch` unaffected).
- `server.ts`: no code changes needed — it's a static server and the pages it serves (`index.html` links page, `index-v2.html`, `index-pres.html`) reference only v2/pres bundles. Verify after the move that `/v2` playground and `/pres` still load.

### 5. Docs

- **`ts/src/v2/overview.md`**: add `# term.ts`, `# hashcons.ts`, `# unify.ts`, `# aggregators.ts` sections (required — `v2_overview.test.ts` fails otherwise).
- **`CLAUDE.md`**: update the deprecation note to say v1 lives at `ts/src/v1/`.
- **`notes/overview.md`**: nothing beyond the plan link (already done).

### 6. Verification

1. `./run-tests.sh` — all 27 suites pass (v1 suites prove the moved code still runs).
2. `npm run build` — both tsconfigs compile.
3. `npm run v2 -- ../example.sl` (or the v2-debug skill) — CLI smoke test.
4. `npm run serve` (or watch.sh) — load `/`, `/v2/playground`, `/pres` and confirm the tic-tac-toe example evaluates.

## Risks / notes

- The trimmed `v2/unify.ts` is the only non-mechanical copy; the cut point is clean (refstore usage starts at `unifyConstraints`) but let the compiler confirm no kept function references a dropped one.
- Deliberate divergence: v1's and v2's copies of types/hashcons/unify/aggregators will drift apart over time. That's the point — v1 is frozen; never share edits across the boundary. The two hashcons instances never interoperate at runtime (each `Store`/v1 run owns its own state), so duplication is safe.
- `profile-ttt-v2.ts` imports only `v2/*` and `fs` — unaffected by the move but listed here so it isn't mistaken for v1 (its v1 twin `profile-ttt.ts` does move).
