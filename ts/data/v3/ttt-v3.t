-- engine: v3
-- display: ttt-display.js
-- tic-tac-toe in the procedural style (plans/v3-procedural.md, the idioms
-- of discussions/procedural-turn.md §6). Every rule is triggered by one
-- episode, and everything else it reads is a lookup of earlier facts, an
-- #acc view, or the answer to its own choice: `v3-cli --report` shows no
-- subscriptions. Compare ts/data/v2/ttt.t.

~game
  ~>setup
  ~turn o

setup
  +player x, +player o
  +other x o, +other o x
  +top-n (s (s z))

-- The board is timeless: views over the setup facts instead of rules that
-- re-derive inside `setup` (idiom 1: closures are #acc relations).
#acc num : nat
top-n N / num N
num (s X) / num X

#acc sq : cell
num R, num C / sq (cell R C)

#acc adj : cell cell dir
num (s X), num Y / adj (cell X Y) (cell (s X) Y) dx
num X, num (s Y) / adj (cell X Y) (cell X (s Y)) dy
num (s X), num (s Y) / adj (cell X Y) (cell (s X) (s Y)) dxy
num (s X), num (s Y) / adj (cell X (s Y)) (cell (s X) Y) dxy'

-- filled cells and the winner, as of a moment (idiom 5: the win check is a
-- view read after the move, not a join that waits inside the turn)
#acc taken : cell
filled Cell _ / taken Cell
#acc winner : player
filled A M, adj A B D, filled B M, adj B C D, filled C M / winner M

-- A turn is a procedure of its player (idiom 2: the actor is an argument):
-- ask for a free cell, place the mark, and unless someone has won, the
-- other player's turn follows.
turn P
  ?C
  !(sq C, not taken C)
  ~>place P C
  not winner _
  other P Op
  ~turn Op

place P C, is C Cell, +filled Cell P