-- Board structure is derived inside `setup` (a bounded episode), so every
-- derived fact starts before setup ends and is visible in every later turn.
-- Joins over sibling facts use `(...)` side conditions.

~setup; ~turn.^:actor wolf

setup, +num (s (s (s (s z))))
  +op sheep wolf, +op wolf sheep
^icon board
^icon nowhere

setup, num (s N), +num N, +incr N (s N)

setup, num I, num J, +cell C I J

setup, (cell C I J), +icon C, +icon:name C -
setup, (cell C _ _), +put C board

setup, (cell C (s z) z), ~make-piece wolf C
setup, (cell C (s (s z)) z), ~make-piece wolf C
setup, (cell C (s (s (s z))) z), ~make-piece wolf C

setup, (cell C X (s (s _))), ~make-piece sheep C

make-piece Ty L
  +piece P, +piece:type P Ty, +put P L
  +icon P, +icon:name P Ty

setup, (piece P), (piece:type P wolf), +wolf P
setup, (piece P), (piece:type P sheep), +sheep P

setup, (incr A B), (cell C1 A X), (cell C2 B X)
  +left:right C1 C2
setup, (incr A B), (cell C1 X A), (cell C2 X B)
  +above:below C2 C1

setup, (cell C1 X Y), (cell C2 (s X) Y)
  +adj r C1 C2, +adj l C2 C1
setup, (cell C1 X Y), (cell C2 X (s Y))
  +adj u C1 C2, +adj d C2 C1

setup, (adj D C1 C), (adj D C C2), +wolf-move C1 C C2
setup, (adj _ C1 C2), +sheep-move C1 C2

-- where each thing is: its latest `put`, as of a moment
#acc at : e (@last place)
put It L / at It L

-- cells with something on them, and cells with a wolf on them
#acc occupied : cell
at _ C / occupied C
#acc wolf-at : cell
at I C, wolf I / wolf-at C

-- the moves open to the side whose turn it is
#acc valid-move : piece cell
turn.:actor wolf, at P C1, wolf P, wolf-move C1 C C2, not occupied C, not wolf-at C2 / valid-move P C2
turn.:actor sheep, at P C, sheep P, sheep-move C C', not occupied C' / valid-move P C'

go,
  ?W, ?To, !(valid-move W To)
  is W WV, is To ToV
  ~done, ~move WV ToV

move It To, +put It To
move It To, at X To, sheep X, ~move X nowhere

(op X Y, turn.:actor X, (done)); ~turn.^:actor Y
-- the turn's move starts after its actor, so `valid-move` sees the actor
turn.:actor _, ~go
