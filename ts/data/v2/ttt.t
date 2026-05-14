-- display: ttt-display.js

-- aggregate decls
#acc fills -> count


~ game
  ( ~ setup );
  ( ~ turn
    ^ actor o)

-- setup: when setup exists, populate players, grid numbers, then cells.
-- All emissions use `+` because they are facts: they should overlap with every following turn
--
setup
  + player x
  + player o
  + other x o
  + other o x
  + n z
  + n (s z)
  + n (s (s z))

-- one rule per (R, C) pair. v2 has no `for each` aggregator beyond
-- weighted matches, so we just match two n tuples.
setup
  n R
  n C
  + cell R C

-- a cell is eligible for a turn if it hasn't been filled in this game

-- order is significant: the `fills` aggregation is performed at
-- the matched turn
cell R C, turn
fills (cell R C) -> z
^ eligible (cell R C)

turn
  ? C
  ~ choice C
  ! eligible C

-- the harness writes `is` rows that represent user input
turn
actor P
choice A
is A Cell
+ filled Cell P
~ did-fill

-- needs ^ so that conclusion is *prompt* and visible to later turns
filled Cell P
^ fills Cell -> ()

-- turn-complete: a turn with at least one filled is finished
turn
did-fill
~ turn-complete

-- after turn is complete, the other player's turn begins
game, other P Op
  ( turn, (actor P, turn-complete) );
  ( ~ turn, ^ actor Op )

-- 4 win-condition rules

filled (cell R z) M
filled (cell R (s z)) M
filled (cell R (s (s z))) M
+ won M (row R)

filled (cell z C) M
filled (cell (s z) C) M
filled (cell (s (s z)) C) M
+ won M (col C)

filled (cell z z) M
filled (cell (s z) (s z)) M
filled (cell (s (s z)) (s (s z))) M
+ won M diag1

filled (cell (s (s z)) z) M
filled (cell (s z) (s z)) M
filled (cell z (s (s z))) M
+ won M diag2



= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (*id r5 2 (*chain V7 V8 V7 V8) :C)
= V10 (cell (s z) z)
^ is V9 V10