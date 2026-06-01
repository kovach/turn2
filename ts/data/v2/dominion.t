-- Each turn has three phases: Action, then Buy, then Clean-up
turn _
  ~action-phase _ ;
  ~buy-phase _ ;
  ~cleanup-phase _

-- In your Action phase, you can play one Action card from your hand.
action-phase _
  ~do-action

do-action
  ~choose-action.it.is A ;
  ~play-action.it.^is A ;

-- Play has three steps: announce, move into play, follow its instructions.
play-action.it.is A
  ~announce A ;
  ~move A in-play ;
  ~activate.^it.^is A

-- How to activate an action (two examples)

-- Throne Room:
-- You may play an action card from your hand twice.
#def throne-room
activate.it.is.card:name throne-room,
  ( ~choose-action.it.is C );
  ( ~play-action.it.^is C);
  ( ~play-action.it.^is C)

-- Village:
-- +1 Card +2 Actions
activate.it.is.card:name village
  ( ~gain-card );
  ( ~gain-action );
  ( ~gain-action )
  

-- The Rest --


#agg at _ -> last
move It To
  +at It -> To

~ game
  (~setup);
  (~turn .(^actor you))

#def mk-card
mk-action Name
  +card C
  +card:name C Name
  +at C -> you-hand
  +action C
  +icon C
  +icon:name C Name

mk-copper Name
  +card C
  +card:name C copper
  +at C -> you-hand
  +treasure C
  +icon C
  +icon:name C copper

setup
  +player you
  +player:hand you you-hand
  +icon you-hand
  +icon in-play
  ~mk-action c
  ~mk-action d
  ~mk-action throne-room
  ~mk-action village
  ~mk-copper cop
  ~mk-bool

mk-bool
  +bool 1
  +bool 0
  +icon 1
  +icon:name 1 do
  +icon 0
  +icon:name 0 do-not

-- your-hand refers to the hand of the active player this turn
turn.actor.player:hand.^your-hand

choose-action E
  ~choose-card.it Card
  ~it E Card
  !action Card

choose-card E
  your-hand H
  ? Card
  ~it E Card
  !at Card -> H

play-action.^it C

#def act-c activate.it.is.card:name c, ~go-c
#def act-d activate.it.is.card:name d, ~go-d

gain-action, ~action-token

action-token
  ? X
  ! bool X
  is X 1
  ~do-action
