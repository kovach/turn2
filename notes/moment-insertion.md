Suppose we start with a graph consisting of one edge `bot -> top`.
We may modify the graph in the following way:
  Choose two vertices A, B such that there is a path from A to B.
  Insert a new vertex V, an edge A -> V, and an edge V - > B.

claim: after any sequence of modifications, the path relation on this graph is a lattice (every pair of vertices have a least upper bound and greatest lower bound)

proof (derived by claude, checked by scott)
The claim is true. Sketch:

  Key structural lemma. When V is inserted between A and B (A ≤ B in the old poset), V's only incoming edge is
  A→V and only outgoing is V→B, so any path ending at V must pass through A and any path leaving V must pass
  through B. Therefore in the new poset:
  - anc(V) = anc_old(A) ∪ {V} (things ≤ V)
  - desc(V) = desc_old(B) ∪ {V} (things ≥ V)

  In particular V is a fresh element strictly between A and B in the comparability order; relations among
  pre-existing vertices are unchanged.

  Induction. Base: bot < top is a 2-chain, a lattice. Suppose P_old is a lattice; insert V between A, B. Show
  every pair in P_new has a LUB (GLB is dual).

  Pair (x, y) both old. Common upper bounds in P_new are exactly the old ones, possibly plus V. V is an upper
  bound of {x, y} iff x, y ≤ A (from the lemma), but then lub_old(x, y) ≤ A ≤ V, so the old lub is still least.
   ✓

  Pair (V, y), y old. The set of common upper bounds is desc(B) ∩ desc_old(y), plus V itself when y ≤ A.
  - If y ≤ A: V is a common upper bound and V ≤ b for every b ∈ desc(B), so LUB = V.
  - If y ≤ B (but not ≤ A): desc_old(y) ⊇ desc(B), so common upper bounds = desc(B), LUB = B.
  - Otherwise: V is not an upper bound and common upper bounds = desc(B) ∩ desc_old(y) = common upper bounds of
   {B, y} in P_old; by IH that pair has a LUB. ✓

  Pair (V, V). Trivially V.

  GLB is symmetric, using anc(V) = anc(A) ∪ {V} and casing on whether y ≥ B / y ≥ A.

  So lattice-ness is preserved by each insertion, hence by any finite sequence.

  Aside on what makes it work. Each insertion is a "subdivision": V is forced to inherit its order-relations
  through exactly one ancestor channel (A) and one descendant channel (B). This single-channel structure is
  what prevents the standard non-lattice patterns (two incomparable minimal upper bounds), because creating a
  vertex above two incomparable elements would require two incoming edges, which the move doesn't allow.
