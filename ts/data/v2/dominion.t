-- Each turn has three phases: Action, then Buy, then Clean-up
-- (they start after the turn's actor, so the actor is visible in them)
turn.actor _
  ~action-phase;
  ~buy-phase ;
  ~cleanup-phase

-- In your Action phase, you can play one Action card from your hand.
action-phase
  ~do-action

do-action
  ~choose-action.it.is A ;
  ~play-action.it.^val A ;

-- Play has three steps: announce, move into play, follow its instructions.
-- (`val` is the card a play or activation is about; `is` is reserved for
-- the harness's choice resolutions)
play-action.it.val A
  ~announce A ;
  ~move A in-play ;
  ~activate.^it.^val A

-- How to activate an action (two examples)

-- Throne Room:
-- You may play an action card from your hand twice.
#def throne-room
activate.it.val.card:name throne-room,
  ( ~choose-action.it.is C );
  ( ~play-action.it.^val C);
  ( ~play-action.it.^val C)

-- Village:
-- +1 Card +2 Actions
activate.it.val.card:name village
  ( ~gain-card );
  ( ~gain-action );
  ( ~gain-action )
  
-- The Rest --

-- where each card is: its latest move, as of a moment
#acc at : card (@last place)
put It To / at It To
move It To
  +put It To

~game
  (~setup);
  (~turn .(^actor you))

#def mk-card
mk-action Name
  +card C
  +card:name C Name
  +put C you-hand
  +action C
  +icon C
  +icon:name C Name

mk-copper Name
  +card C
  +card:name C copper
  +put C you-hand
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
#acc your-hand : place
turn.actor.player:hand H / your-hand H

-- A `!` sits at the moment its `?` was asked. choose-card asks at its own
-- start, so its constraint comes before `~it` (which moves the rule on), and
-- choose-action adds `!action` from the same moment: `~choose-card D` leaves
-- it at choose-card's start, and the parenthesized `(it D Card)` reads the
-- card without moving it.
choose-action E
  ~choose-card D
  (it D Card)
  !action Card
  ~it E Card

choose-card E
  your-hand H
  ? Card
  !(at Card H)
  ~it E Card

play-action.^it C

#def act-c activate.it.val.card:name c, ~go-c
#def act-d activate.it.val.card:name d, ~go-d

gain-action, ~action-token

action-token
  ? X
  ! bool X
  is X 1
  ~do-action