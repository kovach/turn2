import Turn.Store

/-!
# Rule bodies: anchor-threaded evaluation

A rule body is evaluated left to right against a running *anchor* `[XL, XR]`,
initially `[bot, top]`. Each item relates an incoming configuration to the
configurations it can produce (`RunI`/`RunB`), and emitting items contribute
facts (`emitFacts`). This is the semantic table of
`discussions/turn-temporal-logic.md` §1, made exact.

Two points follow the implementation rather than an idealization:

* **Split semantics.** An emit fires as soon as the prefix before it succeeds
  (expand.ts `splitRule`), and the continuation past an emit proceeds only once
  the emitted facts are in the store (the consumer half's paired `Match`).
  `ReachB` gives the program points a prefix reaches; `RunI.emit` waits for
  the facts.
* **Pairwise `Max`/`Min`.** Narrowing on a match uses `Store.IsMax`/`IsMin`,
  which fail on incomparable endpoints (eval.ts `evalMaxMin`). The lattice
  alternative is `MeetMode.lattice`, kept so the two can be compared.

Two switches select variants of the semantics: `strict` makes moment-minting
emits fail at a point anchor, which is finding 3 of the temporal-logic note.
The implementation asserts a cycle there instead. `meet` is described above.
-/

namespace Turn

inductive MeetMode where
  /-- `Max`/`Min` of comparable endpoints (the implementation) -/
  | pairwise
  /-- lattice join/meet in the moment order -/
  | lattice

structure Ctx where
  prog : Program
  I : Inputs
  strict : Bool := false
  meet : MeetMode := .pairwise
  /-- the `#acc` dependency strata in evaluation order (acc.ts `compileAcc`,
  Tarjan SCCs); only `Turn.Acc` reads it -/
  strata : List (List Sym) := []

structure Anchor where
  l : Moment
  r : Moment

/-- Something a firing consulted. Used to state causality (`Turn.Walk`). -/
inductive Dep where
  | tuple (t : Tuple)
  | prim (r : Sym) (vs : List Val)
  | acc (m : Moment) (r : Sym) (vs : List Val)

/-- A configuration at a program point. `σ`, `tr` and `A` are the semantics
proper. `deps` and `anc` are ghost state for stating theorems: `deps` is
everything consulted so far, and `anc` holds the *anchoring* tuple premises,
i.e. those whose interval was intersected into the current anchor. A `sub`
discards its inner matches from `anc`, and those are the "peeks". -/
structure Cfg where
  σ : Env
  tr : List Val
  A : Anchor
  deps : List Dep
  anc : List Tuple

def Cfg.init : Cfg := ⟨[], [], ⟨.bot, .top⟩, [], []⟩

/-- The fresh-name supply at a program point: a Skolem term of the firing. -/
def fresh (rule : Nat) (path : List Nat) (c : Cfg) (k : SkKind) : Val :=
  .sk rule path k c.tr

/-- The tuple an emit of `a` at `[l, r]` produces, and the environment after it. -/
def mkTuple (rule : Nat) (path : List Nat) (c : Cfg) (a : Atom) (l r : Moment) : Tuple :=
  ⟨a.rel, Term.instL (fun x => fresh rule path c (.obj x)) c.σ a.args,
    fresh rule path c .tupleId, l, r⟩

def emitEnv (rule : Nat) (path : List Nat) (c : Cfg) (a : Atom) : Env :=
  bindFresh (fun x => fresh rule path c (.obj x)) c.σ a.vars

/-- Facts an item emits at configuration `c` (empty for non-emitting items). -/
def emitFacts (rule : Nat) (path : List Nat) : Item → Cfg → Set Fact
  | .episode a, c =>
      let l := fresh rule path c .momL
      let r := fresh rule path c .momR
      {.tuple (mkTuple rule path c a l r), .edge c.A.l l, .edge l r, .edge r c.A.r}
  | .fact a, c =>
      let l := fresh rule path c .momL
      {.tuple (mkTuple rule path c a l .top), .edge c.A.l l, .edge l c.A.r}
  | .here a, c =>
      match c.A.l with
      | .bot => {.tuple (mkTuple rule path c a c.A.l c.A.r)}
      | _ =>
        let l := fresh rule path c .momL
        {.tuple (mkTuple rule path c a l c.A.r), .edge c.A.l l, .edge l c.A.r}
  | .ask act xs, c => {f | ∃ x ∈ xs, f = .ask (fresh rule path c (.choose x)) act c.A.l c.A.r}
  | .constrain cs, c => {.constr (cs.map (Atom.subst c.σ)) c.A.l c.A.r}
  | _, _ => ∅

/-- The configuration after an emitting item (expand.ts `decomposeEmit`'s
statically reduced anchor update). -/
def emitNext (rule : Nat) (path : List Nat) : Item → Cfg → Cfg
  | .episode a, c =>
      { c with σ := emitEnv rule path c a,
               A := ⟨fresh rule path c .momL, fresh rule path c .momR⟩ }
  | .fact a, c =>
      { c with σ := emitEnv rule path c a, A := ⟨fresh rule path c .momL, c.A.r⟩ }
  | .here a, c =>
      match c.A.l with
      | .bot => { c with σ := emitEnv rule path c a }
      | _ => { c with σ := emitEnv rule path c a, A := ⟨fresh rule path c .momL, c.A.r⟩ }
  | .ask _ xs, c =>
      { c with σ := bindFresh (fun x => fresh rule path c (.choose x)) c.σ xs }
  | _, c => c

/-- The strict semantics refuses to mint a moment inside a point anchor. -/
def emitGuard (C : Ctx) (i : Item) (c : Cfg) : Prop :=
  C.strict = true → i.mintsMoment = true → c.A.l ≠ c.A.r

/-- Anchor narrowing by a matched interval `[l, r]`. -/
def narrow (C : Ctx) (S : Store) (A : Anchor) (l r : Moment) (A' : Anchor) : Prop :=
  S.le A.l r ∧ S.le l A.r ∧
    match C.meet with
    | .pairwise => S.IsMax A.l l A'.l ∧ S.IsMin A.r r A'.r
    | .lattice => S.IsSup A.l l A'.l ∧ S.IsInf A.r r A'.r

mutual
/-- `RunI C S rule p i c c'`: item `i` at position `p`, started in `c`, can finish in `c'`. -/
inductive RunI (C : Ctx) (S : Store) (rule : Nat) : List Nat → Item → Cfg → Cfg → Prop
  | atom {p a c t σ' A'} :
      Fact.tuple t ∈ S → MatchA c.σ a t.rel t.args σ' → narrow C S c.A t.l t.r A' →
      RunI C S rule p (.atom a) c
        ⟨σ', c.tr ++ [t.toVal], A', c.deps ++ [.tuple t], c.anc ++ [t]⟩
  | sub {p b c c'} :
      RunB C S rule p 0 b c c' → RunI C S rule p (.sub b) c { c' with A := c.A, anc := c.anc }
  | seq {p b c c'} :
      RunB C S rule p 0 b c c' → RunI C S rule p (.seq b) c { c' with A := ⟨c'.A.r, c.A.r⟩ }
  | eq {p t u c v σ₁ σ₂} :
      MatchT c.σ t v σ₁ → MatchT σ₁ u v σ₂ →
      RunI C S rule p (.eq t u) c { c with σ := σ₂, tr := c.tr ++ [v] }
  | prim {p r args c vs σ'} :
      C.I.prim r vs → MatchL c.σ args vs σ' →
      RunI C S rule p (.prim r args) c
        { c with σ := σ', tr := c.tr ++ vs, deps := c.deps ++ [.prim r vs] }
  | accRead {p a c vs σ'} :
      C.I.acc c.A.l a.rel vs → MatchL c.σ a.args vs σ' →
      RunI C S rule p (.accRead a) c
        { c with σ := σ', tr := c.tr ++ vs, deps := c.deps ++ [.acc c.A.l a.rel vs] }
  /-- `not r t̄`: no `#acc` row at the anchor's start matches (the rows at a
  settled moment are final, so this is stratified negation). -/
  | notAcc {p a c} :
      (¬ ∃ vs σ', C.I.acc c.A.l a.rel vs ∧ MatchL c.σ a.args vs σ') →
      RunI C S rule p (.notAcc a) c c
  | emit {p i c} :
      i.isEmit = true → emitGuard C i c → emitFacts rule p i c ⊆ S →
      RunI C S rule p i c (emitNext rule p i c)
/-- `RunB C S rule p k b c c'`: the item list `b`, whose head sits at index `k` of the
list at path `p`, runs from `c` to `c'`. -/
inductive RunB (C : Ctx) (S : Store) (rule : Nat) :
    List Nat → Nat → List Item → Cfg → Cfg → Prop
  | nil {p k c} : RunB C S rule p k [] c c
  | cons {p k i is c c₁ c₂} :
      RunI C S rule (p ++ [k]) i c c₁ → RunB C S rule p (k + 1) is c₁ c₂ →
      RunB C S rule p k (i :: is) c c₂
end

/-- A program point: the item's position path, the item, and the configuration
in which it is reached. -/
abbrev Point := List Nat × Item × Cfg

mutual
/-- Program points reachable inside an item. -/
inductive ReachI (C : Ctx) (S : Store) (rule : Nat) : List Nat → Item → Cfg → Point → Prop
  | self {p i c} : ReachI C S rule p i c (p, i, c)
  | sub {p b c q} : ReachB C S rule p 0 b c q → ReachI C S rule p (.sub b) c q
  | seq {p b c q} : ReachB C S rule p 0 b c q → ReachI C S rule p (.seq b) c q
/-- Program points reachable in an item list: inside the head, or in the tail
once the head has run (the split-rule prefix semantics). -/
inductive ReachB (C : Ctx) (S : Store) (rule : Nat) :
    List Nat → Nat → List Item → Cfg → Point → Prop
  | here {p k i is c q} :
      ReachI C S rule (p ++ [k]) i c q → ReachB C S rule p k (i :: is) c q
  | later {p k i is c c₁ q} :
      RunI C S rule (p ++ [k]) i c c₁ → ReachB C S rule p (k + 1) is c₁ q →
      ReachB C S rule p k (i :: is) c q
end

/-- The facts one rule derives from store `S`. -/
def ruleFacts (C : Ctx) (S : Store) (rule : Nat) (body : Body) : Set Fact :=
  {f | ∃ p i c, ReachB C S rule [] 0 body Cfg.init (p, i, c) ∧ emitGuard C i c ∧
    f ∈ emitFacts rule p i c}

/-! ## Statements about single bodies -/

variable {C : Ctx} {S : Store} {rule : Nat}

/-- Evaluation is monotone in the store (pairwise mode). This is what makes
the chase a least fixpoint. -/
theorem RunB.mono (hm : C.meet = .pairwise) {S' : Store} (h : S ⊆ S')
    {p k b c c'} : RunB C S rule p k b c c' → RunB C S' rule p k b c c' := by
  sorry

theorem ReachB.mono (hm : C.meet = .pairwise) {S' : Store} (h : S ⊆ S')
    {p k b c q} : ReachB C S rule p k b c q → ReachB C S' rule p k b c q := by
  sorry

/-- **Running-anchor invariant.** `XL ≤ XR` is preserved, `XL` only grows and
`XR` only shrinks. -/
theorem RunB.anchor_inv {p k b c c'} (h : RunB C S rule p k b c c')
    (hA : S.le c.A.l c.A.r) :
    S.le c'.A.l c'.A.r ∧ S.le c.A.l c'.A.l ∧ S.le c'.A.r c.A.r := by
  sorry

/-- Every anchoring premise starts no later than the anchor. -/
theorem RunB.anc_le {p k b c c'} (h : RunB C S rule p k b c c')
    (hc : ∀ t ∈ c.anc, S.le t.l c.A.l) : ∀ t ∈ c'.anc, S.le t.l c'.A.l := by
  sorry

/-- **Causality of emissions.** Every emitted tuple starts at or after each
anchoring premise of its firing. Peeked premises (`(atom)` inside a `sub`)
are exactly the ones this does not cover. That is finding 2 of the
temporal-logic note. -/
theorem ReachB.emit_after_anc {body p i c t} (hS : S.Acyclic)
    (h : ReachB C S rule [] 0 body Cfg.init (p, i, c))
    (hin : emitFacts rule p i c ⊆ S) (ht : Fact.tuple t ∈ emitFacts rule p i c) :
    ∀ t' ∈ c.anc, S.le t'.l t.l := by
  sorry

/-- **Anchor functionality.** On an acyclic store the configuration reached at
a program point is determined by the trace. So a Skolem moment always gets
the same order edges, however often it is re-derived. -/
theorem ReachB.functional (hS : S.Acyclic) {body p i c c'}
    (h : ReachB C S rule [] 0 body Cfg.init (p, i, c))
    (h' : ReachB C S rule [] 0 body Cfg.init (p, i, c')) (htr : c.tr = c'.tr) :
    c = c' := by
  sorry

/-- Adjacent matches do **not** commute under pairwise `Max`/`Min`. Example:
`XL` incomparable to `l₁` but both below `l₂`. Under `MeetMode.lattice` they
do commute (`discussions/turn-temporal-logic.md` §2). -/
theorem atom_noncomm : ∃ (C : Ctx) (S : Store) (a₁ a₂ : Atom) (c c' : Cfg),
    C.meet = .pairwise ∧
    RunB C S 0 [] 0 [.atom a₁, .atom a₂] c c' ∧
    ¬ ∃ c'', RunB C S 0 [] 0 [.atom a₂, .atom a₁] c c'' := by
  sorry

theorem atom_comm_lattice (hm : C.meet = .lattice) (hS : S.Acyclic) {p a₁ a₂ c c'}
    (h : RunB C S rule p 0 [.atom a₁, .atom a₂] c c') :
    ∃ c'', RunB C S rule p 0 [.atom a₂, .atom a₁] c c'' ∧ c''.A = c'.A := by
  sorry

end Turn
