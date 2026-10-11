import Turn.Body

/-!
# `#acc` relations: computed at a moment

An acc relation's rows at a moment `m` are a function of the state alive at
`m` (plans/v2-acc-relations.md). The relation's `body / head` rules derive
*contributions*: they read tuples alive at `m` and other acc relations' rows
at `m`. The declared op folds each key's contributions as `ρ(⊕ᵢ η(cᵢ))`. A
recursive stratum iterates with accumulating contributions.

An acc rule body is an ordinary body run at the point anchor `[m, m]`.
`narrow` at a point is exactly point containment (`l ≤ m ≤ r`, and
`Max(m, l) = m`), so `RunB` is reused unchanged.
-/

namespace Turn

open Classical

/-- An op of the registry (acc-ops.ts `AccOpDef`): a commutative monoid
`(M, +, 0)` standing for `(M, ⊕, e)`, with injection `η` and readout `ρ`.
Domain errors of `η` are not modelled. -/
structure AccOp where
  M : Type
  [inst : AddCommMonoid M]
  /-- η: a contribution's value (and its moment, for `@last`) → monoid -/
  inject : Val → Moment → M
  /-- ρ: monoid element → zero or more value terms -/
  readout : M → Set Val

attribute [instance] AccOp.inst

def AccOp.Idempotent (op : AccOp) : Prop := ∀ a : op.M, a + a = a

/-- A join-semilattice with bottom, as a commutative monoid (`+ := ⊔`). The
idempotent ops are of this form. -/
def SupMon (α : Type) := α

instance {α : Type} [SemilatticeSup α] : Add (SupMon α) := ⟨@Max.max α _⟩
instance {α : Type} [Bot α] : Zero (SupMon α) := ⟨(⊥ : α)⟩

instance {α : Type} [SemilatticeSup α] [OrderBot α] : AddCommMonoid (SupMon α) where
  add_assoc a b c := @sup_assoc α _ a b c
  zero_add a := @bot_sup_eq α _ _ a
  add_zero a := @sup_bot_eq α _ _ a
  add_comm a b := @sup_comm α _ a b
  nsmul := nsmulRec

/-- The unit atom `()`, which `@count` heads write and boolean's ρ yields. -/
def Val.unit : Val := .app []

/-- Peano decoding (acc-ops.ts `natValue`). -/
inductive IsPeano : Val → ℕ → Prop
  | z : IsPeano (.sym "z") 0
  | s {v n} : IsPeano v n → IsPeano (.app [.sym "s", v]) (n + 1)

noncomputable def Val.nat? (v : Val) : Option ℕ :=
  if h : ∃ n, IsPeano v n then some (Classical.choose h) else none

/-- Numeric symbols (the `sum` aggregator's representation). -/
def Val.int? : Val → Option ℤ
  | .sym s => s.toInt?
  | _ => none

def opSum : AccOp where
  M := ℤ
  inject v _ := (v.int?).getD 0
  readout n := {.sym (toString n)}

def opCount : AccOp where
  M := ℕ
  inject _ _ := 1
  readout n := {Val.peano n}

/-- `@min`: `⊕ = min`, `e = ∞`, `ρ ∞ = ∅`. As a semilattice: the order dual
of `WithTop ℕ`, whose join is `min` and whose bottom is `⊤ = ∞`. -/
noncomputable def opMin : AccOp where
  M := SupMon (WithTop ℕ)ᵒᵈ
  inject v _ := (show (WithTop ℕ)ᵒᵈ from OrderDual.toDual ((v.nat?).map (↑) |>.getD ⊤))
  readout a := {v | ∃ n : ℕ, (OrderDual.ofDual (show (WithTop ℕ)ᵒᵈ from a)) = n ∧ v = Val.peano n}

/-- The boolean op a declaration without an agg column uses: `∨`, `false`,
`ρ true = {()}`. -/
noncomputable def opBool : AccOp where
  M := SupMon Bool
  inject _ _ := (true : Bool)
  readout b := {v | (show Bool from b) = true ∧ v = Val.unit}

/-- The registry. `@last` and `@arg-min` need the moment order (`@last` keeps
temporal maxima), so their carriers are parameterized by it. They are
phase-4 work (`PLAN.md`). -/
noncomputable def accOp : AccOpName → Option AccOp
  | .sum => some opSum
  | .count => some opCount
  | .min => some opMin
  | .bool => some opBool
  | .last | .argMin => none

/-- One contribution. Its identity includes the firing (the matched tuples,
via the trace), so two `hit x 3` facts both reach `@sum`. -/
structure Contribution where
  rel : Sym
  key : List Val
  val : Val
  mom : Moment
  firing : List Val

/-- Rows of all acc relations at one moment. -/
abbrev AccRows := Sym → List Val → Prop

/-- Split a head row into key columns and the agg value. -/
def AccDecl.split (d : AccDecl) (args : List Val) : List Val × Val :=
  match d.aggIndex with
  | none => (args, Val.unit)
  | some i => (args.take i ++ args.drop (i + 1), args.getD i Val.unit)

/-- Reassemble a row from key and value. -/
def AccDecl.assemble (d : AccDecl) (key : List Val) (v : Val) : List Val :=
  match d.aggIndex with
  | none => key
  | some i => key.take i ++ v :: key.drop i

def Program.accDecl? (P : Program) (rel : Sym) : Option AccDecl :=
  P.accDecls.find? (·.rel == rel)

/-- The contributions acc rules derive at `m`, reading `rows` for acc relations.
A contribution's moment is the lub of its anchoring premises' starts (for
`@last`; moments of acc rows read are not yet tracked). -/
def accContribs (C : Ctx) (S : Store) (m : Moment) (rows : AccRows) : Set Contribution :=
  {k | ∃ j r d c, C.prog.accRules[j]? = some r ∧ C.prog.accDecl? r.head.rel = some d ∧
    RunB { C with I := { C.I with acc := fun m' rel vs => m' = m ∧ rows rel vs } }
      S j [] 0 r.body ⟨[], [], ⟨m, m⟩, [], []⟩ c ∧
    let args := Term.instL (fun _ => Val.unit) c.σ r.head.args
    k.rel = r.head.rel ∧ k.key = (d.split args).1 ∧ k.val = (d.split args).2 ∧
    k.firing = c.tr ∧ S.IsLUBOf (c.anc.map (·.l)) k.mom}

/-- The fold of one key: `⊕` over its contributions' `η`. -/
noncomputable def foldKey (op : AccOp) (cs : Finset Contribution) (rel : Sym)
    (key : List Val) : op.M :=
  ∑ c ∈ cs.filter (fun c => c.rel = rel ∧ c.key = key), op.inject c.val c.mom

/-- Rows from a finite contribution set. A keyed relation has a row only for
keys that some contribution mentions; a keyless one always has `ρ` of its
(possibly empty) fold — the zero row. -/
def rowsOf (P : Program) (cs : Finset Contribution) : AccRows := fun rel args =>
  ∃ d op, P.accDecl? rel = some d ∧ accOp d.op = some op ∧ args.length = d.arity ∧
    ∃ key v, args = d.assemble key v ∧
      (key = [] ∨ ∃ c ∈ cs, c.rel = rel ∧ c.key = key) ∧
      v ∈ op.readout (foldKey op cs rel key)

/-- Rows from an arbitrary contribution set (empty when infinite: the
implementation's `ACC_ROUND_CAP` error). -/
noncomputable def rowsOfSet (P : Program) (cs : Set Contribution) : AccRows :=
  if h : cs.Finite then rowsOf P h.toFinset else fun _ _ => False

/-- Iterate one stratum at `m`, with the lower strata's rows fixed:
contributions accumulate (acc.ts: deduplicated by identity, never retracted). -/
noncomputable def stratumIter (C : Ctx) (S : Store) (m : Moment) (lower : AccRows)
    (strat : List Sym) : ℕ → Set Contribution
  | 0 => ∅
  | n + 1 =>
      let cs := stratumIter C S m lower strat n
      cs ∪ {k ∈ accContribs C S m (lower ⊔ rowsOfSet C.prog cs) | k.rel ∈ strat}

def StratumSettles (C : Ctx) (S : Store) (m : Moment) (lower : AccRows)
    (strat : List Sym) : Prop :=
  ∃ n, stratumIter C S m lower strat (n + 1) = stratumIter C S m lower strat n

noncomputable def stratumLimit (C : Ctx) (S : Store) (m : Moment) (lower : AccRows)
    (strat : List Sym) : Set Contribution :=
  ⋃ n, stratumIter C S m lower strat n

/-- All acc rows at `m` (acc.ts `computeAccAt`), stratum by stratum. -/
noncomputable def accAt (C : Ctx) (S : Store) (m : Moment) : AccRows :=
  C.strata.foldl
    (fun lower strat => lower ⊔ rowsOfSet C.prog (stratumLimit C S m lower strat)) ⊥

/-- A stratification is valid when each acc rule only reads acc relations of
its own or earlier strata. -/
def ValidStrata (P : Program) (strata : List (List Sym)) : Prop :=
  (∀ d ∈ P.accDecls, ∃ s ∈ strata, d.rel ∈ s) ∧
  ∀ r ∈ P.accRules, ∀ i : ℕ, (∃ s, strata[i]? = some s ∧ r.head.rel ∈ s) →
    ∀ a, Item.accRead a ∈ r.body → ∃ j : ℕ, j ≤ i ∧ ∃ s, strata[j]? = some s ∧ a.rel ∈ s

/-! ## Statements -/

/-- The fold is a monoid homomorphism from the free commutative monoid on
contributions: splitting a contribution set splits the fold. -/
theorem foldKey_union (op : AccOp) {cs cs' : Finset Contribution} (h : Disjoint cs cs')
    (rel : Sym) (key : List Val) :
    foldKey op (cs ∪ cs') rel key = foldKey op cs rel key + foldKey op cs' rel key := by
  sorry

/-- For an idempotent op, identifying contributions is harmless: folding a bag
equals folding its support. So dedup-by-identity is only observable for
`@sum`/`@count`. -/
theorem idempotent_fold_dedup (op : AccOp) (h : op.Idempotent) (s : Multiset op.M) :
    s.sum = s.dedup.sum := by
  sorry

theorem opMin_idempotent : opMin.Idempotent := by
  sorry

theorem opBool_idempotent : opBool.Idempotent := by
  sorry

theorem opSum_not_idempotent : ¬ opSum.Idempotent := by
  sorry

theorem stratumIter_mono (C : Ctx) (S : Store) (m : Moment) (lower : AccRows)
    (strat : List Sym) : Monotone (stratumIter C S m lower strat) := by
  sorry

/-- A settled stratum is a solution: one more round changes no row. -/
theorem stratum_limit_solution {C : Ctx} {S : Store} {m : Moment} {lower : AccRows}
    {strat : List Sym} (h : StratumSettles C S m lower strat) :
    rowsOfSet C.prog (stratumLimit C S m lower strat ∪
        {k ∈ accContribs C S m (lower ⊔ rowsOfSet C.prog (stratumLimit C S m lower strat)) |
          k.rel ∈ strat}) =
      rowsOfSet C.prog (stratumLimit C S m lower strat) := by
  sorry

/-- The result does not depend on which valid topological order of the
dependency SCCs is used. -/
theorem accAt_strata_indep {C : Ctx} {S : Store} {m : Moment} {strata' : List (List Sym)}
    (h : ValidStrata C.prog C.strata) (h' : ValidStrata C.prog strata')
    (hp : C.strata.Perm strata') :
    accAt C S m = accAt { C with strata := strata' } S m := by
  sorry

/-- A keyless `@count` with no contributions reads out `z` (the zero row). -/
theorem keyless_count_zero (P : Program) (d : AccDecl) (hd : P.accDecl? d.rel = some d)
    (hop : d.op = .count) (har : d.arity = 1) (hi : d.aggIndex = some 0) :
    rowsOf P ∅ d.rel [Val.peano 0] := by
  sorry

/-! ### Shortest paths through `@min`

```
#acc distance : location location @min
edge A B / distance A B (s z)
edge A B, distance B C L / distance A C (s L)
```
-/

namespace Examples

def distanceDecl : AccDecl := ⟨"distance", 3, some 2, .min⟩

def distanceProg (rules : List Body) : Program where
  rules := rules
  accDecls := [distanceDecl]
  accRules :=
    [ ⟨[.atom ⟨"edge", [.var "A", .var "B"]⟩],
        ⟨"distance", [.var "A", .var "B", .val (Val.peano 1)]⟩⟩,
      ⟨[.atom ⟨"edge", [.var "A", .var "B"]⟩,
        .accRead ⟨"distance", [.var "B", .var "C", .var "L"]⟩],
        ⟨"distance", [.var "A", .var "C", .app [.val (.sym "s"), .var "L"]]⟩⟩ ]

/-- `n`-step paths in the edges alive at `m`. -/
inductive PathLen (S : Store) (m : Moment) : Val → Val → ℕ → Prop
  | one {a b t} : t ∈ S.aliveAt m → t.rel = "edge" → t.args = [a, b] → PathLen S m a b 1
  | step {a b c n t} : t ∈ S.aliveAt m → t.rel = "edge" → t.args = [a, b] →
      PathLen S m b c n → PathLen S m a c (n + 1)

/-- With finitely many edges alive, the stratum settles, and its rows are the
shortest path lengths. -/
theorem distance_correct {rules : List Body} {S : Store} {m : Moment}
    (hfin : (S.aliveAt m).Finite) (C : Ctx)
    (hC : C.prog = distanceProg rules) (hs : C.strata = [["distance"]]) :
    StratumSettles C S m ⊥ ["distance"] ∧
      ∀ a c n, accAt C S m "distance" [a, c, Val.peano n] ↔
        PathLen S m a c n ∧ ∀ k < n, ¬ PathLen S m a c k := by
  sorry

end Examples

end Turn
