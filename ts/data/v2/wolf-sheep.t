#agg at * -> last

~setup; ~turn.^:actor wolf

setup, +num (s (s (s (s z))))
  +op sheep wolf, +op wolf sheep
^icon board
^icon nowhere

cell C I J, ^icon C, ^icon:name C -
cell C (s z) z, setup, ~make-piece wolf C
cell C (s (s z)) z, setup, ~make-piece wolf C
cell C (s (s (s z))) z, setup, ~make-piece wolf C

cell C X (s (s _)), setup, ~make-piece sheep C

make-piece Ty L
  +piece P, +piece:type P Ty, +at P -> L

piece X, ^icon X, piece:type X T, ^icon:name X T

piece P, piece:type P wolf, ^wolf P
piece P, piece:type P sheep, ^sheep P

num (s N), ^num N, ^incr N (s N)

num I, num J, ^cell C I J

setup, incr A B, cell C1 A X, cell C2 B X
  +left:right C1 C2
setup, incr A B, cell C1 X A, cell C2 X B
  +above:below C2 C1

cell C _ _, ^at C board

cell C1 X Y, cell C2 (s X) Y
  ^adj r C1 C2, ^adj l C2 C1
cell C1 X Y, cell C2 X (s Y)
  ^adj u C1 C2, ^adj d C2 C1

adj D C1 C, adj D C C2, ^wolf-move C1 C C2
adj _ C1 C2, ^sheep-move C1 C2

#macro it:at It L := [at It L | last L]
#macro cell:count C N := [it:at A C | N = count A]
#macro no-wolf C := [it:at I C, wolf I | z = count I]

turn, :actor _ wolf
  at P -> C1, wolf P
  wolf-move C1 C C2
  cell:count C z, no-wolf C2
  ^valid-move P C2

turn, :actor _ sheep,
  at P -> C, sheep P
  sheep-move C C', 
  cell:count C' z,
  ^valid-move P C'

go,
  ?W, ?To, !(valid-move W To)
  is W WV, is To ToV
  ~done, ~move WV ToV

move It To, +at It To
move It To, at X -> To, sheep X, ~move X nowhere

(op X Y, turn.:actor X, (done)); ~turn.^:actor Y
turn, ~go