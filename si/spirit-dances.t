-- Dances Up Earthquakes (Nature Incarnate), special rules:
--  BEGIN A DANCE OF DECADES
--  "Whenever you would play a Power Card, you may instead pay any amount of
--   Energy onto the card to make it an impending card ( [Impending] ), setting
--   it aside out of play for use on a future turn. (It doesn't provide
--   Elements. It's still your Power Card, so it can be forgotten while it's
--   impending.)"
--  RHYTHMIC POWER BUILDS TO A CATACLYSMIC CRESCENDO
--  "When you gain Energy from your Presence Track, also gain [{{{width}}}px]
--   Energy onto each Power Card made [Impending] on a previous turn. If any
--   [Impending] now have Energy on them at least equal to their cost, discard
--   that Energy and play them. (This costs no card plays.)"
--  (the wiki text lost the printed amount to a template glitch: it is a fixed
--   per-turn amount printed on the panel; 1 is used here)

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- More than one turn (as in spirit-wounded.t).
#acc turns-done : @sum
turn-done X / turns-done 1
game, >turn, +turn-done X, ~>tick, turns-done N, lt N 3, ~turn
tick, ^nothing
-- Energy (p13).
#js-def plus +A +B -C { yield [A + B] }
#js-def neg +A -B { yield [-A] }
#js-def upto +Hi -I { for (let i = 0; i <= Hi; i++) yield [i]; }
#acc energy : spirit @sum
spirit S / energy S 0
energy-gain S N / energy S N
energy-spend S N, neg N M / energy S M
-- p8 Spirit Phase: "2. Gain Energy: Gain an amount of Energy equal to the
-- highest uncovered number on your Energy Presence Track. 3. Play and Pay
-- for Power Cards: Select the Power Cards ... You must immediately pay
-- Energy for all Power Cards played". (track value is a fact here)
spirit-phase, turns-done N, ~>gain-energy-phase N, ~>choose-cards, ~play-cards
gain-energy-phase N, spirit:track-energy S X, ~gain-energy-from-track S X
gain-energy-from-track S N, +energy-gain S N
choose-cards, ^nothing
-- the cards a Spirit wants to play this turn are given by the scenario
-- (`wants S P`); each play is keyed by the turn number so that `>play-card`
-- does not also match an earlier turn's play
play-cards, turns-done N, wants S P N, ~play-card S P N
play-card S P N, power:cost P C, +energy-spend S C, ~move P in-play
turn, turns-done N, >play-card S P N, ^played S P
-- "you may": a yes/no decision
setup, +may yes, +may no

-- ---------------------------------------------------------------- BEGIN A DANCE OF DECADES
-- "Whenever you would play a Power Card, you may instead ..."
-- (the "may" is decided before the play, in choose-cards)
choose-cards, spirit:special S dance-of-decades, turns-done N, wants S P N
  ?[rng] R
  !(may R)
  ~dance-ask S P R N
turn, turns-done N, >dance-ask S P R N, is R yes, { play-card S P _ => ~make-impending S P }
-- "... pay any amount of Energy onto the card to make it an impending card,
--  setting it aside out of play for use on a future turn."
make-impending S P, energy S E, turns-done N
  ?[rng] A
  !(upto E A)
  ~impending-pay S P N A
impending-pay S P N C, is C A
  +energy-spend S A
  +energy-on S P A
  +impending S P N
  ~move P impending
-- "(It doesn't provide Elements.)" -- nothing to write: no `played` tuple
-- exists for it, and Elements are counted from `played`.

-- ---------------------------------------------------------------- RHYTHMIC POWER BUILDS TO A CATACLYSMIC CRESCENDO
#acc energy-on-card : power @sum
energy-on S P A / energy-on-card P A
-- "When you gain Energy from your Presence Track, also gain 1 Energy onto each
--  Power Card made Impending on a previous turn."
gain-energy-from-track S X, spirit:special S crescendo, turns-done N
  at P impending, impending S P M, lt M N
  +energy-on S P 1
-- "If any Impending now have Energy on them at least equal to their cost,
--  discard that Energy and play them. (This costs no card plays.)"
spirit-phase, spirit:special S crescendo, turns-done N, >gain-energy-phase N
  at P impending, impending S P M, energy-on-card P E, power:cost P C, ge E C
  ~crescendo-play S P N
crescendo-play S P N, ~move P in-play
turn, turns-done N, >crescendo-play S P N, ^played S P

-- ---------------------------------------------------------------- scenario
-- Dances has 4 Energy, gains 1 per turn from its track. Turn 1 it wants to
-- play Quake (cost 4, Earth): it may make it impending with 0..4 Energy on it;
-- each later turn adds 1 onto it until it reaches 4, then it is played.
setup
  +spirit dances, +spirit:special dances dance-of-decades, +spirit:special dances crescendo
  +spirit:track-energy dances 1, +energy-gain dances 3
  +power quake, +power:card quake, +power:speed quake slow, +power:cost quake 4, +power:element quake fire
  +wants dances quake 0
scenario, ~move quake hand
turn, turns-done N, ^turn-no N
use-power S P, turns-done N, ^used-on-turn S P N
fast-phase, elements dances fire F, turns-done N, ^fire-elements N F
