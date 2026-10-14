-- Wounded Waters Bleeding (Nature Incarnate), special rule:
--  SEEKING A PATH TOWARDS HEALING
--  "After playing cards each Spirit Phase:
--    Claim a Healing Marker (Element Marker) matching whichever of [Water] or
--    [Animal] you have more of. ( You break ties. )
--    You may then Claim a Healing Card if you meet its requirements. ( You can
--    claim your first Healing Card on Turn 3. )
--    Then Destroy 1 [Presence] or Forget a Power Card ( unless a Healing Card
--    just removed this rule )."

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- More than one turn (p8: the game is a sequence of turns). core.t runs one
-- `turn`; each finished turn starts the next, up to 3 turns.
#acc turns-done : @sum
turn-done X / turns-done 1
game, >turn, +turn-done X, ~>tick, turns-done N, lt N 3, ~turn
tick, ^nothing
-- p8 Spirit Phase "3. Play and Pay for Power Cards" as its own step, so
-- "after playing cards" has an end to follow. (`spirit-phase, >play-cards`
-- would also match every earlier turn's play-cards: `>p` only needs p to end
-- before the window, so a step that comes "after" is spelled out instead.)
spirit-phase, ~>play-cards, ~after-play-cards
play-cards, ^nothing
after-play-cards, ^nothing
-- Power Cards have a location (hand / forgotten); p18 "Forget - permanently
-- lose - one of your Power Cards".
forget S P, ~move P forgotten
-- "you may": a yes/no decision
setup, +may yes, +may no

-- ---------------------------------------------------------------- SEEKING A PATH TOWARDS HEALING
-- "After playing cards each Spirit Phase:"
after-play-cards, spirit:special S seeking-a-path, ~seeking S
seeking S
  ~>claim-marker S
  ~>maybe-claim-healing S
  ~pay-the-cost S

-- "Claim a Healing Marker (Element Marker) matching whichever of Water or
--  Animal you have more of. (You break ties.)"
#acc markers : spirit element @sum
spirit S, element E / markers S E 0
healing-marker S E / markers S E 1
claim-marker S, elements S water W, elements S animal A, gt W A, +healing-marker S water
claim-marker S, elements S water W, elements S animal A, lt W A, +healing-marker S animal
claim-marker S, elements S water W, elements S animal A, ge W A, le W A
  ?[rng] E
  !(healing-element E)
  ~tie-break S E
tie-break S C, is C E, +healing-marker S E
setup, +healing-element water, +healing-element animal

-- "You may then Claim a Healing Card if you meet its requirements. (You can
--  claim your first Healing Card on Turn 3.)"
-- (turn 3 = two turns already done; the card and its requirement are invented:
--  "serene-waters: 2 Water Healing Markers; removes Seeking a Path")
maybe-claim-healing S, turns-done N, ge N 2, healing-card H, healing:water H Need, markers S water M, ge M Need
  ?[rng] R
  !(may R)
  ~healing-ask S H R N
-- (healing-ask carries the turn number N: `>healing-ask` alone would also
--  match the ask of an earlier turn)
seeking S, turns-done N, >healing-ask S H R N, is R yes
  +claimed S H
  ^healing-claimed S H
-- a claimed card that removes this rule: from now on the rule is gone ...
seeking S, turns-done N, >healing-ask S H R N, is R yes, healing:removes-rule H
  +rule-removed S seeking-a-path
turn, rule-removed S seeking-a-path, { seeking S => }

-- "Then Destroy 1 Presence or Forget a Power Card"
#acc wounded-option : spirit e
pay-the-cost S, presence-of S P, at P L, land L / wounded-option S P
pay-the-cost S, power:owner P S, at P hand / wounded-option S P
pay-the-cost S
  ?[rng] O
  !(wounded-option S O)
  ~cost-choice S O
cost-choice S O, is O P, presence-of S P, ~destroy-presence O
cost-choice S O, is O P, power:owner P S, ~forget S P
-- "(unless a Healing Card just removed this rule)"
seeking S, turns-done N, >healing-ask S H R N, is R yes, healing:removes-rule H, { pay-the-cost S => }

-- ---------------------------------------------------------------- scenario
-- Three turns. Turn 1 plays a Water card, turn 2 an Animal card, turn 3 a
-- Water card again: markers water, animal, water; on turn 3 the (invented)
-- Healing Card needs 2 Water markers, so it may be claimed, skipping that
-- turn's cost.
setup
  +spirit wounded, +spirit:special wounded seeking-a-path
  +presence-of wounded w1, +presence-of wounded w2, +presence-of wounded w3
  +power tide, +power:card tide, +power:speed tide slow, +power:element tide water, +power:owner tide wounded
  +power claws, +power:card claws, +power:speed claws slow, +power:element claws animal, +power:owner claws wounded
  +power spare, +power:card spare, +power:speed spare slow, +power:element spare fire, +power:owner spare wounded
  +healing-card serene-waters, +healing:water serene-waters 2, +healing:removes-rule serene-waters
  +turn-card 0 tide, +turn-card 1 claws, +turn-card 2 tide
scenario, ~>move w1 l3, ~>move w2 l3, ~>move w3 l3, ~>move tide hand, ~>move claws hand, ~move spare hand
-- the cards played this turn: a turn-scoped acc view (holds at every moment
-- of the turn, so the phases' reads see it)
#acc played : spirit power
turn, turns-done N, turn-card N P / played wounded P
seeking S, turns-done N, ^seeking-on-turn N
cost-choice S O, is O P, turns-done N, ^paid-cost N P
