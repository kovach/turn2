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
  +n z
  +n (s z)
  +n (s (s z))

-- For each pair of numbers, create a cell
setup
  n R
  n C
  +cell R C

-- determine filled cells
#acc fills -> bool

-- A cell is eligible to be chosen if it hasn't been filled yet
cell R C, turn
fills (cell R C) -> 0
^eligible (cell R C)

-- ?C: C is a choice to be made
-- ~choice C: other rules refer to it this way
-- !eligible C: C must be *eligible* at the time it is chosen
turn, did-win -> 0
  ?C
  ~choice C
  !eligible C

-- The external harness writes `is` rows for each user input
-- This rule observes them and fills the chosen cell
turn
actor P
choice A
is A Cell
  +filled Cell P
  ~did-fill

turn
filled Cell P
+fills Cell -> 1

-- A turn with at least one filled is finished
turn, did-fill, ~turn-complete

-- After turn is complete, the other player's turn begins
game, other P Op
  ( turn, (actor P, turn-complete) );
  ( ~turn, ^actor Op )

turn, did-win -> 1, +hi

-- Win condition
turn
filled (cell R z) M
filled (cell R (s z)) M
filled (cell R (s (s z))) M
+won M (row R)

turn
filled (cell z C) M
filled (cell (s z) C) M
filled (cell (s (s z)) C) M
+won M (col C)

turn
filled (cell z z) M
filled (cell (s z) (s z)) M
filled (cell (s (s z)) (s (s z))) M
+won M diag1

turn
filled (cell (s (s z)) z) M
filled (cell (s z) (s z)) M
filled (cell z (s (s z))) M
+won M diag2

#acc did-win -> bool

turn, won _ _, +did-win -> 1