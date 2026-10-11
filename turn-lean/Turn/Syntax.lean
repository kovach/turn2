import Mathlib

/-!
# Kernel Turn: values, terms, and rule syntax

The *kernel* is the surface language after parsing and the purely syntactic
desugarings (dot chains, arity saturation, `#macro`, `#type` resolution), but
**before** anchor decomposition (expand.ts `decomposeRule`). It keeps the
source-level markers, so its semantics (`Turn.Body`) can be read directly as
the anchor-threading table of `discussions/turn-temporal-logic.md` §1. The flat
post-expand IR (`Match`/`Emit`/`Le`/`AssertLt`/`Equal`) is a later target; see
`PLAN.md`, phase 3.

Left out of the kernel, each for a stated reason:

* `#agg`, `#reactive`, bracket `[ … ]` aggregation: superseded by `#acc`
  (plans/v2-acc-relations.md §10).
* exceptions `{p t̄ => e}`: eliminated source-to-source by `applyExceptions`
  into ordinary rules plus a `bool` flag relation (phase 5 in `PLAN.md`).
* `@js(…)` term functions: `+m @js(f X)` is `f' X Y, +m Y` where `f'` is the
  graph of `f`, i.e. a timeless primitive relation (`Item.prim`).
-/

namespace Turn

abbrev Sym := String
abbrev Var := String

/-- What a Skolem term was minted for. The implementation's fresh templates
`*mom`, `*id`, `*choose` and the universal trailing id slot. -/
inductive SkKind where
  /-- left endpoint of a `+`/`~` emit (`*mom … l`) -/
  | momL
  /-- right endpoint of a `~` emit (`*mom … r`) -/
  | momR
  /-- fresh object for an emit variable that is unbound so far (`*id`) -/
  | obj (x : Var)
  /-- the per-firing id slot every emitted tuple carries (`_emitId`) -/
  | tupleId
  /-- a choice term minted by `?x` (`*choose`) -/
  | choose (x : Var)
  deriving DecidableEq

/-- Ground values. Moments are values too (as in the implementation, where
moment names are hashconsed terms): `bot`, `top`, and Skolem terms of kind
`momL`/`momR`.

A Skolem term records the rule, the item's position path inside the rule
body, its kind, and the firing's *trace* (every value the firing consulted
so far, in order) — the formal counterpart of the `(*chain …)` fingerprint,
minus the liveness pruning of expand-liveness.ts. -/
inductive Val where
  | sym (s : Sym)
  | app (vs : List Val)
  | sk (rule : Nat) (path : List Nat) (kind : SkKind) (trace : List Val)
  | bot
  | top

abbrev Moment := Val

/-- Peano numerals, the representation `@count`/`@min`/`@arg-min` use. -/
def Val.peano : ℕ → Val
  | 0 => .sym "z"
  | n + 1 => .app [.sym "s", Val.peano n]

/-- Patterns. Symbols are `val (.sym s)`. -/
inductive Term where
  | val (v : Val)
  | var (x : Var)
  | wild
  | app (ts : List Term)

/-- A relation atom `rel t₁ … tₙ`. -/
structure Atom where
  rel : Sym
  args : List Term

/-- Who resolves a choice (types.ts `Actor`). -/
inductive Actor where
  | you
  | rng
  deriving DecidableEq

/-- Body items. One constructor per source marker / construct.

| item | source | anchor effect |
|---|---|---|
| `atom a` | `p t̄` | narrow to `A ∩ [l, r]` |
| `sub B` | `(B)` | run `B`, keep its bindings, restore `A` |
| `seq B` | `(B);` | run `B`, continue on `[B.r, A.r]` |
| `eq t u` | `t = u` | none |
| `prim r t̄` | `lt`/`gt`/`le`/`ge`, `#js-def` | none (timeless) |
| `accRead a` | match of an `#acc` relation | none (point read at `A.l`) |
| `notAcc a` | `not r t̄` on an `#acc` relation | none (no row at `A.l`) |
| `episode a` | `~a` | `[l, r]`, fresh, `A.l < l < r < A.r` |
| `fact a` | `+a` | `[l, A.r]`, fresh, `A.l < l < A.r` |
| `here a` | `^a` | `[l, A.r]`, fresh, `A.l < l < A.r` (at `[bot, top]`: none) |
| `ask act x̄` | `?[act] x̄` | none |
| `constrain c̄` | `!(c̄)` | none |

`^` mints a fresh left end like `+` and ends with the anchor
(plans/v2-caret-fresh-left.md §2); at the initial anchor `[bot, top]` it emits
exactly there (the implementation's test is static — "nothing narrowed the
anchor yet" — the model's is dynamic). `is` rows are ordinary tuples on
`[ask moment, top]`, supplied by the walk as input tuples (`Inputs.tuples`).
`#agg`, `#reactive`, bracket aggregation and `#macro` no longer exist. -/
inductive Item where
  | atom (a : Atom)
  | sub (body : List Item)
  | seq (body : List Item)
  | eq (t u : Term)
  | prim (r : Sym) (args : List Term)
  | accRead (a : Atom)
  | notAcc (a : Atom)
  | episode (a : Atom)
  | fact (a : Atom)
  | here (a : Atom)
  | ask (actor : Actor) (xs : List Var)
  | constrain (cs : List Atom)

abbrev Body := List Item

namespace Item

/-- Items that emit facts (and whose continuation waits for them). -/
def isEmit : Item → Bool
  | .episode _ | .fact _ | .here _ | .ask _ _ | .constrain _ => true
  | _ => false

/-- Items that mint moments (and so need a non-degenerate anchor under the
strict semantics). -/
def mintsMoment : Item → Bool
  | .episode _ | .fact _ | .here _ => true
  | _ => false

end Item

/-- The `#acc` op registry names (acc-ops.ts). Their algebra is in `Turn.Acc`. -/
inductive AccOpName where
  | sum
  | count
  | min
  | last
  | argMin
  | bool
  deriving DecidableEq

/-- `#acc rel : col…`. `aggIndex = none` is a boolean relation. -/
structure AccDecl where
  rel : Sym
  arity : Nat
  aggIndex : Option Nat
  op : AccOpName

/-- An acc rule `body / head`. The body uses only `atom`, `eq`, `prim` and
`accRead`; the head is one atom of a declared acc relation whose agg column
holds the contribution. -/
structure AccRule where
  body : Body
  head : Atom

structure Program where
  rules : List Body
  accDecls : List AccDecl
  accRules : List AccRule

/-! ## Syntactic helpers (variables, substitution) -/

mutual
/-- Variables of a term, in order of occurrence. -/
def Term.vars : Term → List Var
  | .val _ => []
  | .var x => [x]
  | .wild => []
  | .app ts => Term.varsL ts
def Term.varsL : List Term → List Var
  | [] => []
  | t :: ts => Term.vars t ++ Term.varsL ts
end

def Atom.vars (a : Atom) : List Var := Term.varsL a.args

mutual
/-- Apply a function to every embedded value. Used to plug choice values into
constraint atoms. -/
def Term.mapVal (f : Val → Val) : Term → Term
  | .val v => .val (f v)
  | .var x => .var x
  | .wild => .wild
  | .app ts => .app (Term.mapValL f ts)
def Term.mapValL (f : Val → Val) : List Term → List Term
  | [] => []
  | t :: ts => Term.mapVal f t :: Term.mapValL f ts
end

def Atom.mapVal (f : Val → Val) (a : Atom) : Atom := ⟨a.rel, Term.mapValL f a.args⟩

mutual
/-- Replace values `θ` assigns (choice terms) everywhere inside a value. -/
def Val.replace (θ : Val → Option Val) : Val → Val
  | v@(.sym _) => (θ v).getD v
  | v@(.app vs) => (θ v).getD (.app (Val.replaceL θ vs))
  | v@(.sk r p k tr) => (θ v).getD (.sk r p k (Val.replaceL θ tr))
  | .bot => .bot
  | .top => .top
def Val.replaceL (θ : Val → Option Val) : List Val → List Val
  | [] => []
  | v :: vs => Val.replace θ v :: Val.replaceL θ vs
end

end Turn
