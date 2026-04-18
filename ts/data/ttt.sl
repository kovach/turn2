# basically tic-tac-toe

# players, grid
+ game
  + player x
  + player o
  + other x o
  + other o x
  + n 1
  + n 2
  + n 3
  - n X
  - n Y
  + cell X Y

# first turn
- game
  + turn 
    + actor x

- is A X
-[A] ask
  + value X

# actor P fills a square with their mark
- turn
  - actor P
  ? ask
     - value C
     + fill C P

# after player fills a square, other player turns
- game
  - other P Op
  - turn
    - actor P
    - fill _ _
  + turn
    + actor Op