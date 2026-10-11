#acc marked : @count

~ game
  + rng-seed 1
  ( ~setup ); ( ~t )

setup, +opt a
setup, +opt2 b

-- A: the continuation of a choice asserts ^mark at the ask moment (t.l)
t, ?[rng] X, !opt X, is X V, ^mark

-- B: a second choice at the same moment whose options need mark
t, ?[rng] Y, !(opt2 Y, mark), ~picked Y

mark / marked ()
t, marked N, ^marked-at-t-start N
t, mark, ^mark-during-t
