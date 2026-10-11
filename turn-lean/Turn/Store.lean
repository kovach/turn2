import Turn.Match

/-!
# Stores: tuples on intervals, and the moment order

A store is a *set of facts*. The implementation encodes everything as tuples
(`_choose`, `_constrain`, `_aggval`, order edges kept in side tables); the
model keeps the kinds apart. Making `Store := Set Fact` gives the complete
lattice the chase needs for free.

Facts that come from *outside* the monotone part — `is` rows appended by the
harness, `_dead-choice` markers, and `#acc` rows written when a moment settles
— are not facts here but `Inputs`: the monotone chase is parameterized by
them, and the moment walk (`Turn.Walk`) is what produces them.
-/

namespace Turn

/-- A stored tuple: `rel args` on the interval `[l, r]`, with its per-firing id
(the universal trailing id slot). -/
structure Tuple where
  rel : Sym
  args : List Val
  id : Val
  l : Moment
  r : Moment

/-- The tuple as a value, for traces. -/
def Tuple.toVal (t : Tuple) : Val := .app [.sym t.rel, .app t.args, t.id, t.l, t.r]

inductive Fact where
  | tuple (t : Tuple)
  /-- an asserted order edge `a < b` (`AssertLt` / `addOrder`) -/
  | edge (a b : Moment)
  /-- a choice term asked at the anchor `[l, r]` (the `_choose` row); its
  *ask moment* is `l` -/
  | ask (c : Val) (actor : Actor) (l r : Moment)
  /-- a constraint block at `[l, r]` (the `_constrain` row): atoms with the
  rule's bindings substituted; remaining variables are block-local
  existentials -/
  | constr (cs : List Atom) (l r : Moment)

abbrev Store := Set Fact

/-- What the monotone chase reads but does not derive. -/
structure Inputs where
  /-- timeless relations: built-ins (`lt`, …) and `#js-def` generators -/
  prim : Sym → List Val → Prop
  /-- `#acc` rows at a moment: `acc m rel args` -/
  acc : Moment → Sym → List Val → Prop
  /-- input tuples: the `is` rows resolving choices, on `[ask moment, top]` -/
  tuples : Set Tuple := ∅

namespace Store

variable (S : Store)

def edgeRel (a b : Moment) : Prop := Fact.edge a b ∈ S

/-- The moment order the store presents (store.ts `lessEq`): reflexive, `bot`
below and `top` above everything, plus paths of asserted edges. -/
def le (a b : Moment) : Prop :=
  a = b ∨ a = .bot ∨ b = .top ∨ Relation.TransGen S.edgeRel a b

def comparable (a b : Moment) : Prop := S.le a b ∨ S.le b a

/-- `Max a b = c` (types.ts `Expr.Max`): defined only on comparable
arguments. Stated relationally, so it is monotone in the store; on an acyclic
store it is a partial function. -/
def IsMax (a b c : Moment) : Prop := (S.le a b ∧ c = b) ∨ (S.le b a ∧ c = a)

def IsMin (a b c : Moment) : Prop := (S.le a b ∧ c = a) ∨ (S.le b a ∧ c = b)

/-- Every moment the store mentions. -/
def moments : Set Moment :=
  {m | m = .bot ∨ m = .top ∨
    (∃ a, Fact.edge m a ∈ S ∨ Fact.edge a m ∈ S) ∨
    (∃ t, Fact.tuple t ∈ S ∧ (m = t.l ∨ m = t.r))}

/-- Lattice join of two moments within the store's moments. The semantics
`discussions/turn-temporal-logic.md` §5.1 recommends instead of `Max`. -/
def IsSup (a b c : Moment) : Prop :=
  c ∈ S.moments ∧ S.le a c ∧ S.le b c ∧ ∀ d ∈ S.moments, S.le a d → S.le b d → S.le c d

def IsInf (a b c : Moment) : Prop :=
  c ∈ S.moments ∧ S.le c a ∧ S.le c b ∧ ∀ d ∈ S.moments, S.le d a → S.le d b → S.le d c

/-- The least upper bound of a finite set of moments (`leastUpperBound`;
`bot` for the empty list). -/
def IsLUBOf (ms : List Moment) (c : Moment) : Prop :=
  c ∈ S.moments ∧ (∀ m ∈ ms, S.le m c) ∧
    ∀ d ∈ S.moments, (∀ m ∈ ms, S.le m d) → S.le c d

/-- No cycles: `le` is antisymmetric. -/
def Acyclic : Prop := ∀ a b, S.le a b → S.le b a → a = b

/-- A tuple is alive at `m` when its interval contains the point
(store.ts `intervalContains(l, r, m, m)`). -/
def alive (t : Tuple) (m : Moment) : Prop := S.le t.l m ∧ S.le m t.r

/-- The tuples alive at `m`: the state an aggregate or a choice observes. -/
def aliveAt (m : Moment) : Set Tuple := {t | Fact.tuple t ∈ S ∧ S.alive t m}

/-- The *causal past* of `m`: tuples started by `m`. Unlike `aliveAt`, this is
closed under derivation for causal programs (`Turn.Walk`). -/
def pastOf (m : Moment) : Set Fact :=
  {f | match f with
    | .tuple t => S.le t.l m
    | .edge a _ => S.le a m
    | .ask _ _ l _ => S.le l m
    | .constr _ l _ => S.le l m}

end Store

theorem Store.le_mono {S S' : Store} (h : S ⊆ S') {a b : Moment} : S.le a b → S'.le a b := by
  sorry

theorem Store.isMax_mono {S S' : Store} (h : S ⊆ S') {a b c : Moment} :
    S.IsMax a b c → S'.IsMax a b c := by
  sorry

/-- On an acyclic store `Max` is functional. -/
theorem Store.isMax_unique {S : Store} (h : S.Acyclic) {a b c c' : Moment} :
    S.IsMax a b c → S.IsMax a b c' → c = c' := by
  sorry

/-- When `Max` is defined it is the lattice join. So the implementation's
pairwise semantics refines the lattice semantics. -/
theorem Store.isMax_isSup {S : Store} (h : S.Acyclic) {a b c : Moment}
    (ha : a ∈ S.moments) (hb : b ∈ S.moments) :
    S.IsMax a b c → S.IsSup a b c := by
  sorry

end Turn
