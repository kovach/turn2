~game
  ~setup;
  ~turn
    .(^actor me)
    .(^index 1)   

game, (turn, (turn-done)); ~turn

setup
  ~mk-players
  ~mk-piles
  ~mk-cards

mk-piles
  ~mk-place stock
  ~mk-place in-play
  ~mk-place discard

mk-place X, +place X, +icon X

mk-cards, ~mk-card trade

mk-card N
  +card C, +card:name C N
  ~move C stock
  +icon C
  +icon:name C N

mk-card trade
  card:name C trade
  +card:cost C -> 2

mk-players
  ~mk-player me
  ~mk-player you

mk-player P, +place H
  +player:hand P H
  +icon H
  +icon:name H (hand P)

#def turn turn _,
  ~draw-one;
  ~play-one

-- TODO
card C, ^may-draw C

#def draw
draw-one, ?_It, !(at _It -> stock, may-draw _it)
  is _It It
  your-hand H
  ~move It H

#def play
play-one, ?_It, !(your-hand H, at _It -> H)
  is _It It
  ~move It in-play;
  ~play.^it It

play.play:name trade, ~gain 2

-- MISC --
#agg at * -> last
move X To, +at X -> To

#agg card:cost card -> sum

play P, it P.card:name N, ^play:name P N

turn.actor Y, player:hand Y H, ^your-hand H
