-- Lightning's Swift Strike, special rule "Swiftness of Lightning":
--   "For every Air you have, you may use 1 Slow Power as if it were Fast."
-- FAQ: used during the Fast phase; the Air total is checked each time it is
-- used; once made Fast, a Power stays Fast for the rest of the turn.
#acc made-fast-count : spirit @sum
spirit:special S swiftness-of-lightning / made-fast-count S 0
made-fast S P T, turn T / made-fast-count S 1
-- "as if it were Fast": a later speed contribution wins (@last); the base
-- Slow phase then no longer resolves it (One Use!). `made-fast` names its
-- turn, so the override lasts exactly that turn.
made-fast S P T, turn T / speed P fast

-- "you may": declining is an option
#acc swift-option : spirit e
swiftness S, played S P, speed P slow / swift-option S P
swiftness S / swift-option S decline

fast-phase, spirit:special S swiftness-of-lightning, ~swiftness S
swiftness S, elements S air A, made-fast-count S U, lt U A
  ?[rng] P
  !(swift-option S P)
  ~swift-choice S P
-- (made-fast is asserted in the chain that uses the Power and asks again,
--  so the next `swiftness` counts it)
fast-phase, turn T, >swift-choice S C, is C P, played S P
  +made-fast S P T
  ~>use-power S P
  ~swiftness S

-- scenario: Lightning plays three Slow cards and gains 2 Air from them
-- (plays are asserted before the turn, so every phase of it sees them)
setup
  +spirit lightning, +spirit:special lightning swiftness-of-lightning
  +power shatter-homesteads, +power:speed shatter-homesteads slow, +power:element shatter-homesteads air
  +power raging-storm, +power:speed raging-storm slow, +power:element raging-storm air
  +power harbingers, +power:speed harbingers slow, +power:element harbingers fire
scenario, +played lightning shatter-homesteads
scenario, +played lightning raging-storm
scenario, +played lightning harbingers
