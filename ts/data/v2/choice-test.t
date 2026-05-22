#acc at * -> last

~game
  (~setup);
  (~turn)

setup
  ~mk a
  ~mk b
  ~mk-slot here
  ~mk-slot there
  ~mk-slot else
  ~link here there
  ~link there else
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
  ( ~push )

push
  ? It To
  !(at It -> X, adjacent X To)
  is It I
  is To T
  ~move I T
  +done

game
  ( turn ); ~tur

game
  turn;
  ~look;
  locations X -> Y, ~count X Y

#acc locations * -> count

look
  at X -> Y, +locations X -> ()

move It To
  +at It -> To

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (*chain V7 V8 V7 V8)
= V10 (*mom r6 2 V9 l)
= V11 (*mom r6 2 V9 r)
= V12 (*id r7 2 (*chain V10 V11 V10 V11) :It)
^ is V12 b

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (*chain V7 V8 V7 V8)
= V10 (*mom r6 2 V9 l)
= V11 (*mom r6 2 V9 r)
= V12 (*id r7 2 (*chain V10 V11 V10 V11 (*id r7 2 (*chain V10 V11 V10 V11) :It)) :To)
^ is V12 else

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (*chain V7 V8 V7 V8)
= V10 (*chain V7 V8 V7 V8 (*mom r6 2 V9 l) (*mom r6 2 V9 r))
= V11 (*mom r6 3 V10 l)
= V12 (*mom r6 3 V10 r)
= V13 (*id r7 2 (*chain V11 V12 V11 V12) :It)
^ is V13 b

= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (*chain V7 V8 V7 V8)
= V10 (*chain V7 V8 V7 V8 (*mom r6 2 V9 l) (*mom r6 2 V9 r))
= V11 (*mom r6 3 V10 l)
= V12 (*mom r6 3 V10 r)
= V13 (*id r7 2 (*chain V11 V12 V11 V12 (*id r7 2 (*chain V11 V12 V11 V12) :It)) :To)
^ is V13 here