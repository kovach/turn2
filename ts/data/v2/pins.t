-- Poison Pins
-- A row of five pins. On your turn, knock down one pin, or two adjacent
-- standing pins. Pin 1 is poisoned: whoever knocks it down loses.

~ game
  ( ~setup );
  ( ~turn
    ^actor a )

setup
  +player a
  +player b
  +other a b
  +other b a
  +n (s (s (s (s (s z)))))

setup, n (s X), +n X

-- pins are numbered 1..5
setup, n (s X), +pin (s X)

-- neighboring pins in the row
-- (derived from n rather than pin x pin: sibling pin emissions have no
--  constructive overlap, so a pin/pin join would not fire; n is derived
--  recursively and hence chain-ordered)
setup, n (s (s X)), +adj (s X) (s (s X))

-- a move hits the pins it knocks down
setup, pin Q, +hits (one Q) Q

setup, adj Q R, +hits (two Q R) Q

setup, adj Q R, +hits (two Q R) R

-- fallen pins, as of a moment
#acc fallen : pin
down Q / fallen Q

-- a pin is standing if it hasn't fallen before this turn
pin Q, turn
  not fallen Q
  ^standing Q

-- legal moves this turn
turn, standing Q
  ^eligible (one Q)

turn, adj Q R, standing Q, not fallen R
  ^eligible (two Q R)

-- At the end of a turn, while the poison pin stands, its player picks a move.
-- The turn's views (`standing`, `eligible`) start inside the turn and hold to
-- its end, so the turn's end is where all of them are alive: the choice is
-- asked there, the move follows, and then the opponent's turn.
game, other P Op
  ( turn, (actor P), not fallen (s z) );
  ?C
  !eligible C
  ( ~move C
    ^mover P );
  ~turn
  ^actor Op

-- the move knocks down the pins it hits
move C, is C M, hits M Q
  +down Q

-- knocking down the poison pin loses the game
move C, (mover P), other P Op, is C M, hits M (s z)
  +won Op
