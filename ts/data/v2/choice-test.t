#acc at * -> last

~game
  (~setup); 
  --(~foo);
  (~turn)

foo, ?C, !item C

foo, ?X, !item X

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
  ~mk-slot in-play

mk X, +item X, +icon X

mk-slot X, +icon X, +slot X

#def choose-item
turn
  ?C X
  ~it C
  !item C
  !item X
  !pair C X
  is C Card
  +at Card -> in-play

--#def also turn, it C, ?D, ~also D, !pair C D
