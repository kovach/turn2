/ display: ttt.js
/ implementation of tic-tac-toe

: start
+ game
  + setup
  + turn
    + actor o

: setup
/ players, grid
- setup
  + player x
  + player o
  + other x o
  + other o x
  + n z
  + n (s z)
  + n (s (s z))
  / for each Row and Column, make a cell
  , n R
  - n C
  + cell R C

- setup
  , n X
+ hi X

/ A Cell can be chosen if it has not been filled earlier
- [Cell] cell R C
- [T] turn
  # count -> z            / z = zero
    < fill (cell R C) _
  + eligible T Cell

/ each turn, choose an eligible Cell to mark
-[T] turn
  ? Cell
  + choice Cell
  ! eligible T Cell

/ nb: in this demo, decisions are recorded by 
/ *appending* them to the program source.
/ each is a tuple `is ChoiceId DecisionValue`.

/ mark the R,C pair as filled
/ `is` populated by environment whenever a choice is made
/ relates id of choice to id of chosen cell
- is A X
- [X] cell R C
- turn
  - actor P
  - choice A
  + fill (cell R C) P

/ turn is done after choice is made
- turn
  - fill _ _
  + turn-complete

/ after turn is complete, other player turns
- game
  - other P Op
  - turn
    - actor P
    - turn-complete
  + turn
    + actor Op

/ 4 win condition rules /

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




= V1 (@id id r1 id2)
= V2 (@id id r4 id1 (@id id r1 id3))
= V3 (@id id r2 id6 V1)
= V4 (@id id r2 id11 V1 V3 V3)
+ is V2 V4

= V1 (@id id r1 id2)
= V2 (@id id r1 id3)
= V3 (@id id r2 id6 V1)
= V4 (@id id r1 id4)
= V5 (@id id r2 id7 V1)
= V6 (@id id r2 id11 V1 V5 V5)
= V7 (@id id r4 id1 (@id id r7 id6 (@id id r1 id1) (@id id r2 id5 V1) V2 V4 (@id id r6 id3 V2 (@id id r5 id5 (@id id r12 id1) (@id id r2 id11 V1 V3 V3) V2 V4 (@id id r4 id2 V2)))))
+ is V7 V6