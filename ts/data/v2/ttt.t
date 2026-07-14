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
