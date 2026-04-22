---
--- display: ttt.js
---

-- basically tic-tac-toe

-- players, grid
+ game
  + setup
  + turn
    + actor x

- setup
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


- turn
  - fill _ _
  + complete

-- after player fills a square, other player turns
- game
  - other P Op
  - turn
    - actor P
    - complete
  + turn
    + actor Op

- game
  - fill (cell R z) M
  - fill (cell R (s z)) M
  - fill (cell R (s (s z))) M
  + won M (row R)

-[T] turn
  - actor X
  - complete
  < player X
    + acted T

- [A] ask
  + ask-id A

- fill (cell R C) _
- cell R C
  + filled


= V1 (id r1 id2)
= V2 (id r4 id3 (id r1 id3) (id r1 id4))
= V3 (id r2 id6 V1)
= V4 (id r2 id11 V1 V3 V3)
+ is V2 V4

= V1 (id r1 id1)
= V2 (id r1 id2)
= V3 (id r1 id3)
= V4 (id r1 id4)
= V5 (id r2 id6 V2)
= V6 (id r2 id4 V2)
= V7 (id r2 id7 V2)
= V8 (id r2 id11 V2 V7 V7)
= V9 (id r6 id3 V3 (id r4 id5 V3 V4 (id r3 id2 (id r12 id5) (id r2 id11 V2 V5 V5) (id r4 id3 V3 V4))))
= V10 (id r4 id3 (id r7 id6 V1 V6 V3 V4 V9) (id r7 id7 V1 V6 V3 V4 V9))
+ is V10 V8

= V1 (id r1 id1)
= V2 (id r1 id2)
= V3 (id r1 id3)
= V4 (id r1 id4)
= V5 (id r2 id6 V2)
= V6 (id r2 id4 V2)
= V7 (id r2 id7 V2)
= V8 (id r6 id3 V3 (id r4 id5 V3 V4 (id r3 id2 (id r12 id5) (id r2 id11 V2 V5 V5) (id r4 id3 V3 V4))))
= V9 (id r7 id6 V1 V6 V3 V4 V8)
= V10 (id r7 id7 V1 V6 V3 V4 V8)
= V11 (id r2 id5 V2)
= V12 (id r2 id11 V2 V7 V5)
= V13 (id r6 id3 V9 (id r4 id5 V9 V10 (id r3 id2 (id r13 id11) (id r2 id11 V2 V7 V7) (id r4 id3 V9 V10))))
= V14 (id r4 id3 (id r7 id6 V1 V11 V9 V10 V13) (id r7 id7 V1 V11 V9 V10 V13))
+ is V14 V12

= V1 (id r1 id1)
= V2 (id r1 id2)
= V3 (id r1 id3)
= V4 (id r1 id4)
= V5 (id r2 id6 V2)
= V6 (id r2 id4 V2)
= V7 (id r2 id7 V2)
= V8 (id r6 id3 V3 (id r4 id5 V3 V4 (id r3 id2 (id r12 id5) (id r2 id11 V2 V5 V5) (id r4 id3 V3 V4))))
= V9 (id r7 id6 V1 V6 V3 V4 V8)
= V10 (id r7 id7 V1 V6 V3 V4 V8)
= V11 (id r2 id5 V2)
= V12 (id r6 id3 V9 (id r4 id5 V9 V10 (id r3 id2 (id r13 id11) (id r2 id11 V2 V7 V7) (id r4 id3 V9 V10))))
= V13 (id r7 id6 V1 V11 V9 V10 V12)
= V14 (id r7 id7 V1 V11 V9 V10 V12)
= V15 (id r2 id11 V2 (id r2 id8 V2) V5)
= V16 (id r6 id3 V13 (id r4 id5 V13 V14 (id r3 id2 (id r14 id15) (id r2 id11 V2 V7 V5) (id r4 id3 V13 V14))))
= V17 (id r4 id3 (id r7 id6 V1 V6 V13 V14 V16) (id r7 id7 V1 V6 V13 V14 V16))
+ is V17 V15

= V1 (id r1 id1)
= V2 (id r1 id2)
= V3 (id r1 id3)
= V4 (id r1 id4)
= V5 (id r2 id6 V2)
= V6 (id r2 id4 V2)
= V7 (id r2 id7 V2)
= V8 (id r6 id3 V3 (id r4 id5 V3 V4 (id r3 id2 (id r12 id5) (id r2 id11 V2 V5 V5) (id r4 id3 V3 V4))))
= V9 (id r7 id6 V1 V6 V3 V4 V8)
= V10 (id r7 id7 V1 V6 V3 V4 V8)
= V11 (id r2 id5 V2)
= V12 (id r6 id3 V9 (id r4 id5 V9 V10 (id r3 id2 (id r13 id11) (id r2 id11 V2 V7 V7) (id r4 id3 V9 V10))))
= V13 (id r7 id6 V1 V11 V9 V10 V12)
= V14 (id r7 id7 V1 V11 V9 V10 V12)
= V15 (id r2 id8 V2)
= V16 (id r6 id3 V13 (id r4 id5 V13 V14 (id r3 id2 (id r14 id15) (id r2 id11 V2 V7 V5) (id r4 id3 V13 V14))))
= V17 (id r7 id6 V1 V6 V13 V14 V16)
= V18 (id r7 id7 V1 V6 V13 V14 V16)
= V19 (id r2 id11 V2 V15 V7)
= V20 (id r6 id3 V17 (id r4 id5 V17 V18 (id r3 id2 (id r15 id18) (id r2 id11 V2 V15 V5) (id r4 id3 V17 V18))))
= V21 (id r4 id3 (id r7 id6 V1 V11 V17 V18 V20) (id r7 id7 V1 V11 V17 V18 V20))
+ is V21 V19

= V1 (id r1 id1)
= V2 (id r1 id2)
= V3 (id r1 id3)
= V4 (id r1 id4)
= V5 (id r2 id6 V2)
= V6 (id r2 id4 V2)
= V7 (id r2 id7 V2)
= V8 (id r6 id3 V3 (id r4 id5 V3 V4 (id r3 id2 (id r12 id5) (id r2 id11 V2 V5 V5) (id r4 id3 V3 V4))))
= V9 (id r7 id6 V1 V6 V3 V4 V8)
= V10 (id r7 id7 V1 V6 V3 V4 V8)
= V11 (id r2 id5 V2)
= V12 (id r6 id3 V9 (id r4 id5 V9 V10 (id r3 id2 (id r13 id11) (id r2 id11 V2 V7 V7) (id r4 id3 V9 V10))))
= V13 (id r7 id6 V1 V11 V9 V10 V12)
= V14 (id r7 id7 V1 V11 V9 V10 V12)
= V15 (id r2 id8 V2)
= V16 (id r6 id3 V13 (id r4 id5 V13 V14 (id r3 id2 (id r14 id15) (id r2 id11 V2 V7 V5) (id r4 id3 V13 V14))))
= V17 (id r7 id6 V1 V6 V13 V14 V16)
= V18 (id r7 id7 V1 V6 V13 V14 V16)
= V19 (id r6 id3 V17 (id r4 id5 V17 V18 (id r3 id2 (id r15 id18) (id r2 id11 V2 V15 V5) (id r4 id3 V17 V18))))
= V20 (id r7 id6 V1 V11 V17 V18 V19)
= V21 (id r7 id7 V1 V11 V17 V18 V19)
= V22 (id r2 id11 V2 V5 V7)
= V23 (id r6 id3 V20 (id r4 id5 V20 V21 (id r3 id2 (id r16 id22) (id r2 id11 V2 V15 V7) (id r4 id3 V20 V21))))
= V24 (id r4 id3 (id r7 id6 V1 V6 V20 V21 V23) (id r7 id7 V1 V6 V20 V21 V23))
+ is V24 V22