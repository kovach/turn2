-- Thunderspeaker (Base). Special rules, verbatim:
--   ALLY OF THE DAHAN: "Your [Presence] may move with [Dahan]. (Whenever a
--   [Dahan] moves from 1 of your lands to another land, you may move 1
--   [Presence] along with it.)"
--   SWORN TO VICTORY: "After a Ravage Action destroys 1 or more [Dahan], for
--   each [Dahan] Destroyed, Destroy 1 of your [Presence] within 1 [Range]."

-- ---------------------------------------------------------------- ALLY OF THE DAHAN
-- "Whenever a Dahan moves from 1 of your lands to another land, you may move
--  1 Presence along with it."  (trigger on the base move episode; `at D From`
--  is read at the start of the move, i.e. where the Dahan came from)
#acc ally-option : spirit land e
presence-of S P, at P From / ally-option S From P
spirit S, land From / ally-option S From stay
move D To, piece:kind D dahan, land To, at D From, land From,
  spirit:special S ally-of-the-dahan, has-presence S From
  ?[rng] C
  !(ally-option S From C)
  ~ally-choice S C To
ally-choice S C To, is C P, presence-of S P, ~move P To

-- ---------------------------------------------------------------- SWORN TO VICTORY
-- "After a Ravage Action destroys 1 or more Dahan, for each Dahan Destroyed,
--  Destroy 1 of your Presence within 1 Range."
#acc near : land land
land L / near L L
adjacent L L2, land L2 / near L L2
ravage L, destroy D, piece:kind D dahan, +dahan-lost-in L D
#acc dahan-lost : land @sum
dahan-lost-in L D / dahan-lost L 1
-- "After a Ravage Action ...": after its last step (Dahan fight back) but
-- still inside the Ravage, so it finishes before the next land Ravages.
ravage L, >dahan-fight-back L, dahan-lost L N, spirit:special S sworn-to-victory
  ~sworn S L N
-- "for each Dahan Destroyed": a counted loop, one Presence at a time, so
-- that each destroys a *different* Presence (independent per-Dahan firings
-- happen at one moment and may all choose the same Presence)
sworn S L N, gt N 0
  ?[rng] C
  !(presence-of S C, at C L2, near L L2)
  ~>destroy-presence C
  minus N 1 N1
  ~sworn S L N1

-- scenario: Thunderspeaker has Presence in l1, l2, l3; in the Fast phase it
-- Pushes l2's two Dahan; l2 Ravages (5 Damage) later.
setup
  +spirit thunder, +spirit:special thunder ally-of-the-dahan, +spirit:special thunder sworn-to-victory
  +presence-of thunder t1, +presence-of thunder t2, +presence-of thunder t3
scenario, ~>move t1 l1, ~>move t2 l2, ~move t3 l3
fast-phase, at D l2, piece:kind D dahan, ~push thunder D l2
report, presence-of thunder P, at P L, ^thunder-presence P L
