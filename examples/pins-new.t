-- Poison Pins, rewritten for fresh-left `^`.
-- A turn is a deliberation episode: views are derived with `^` inside it and
-- all hold from their own start to the turn's end, so the turn's end is the
-- one moment where every view is alive. The move is chosen there, after the
-- turn, and the next turn follows the move.

~ game
  + rng-seed 7
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
setup, n (s X), +pin (s X)
setup, n (s (s X)), +adj (s X) (s (s X))
setup, pin Q, +hits (one Q) Q
setup, adj Q R, +hits (two Q R) Q
setup, adj Q R, +hits (two Q R) R

#agg downs -> bool

-- views of the turn (unchanged)
pin Q, turn
  downs Q -> 0
  ^standing Q

turn, standing Q
  ^eligible (one Q)

turn, adj Q R, standing Q, downs R -> 0
  ^eligible (two Q R)

-- at the end of the turn, while the poison pin stands, its player moves;
-- the next turn follows the move
game, other P Op
  ( turn, (actor P), downs (s z) -> 0 );
  ?[rng] C
  !eligible C
  ( ~move C
    ^mover P );
  ~turn
  ^actor Op

-- the move's effects happen inside the move
move C, is C M, hits M Q
  +down Q
  +downs Q -> 1

move C, (mover P), other P Op, is C M, hits M (s z)
  +won Op
