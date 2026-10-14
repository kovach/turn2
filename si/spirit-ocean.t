-- Ocean's Hungry Grasp, special rule "Ocean in Play":
--   "You may add/move Presence into Oceans, but may not add/move Presence
--    into Inland lands. On boards with your Presence, treat the Oceans as
--    Coastal Wetlands for Spirit Powers and Blight. You Drown any Invaders
--    or Dahan moved into those Oceans."
-- (single board here, so "boards with your Presence" = "you have Presence")
#acc ocean-in-play : land
spirit:special S ocean-in-play, presence-of S P, at P L, land L, ocean O / ocean-in-play O

-- "You may add/move Presence into Oceans" (widens the base domain)
spirit:special S ocean-in-play, add-presence S, ocean O / presence-dest S O
-- "but may not add/move Presence into Inland lands" (narrows: extra constraint)
#acc coastal : land
adjacent L O, ocean O / coastal L
ocean O / coastal O
add-presence S, spirit:special S ocean-in-play, (presence-choice S C), !(coastal C)

-- "treat the Oceans as Coastal Wetlands for Spirit Powers and Blight"
ocean-in-play O / land-for power O
ocean-in-play O / land-for blight O
ocean-in-play O / terrain-for power O wetland
ocean-in-play O / terrain-for blight O wetland

-- "You Drown any Invaders or Dahan moved into those Oceans."
-- (FAQ: a triggered action, "After Invaders/Dahan are moved into the Ocean, ...")
setup, +human dahan
setup, +human explorer, +human town, +human city
move P O, ocean-in-play O, piece:kind P K, human K, ~drown P

-- special rule "Drowning": "Destroy Drowned pieces, placing Drowned Invaders here."
drown P, ~>destroy P, piece:kind P K, invader K, ~move P ocean-mat
-- "At any time you may exchange X Health of these Invaders for 1 Energy,
--  where X = number of players."  -- not modeled: see report

-- scenario: Ocean has Presence in l1; grows (adds a Presence); a Power
-- of Ocean's pushes l1's Town
setup
  +spirit ocean, +spirit:special ocean ocean-in-play
  +presence-of ocean o1, +presence-of ocean o2
scenario, ~>move o1 l1, ~move o2 supply
spirit-phase, ~add-presence ocean
fast-phase, at P l1, piece:kind P town, ~push ocean P l1
