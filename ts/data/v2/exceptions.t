-- Exceptions demo (plans/v2-exceptions.md).
-- `{p t1..tn => e}` in a rule body: in this rule's context, wherever
-- `p t1..tn` would have been produced, do `e` instead.

~phase1; ~phase2

phase1, ^p a

phase2, ^p b

-- Intercept `p` during phase1 only: `p a` becomes `e a`; `p b` (in
-- phase2, outside the flag's interval) stays real.
#def r
  phase1
  {p X => ^e X}
