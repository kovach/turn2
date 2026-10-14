-- Sharp Fangs Behind the Leaves (Branch & Claw). Special rules (wiki, verbatim):
--  ALLY OF THE BEASTS: "Your [Presence] may move with [Beasts]. (Whenever a
--   [Beasts] moves from 1 of your lands to another land, you may move 1
--   [Presence] along with it.)"
--  CALL FORTH PREDATORS: "During each Spirit Phase, you may replace 1 of
--   your [Presence] with 1 [Beasts]. The replaced [Presence] leaves the
--   game. (It was not destroyed, so things which return destroyed
--   [Presence] cannot bring it back.)"

-- ALLY OF THE BEASTS
-- "Whenever a Beasts moves from 1 of your lands to another land, you may
--  move 1 Presence along with it."  (`at` is read at the start of the move,
--  i.e. where the Beasts comes from; `decline` is the "may")
#acc ally-option : spirit e
ally-move S B From To, presence-of S P, at P From / ally-option S P
ally-move S B From To / ally-option S decline
move B To, beasts-at B From, land To, spirit:special S ally-of-the-beasts, has-presence S From
  ~ally-move S B From To
ally-move S B From To
  ?[rng] P
  !(ally-option S P)
  ~ally-choice S P To
ally-choice S C To, is C P, presence-of S P, ~move P To

-- CALL FORTH PREDATORS
-- "During each Spirit Phase, you may replace 1 of your Presence with 1
--  Beasts. The replaced Presence leaves the game."
#acc predator-option : spirit e
call-forth S, presence-of S P, at P L, land L / predator-option S P
call-forth S / predator-option S decline
spirit-phase, spirit:special S call-forth-predators, ~call-forth S
call-forth S
  ?[rng] P
  !(predator-option S P)
  ~predator-choice S P
predator-choice S C, is C P, presence-of S P, at P L
  ~>move P out-of-game
  ~add-piece L beasts

-- scenario: Fangs has 2 Presence in l3 and a Beasts there; a Power pushes
-- the Beasts (rng may bring a Presence along). In the Spirit Phase it may
-- also replace a Presence with a Beasts.
setup
  +spirit fangs, +spirit:special fangs ally-of-the-beasts
  +spirit:special fangs call-forth-predators
  +presence-of fangs f1, +presence-of fangs f2
scenario, ~>move f1 l3, ~>move f2 l3, ~add-piece l3 beasts
fast-phase, at B l3, piece:kind B beasts, ~push fangs B l3
report, presence-of fangs P, at P L, ^fangs-presence P L
report, at B L, piece:kind B beasts, ^beasts-report B L
