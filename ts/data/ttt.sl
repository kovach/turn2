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
-[X] cell R C
-[A] ask
  + value (cell R C)

 -- actor P fills a square with their mark
- turn
  - actor P
  ? ask
     - value C
     + fill C P

-- after player fills a square, other player turns
- game
  - other P Op
  - turn
    - actor P
    - fill _ _
  + turn
    + actor P

- game
  - fill (cell R z) M
  - fill (cell R (s z)) M
  - fill (cell R (s (s z))) M
  + won M (row R)

-[T] turn
  - actor X
  < player X 
    + acted T


+ is (id r5 id3 (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1))) (id r2 id11 (id r2 id6) (id r2 id6))

+ is (id r5 id3 (id r6 id6 (id r2 id1) (id r2 id4) (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1)) (id r5 id5 (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1)) (id r4 id2 (id r9 id1) (id r2 id11 (id r2 id6) (id r2 id6)) (id r5 id3 (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1)))))) (id r6 id7 (id r2 id1) (id r2 id4) (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1)) (id r5 id5 (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1)) (id r4 id2 (id r9 id1) (id r2 id11 (id r2 id6) (id r2 id6)) (id r5 id3 (id r3 id2 (id r2 id1)) (id r3 id3 (id r2 id1))))))) (id r2 id11 (id r2 id6) (id r2 id7))