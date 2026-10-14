-- FAQ .7w4geew  https://querki.net/raw/darker/spirit-island-faq/.7w4geew
-- Q: If Invaders Ravage twice in the same round, how does Defend work? If
--    each Ravage deals 1 damage to the land, do you add a Blight?
-- A: "Defend applies each time the Invaders deal Damage in a land - it isn't
--    'used up' in the first Ravage. Each time the land itself is damaged is
--    separate - it does not accumulate Damage during a turn ... Only add a
--    Blight when a single instance of Damage is enough to cause Blight."
-- uses: core.t
--
-- A Fast Power makes l1 Ravage twice, then the Invader Phase Ravages it a
-- third time. l1 deals 6 Damage (Town, Explorer, added City) against
-- Defend 6; its Dahan fights back each time, removing one Invader, so every
-- later Ravage still deals at least 3 before Defend. If Defend were used up,
-- the second Ravage would Blight l1 and destroy the Dahan.
-- Second clause: a Slow Power Damages l3 by 1, twice.
setup
  +defend l1 6, +defend l2 9
  +power:speed twice-ravage fast, +played river twice-ravage
  +power:speed two-hits slow, +played river two-hits
scenario, ~add-piece l1 city
use-power S twice-ravage, ~>ravage l1, ~ravage l1
use-power S two-hits, ~>damage-land l3 1, ~damage-land l3 1
-- expect: damage-land l1 0
-- expect-not: damage-land l1 1
-- expect-not: damage-land l1 2
-- expect-not: damage-land l1 3
-- expect: count l1 blight 0
-- expect: count l1 dahan 1
-- expect: damage-land l3 1
-- expect: count l3 blight 0
