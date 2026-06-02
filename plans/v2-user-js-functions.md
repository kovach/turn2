# v2 — user-defined JS functions

## Goal

Declare a pure JS helper at top level and call it inside a rule atom to compute
a term from bound arguments.

```
#js (div x y) { return Math.round(x / y); }
```
compiles to `function div(x, y) { return Math.round(x / y); }`, called as:
```
+foo @js(div X 4)
```

Every variable in `@js(...)` must already be bound where the call appears — by an
earlier term in the same atom, or an earlier atom. Checked statically during
decompose. The function runs at eval time once args are ground; its return value
becomes the term.

## Design

`@js(...)` is not a stored value and must never reach hashcons / unify / the
store. We lower each call to a fresh variable `V` plus a `JsCall` computation
atom (sibling of `Max`/`Min`/`Equal`) that runs in body order and binds `V`.

Two choices keep the blast radius small:

1. **No new `Term` variant.** The parser emits `@js(name a1..an)` as an ordinary
   compound term with reserved head `*js`: `Atom([Symbol("*js"), Symbol(name),
   ...args])`. The `*`-prefix is already reserved for compiler terms (parseTerms
   parse.ts:856-861; head-sym guard parse.ts:709-712), so `hashconsTerm` /
   `unifyTerms` / `substTerm` / `renderTerm` need no new case. The `*js` term is
   consumed during decompose and never survives into post-expand IR.
2. **One new `RuleAtom` variant `JsCall`**, treated like `Equal` in the remaining
   expand passes, with its own evaluator case.

Pipeline:
```
parse      #js -> Program.jsDefs;  @js(...) -> Atom([*js, name, ..args])
decompose  emitBindingsAndRewrite lowers each *js term to a JsCall + fresh var V
expand     split / delta-variant / liveness: treat JsCall like Equal
eval       evalJsCall: decode args -> run compiled body -> encode result -> unify V
```

## Changes

### 1. Types (`ts/src/v2/types.ts`)

New `RuleAtom` variant (sibling of `Equal`, ~types.ts:103):
```ts
| { tag: "JsCall"; func: string; args: Term[]; out: Term; span: Span }
```
Extend `Program` (types.ts:189):
```ts
export interface JsDef { name: string; params: string[]; body: string; span: Span }
export interface Program { rules: Rule[]; schema: Map<string,string>; jsDefs: Map<string, JsDef> }
```

### 2. Parser — `#js` directive (`ts/src/v2/parse.ts`)

- **Tokenizer (parse.ts:120-148):** add a `name === "js"` branch beside `def`.
  The body is a brace block spanning multiple lines: capture from the current
  line through the brace-balanced `{...}`, consuming `lines[]` and advancing
  `li`. Read the body from the **raw** lines, not the `stripComment`-ed `raw`
  (parse.ts:68) — `--` is not treated as a comment inside a `#js` body; preserve
  newlines. Brace counting is lexical (does not skip braces inside JS
  string/regex literals — document this limit). Emit `{tag:"command",
  name:"js", argText:<signature + raw {...}>, line}`. Error on EOF with
  unbalanced braces.
- **`parseCommand` (parse.ts:197):** add a `js` case. Parse signature
  `(name p1..pn)` — name and each param a lowercase symbol, name not a reserved
  auto-name (mirror parse.ts:205-208). Body = brace-balanced substring after the
  first `{`. Return `{kind:"js", name, params, body, line}`.
- **`Command` type (parse.ts:26-29):** add `| {kind:"js"; name; params; body; line}`.
- **`parseProgram` (parse.ts:220-250):** collect `js` commands into a `jsDefs`
  map (error on duplicate name); does **not** require a following rule. Init
  `jsDefs: new Map()` where `Program` is built.

### 3. Parser — `@js(...)` calls (`ts/src/v2/parse.ts`)

- **`tokenizeTermText` (parse.ts:835):** break `@js` off as its own token —
  `.replace(/@js\(/g, " @js ( ")`.
- **`parseTerms` (parse.ts:847-873):** on `tok === "@js"`, require `(`, recurse
  for the inner list, require `)`. First inner term must be a Symbol (the name).
  Push `Atom([Symbol("*js"), ...inner])`. Errors: missing `(`, unbalanced
  parens, non-symbol head.

### 4. Lowering in `emitBindingsAndRewrite` (`ts/src/v2/expand.ts`)

`emitBindingsAndRewrite` (expand.ts:293-317) already walks each positive atom's
terms left-to-right, maintaining `state.seen` at term granularity (a var enters
`seen` the moment it is rewritten, line 303). Add a `*js`-head case before the
generic Atom/Id recursion (line 312):

```
if term is Atom/Id with head Symbol "*js":
  const [_, nameSym, ...rawArgs] = term.atom.terms
  validate vs jsDefs: function exists, rawArgs.length === params.length
  const args = rawArgs.map(a => {
    if a is Variable && a.name !== "_" && !state.seen.has(a.name)
      error `@js(<name> ...): <a.name> not bound before this use`
    if a is Wildcard error `@js(<name> ...): '_' has no value`
    return emitBindingsAndRewrite(a, state, lexPos, span)   // nested @js + compound data
  })
  const V = { tag:"Variable", name:`_js_${state.jsCounter++}` }   // new counter on DecState
  state.out.push({ tag:"JsCall", func: nameSym.name, args, out: V, span })
  state.seen.add(V.name); state.chain.push(V); state.essential.add(V.name)
  return V
```

Reusing `state.seen` for the check gives the desired scoping for free:
`foo X @js(f X)` (X bound by the earlier term), X bound by an earlier atom, and
nested `@js(f @js(g X) Y)` all work; `+foo @js(f X)` with X nowhere else errors.
The one custom bit vs. the existing mechanism: for an unbound var the default
behavior *invents* a fresh id (lines 299-306); `@js` errors instead, since an
argument must be a real prior value.

**Restriction (v1):** handle `@js` only in positive emit atoms (markers
`fact`/`episode`/`anchor`/`ask`), which flow through this loop. In `match`
patterns, `=` equalities (decomposeBody Equal branch, expand.ts:326), `!(...)`
constrains, and aggregate patterns a `*js` term would survive unlowered. Guard
with a helper `assertNoJsHead(term)` called from `collectVarsTerm`, raising
"@js not supported here (yet)".

### 5. Expand passthrough (`JsCall` ≈ `Equal`)

`JsCall` is produced during decompose, so it appears only post-expand;
`decomposeBody` needs no source case. Later passes must carry it and not prune it:
- **liveness `pruneChains` (expand-liveness.ts:57,79,98):** add `JsCall` cases
  beside `Equal` — `out` is a def, args are uses; never prune (assume possible
  effects).
- **`splitRule` / positivity (expand.ts:80):** classify `JsCall` as non-positive
  scaffolding like `Equal` (not an emit, not a split point).
- **`generateDeltaVariants`:** no change (only `Match` count matters); verify
  `tagBody` copies `JsCall` untouched.

### 6. Term encoding / decoding

New module `ts/src/v2/js-values.ts` — single source of truth for the Term↔JS
mapping (modular so nat-syntax can refine numerics later):

| Term | JS |
|---|---|
| compound `(pair x (f y))` | array `["pair","x",["f","y"]]` |
| `Symbol` non-numeric `x` | string `"x"` |
| `Symbol` matching `/^-?\d+$/` | number |
| — | `boolean` → `0`/`1` (encode only) |

```ts
function decodeTerm(t: Term, hc: HashconsState): unknown {
  switch (t.tag) {
    case "Ref":    return decodeTerm(expandRef(t.id, hc), hc);
    case "Symbol": return /^-?\d+$/.test(t.name) ? Number(t.name) : t.name;
    case "Atom":
    case "Id":     return t.atom.terms.map(x => decodeTerm(x, hc));
    default:       throw new Error("internal: @js arg not ground at decode");
  }
}
function encodeTerm(v: unknown): Term {
  if (typeof v === "number")  return { tag:"Symbol", name:String(v) };
  if (typeof v === "string")  return { tag:"Symbol", name:v };
  if (typeof v === "boolean") return { tag:"Symbol", name: v ? "1" : "0" };
  if (Array.isArray(v))       return { tag:"Atom", atom:{ terms: v.map(encodeTerm) } };
  throw new Error(`@js: cannot encode return of type ${typeof v}`);
}
```

`expandRef(id, hc)` reads the stored body via `hc.refToAtom` + `refTagOf`
(unify.ts:113-122). `encodeTerm` returns a raw Term; `unifyTerms`/`bindable`
(unify.ts:74-78) hashconses it when binding `out`, so no interning here.

Decisions (flag to change): numeric symbols decode to JS numbers (so
`Math.round(x/y)` works; round-trips since `encode(4)===encode("4")===Symbol("4")`);
`number` encodes to a plain symbol for now (the one spot to revisit under
nat-syntax); `Id` args decode like `Atom`; unsupported returns throw.

### 7. Evaluator (`ts/src/v2/eval.ts`)

- `Ctx` (~eval.ts:35) gains `jsFuncs: Map<string, CompiledJs>` (§8); thread a
  `jsFuncs` param through `evaluateRule` (eval.ts:37-49).
- `evalSeq` dispatch (eval.ts:64-75): add `case "JsCall": evalJsCall(a, ctx, next); return;`
- `evalJsCall` (model on `evalMaxMin`):
```ts
function evalJsCall(a, ctx, next) {
  const args = a.args.map(t => substTerm(t, ctx.trail)); // may contain Refs
  const fn = ctx.jsFuncs.get(a.func);
  if (!fn) throw new Error(`@js(${a.func} ...): undefined #js function`);
  let term: Term;
  try { term = fn(ctx.store.hash, args); }
  catch (e) { throw new Error(`@js(${a.func} ...) threw: ${(e as Error).message}`); }
  const mark = trailLength(ctx.trail);
  if (unifyTerms(a.out, term, ctx.trail, ctx.store.hash)) next();
  trailUnwind(ctx.trail, mark);
}
```
The §4 scope check guarantees args are bound, so no extra runtime groundness guard.

### 8. Function compilation

Compile once before the fixpoint; decode args / run untouched body / encode result:
```ts
type CompiledJs = (hc: HashconsState, args: Term[]) => Term;
function compileJsDefs(jsDefs: Map<string, JsDef>): Map<string, CompiledJs> {
  const m = new Map<string, CompiledJs>();
  for (const [name, d] of jsDefs) {
    const inner = new Function(...d.params, d.body) as (...xs: unknown[]) => unknown;
    m.set(name, (hc, args) => encodeTerm(inner(...args.map(t => decodeTerm(t, hc)))));
  }
  return m;
}
```
Body is verbatim (user writes a complete body incl. `return`). A malformed body
throws here, before the fixpoint — wrap as `#js <name>: <error>`. Decoding/encoding
*around* the untouched body means multiple `return`s need no handling — this
realizes the overview's "decode args / encode at return" without parsing `return`.

Wire-up: at the `evaluateRule` caller (`fixpoint.ts`/`scheduler.ts`),
`compileJsDefs(program.jsDefs)` once and pass the map down.

### 9. Rendering

No change: no `*js`/`JsCall` reaches the store, and there is no v2 source
re-formatter. (A future pre-expand IR dumper would render `*js` as
`@js(name args...)`.)

## Tests (`ts/src/tests/v2_js.test.ts`)

1. Parse `#js` (single- and multi-line body) into `Program.jsDefs`.
2. Parse `@js(div X 4)` → `Atom([*js, div, X, 4])`.
3. End-to-end `+foo @js(div X 4)` with `X` bound to a numeric symbol.
4. Same-atom binding `+foo X @js(f X)`.
5. Nested `@js(f @js(g X) Y)`.
6. Compound round-trip, e.g. `#js (swap p) { return [p[0], p[2], p[1]]; }` on
   `(pair a b)` → `(pair b a)`.
7. `Ref` arg decodes (arg bound to a hashconsed compound from a prior match).
8. Boolean return → `0`/`1`.
9. Errors: arity mismatch; unknown function; unbound variable; malformed body;
   body throws at runtime; unsupported return type.

Run `./run-tests.sh v2_js` plus the full suite (the `Program`/`evaluateRule`
signature changes ripple to callers).
