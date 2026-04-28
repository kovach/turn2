/ display: ttt.js

/ basically tic-tac-toe
+ game
  + setup
  + turn
    + actor x

/ players, grid
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

/ surface every cell-row id so the per-turn ask has options to enumerate
- [X] cell R C
+ is-cell X

/ actor P fills a square with their mark.
/   ? A             choice term; options come from `! is-cell A`
/   + asked-cell A T  surfaces the (choice, turn) link at top level so
/                     the click consumer below can locate the right turn
-[T] turn
  - actor P
  ? A
  + choice A
  ! is-cell A

/ Click resolution: once `+ is <A> <cellId>` is appended to source, derive
/ the fill under the asking turn. Top-level Match siblings let us see the
/ click-asserted `is` row (also top-level) — a Match nested inside `turn`
/ would only descend into turn's children and miss the sibling `is`.
- is A X
- [X] cell R C
- turn
  - actor P
  - choice A
  + fill (cell R C) P

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