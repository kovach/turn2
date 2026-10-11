import Turn.Syntax

/-!
# Environments, matching, instantiation

Matching is one-sided: stored values are ground, patterns are terms. This is
the part of unify.ts that evaluation actually exercises (variables are only
ever bound to ground, hashconsed values).
-/

namespace Turn

/-- An environment, most recent binding first. -/
abbrev Env := List (Var × Val)

mutual
/-- `MatchT σ t v σ'`: pattern `t` matches value `v`, extending `σ` to `σ'`. -/
inductive MatchT : Env → Term → Val → Env → Prop
  | val {σ v} : MatchT σ (.val v) v σ
  | wild {σ v} : MatchT σ .wild v σ
  | bound {σ x v} : σ.lookup x = some v → MatchT σ (.var x) v σ
  | bind {σ x v} : σ.lookup x = none → MatchT σ (.var x) v ((x, v) :: σ)
  | app {σ σ' ts vs} : MatchL σ ts vs σ' → MatchT σ (.app ts) (.app vs) σ'
/-- Pointwise matching of argument lists. -/
inductive MatchL : Env → List Term → List Val → Env → Prop
  | nil {σ} : MatchL σ [] [] σ
  | cons {σ σ₁ σ₂ t ts v vs} :
      MatchT σ t v σ₁ → MatchL σ₁ ts vs σ₂ → MatchL σ (t :: ts) (v :: vs) σ₂
end

/-- An atom matches a stored row `rel vs`. -/
def MatchA (σ : Env) (a : Atom) (rel : Sym) (vs : List Val) (σ' : Env) : Prop :=
  a.rel = rel ∧ MatchL σ a.args vs σ'

mutual
/-- Instantiate a term for emission: bound variables by their values, unbound
ones by the fresh supply (expand.ts `emitBindingsAndRewrite`). Kernel programs
have no wildcards in emit position (the implementation freshens each `_`);
`wild` instantiates to the fresh value for the reserved name `"_"`. -/
def Term.inst (fresh : Var → Val) (σ : Env) : Term → Val
  | .val v => v
  | .var x => (σ.lookup x).getD (fresh x)
  | .wild => fresh "_"
  | .app ts => .app (Term.instL fresh σ ts)
def Term.instL (fresh : Var → Val) (σ : Env) : List Term → List Val
  | [] => []
  | t :: ts => Term.inst fresh σ t :: Term.instL fresh σ ts
end

/-- Bind every not-yet-bound variable among `xs` to its fresh value, so the
rest of the rule sees the object an emit created (`+card C, +card:name C x`). -/
def bindFresh (fresh : Var → Val) (σ : Env) (xs : List Var) : Env :=
  xs.foldl (fun σ x => if (σ.lookup x).isSome then σ else (x, fresh x) :: σ) σ

mutual
/-- Substitute bound variables, leaving free ones (the existentials of a
`!(…)` block) in place. -/
def Term.subst (σ : Env) : Term → Term
  | .val v => .val v
  | .var x => match σ.lookup x with
    | some v => .val v
    | none => .var x
  | .wild => .wild
  | .app ts => .app (Term.substL σ ts)
def Term.substL (σ : Env) : List Term → List Term
  | [] => []
  | t :: ts => Term.subst σ t :: Term.substL σ ts
end

def Atom.subst (σ : Env) (a : Atom) : Atom := ⟨a.rel, Term.substL σ a.args⟩

theorem MatchT.extends {σ σ' : Env} {t : Term} {v : Val} (h : MatchT σ t v σ') :
    ∃ δ, σ' = δ ++ σ := by
  sorry

/-- On fully bound patterns, matching the substituted pattern is equality with
the instantiation (whatever the fresh supply). -/
theorem MatchL.subst_iff_inst {fresh : Var → Val} {σ : Env} {ts : List Term} {vs : List Val}
    (hb : ∀ x ∈ Term.varsL ts, (σ.lookup x).isSome) :
    MatchL [] (Term.substL σ ts) vs [] ↔ vs = Term.instL fresh σ ts := by
  sorry

end Turn
