-- display: ttt-display.js

~ game
  ( ~setup );
  ( ~turn
    ^actor o)

-- Setup players and board
--   each `+` is a fact: overlaps every later episode
setup
  +player x
  +player o
  +other x o
  +other o x
  +n (s (s z))

setup, n (s X), +n X

-- For each pair of numbers, create a cell
setup, n R, n C
  +cell R C

-- determine filled cells
#agg fills -> bool

-- A cell is eligible to be chosen if it hasn't been filled earlier
cell R C, turn
fills (cell R C) -> 0
^eligible (cell R C)

-- ?C: C is a choice to be made
-- ~choice C: other rules refer to it this way
-- !eligible C: C must be *eligible* at the time it is chosen
turn, (actor P), did-win -> 0
  ?C
  ~choice C
  !eligible C
  
  is C Cell    -- The external harness writes `is` rows for each user input
    +filled Cell P
    ~did-fill

turn
  filled Cell P
  +fills Cell -> 1

-- A turn with at least one filled is finished
turn, did-fill, ~turn-complete

-- After turn is complete, the other player's turn begins
game, other P Op
  ( turn, (actor P), (turn-complete) );
  ( ~turn, ^actor Op )

-- Directions and Adjacency
-- (excessively general; could use to implement go-moku, etc)
#def dx setup, n (s X), n Y, +vector X Y (s X) Y dx
#def dy setup, n X, n (s Y), +vector X Y X (s Y) dy
#def dxy setup, n (s X), n (s Y), +vector X Y (s X) (s Y) dxy
#def dxy' setup, n (s X), n (s Y), +vector X (s Y) (s X) Y dxy'

setup
  vector X1 Y1 X2 Y2 Dir,
  +adj (cell X1 Y1) (cell X2 Y2) Dir

-- Win condition
turn
  filled A M
  adj A B D
  filled B M
  adj B C D
  filled C M
  ~won M D

-- needed for negation
#agg did-win -> bool
turn, (won _ _), +did-win -> 1

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (cell (s z) z)
= V10 (*id r6 4 (*chain V7 V8 V7 V8 o V7 V8) :C)
^ is V10 V9

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*mom r1 2 V4 l)
= V7 (*chain V2 V3 V3 V6 V5 V5)
= V8 (*mom r1 3 V7 l)
= V9 (*mom r1 3 V7 r)
= V10 (s z)
= V11 (cell V10 z)
= V12 (*chain V8 V9 V8 V9 o V8 V9)
= V13 (*id r6 4 V12 :C)
= V14 (*mom r2 2 (*chain V6 V5 V6 V5) l)
= V15 (*mom r2 3 (*chain V6 V5 V14 top V14 V5) l)
= V16 (*mom r2 4 (*chain V6 V5 V14 top V15 top V15 V5) l)
= V17 (cell (s V10) z)
= V18 (*mom r6 4 V12 l)
= V19 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V18 V9)
= V20 (*mom r6 5 V19 l)
= V21 (*mom r6 5 V19 r)
= V22 (*mom r6 6 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V20 V21 V20 V21) l)
= V23 (*mom r6 8 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V20 V21 V22 top bot top V22 V21 V11) l)
= V24 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V20 V21 V22 top bot top V11 V23 top V23 V21)
= V25 (*mom r6 9 V24 l)
= V26 (*mom r6 9 V24 r)
= V27 (*chain V8 V9 V25 V26 V25 V26)
= V28 (*chain V2 V3 (*mom r2 5 (*chain V6 V5 V14 top V15 top V16 top V16 V5) l) top V3 o x V8 V9 V8 V9 (*mom r8 3 V27 l) (*mom r8 3 V27 r) V9)
= V29 (*mom r9 6 V28 l)
= V30 (*mom r9 6 V28 r)
= V31 (*id r6 4 (*chain V29 V30 V29 V30 x V29 V30) :C)
^ is V31 V17

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*mom r1 2 V4 l)
= V7 (*chain V2 V3 V3 V6 V5 V5)
= V8 (*mom r1 3 V7 l)
= V9 (*mom r1 3 V7 r)
= V10 (s z)
= V11 (cell V10 z)
= V12 (*chain V8 V9 V8 V9 o V8 V9)
= V13 (*id r6 4 V12 :C)
= V14 (*mom r2 2 (*chain V6 V5 V6 V5) l)
= V15 (*mom r2 3 (*chain V6 V5 V14 top V14 V5) l)
= V16 (*mom r2 4 (*chain V6 V5 V14 top V15 top V15 V5) l)
= V17 (cell (s V10) z)
= V18 (*mom r6 4 V12 l)
= V19 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V18 V9)
= V20 (*mom r6 5 V19 l)
= V21 (*mom r6 5 V19 r)
= V22 (*mom r6 6 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V20 V21 V20 V21) l)
= V23 (*mom r6 8 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V20 V21 V22 top bot top V22 V21 V11) l)
= V24 (*chain V8 V9 V8 V9 o V8 V9 V13 V18 top V20 V21 V22 top bot top V11 V23 top V23 V21)
= V25 (*mom r6 9 V24 l)
= V26 (*mom r6 9 V24 r)
= V27 (*chain V8 V9 V25 V26 V25 V26)
= V28 (*chain V2 V3 (*mom r2 5 (*chain V6 V5 V14 top V15 top V16 top V16 V5) l) top V3 o x V8 V9 V8 V9 (*mom r8 3 V27 l) (*mom r8 3 V27 r) V9)
= V29 (*mom r9 6 V28 l)
= V30 (*mom r9 6 V28 r)
= V31 (*chain V29 V30 V29 V30 x V29 V30)
= V32 (*id r6 4 V31 :C)
= V33 (cell V10 V10)
= V34 (*mom r6 4 V31 l)
= V35 (*chain V29 V30 V29 V30 x V29 V30 V32 V34 top V34 V30)
= V36 (*mom r6 5 V35 l)
= V37 (*mom r6 5 V35 r)
= V38 (*mom r6 6 (*chain V29 V30 V29 V30 x V29 V30 V32 V34 top V36 V37 V36 V37) l)
= V39 (*mom r6 8 (*chain V29 V30 V29 V30 x V29 V30 V32 V34 top V36 V37 V38 top bot top V38 V37 V17) l)
= V40 (*chain V29 V30 V29 V30 x V29 V30 V32 V34 top V36 V37 V38 top bot top V17 V39 top V39 V37)
= V41 (*mom r6 9 V40 l)
= V42 (*mom r6 9 V40 r)
= V43 (*chain V29 V30 V41 V42 V41 V42)
= V44 (*chain V2 V3 V16 top V3 x o V29 V30 V29 V30 (*mom r8 3 V43 l) (*mom r8 3 V43 r) V30)
= V45 (*mom r9 6 V44 l)
= V46 (*mom r9 6 V44 r)
= V47 (*id r6 4 (*chain V45 V46 V45 V46 o V45 V46) :C)
^ is V47 V33