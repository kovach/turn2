could dispatch be computed statically by doing a binding analysis on the variables in the constraints?

● Yes, mostly. Each constraint's mode is a function of which variables are bound on entry, and the bindings
  each constraint produces when run are deterministic:

  - Equal binds its name (always check-mode, always runnable).
  - Match with ground id is check-mode; otherwise enumerate-mode and binds id plus any free vars in atom.
  - AssertIntervalRel is check / enumerate-one-side / blocked based on which of a, b are ground; enumerate-mode
   binds the unbound side.

  So at lower time you can simulate: start with vars bound by the rule's "input" (none, for a top-level rule),
  then repeatedly pick a runnable constraint, mark its outputs bound, and emit it into a fixed schedule. The
  result is a permutation of te.matching that's correct for any input ordering — exactly the order-robustness
  property, achieved statically.

  What you lose is dynamic size-based selection. The current scheduler picks the smallest enumerator using
  actual store cardinalities; a static schedule has to commit to an order without seeing the store. You can
  approximate (e.g. prefer IntervalRel-with-one-bound over Match-with-free-id, since the former is usually a
  small neighborhood and the latter scans by head symbol), but it's a heuristic.

  Two options:

  1. Pure static schedule. Lower emits matching already in runnable order; runtime just walks it. Cheapest,
  loses adaptive selection.
  2. Static groups, dynamic tie-break. Lower partitions matching into "ready cohorts" — within a cohort all are
   runnable and you pick smallest by size at runtime; between cohorts the order is fixed. Keeps adaptivity
  where it matters, drops the per-step O(n) classify scan.

  (2) is probably the sweet spot if the scheduler shows up in profiles. If it doesn't, (1) is a nice
  simplification — fewer moving parts at runtime, and the schedule is inspectable in tests.

  One subtlety: Match with a partially-ground id (e.g. Id atom containing a mix of bound and free vars) is
  enumerate-mode and binds the free interior vars. Static analysis has to walk into Atom/Id sub-terms the same
  way isGround does — straightforward but easy to miss.
