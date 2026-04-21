-- basically tic-tac-toe

-- players, grid
+ game
  + player x
  + player o
  + other x o
  + other o x
  + n z
  + n (s z)
  + n (s (s z))
  - n R
  - n C
  + cell R C

-- first turn
- game
  + turn 
    + actor x

- is A X
- [X] cell R C
- [A] ask
  + value (cell R C)

 -- actor P fills a square with their mark
- turn
  - actor P
  ? ask
    - value C
    + fill C P

- game
  - fill C P
  + not-empty C  

-- after player fills a square, other player turns
- game
  - other P Op
  - turn
    - actor P
    - fill _ _
  + turn
    + actor Op

- game
  - fill (cell R z) M
  - fill (cell R (s z)) M
  - fill (cell R (s (s z))) M
  + won M (row R)

-[T] turn
  - actor X
  < player X 
    + acted T

- [A] ask
  + what A

- fill (cell R C) _
- cell R C
  + filled

= V1 (id r2 id1)
= V2 (id r2 id11 (id r2 id8) (id r2 id7))
= V3 (id r5 id3 (id r3 id2 V1) (id r3 id3 V1))
+ is V3 V2

= V1 (id r2 id1)
= V2 (id r2 id4)
= V3 (id r2 id8)
= V4 (id r2 id7)
= V5 (id r11 id4 X1 X2 X3)
= V6 (id r3 id2 V1)
= V7 (id r3 id3 V1)
= V8 (id r2 id11 V3 V4)
= V9 (id r2 id11 V3 (id r2 id6))
= V10 (id r5 id3 V6 V7)
= V11 (id r4 id2 V5 V8 V10)
= V12 (id r5 id5 V6 V7 V11)
= V13 (id r5 id3 (id r7 id6 V1 V2 V6 V7 V12) (id r7 id7 V1 V2 V6 V7 V12))
+ is V13 V9

= V1 (id r2 id1)
= V2 (id r2 id4)
= V3 (id r2 id8)
= V4 (id r2 id7)
= V5 (id r12 id4 X1 X2 X3)
= V6 (id r3 id2 V1)
= V7 (id r3 id3 V1)
= V8 (id r2 id11 V3 V4)
= V9 (id r2 id11 V4 (id r2 id6))
= V10 (id r5 id3 V6 V7)
= V11 (id r4 id2 V5 V8 V10)
= V12 (id r5 id5 V6 V7 V11)
= V13 (id r5 id3 (id r7 id6 V1 V2 V6 V7 V12) (id r7 id7 V1 V2 V6 V7 V12))
+ is V13 V9

= V1 (id r2 id1)
= V2 (id r2 id5)
= V3 (id r2 id4)
= V4 (id r2 id8)
= V5 (id r2 id7)
= V6 (id r2 id6)
= V7 (id r12 id4 X1 X2 X3)
= V8 (id r3 id2 V1)
= V9 (id r3 id3 V1)
= V10 (id r2 id11 V4 V5)
= V11 (id r2 id11 V5 V6)
= V12 (id r2 id11 V6 V6)
= V13 (id r14 id14 X1 X2 X3 X4 X5 X6 X7 X8 X9 X10 X11 X12 X13)
= V14 (id r5 id3 V8 V9)
= V15 (id r4 id2 V7 V10 V14)
= V16 (id r5 id5 V8 V9 V15)
= V17 (id r7 id6 V1 V3 V8 V9 V16)
= V18 (id r7 id7 V1 V3 V8 V9 V16)
= V19 (id r5 id3 V17 V18)
= V20 (id r4 id2 V13 V11 V19)
= V21 (id r5 id5 V17 V18 V20)
= V22 (id r5 id3 (id r7 id6 V1 V2 V17 V18 V21) (id r7 id7 V1 V2 V17 V18 V21))
+ is V22 V12