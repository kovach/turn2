#acc reach : node node

~ game
  ( ~setup ); ( ~turn )

setup
  +edge a b
  +edge b c
  +edge c a

edge A B / reach A B
edge A B, reach B C / reach A C

-- an ordinary rule reads the closure at its anchor's start
turn, reach A C, ^can-reach A C
