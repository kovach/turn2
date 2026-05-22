#acc at * -> last

~game
  (~setup); ~turn

setup
  ~mk a
  ~mk b
  ~mk-slot c
  ~mk-slot d
  +pair a b
  +pair b a
  +at a -> c
  +at b -> d
  ~mk e
  +at e -> a
  +pair e a

mk X, +item X, +icon X

mk-slot X, +icon X, +slot X

#def choose-item
turn
  ?C X
  ~it C
  !item C
  !item X
  !pair C X

#def also turn, it C, ?D, ~also D, !pair C D


= V1 (*chain)
= V2 (*mom r1 1 V1 l)
= V3 (*mom r1 1 V1 r)
= V4 (*chain V2 V3 V2 V3)
= V5 (*mom r1 2 V4 r)
= V6 (*chain V2 V3 V3 (*mom r1 2 V4 l) V5 V5)
= V7 (*mom r1 3 V6 l)
= V8 (*mom r1 3 V6 r)
= V9 (*id choose-item 2 (*chain V7 V8 V7 V8) :C)
^ is V9 a