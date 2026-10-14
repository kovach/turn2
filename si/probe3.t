#acc fear-generated : @sum
#acc at : e @last
move It To, +moved It To
moved It To / at It To
fear-from P N / fear-generated N

~game
game, ~>setup, ~t1
setup, +fear-from a 1, +fear-from b 2, +piece x, ~move x l1
t1, fear-generated N, ^saw N
t1, at x L, ^where L
t1, ?[rng] C, !(opt C), ~picked C
setup, +opt q, +opt r
picked C, is C V, ^chose V
