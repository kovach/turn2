/ display: ttt.js

/ basically tic-tac-toe
/ players, grid
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

/ actor P fills a square with their mark
- turn
  - actor P
  ? ask
    - value C
    + fill C P

- target-power
  - power P
  - power:range P R
  ? target T
  ? source S
  ! land S
  ! land T
  ! range S T R 

- game
  - fill C P
  + not-empty C

- turn
  - fill _ _
  + complete

/ after player fills a square, other player turns
- game
  - other P Op
  - turn
    - actor P
    - complete
  + turn
    + actor Op

/ `<` demo
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

- game
  - fill (cell R z) M
  - fill (cell R (s z)) M
  - fill (cell R (s (s z))) M
  + won M (row R)

- game
  - fill (cell z C) M
  - fill (cell (s z) C) M
  - fill (cell (s (s z)) C) M
  + won M (col C)

- game
  - fill (cell z z) M
  - fill (cell (s z) (s z)) M
  - fill (cell (s (s z)) (s (s z))) M
  + won M diag1

- game
  - fill (cell (s (s z)) z) M
  - fill (cell (s z) (s z)) M
  - fill (cell z (s (s z))) M
  + won M diag2