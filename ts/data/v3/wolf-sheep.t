-- Wolf and sheep in the procedural style (compare ts/data/v2/wolf-sheep.t).
-- The board is a set of #acc views over one setup fact; pieces are made by
-- called procedures; a turn is a procedure of its side. `v3-cli --report`
-- shows no subscriptions: every match is a lookup, an #acc read, or the
-- answer to a choice.

~game
  ~>setup
  ~play wolf z

-- the game loop: a side's turn; if it moved, the other side's turn. Turns
-- do not nest (each ends before the next starts), so `turn wolf` is alive
-- only during a wolf turn. Whether the turn moved is read back as a view
-- once it is over (idiom 3: a child's result is read at its end).
play Side N
  ~>turn Side N
  moved-on N
  op Side Next
  ~play Next (s N)

#acc moved-on : n
went N / moved-on N

setup
  +top-n (s (s (s (s z))))
  +op sheep wolf, +op wolf sheep
  +icon board, +icon nowhere
  ~>make-piece wolf (cell (s z) z)
  ~>make-piece wolf (cell (s (s z)) z)
  ~>make-piece wolf (cell (s (s (s z))) z)
  ~sheep-rows

-- sheep on every cell of rows 2 and up (a lookup over a view, one call each)
sheep-rows, cell (cell X (s (s Y))), ~make-piece sheep (cell X (s (s Y)))

make-piece Ty L
  +piece P, +piece:type P Ty, +put P L
  +icon P, +icon:name P Ty

-- the board: cells are (cell X Y) terms, not fresh objects, so a view can
-- name them (idiom 1)
#acc num : nat
top-n N / num N
num (s X) / num X
#acc cell : cell
num X, num Y / cell (cell X Y)
#acc adj : dir cell cell
num X, num (s X), num Y / adj r (cell X Y) (cell (s X) Y)
num X, num (s X), num Y / adj l (cell (s X) Y) (cell X Y)
num X, num Y, num (s Y) / adj u (cell X Y) (cell X (s Y))
num X, num Y, num (s Y) / adj d (cell X (s Y)) (cell X Y)
#acc wolf-move : cell cell cell
adj D C1 C, adj D C C2 / wolf-move C1 C C2
#acc sheep-move : cell cell
adj _ C1 C2 / sheep-move C1 C2

#acc wolf : piece
piece:type P wolf / wolf P
#acc sheep : piece
piece:type P sheep / sheep P

-- where each piece is: its latest `put`, as of a moment
#acc at : e (@last place)
put It L / at It L
#acc occupied : cell
at _ C / occupied C
#acc wolf-at : cell
at I C, wolf I / wolf-at C

-- the moves open to the side whose turn it is (the turn is alive while
-- it is asked)
#acc valid-move : piece cell
turn wolf _, at P C1, wolf P, wolf-move C1 C C2, not occupied C, not wolf-at C2 / valid-move P C2
turn sheep _, at P C, sheep P, sheep-move C C', not occupied C' / valid-move P C'

-- a turn: pick a piece and a destination, then move it
turn Side N
  ?W, ?To, !(valid-move W To)
  ~go N W To

go N W To, is W WV, is To ToV
  +went N
  ~move WV ToV

move It To, +put It To
-- a wolf landing on a sheep sends the sheep off the board
move It To, wolf It, at X To, sheep X, ~move X nowhere
