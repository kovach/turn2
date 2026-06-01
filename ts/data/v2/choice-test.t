#agg at * -> last

~game, ( ~setup; ~turn )

setup
  ~mk a; ~mk b
  ~mk-slot here
  ~mk-slot there
  ~mk-slot else
  ~link here there; ~link there else
  +at a -> here
  +at b -> there
  -- ~mk-slot in-play

link A B
  +adjacent A B
  +adjacent B A

mk X, +item X, +icon X

mk-slot X, +slot X, +icon X

turn
  ( ~push )

push
  ? It To
  !(at It -> X, adjacent X To)
  is It I
  is To T
  ~move I T
  ~done

game
  turn, (done) ; ~turn

game
  turn;
  ~look;
  locations X -> Y, ~count X Y

#agg locations * -> count

look
  at X -> Y, +locations X -> ()

move It To
  +at It -> To