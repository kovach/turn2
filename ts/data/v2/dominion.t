#acc at e -> last

~ game
  (~setup);
  (~turn .(^actor you))

#def mk-card
mk-card Name
  +card C
  +card:name C Name
  +at C -> you-hand
  +action C

setup
  +player you
  +player:hand you you-hand
  ~mk-card c
  ~mk-card d

-- Each turn has three phases: Action, then Buy, then Clean-up
turn _
  ( ~action-phase );
  ( ~buy-phase );
  ( ~cleanup-phase )

-- In your Action phase, you can play one Action card from your hand.
action-phase
  ( ~choose-action.it.is A);
  ( ~play-action.it.^is A )

-- your-hand refers to the hand of the active player this turn
turn.actor.player:hand.^your-hand

choose-action E
  your-hand H
  ? Card
  ~it E Card
  !at Card -> H
  !action Card

move It To, +at It -> To

#def play
play-action E
  ? C
  ~it E C
  !card C

-- Playing an Action card has three steps:
--   announcing it, moving it to the play area, and following the instructions on it
play-action.it.is A
  ( ~announce A );
  ( ~move A in-play );
  ( ~activate.^it A)

activate.it.card:name c, ~go-c

activate.it.card:name d, ~go-d

-- Throne Room:
-- You may play an action card from your hand twice.
activate.it.card:name throne-room,
  ( ~choose-action.it.is C );
  ( ~play-action.it.^is C);
  ( ~play-action.it.^is C)

-- Village:
-- +1 Card +2 Actions
activate.it.card:name village
  ( ~gain-card );
  ( ~gain-action );
  ( ~gain-action )
