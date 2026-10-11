import Turn.Body
import Turn.Order.Subdivision

/-!
# The monotone part: rules as existential rules, evaluated by the chase

With the inputs (`is` rows, `#acc` rows) held fixed, a program is a set of
existential rules: each firing mints Skolem moments and ids
(`discussions/turn-temporal-logic.md` §3). Its meaning is the least store
closed under all rules. That store is the *chase*, and fixpoint.ts's inner
loop computes it semi-naively.

The chase is defined directly as the Knaster–Tarski infimum of the closed
stores, so no proof obligation is attached to the definition; that it *is*
a fixpoint is `chase_isModel`/`chase_fixed` and needs `T_mono`.
-/

namespace Turn

/-- One round: everything any rule derives from `S`. -/
def T (C : Ctx) (S : Store) : Store :=
  {f | (∃ k b, C.prog.rules[k]? = some b ∧ f ∈ ruleFacts C S k b) ∨
    (∃ t ∈ C.I.tuples, f = .tuple t)}

/-- A store closed under every rule: a model of the program read as
existential rules (with Skolemized heads). -/
def IsModel (C : Ctx) (S : Store) : Prop := T C S ⊆ S

/-- The least model. -/
def chase (C : Ctx) : Store := sInf {S | IsModel C S}

/-- Finite stages of the chase (the inner loop's iterations, without
semi-naive bookkeeping). -/
def stage (C : Ctx) : ℕ → Store
  | 0 => ∅
  | n + 1 => stage C n ∪ T C (stage C n)

variable {C : Ctx}

theorem T_mono (hm : C.meet = .pairwise) : Monotone (T C) := by
  sorry

theorem chase_isModel (hm : C.meet = .pairwise) : IsModel C (chase C) := by
  sorry

theorem chase_least {S : Store} (h : IsModel C S) : chase C ⊆ S := by
  sorry

/-- The chase is a fixpoint: nothing in it is unsupported. -/
theorem chase_fixed (hm : C.meet = .pairwise) : T C (chase C) = chase C := by
  sorry

/-- **Kleene.** Each firing reads finitely many facts, so `T` is
ω-continuous and the chase is the union of its stages. This is the statement
that the inner loop is complete (given unbounded gas). -/
theorem chase_eq_iUnion_stage (hm : C.meet = .pairwise) :
    chase C = ⋃ n, stage C n := by
  sorry

theorem stage_mono (hm : C.meet = .pairwise) : Monotone (stage C) := by
  sorry

/-! ## Shape of the moment order -/

/-- Under the strict semantics no stage asserts a cycle. -/
theorem stage_acyclic (hs : C.strict = true) (hm : C.meet = .pairwise) (n : ℕ) :
    (stage C n).Acyclic := by
  sorry

/-- **Every finite stage's moment order is a subdivision graph** (strict
semantics). Proof idea: each fresh moment is inserted by exactly one emit
site with a determined anchor (`ReachB.functional`), and a stage's
insertions can be sequenced (episode: `l` first, then `r` inside `[l, XR]`). -/
theorem stage_subdiv (hs : C.strict = true) (hm : C.meet = .pairwise) (n : ℕ)
    (hfin : (stage C n).Finite) :
    ∃ G : Order.Graph Val, Order.Subdiv .bot .top G ∧ G.V = (stage C n).moments ∧
      ∀ x ∈ G.V, ∀ y ∈ G.V, G.reach x y ↔ (stage C n).le x y := by
  sorry

/-- **Lattice theorem for the chase.** Passes from finite stages to the limit via
`Subdiv.lub_stable`. -/
theorem chase_lattice (hs : C.strict = true) (hm : C.meet = .pairwise)
    (hfin : ∀ n, (stage C n).Finite) {x y : Moment}
    (hx : x ∈ (chase C).moments) (hy : y ∈ (chase C).moments) :
    (∃ z, (chase C).IsSup x y z) ∧ (∃ z, (chase C).IsInf x y z) := by
  sorry

/-- A Skolem moment is placed once: all the edges into a `momL` moment come
from the same anchor (strict semantics). -/
theorem chase_momL_edge_unique (hs : C.strict = true) (hm : C.meet = .pairwise)
    {r : Nat} {p : List Nat} {tr : List Val} {a a' : Moment}
    (h : Fact.edge a (.sk r p .momL tr) ∈ chase C)
    (h' : Fact.edge a' (.sk r p .momL tr) ∈ chase C) : a = a' := by
  sorry

/-! ## Worked examples -/

namespace Examples

def sym (s : String) : Term := .val (.sym s)
def at0 (r : String) : Atom := ⟨r, []⟩

/-- `~a` and `a, (+p); +q`. The sequence closes at `a`'s right end, so `+q`
mints a moment inside the point anchor `[a.r, a.r]`. -/
def pointProg : Program where
  rules := [ [.episode (at0 "a")],
             [.atom (at0 "a"), .seq [.fact (at0 "p")], .fact (at0 "q")] ]
  accDecls := []
  accRules := []

def noInputs : Inputs := ⟨fun _ _ => False, fun _ _ _ => False, ∅⟩

/-- The implementation's semantics asserts a cycle (`a.r < q.l < a.r`). -/
theorem point_cycle :
    ¬ (chase { prog := pointProg, I := noInputs, strict := false }).Acyclic := by
  sorry

/-- The strict semantics derives no `q` at all. -/
theorem point_strict :
    ¬ ∃ t, Fact.tuple t ∈ chase { prog := pointProg, I := noInputs, strict := true } ∧
      t.rel = "q" := by
  sorry

/-- Poison Pins' sibling problem (tutorial, "Joins need constructive
overlap"): `~s`, `s, +pin a`, `s, +pin b`, `s, pin A, pin B, +pair A B`. -/
def pinsProg (join : Body) : Program where
  rules := [ [.episode (at0 "s")],
             [.atom (at0 "s"), .fact ⟨"pin", [sym "a"]⟩],
             [.atom (at0 "s"), .fact ⟨"pin", [sym "b"]⟩],
             join ]
  accDecls := []
  accRules := []

def pinA : Atom := ⟨"pin", [.var "A"]⟩
def pinB : Atom := ⟨"pin", [.var "B"]⟩
def pairAB : Atom := ⟨"pair", [.var "A", .var "B"]⟩

def joinPlain : Body := [.atom (at0 "s"), .atom pinA, .atom pinB, .fact pairAB]
def joinPeek : Body := [.atom (at0 "s"), .sub [.atom pinA], .sub [.atom pinB], .fact pairAB]

def derives (C : Ctx) (rel : Sym) (args : List Val) : Prop :=
  ∃ t, Fact.tuple t ∈ chase C ∧ t.rel = rel ∧ t.args = args

/-- Self-pairs fire... -/
theorem pins_self :
    derives { prog := pinsProg joinPlain, I := noInputs } "pair" [.sym "a", .sym "a"] := by
  sorry

/-- ...cross pairs do not: the pins' left endpoints are incomparable. -/
theorem pins_no_cross :
    ¬ derives { prog := pinsProg joinPlain, I := noInputs } "pair" [.sym "a", .sym "b"] := by
  sorry

/-- Peeking (`(pin A), (pin B)`) gives the full cross product. -/
theorem pins_peek_cross :
    derives { prog := pinsProg joinPeek, I := noInputs } "pair" [.sym "a", .sym "b"] := by
  sorry

/-- Under the lattice semantics the plain join's anchor collapses to the point
`[s.r, s.r]` (siblings join at the end of their episode), so the strict
semantics refuses `+pair a b` rather than silently dropping it for
incomparability. -/
theorem pins_lattice_strict_no_cross :
    ¬ derives { prog := pinsProg joinPlain, I := noInputs, strict := true, meet := .lattice }
      "pair" [.sym "a", .sym "b"] := by
  sorry

end Examples

end Turn
