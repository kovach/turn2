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
turn, did-fill, ~turn-complete

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
= V10 (cell z z)
^ is V9 V10

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*mom r1 2 V4 l)
= V7 (*chain V2 V3 V3 V6 V5 V5)
= V8 (*mom r1 3 V7 l)
= V9 (*mom r1 3 V7 r)
= V10 (*chain V8 V9 V8 V9)
= V11 (*id r5 2 V10 :C)
= V12 (cell z z)
= V13 (*mom r2 2 (*chain V6 V5 V6 V5) l)
= V14 (*mom r2 3 (*chain V6 V5 V13 top V13 V5) l)
= V15 (*mom r5 2 V10 l)
= V16 (*mom r2 4 (*chain V6 V5 V13 top V14 top V14 V5) l)
= V17 (*chain V8 V9 V11 V15 top V15 V9)
= V18 (*mom r5 3 V17 l)
= V19 (*mom r5 3 V17 r)
= V20 (*mom r6 5 (*chain V8 V9 V8 V9 o V18 V19 V11 bot top V18 V19 V12) l)
= V21 (*chain V8 V9 V8 V9 o V18 V19 V11 bot top V12 V20 top V20 V19)
= V22 (*mom r6 6 V21 l)
= V23 (*mom r6 6 V21 r)
= V24 (*chain V8 V9 V22 V23 V22 V23)
= V25 (*chain V2 V3 (*mom r2 5 (*chain V6 V5 V13 top V14 top V16 top V16 V5) l) top V3 o x V8 V9 V8 V9 (*mom r8 3 V24 l) (*mom r8 3 V24 r) V9)
= V26 (*mom r9 6 V25 l)
= V27 (*mom r9 6 V25 r)
= V28 (*id r5 2 (*chain V26 V27 V26 V27) :C)
= V29 (cell (s z) z)
^ is V28 V29

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*mom r1 2 V4 l)
= V7 (*chain V2 V3 V3 V6 V5 V5)
= V8 (*mom r1 3 V7 l)
= V9 (*mom r1 3 V7 r)
= V10 (*chain V8 V9 V8 V9)
= V11 (*id r5 2 V10 :C)
= V12 (cell z z)
= V13 (*mom r2 2 (*chain V6 V5 V6 V5) l)
= V14 (*mom r2 3 (*chain V6 V5 V13 top V13 V5) l)
= V15 (*mom r5 2 V10 l)
= V16 (*mom r2 4 (*chain V6 V5 V13 top V14 top V14 V5) l)
= V17 (*chain V8 V9 V11 V15 top V15 V9)
= V18 (*mom r5 3 V17 l)
= V19 (*mom r5 3 V17 r)
= V20 (*mom r6 5 (*chain V8 V9 V8 V9 o V18 V19 V11 bot top V18 V19 V12) l)
= V21 (*chain V8 V9 V8 V9 o V18 V19 V11 bot top V12 V20 top V20 V19)
= V22 (*mom r6 6 V21 l)
= V23 (*mom r6 6 V21 r)
= V24 (*chain V8 V9 V22 V23 V22 V23)
= V25 (*chain V2 V3 (*mom r2 5 (*chain V6 V5 V13 top V14 top V16 top V16 V5) l) top V3 o x V8 V9 V8 V9 (*mom r8 3 V24 l) (*mom r8 3 V24 r) V9)
= V26 (*mom r9 6 V25 l)
= V27 (*mom r9 6 V25 r)
= V28 (*chain V26 V27 V26 V27)
= V29 (*id r5 2 V28 :C)
= V30 (s z)
= V31 (cell V30 z)
= V32 (*mom r5 2 V28 l)
= V33 (*chain V26 V27 V29 V32 top V32 V27)
= V34 (*mom r5 3 V33 l)
= V35 (*mom r5 3 V33 r)
= V36 (*mom r6 5 (*chain V26 V27 V26 V27 x V34 V35 V29 bot top V34 V35 V31) l)
= V37 (*chain V26 V27 V26 V27 x V34 V35 V29 bot top V31 V36 top V36 V35)
= V38 (*mom r6 6 V37 l)
= V39 (*mom r6 6 V37 r)
= V40 (cell (s V30) z)
= V41 (*chain V26 V27 V38 V39 V38 V39)
= V42 (*chain V2 V3 V16 top V3 x o V26 V27 V26 V27 (*mom r8 3 V41 l) (*mom r8 3 V41 r) V27)
= V43 (*mom r9 6 V42 l)
= V44 (*mom r9 6 V42 r)
= V45 (*id r5 2 (*chain V43 V44 V43 V44) :C)
^ is V45 V40

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*mom r1 2 V4 l)
= V7 (*chain V2 V3 V3 V6 V5 V5)
= V8 (*mom r1 3 V7 l)
= V9 (*mom r1 3 V7 r)
= V10 (*chain V8 V9 V8 V9)
= V11 (*id r5 2 V10 :C)
= V12 (cell z z)
= V13 (*mom r2 2 (*chain V6 V5 V6 V5) l)
= V14 (*mom r2 3 (*chain V6 V5 V13 top V13 V5) l)
= V15 (*mom r5 2 V10 l)
= V16 (*mom r2 4 (*chain V6 V5 V13 top V14 top V14 V5) l)
= V17 (*chain V8 V9 V11 V15 top V15 V9)
= V18 (*mom r5 3 V17 l)
= V19 (*mom r5 3 V17 r)
= V20 (*mom r6 5 (*chain V8 V9 V8 V9 o V18 V19 V11 bot top V18 V19 V12) l)
= V21 (*chain V8 V9 V8 V9 o V18 V19 V11 bot top V12 V20 top V20 V19)
= V22 (*mom r6 6 V21 l)
= V23 (*mom r6 6 V21 r)
= V24 (*chain V8 V9 V22 V23 V22 V23)
= V25 (*mom r2 5 (*chain V6 V5 V13 top V14 top V16 top V16 V5) l)
= V26 (*chain V2 V3 V25 top V3 o x V8 V9 V8 V9 (*mom r8 3 V24 l) (*mom r8 3 V24 r) V9)
= V27 (*mom r9 6 V26 l)
= V28 (*mom r9 6 V26 r)
= V29 (*chain V27 V28 V27 V28)
= V30 (*id r5 2 V29 :C)
= V31 (s z)
= V32 (cell V31 z)
= V33 (*mom r5 2 V29 l)
= V34 (*chain V27 V28 V30 V33 top V33 V28)
= V35 (*mom r5 3 V34 l)
= V36 (*mom r5 3 V34 r)
= V37 (*mom r6 5 (*chain V27 V28 V27 V28 x V35 V36 V30 bot top V35 V36 V32) l)
= V38 (*chain V27 V28 V27 V28 x V35 V36 V30 bot top V32 V37 top V37 V36)
= V39 (*mom r6 6 V38 l)
= V40 (*mom r6 6 V38 r)
= V41 (s V31)
= V42 (cell V41 z)
= V43 (*chain V27 V28 V39 V40 V39 V40)
= V44 (*chain V2 V3 V16 top V3 x o V27 V28 V27 V28 (*mom r8 3 V43 l) (*mom r8 3 V43 r) V28)
= V45 (*mom r9 6 V44 l)
= V46 (*mom r9 6 V44 r)
= V47 (*chain V45 V46 V45 V46)
= V48 (*id r5 2 V47 :C)
= V49 (cell V41 V31)
= V50 (*mom r5 2 V47 l)
= V51 (*chain V45 V46 V48 V50 top V50 V46)
= V52 (*mom r5 3 V51 l)
= V53 (*mom r5 3 V51 r)
= V54 (*mom r6 5 (*chain V45 V46 V45 V46 o V52 V53 V48 bot top V52 V53 V42) l)
= V55 (*chain V45 V46 V45 V46 o V52 V53 V48 bot top V42 V54 top V54 V53)
= V56 (*mom r6 6 V55 l)
= V57 (*mom r6 6 V55 r)
= V58 (*chain V45 V46 V56 V57 V56 V57)
= V59 (*chain V2 V3 V25 top V3 o x V45 V46 V45 V46 (*mom r8 3 V58 l) (*mom r8 3 V58 r) V46)
= V60 (*mom r9 6 V59 l)
= V61 (*mom r9 6 V59 r)
= V62 (*id r5 2 (*chain V60 V61 V60 V61) :C)
^ is V62 V49