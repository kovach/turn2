-- Tic-tac-toe drawn by the default icon display: no `-- display:` module.
-- The same game as ttt.t; the rows the display reads (`icon`, `icon:name`,
-- `at`, `left:right`, `above:below`) are at the end.

~game
  ~setup;
  ~turn, ^actor o

-- Setup players and board
--   each `+` is a fact: overlaps every later episode
setup
  +player x, +player o
  +other x o, +other o x
  +n (s (s z))
setup, n (s X), +n X  -- make numbers 2,1,0

-- For each pair of numbers, create a cell
setup, n R, n C
  +cell R C
  +sq (cell R C)

-- filled cells, as of a moment
#acc taken : cell
filled Cell _ / taken Cell

turn, actor P
  ?C
  !(sq C, not taken C)
  ~choice C

-- The external harness writes `is` rows for each user input
turn, actor P, choice C, is C Cell
  +filled Cell P
  ~turn-done

game, other P Op
  (turn, (actor P, turn-done));
  not winner _
  ~turn, ^actor Op

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

-- Display. Every cell is an icon inside `board`; clicking a cell icon
-- answers the move choice, since its term is the option's value.
setup, +icon board
setup, (cell R C)
  +icon (cell R C)
  +at (cell R C) board
-- a cell's label, as of the moment shown: `-`, then the mark played there
#acc icon:name : e (@last name)
sq C / icon:name C -
filled C P / icon:name C P
-- a cell's style, as of the moment shown: a 60px square, then the mark's colour
#acc icon:css : e (@last css)
sq C / icon:css C "width: 60px; height: 60px; padding: 0; justify-content: center; align-items: center; font-size: 32px; font-weight: bold; color: var(--fg-faint)"
filled C x / icon:css C "width: 60px; height: 60px; padding: 0; justify-content: center; align-items: center; font-size: 32px; font-weight: bold; color: var(--t-sl)"
filled C o / icon:css C "width: 60px; height: 60px; padding: 0; justify-content: center; align-items: center; font-size: 32px; font-weight: bold; color: var(--err)"
-- the cells' grid positions: column follows C, row follows R
setup, (cell R C), (cell R (s C)), +left:right (cell R C) (cell R (s C))
setup, (cell R C), (cell (s R) C), +above:below (cell R C) (cell (s R) C)
has-won M, +icon (wins M)
has-won M / icon:css (wins M) "font-size: 20px; font-weight: bold"
