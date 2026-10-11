import Turn.Chase
import Turn.Acc

/-!
# The non-monotone part: the moment walk, acc snapshots, and choices

A program has a monotone part (the chase, with inputs fixed) and a
non-monotone part that must observe a *complete* state at a moment:
`#acc` folds and choice resolution (plans/v2-moment-walk.md). The walk
processes the **frontier** (the minimal unresolved moments). At each one it
*settles* (writes acc rows, once), surfaces choices once every frontier moment
is blocked, and *resolves* the moment when nothing is pending there.

The model abstracts the rounds: a walk state carries the inputs produced so
far, and its store is always the chase of those inputs. The inner loop's
quiescence is built in.

The key semantic question this layer makes precise is **causality**: when is
the state at a settled or resolved moment final? `discussions/turn-temporal-logic.md`
§4 and §5.2 identify the obstructions: peeks `(atom)`, and timeless reads
(`is`) by rules anchored before the choice. Here causality is a *semantic*
per-firing condition (`Causal`). A syntactic sufficient condition is a
separate theorem.
-/

namespace Turn

open Classical

/-- `c` occurs inside `v`. -/
inductive Val.Occurs (c : Val) : Val → Prop
  | refl : Val.Occurs c c
  | app {v vs} : v ∈ vs → Val.Occurs c v → Val.Occurs c (.app vs)
  | sk {v r p k tr} : v ∈ tr → Val.Occurs c v → Val.Occurs c (.sk r p k tr)

inductive Term.Occurs (c : Val) : Term → Prop
  | val {v} : Val.Occurs c v → Term.Occurs c (.val v)
  | app {t ts} : t ∈ ts → Term.Occurs c t → Term.Occurs c (.app ts)

def Atom.Mentions (c : Val) (a : Atom) : Prop := ∃ t ∈ a.args, Term.Occurs c t

def Atoms.Mentions (c : Val) (cs : List Atom) : Prop := ∃ a ∈ cs, a.Mentions c

/-! ## Walk states -/

structure WState where
  /-- committed choices, in order: choice term, value, and the ask moment
  (the harness's appended `is` rows, placed on `[ask moment, top]`) -/
  isRows : List (Val × Val × Moment)
  /-- choice terms of zero-option components (`_dead-choice`) -/
  dead : Set Val
  /-- acc rows written at settled moments -/
  acc : Moment → AccRows
  settled : Set Moment
  resolved : Set Moment

def WState.init : WState := ⟨[], ∅, fun _ => ⊥, ∅, ∅⟩

/-- The `is` row resolving choice `c` with `v`, asked at `m`. -/
def isTuple (c v m : Val) : Tuple := ⟨"is", [c, v], .app [.sym "*is", c], m, .top⟩

def WState.inputs (base : Inputs) (w : WState) : Inputs where
  prim := base.prim
  acc := w.acc
  tuples := base.tuples ∪ {t | ∃ c v m, (c, v, m) ∈ w.isRows ∧ t = isTuple c v m}

def WState.ctx (C : Ctx) (w : WState) : Ctx := { C with I := w.inputs C.I }

/-- The store of a walk state: the chase of everything input so far. -/
def WState.store (C : Ctx) (w : WState) : Store := chase (w.ctx C)

def WState.isResolvedTerm (w : WState) (c : Val) : Prop :=
  (∃ v m, (c, v, m) ∈ w.isRows) ∨ c ∈ w.dead

/-- Replace resolved choice terms by their values. -/
noncomputable def WState.θ (w : WState) : Val → Option Val :=
  fun c => (w.isRows.find? (fun p => decide (p.1 = c))).map (·.2.1)

/-- Unresolved choice terms asked at `m` (the ask moment is the `_choose`
row's left endpoint). -/
def pending (S : Store) (w : WState) (m : Moment) : Set Val :=
  {c | ∃ act r, Fact.ask c act m r ∈ S ∧ ¬ w.isResolvedTerm c}

def pendingAnywhere (S : Store) (w : WState) : Set Val := {c | ∃ m, c ∈ pending S w m}

/-- The minimal unresolved moments (moment-walk.ts `frontier`). -/
def frontier (S : Store) (resolved : Set Moment) : Set Moment :=
  {m | m ∈ S.moments ∧ m ≠ .top ∧ m ∉ resolved ∧
    ∀ m' ∈ S.moments, S.le m' m → m' ≠ m → m' ∈ resolved}

/-! ## Choice components and their options -/

/-- A constraint row at `m` is *ready* when every unresolved choice term it
mentions was asked at `m`. Rows that mention a later ask are deferred to it. -/
def readyRows (S : Store) (w : WState) (m : Moment) : Set (List Atom) :=
  {cs | (∃ r, Fact.constr cs m r ∈ S) ∧
    ∀ c ∈ pendingAnywhere S w, Atoms.Mentions c cs → c ∈ pending S w m}

def linked (S : Store) (w : WState) (m : Moment) (c c' : Val) : Prop :=
  ∃ cs ∈ readyRows S w m, Atoms.Mentions c cs ∧ Atoms.Mentions c' cs

/-- A component: a connected class of pending terms at `m` under shared ready
rows (constraint-query.ts `computeComponents`). -/
def IsComponent (S : Store) (w : WState) (m : Moment) (comp : List Val) : Prop :=
  comp ≠ [] ∧ comp.Nodup ∧ (∀ c ∈ comp, c ∈ pending S w m) ∧
  ∀ c ∈ comp, ∀ c' ∈ pending S w m, (Relation.EqvGen (linked S w m) c c' ↔ c' ∈ comp)

/-- One constraint atom holds at `m`: a tuple alive at `m`, a timeless
primitive, or an acc row at `m`. -/
def atomHoldsAt (S : Store) (I : Inputs) (m : Moment) (σ : Env) (a : Atom) (σ' : Env) : Prop :=
  (∃ t ∈ S.aliveAt m, MatchA σ a t.rel t.args σ') ∨
  (∃ vs, I.prim a.rel vs ∧ MatchL σ a.args vs σ') ∨
  (∃ vs, I.acc m a.rel vs ∧ MatchL σ a.args vs σ')

/-- A block holds: one conjunctive query, its free variables existential. -/
inductive AtomsHoldAt (S : Store) (I : Inputs) (m : Moment) : Env → List Atom → Prop
  | nil {σ} : AtomsHoldAt S I m σ []
  | cons {σ σ' a as} : atomHoldsAt S I m σ a σ' → AtomsHoldAt S I m σ' as →
      AtomsHoldAt S I m σ (a :: as)

/-- The options of a component: joint values for its terms satisfying every
ready row that mentions them, with earlier choices already substituted. -/
noncomputable def Options (C : Ctx) (w : WState) (m : Moment) (comp : List Val) :
    Set (List Val) :=
  let S := w.store C
  let I := w.inputs C.I
  {vs | vs.length = comp.length ∧
    let θ : Val → Option Val := fun c =>
      ((comp.zip vs).find? (fun p => decide (p.1 = c))).map (·.2) <|> w.θ c
    ∀ cs ∈ readyRows S w m, (∃ c ∈ comp, Atoms.Mentions c cs) →
      AtomsHoldAt S I m [] (cs.map (Atom.mapVal (Val.replace θ)))}

/-- Every frontier moment is settled and has a pending choice: the
precondition for surfacing choices (fixpoint.ts). -/
def AllBlocked (C : Ctx) (w : WState) : Prop :=
  ∀ m ∈ frontier (w.store C) w.resolved, m ∈ w.settled ∧ (pending (w.store C) w m).Nonempty

/-! ## Walk steps -/

inductive WStep (C : Ctx) : WState → WState → Prop
  /-- write the acc rows of a frontier moment, once -/
  | settle {w m} :
      m ∈ frontier (w.store C) w.resolved → m ∉ w.settled →
      WStep C w { w with acc := Function.update w.acc m (accAt (w.ctx C) (w.store C) m),
                         settled := insert m w.settled }
  /-- a settled frontier moment with nothing pending is resolved -/
  | resolve {w m} :
      m ∈ frontier (w.store C) w.resolved → m ∈ w.settled →
      pending (w.store C) w m = ∅ →
      WStep C w { w with resolved := insert m w.resolved }
  /-- the actor (`you` or `rng`) picks one option of a component -/
  | choose {w m comp vs} :
      AllBlocked C w → m ∈ frontier (w.store C) w.resolved →
      IsComponent (w.store C) w m comp → vs ∈ Options C w m comp →
      WStep C w { w with isRows := w.isRows ++ (comp.zip vs).map (fun p => (p.1, p.2, m)) }
  /-- a component with no options is dead (Ceptre's "not applicable") -/
  | dead {w m comp} :
      AllBlocked C w → m ∈ frontier (w.store C) w.resolved →
      IsComponent (w.store C) w m comp → Options C w m comp = ∅ →
      WStep C w { w with dead := w.dead ∪ {c | c ∈ comp} }

/-- Internal steps: the ones the engine takes without asking anyone. -/
def WStep.Internal (C : Ctx) (w w' : WState) : Prop :=
  (∃ m, m ∈ frontier (w.store C) w.resolved ∧ m ∉ w.settled ∧
    w' = { w with acc := Function.update w.acc m (accAt (w.ctx C) (w.store C) m),
                  settled := insert m w.settled }) ∨
  (∃ m, m ∈ frontier (w.store C) w.resolved ∧ m ∈ w.settled ∧
    pending (w.store C) w m = ∅ ∧ w' = { w with resolved := insert m w.resolved })

/-! ## Causality -/

/-- When a consulted dependency became available. A tuple is available from its
start — including an `is` row, which starts at its choice's ask moment.
Primitives are timeless. An acc row at `m'` is available from `m'`. -/
def Dep.availBy (S : Store) (m : Moment) : Dep → Prop
  | .tuple t => S.le t.l m
  | .prim _ _ => True
  | .acc m' _ _ => S.le m' m

/-- **Causal programs.** For any inputs, at every emitting program point of
the chase, everything the firing consulted was available by the anchor's
start. -/
def Causal (C : Ctx) : Prop :=
  ∀ I : Inputs, ∀ k b p i c, C.prog.rules[k]? = some b →
    ReachB { C with I := I } (chase { C with I := I }) k [] 0 b Cfg.init (p, i, c) →
    i.isEmit = true → ∀ d ∈ c.deps, d.availBy (chase { C with I := I }) c.A.l

mutual
/-- No `(…)` side condition reads anything time-bound (tuples or acc rows).
Sufficient for the tuple and acc parts of causality, though not necessary:
ttt's `turn, (actor P), (turn-complete)` is causal because those tuples start
inside `turn`. -/
def Item.PeekFree : Item → Prop
  | .sub b => Body.Inert b
  | .seq b => Body.PeekFree b
  | _ => True
def Body.PeekFree : Body → Prop
  | [] => True
  | i :: is => Item.PeekFree i ∧ Body.PeekFree is
/-- A side-condition body that reads nothing time-bound. -/
def Item.Inert : Item → Prop
  | .atom _ | .accRead _ => False
  | .sub b | .seq b => Body.Inert b
  | _ => True
def Body.Inert : Body → Prop
  | [] => True
  | i :: is => Item.Inert i ∧ Body.Inert is
end

/-- Restrict inputs to what is available by `m`: acc rows at moments `≤ m` and
`is` rows of choices asked `≤ m` (ask moments read in `S`). -/
def Inputs.upTo (I : Inputs) (S : Store) (m : Moment) : Inputs where
  prim := I.prim
  acc m' rel vs := I.acc m' rel vs ∧ S.le m' m
  tuples := {t ∈ I.tuples | S.le t.l m}

/-- Restrict inputs to what is available strictly before `m`. -/
def Inputs.before (I : Inputs) (S : Store) (m : Moment) : Inputs where
  prim := I.prim
  acc m' rel vs := I.acc m' rel vs ∧ S.le m' m ∧ m' ≠ m
  tuples := {t ∈ I.tuples | S.le t.l m ∧ t.l ≠ m}

/-! ## Statements -/

variable {C : Ctx}

/-- Peek-freedom gives the tuple and acc parts of causality. -/
theorem peekFree_deps_avail (hm : C.meet = .pairwise)
    (hpf : ∀ b ∈ C.prog.rules, Body.PeekFree b) (I : Inputs) {k b p i c}
    (hb : C.prog.rules[k]? = some b)
    (h : ReachB { C with I := I } (chase { C with I := I }) k [] 0 b Cfg.init (p, i, c)) :
    ∀ d ∈ c.deps, (∀ t, d = .tuple t → (chase { C with I := I }).le t.l c.A.l) ∧
      (∀ m' r vs, d = .acc m' r vs → (chase { C with I := I }).le m' c.A.l) := by
  sorry

/-- **Locality.** For a causal program, the causal past of `m` depends only on
the inputs available by `m`. -/
theorem past_local (hc : Causal C) (hs : C.strict = true) (hm : C.meet = .pairwise)
    (m : Moment) :
    (chase C).pastOf m =
      (chase { C with I := C.I.upTo (chase C) m }).pastOf m := by
  sorry

/-- The walk keeps `resolved ⊆ settled`, and `resolved` is a down-set. -/
theorem walk_inv (hs : C.strict = true) {w : WState}
    (h : Relation.ReflTransGen (WStep C) WState.init w) :
    w.resolved ⊆ w.settled ∧
      ∀ m ∈ w.resolved, ∀ m', (w.store C).le m' m → m' ∈ (w.store C).moments → m' ∈ w.resolved := by
  sorry

/-- **Resolved moments are final.** Nothing derived later is alive at a
resolved moment. This is the temporal-monotonicity assumption fixpoint.ts
relies on, proved for causal programs. -/
theorem resolved_final (hc : Causal C) (hs : C.strict = true) (hm : C.meet = .pairwise)
    {w w' : WState} (h0 : Relation.ReflTransGen (WStep C) WState.init w)
    (h : Relation.ReflTransGen (WStep C) w w') {m : Moment} (hm' : m ∈ w.resolved) :
    (w'.store C).aliveAt m = (w.store C).aliveAt m := by
  sorry

/-- **Options are stable.** The options of a component at a blocked frontier
moment cannot change before it is resolved. So surfacing them is sound, and
a dead component stays dead. -/
theorem options_stable (hc : Causal C) (hs : C.strict = true) (hm : C.meet = .pairwise)
    {w w' : WState} (h0 : Relation.ReflTransGen (WStep C) WState.init w)
    (h : Relation.ReflTransGen (WStep.Internal C) w w') {m : Moment} {comp : List Val}
    (hb : AllBlocked C w) (hcomp : IsComponent (w.store C) w m comp) :
    Options C w' m comp = Options C w m comp := by
  sorry

/-- **Confluence of internal steps.** Settling and resolving incomparable
frontier moments commute. For a fixed sequence of choices, the order in which
the engine walks the frontier is unobservable. -/
theorem internal_diamond (hc : Causal C) (hs : C.strict = true) (hm : C.meet = .pairwise)
    {w w₁ w₂ : WState} (h0 : Relation.ReflTransGen (WStep C) WState.init w)
    (h₁ : WStep.Internal C w w₁) (h₂ : WStep.Internal C w w₂) :
    ∃ w₃, Relation.ReflTransGen (WStep.Internal C) w₁ w₃ ∧
      Relation.ReflTransGen (WStep.Internal C) w₂ w₃ := by
  sorry

/-- **Determinacy.** Two maximal internal runs from the same state end in the
same store. -/
theorem internal_determinate (hc : Causal C) (hs : C.strict = true)
    (hm : C.meet = .pairwise) {w w₁ w₂ : WState}
    (h0 : Relation.ReflTransGen (WStep C) WState.init w)
    (h₁ : Relation.ReflTransGen (WStep.Internal C) w w₁)
    (h₂ : Relation.ReflTransGen (WStep.Internal C) w w₂)
    (hmax₁ : ∀ w', ¬ WStep.Internal C w₁ w') (hmax₂ : ∀ w', ¬ WStep.Internal C w₂ w') :
    w₁.store C = w₂.store C ∧ w₁.resolved = w₂.resolved := by
  sorry

/-- **Acc snapshots are temporally stratified.** The rows written at a settled
`m` are the acc rows computed from the inputs available strictly before `m`,
together with the choices asked strictly before `m`. This is the declarative
reading of "acc at a choice's moment is the state from before the choice". -/
theorem acc_snapshot (hc : Causal C) (hs : C.strict = true) (hm : C.meet = .pairwise)
    {w : WState} (h0 : Relation.ReflTransGen (WStep C) WState.init w)
    {m : Moment} (hset : m ∈ w.settled) :
    let C' := { C with I := (w.inputs C.I).before (w.store C) m }
    w.acc m = accAt C' (chase C') m := by
  sorry

/-- **Snapshot = final state.** With fresh-left `^` every tuple a rule emits
starts strictly after the anchor's start, so nothing derived after `m` settled
is alive at `m`: the rows written when `m` settled are what the final store
yields at `m`. This is what makes `not` (and choice options) sound
(plans/v2-caret-fresh-left.md §2.2). Exceptions' internal exact emits are
outside the kernel and outside this statement. -/
theorem snapshot_eq_final (hc : Causal C) (hs : C.strict = true) (hm : C.meet = .pairwise)
    {w w' : WState} (h0 : Relation.ReflTransGen (WStep C) WState.init w)
    (h : Relation.ReflTransGen (WStep C) w w') {m : Moment} (hset : m ∈ w.settled) :
    w.acc m = accAt (w'.ctx C) (w'.store C) m := by
  sorry

end Turn
