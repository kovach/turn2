#agg at * -> last
move X To, +at X -> To

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
  +place stock
  +place in-play
  +place discard

  +icon stock
  +icon in-play
  +icond discard

mk-cards, ~mk-card trade

mk-card N
  +card C, +card:name C N
  ~move C stock
  +icon C
  +icon:name C N

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

#def draw
draw-one, ?_It, !at _It -> stock
  is _It It
  your-hand H
  ~move It H

#def play
play-one, ?_It, !(your-hand H, at _It -> H)
  is _It It
  ~play.^it It

play P, it P.card:name N, ^play:name P N

play.play:name trade, ~gain 2

turn.actor Y, player:hand Y H, ^your-hand H