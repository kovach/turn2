-- display: ttt-display.js

~game
  ~setup;
  ~turn, ^actor o

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
  +sq (cell R C)

-- filled cells, as of a moment
#acc taken : cell
filled Cell _ / taken Cell

turn, actor P
  not winner _
  ?C
  !(sq C, not taken C)
  ( ~choice C
    ^chooser P );

game, other P Op
  (turn, actor P, not winner _);
  ~turn
  ^actor Op

-- The external harness writes `is` rows for each user input
choice C, (chooser P), is C Cell
  +filled Cell P

-- Directions and Adjacency
-- (excessively general; could use to implement go-moku, etc)
#def dx   setup, n (s X), n Y, +vector X Y (s X) Y dx
#def dy   setup, n X, n (s Y), +vector X Y X (s Y) dy
#def dxy  setup, n (s X), n (s Y), +vector X Y (s X) (s Y) dxy
#def dxy' setup, n (s X), n (s Y), +vector X (s Y) (s X) Y dxy'

setup
  vector X1 Y1 X2 Y2 Dir,
  +adj (cell X1 Y1) (cell X2 Y2) Dir

-- Win condition: checked in each turn, over the moves made before it
turn
  filled A M
  adj A B D
  filled B M
  adj B C D
  filled C M
  ~won M D

-- someone has won (persistent), for negation
turn, (won M _), +has-won M
#acc winner : player
has-won M / winner M