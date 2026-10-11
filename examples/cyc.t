~ game
  ( ~setup ); ( ~turn )

setup
  +edge a b
  +edge b c
  +edge c a

turn, edge A B, ^reach A B
turn, reach A B, edge B C, ^reach A C
