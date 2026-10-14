-- Spirit Island, base game rules (experiment). Each rule quotes the
-- rulebook sentence it implements (page numbers: base rulebook).
-- Decisions are `?[rng]` so the program runs headless.

#js-def minus +A +B -C { yield [A - B] }
#js-def half +A -C { yield [Math.floor(A / 2)] }
#js-def pos +A -C { yield [Math.max(0, A)] }

-- ---------------------------------------------------------------- pieces
#acc at : e @last
move It To, +moved It To
moved It To / at It To

#acc land:count : land kind @sum
land L, kind K / land:count L K 0
at P L, piece:kind P K / land:count L K 1

add-piece L K, +piece P, +piece:kind P K, ~move P L

-- p15 "A land containing any number of these is 'a land with Invaders'."
#acc has-invaders : land
at P L, piece:kind P K, invader K / has-invaders L

-- p15 "Explorers ... have 1 Health and deal 1 Damage during Ravage."
--     "Towns ... have 2 Health and deal 2 Damage" / "Cities ... 3 Health, 3 Damage"
-- (Health is unused in this slice: Dahan fight back destroys outright, see below.)

-- p15 "Whenever a Town is destroyed, it generates 1 Fear. Whenever a City
--      is destroyed, it generates 2 Fear."
destroy P, ~move P destroyed
destroy P, piece:kind P town, +fear-from P 1
destroy P, piece:kind P city, +fear-from P 2
#acc fear-generated : @sum
fear-from P N / fear-generated N

-- ---------------------------------------------------------------- blight
#acc has-blight : land
at B L, piece:kind B blight / has-blight L

-- p15 "After Setup, whenever you add Blight to a land (including when
--      Blight cascades), two bad things happen:"
add-blight L, ~add-piece L blight

-- "1. Destroy Presence: In that land, destroy one Presence from each
--     Spirit with Presence there."
#acc has-presence : spirit land
presence-of S P, at P L / has-presence S L
add-blight L, spirit S, has-presence S L
  ?[rng] P
  !(presence-of S P, at P L)
  ~destroy-presence P
destroy-presence P, is P X, ~move X destroyed

-- "2. Cascade: If the land already had any Blight, also add one Blight to
--     any adjacent land."
add-blight L, has-blight L
  ?[rng] L2
  !(adjacent L L2)
  ~cascade L2
cascade L2, is L2 X, ~add-blight X

-- ---------------------------------------------------------------- turn
-- p8 "Each turn has the following phases: ..."  (only the Invader phase here)
-- p9 "The Invader phase has the following parts: ... 3a Ravage 3b Build 3c Explore"
invader-phase
  ~>ravage-step
  ~>build-step
  ~explore-step

-- p9 "the Invaders Ravage in each land of the shown type only."
-- p10 "Ravage and Build Actions only affect lands that have Invaders!"
-- (sequential variant: one land at a time, order chosen; see report)
#acc ravage-target : land
invader-card:ravage C, card:terrain C T, land:terrain L T, has-invaders L / ravage-target L
#acc ravaged : land
did-ravage L / ravaged L
ravage-step, ~ravage-next
ravage-next
  ?[rng] L
  !(ravage-target L, not ravaged L)
  ~ravage-chosen L
ravage-chosen L, is L X
  ~>ravage X
  +did-ravage X
  ~ravage-next

-- p9 "First, Invaders deal Damage to the land and Dahan. Then, any
--     surviving Dahan fight back."
ravage L
  ~>invaders-deal-damage L
  ~dahan-fight-back L

-- p9 "Invaders deal Damage: 1 per Explorer, 2 per Town, and 3 per City."
tally L, at P L, piece:kind P K, kind:damage K D
  ^deals L P D
#acc invader-damage : land @sum
invaders-deal-damage L / invader-damage L 0
deals L P D / invader-damage L D

-- p18 Defend N: "reduce the total amount of Damage they do by N. If multiple
--     Defend effects are used in one land, they add together."
#acc defend-total : land @sum
defend L N / defend-total L N
land L / defend-total L 0

-- "Damage is done both to the land and Dahan."
invaders-deal-damage L
  ~>tally L
  invader-damage L Raw, defend-total L Def, minus Raw Def D0, pos D0 D
  ~damage-land L D
  ~damage-dahan L D
tally L, ^tallied

-- "1. Invaders Damage the Land: If 2 or more Damage is dealt, add a Blight
--     to the land."
damage-land L D, ge D 2, ~add-blight L

-- "2. Invaders Fight the Dahan: Every 2 points of Damage destroys one Dahan."
damage-dahan L D, half D N, ~kill-dahan L N
kill-dahan L N, gt N 0, land:count L dahan C, gt C 0
  ?[rng] V
  !(at V L, piece:kind V dahan)
  is V X
  ~>destroy X
  minus N 1 N1
  ~kill-dahan L N1

-- "After Invader Damage has been fully resolved in a land, any surviving
--  Dahan there fight back. Each Dahan deals 2 Damage to the Invaders."
-- (simplified: each 2 Damage destroys one Invader of the land, rng's pick)
dahan-fight-back L, land:count L dahan C, gt C 0
  ~kill-invaders L C
kill-invaders L N, gt N 0, has-invaders L
  ?[rng] V
  !(at V L, piece:kind V K, invader K)
  is V X
  ~>destroy X
  minus N 1 N1
  ~kill-invaders L N1

-- p10 Build: "Wherever there are Invaders in the specified type of land,
--  they add either one City or one Town:"
build-step, invader-card:build C, card:terrain C T, land:terrain L T, has-invaders L
  ~build L
-- "If the land has more Towns than Cities, add a City."
build L, land:count L town Nt, land:count L city Nc, gt Nt Nc, ~add-piece L city
-- "In all other cases, add a Town."
build L, land:count L town Nt, land:count L city Nc, le Nt Nc, ~add-piece L town

-- p10 Explore: "Add an Explorer to every land of the shown type which
--  either: Contains a Town or City; or Is adjacent to a Town, City, or Ocean."
#acc explore-source : land
at P L, piece:kind P town / explore-source L
at P L, piece:kind P city / explore-source L
ocean L / explore-source L
#acc explorable : land
explore-source L / explorable L
adjacent L L2, explore-source L2 / explorable L
-- "No matter how many sources are in or adjacent to an Explored land, you
--  only add one Explorer."  (explorable is a set, so one `explore L` each)
explore-step, invader-card:explore C, card:terrain C T, land:terrain L T, explorable L
  ~explore L
explore L, ~add-piece L explorer

-- ---------------------------------------------------------------- setup
setup
  +rng-seed 7
  +kind explorer, +kind town, +kind city, +kind dahan, +kind blight
  +invader explorer, +invader town, +invader city
  +kind:damage explorer 1, +kind:damage town 2, +kind:damage city 3
  +land l1, +land:terrain l1 wetland
  +land l2, +land:terrain l2 wetland
  +land l3, +land:terrain l3 mountain
  +ocean sea
  +adjacent sea l1, +adjacent l1 sea
  +adjacent l1 l2, +adjacent l2 l1
  +adjacent l2 l3, +adjacent l3 l2
  +spirit river
  +presence-of river p1
  +card w, +card:terrain w wetland
  +card m, +card:terrain m mountain
  +invader-card:ravage w
  +invader-card:build w
  +invader-card:explore m

setup
  ~>move p1 l2
  ~>add-piece l1 town
  ~>add-piece l1 explorer
  ~>add-piece l1 dahan
  ~>add-piece l2 city
  ~>add-piece l2 town
  ~>add-piece l2 dahan
  ~>add-piece l2 dahan
  ~add-piece l2 blight

~game
game, ~>setup, ~>scenario, ~>invader-phase, ~report
scenario, ^nothing

report, land L, land:count L K N, ^count L K N
report, fear-generated F, ^fear F
