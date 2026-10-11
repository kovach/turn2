-- where something is: its latest position, as of a moment
#acc at : e (@last location)
put It To / at It To

-- To move something, assert its new position
move It To, +put It To

-- Rule of thumb: actions are usually unary predicates (on an id for the particular event)
-- Their arguments can be attached as attributes
-- Turn infers the arity of each predicate, and allows us to drop extra arguments when a rule doesn't need to refer to them

-- During your turn, first draw and then play a card.
turn,
  ~draw; ~play

-- To draw, move the top card of the deck to your hand.
draw, top-card C, your-hand H, ~move C H

-- To play a card: choose a card in your hand, move it into play, and activate it.
play,
  ?X, !(at X hand), is X Card,
  ~move Card in-play; ~activate, ^:card Card

~setup; ( ~turn, ^:player me )

setup
  +player:opponent me you, +player:opponent you me
  
-- relational data
--- "minion" is a card
define-cards
  +card It              -- Unbound var -> fresh id term
  +card:name It minion

activate, :card.card:name minion,
  ~summon, ^:type minion

summon,
  ?X, !land X, is X L
  ^:it I, +put I L

summon, :it I, :type minion, +:ap I 1, +:hp I 1

-- Rule of thumb: an action should name its arguments
draw D, top-of-deck C, ^:card D C

-- "your hand": the hand of the player whose turn it is
turn, active-player P, player:hand P H, ^your-hand H

---- temporal locality

-- To push: choose a creature and a location adjacent to it, then move it there.
push P,
  ?It, !creature It, ^:it P It
  ?To, !location To, ^:to P To
  !(at It X, adjacent X To)
  is It A, is To B, ~move A B

-- exceptions
--- unconditional exception

-- Insert a *pre-draw* step before every draw
{draw => ~pre-draw; ~draw}

--- local effect modification
-- ritual: push a creature you control into a forest. then attack with it. it has +1 AP for this attack
activate.:card.card:name ritual,
  ( ~push, .(:to L), .(:it C),
    !yours C,
    !forest L );
  ~attack.^:it C,
    { ap X => ~ap (s X) }

--- new mechanic

attack A, :creature A C, :ap C AP, ^:ap A AP

-- choose A; push A; choose creature C in same land; A deals AP damage to C
attack E,
  ?X, !yours X, is X A, 
  ~push.^:it A ;
  at A Land
  ?C, !(at C Land),
  :ap E Dmg, ~dmg.(^:it C).(^:amount Dmg)

--- turn alternation
game, player:opponent Current Next
  ( turn
      .(:player Current)
      (turn-complete)
  ); ( ~turn, ^:player Next )