-- display: ttt-display.js

-- aggregate decls
% fills -> count

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

= V1 (*mom r1 1 l)
= V2 (*mom r1 1 r)
= V3 (*mom r1 2 V1 V2 l)
= V4 (*mom r1 2 V1 V2 r)
= V5 (cell z z)
= V6 (*id r5 2 (*mom r1 3 V1 V2 V3 V4 l) (*mom r1 3 V1 V2 V3 V4 r) c)
^ is V6 V5

= V1 (*mom r1 1 l)
= V2 (*mom r1 1 r)
= V3 (*mom r1 2 V1 V2 l)
= V4 (*mom r1 2 V1 V2 r)
= V5 (*mom r1 3 V1 V2 V3 V4 l)
= V6 (*mom r1 3 V1 V2 V3 V4 r)
= V7 (*mom r2 2 V3 V4 l)
= V8 (*mom r2 3 V3 V4 V7 top l)
= V9 (*mom r2 5 V3 V4 V7 top V8 top (*mom r2 4 V3 V4 V7 top V8 top l) top l)
= V10 (cell z z)
= V11 (cell (s z) z)
= V12 (*id r5 2 V5 V6 c)
= V13 (*mom r5 2 V5 V6 l)
= V14 (*mom r5 3 V5 V6 V13 top V12 l)
= V15 (*mom r5 3 V5 V6 V13 top V12 r)
= V16 (*mom r6 5 V5 V6 V5 V6 o V14 V15 V12 bot top V10 l)
= V17 (*mom r6 6 V5 V6 V5 V6 o V14 V15 V12 bot top V10 V16 top l)
= V18 (*mom r6 6 V5 V6 V5 V6 o V14 V15 V12 bot top V10 V16 top r)
= V19 (*mom r8 3 V5 V6 V17 V18 l)
= V20 (*mom r8 3 V5 V6 V17 V18 r)
= V21 (*id r5 2 (*mom r9 6 V1 V2 V9 top o x V5 V6 V5 V6 V19 V20 l) (*mom r9 6 V1 V2 V9 top o x V5 V6 V5 V6 V19 V20 r) c)
^ is V21 V11

= V1 (*mom r1 1 l)
= V2 (*mom r1 1 r)
= V3 (*mom r1 2 V1 V2 l)
= V4 (*mom r1 2 V1 V2 r)
= V5 (*mom r1 3 V1 V2 V3 V4 l)
= V6 (*mom r1 3 V1 V2 V3 V4 r)
= V7 (*mom r2 2 V3 V4 l)
= V8 (*mom r2 3 V3 V4 V7 top l)
= V9 (*mom r2 4 V3 V4 V7 top V8 top l)
= V10 (*mom r2 5 V3 V4 V7 top V8 top V9 top l)
= V11 (s z)
= V12 (cell z z)
= V13 (cell V11 z)
= V14 (cell V11 V11)
= V15 (*id r5 2 V5 V6 c)
= V16 (*mom r5 2 V5 V6 l)
= V17 (*mom r5 3 V5 V6 V16 top V15 l)
= V18 (*mom r5 3 V5 V6 V16 top V15 r)
= V19 (*mom r6 5 V5 V6 V5 V6 o V17 V18 V15 bot top V12 l)
= V20 (*mom r6 6 V5 V6 V5 V6 o V17 V18 V15 bot top V12 V19 top l)
= V21 (*mom r6 6 V5 V6 V5 V6 o V17 V18 V15 bot top V12 V19 top r)
= V22 (*mom r8 3 V5 V6 V20 V21 l)
= V23 (*mom r8 3 V5 V6 V20 V21 r)
= V24 (*mom r9 6 V1 V2 V10 top o x V5 V6 V5 V6 V22 V23 l)
= V25 (*mom r9 6 V1 V2 V10 top o x V5 V6 V5 V6 V22 V23 r)
= V26 (*id r5 2 V24 V25 c)
= V27 (*mom r5 2 V24 V25 l)
= V28 (*mom r5 3 V24 V25 V27 top V26 l)
= V29 (*mom r5 3 V24 V25 V27 top V26 r)
= V30 (*mom r6 5 V24 V25 V24 V25 x V28 V29 V26 bot top V13 l)
= V31 (*mom r6 6 V24 V25 V24 V25 x V28 V29 V26 bot top V13 V30 top l)
= V32 (*mom r6 6 V24 V25 V24 V25 x V28 V29 V26 bot top V13 V30 top r)
= V33 (*mom r8 3 V24 V25 V31 V32 l)
= V34 (*mom r8 3 V24 V25 V31 V32 r)
= V35 (*id r5 2 (*mom r9 6 V1 V2 V9 top x o V24 V25 V24 V25 V33 V34 l) (*mom r9 6 V1 V2 V9 top x o V24 V25 V24 V25 V33 V34 r) c)
^ is V35 V14