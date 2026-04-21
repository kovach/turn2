---
--- display: ttt.js
---

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