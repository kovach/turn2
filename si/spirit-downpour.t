-- Downpour Drenches the World (Promo Pack 2). Special rules (verbatim):
--  DRENCH THE LANDSCAPE
--   "Spirit Actions and Special Rules treat your [Sacred Site] as Wetlands
--    in addition to the printed terrain."
--  POUR DOWN POWER ACROSS THE ISLAND
--   "For each 2 [Water] you have, during the [Fasticon] / [Slowicon] phase
--    you may either: Gain 1 Energy; or Repeat a land-targeting Power Card by
--    paying its cost again. (It need not target the same land.) Use scenario
--    markers or spare game pieces to track uses of this rule. (Max 5 times
--    per turn, no matter how much [Water] you have.)"

#js-def plus +A +B -C { yield [A + B] }
#js-def neg +A -C { yield [-A] }
#js-def pour-limit +W -L { yield [Math.min(5, Math.floor(W / 2))] }

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit)
#acc energy : spirit @sum
spirit S / energy S 0
gain-energy S N / energy S N
-- Range and target terrain (p16 "Target: what land type this Power can affect")
#acc reach : land land num
land L / reach L L 0
reach A M K, adjacent M B, land B, plus K 1 K1, le K1 3 / reach A B K1
#acc targetable : spirit power land
played S P, power:range P R, has-presence S O, reach O T K, le K R
  power:target-terrain P Tr, terrain-for power T Tr / targetable S P T

-- ---------------------------------------------------------------- Drench the Landscape
-- "Spirit Actions and Special Rules treat your Sacred Site as Wetlands in
--  addition to the printed terrain."  (two contexts; Invaders don't see it)
sacred-site S L, spirit:special S drench / terrain-for power L wetland
sacred-site S L, spirit:special S drench / terrain-for special-rule L wetland

-- ---------------------------------------------------------------- Pour Down Power
-- "For each 2 Water you have ... (Max 5 times per turn ...)": one budget
-- for the whole turn, spent in either phase
#acc pour-used : spirit @sum
spirit:special S pour / pour-used S 0
poured S O / pour-used S 1
fast-phase, spirit:special S pour, ~pour S fast
slow-phase, spirit:special S pour, ~pour S slow
-- "during the Fast/Slow phase you may either: Gain 1 Energy; or Repeat a
--  land-targeting Power Card by paying its cost again."
#acc pour-option : spirit e e
pour S Ph / pour-option S Ph energy
pour S Ph / pour-option S Ph decline
pour S Ph, played S P, speed P Ph, power:target-terrain P _, power:cost P C
  energy S E, ge E C / pour-option S Ph (repeat P)
pour S Ph, elements S water W, pour-limit W Lim, pour-used S U, lt U Lim
  ?[rng] O
  !(pour-option S Ph O)
  ~pour-choice S Ph O
-- a use is marked from inside its choice on (a `^` under the turn would
-- start at a moment concurrent with the next offer, which then would not
-- see it; `+` lasts past the turn, fine for this one-turn scenario)
pour-choice S Ph C, is C energy, +poured S energy
pour-choice S Ph C, is C (repeat P), +poured S (repeat P)
pour-choice S Ph C, is C energy, +gain-energy S 1
pour-choice S Ph C, is C (repeat P), power:cost P Cost, neg Cost NC
  +gain-energy S NC
  ~use-power S P
-- keep going (inside the same phase) unless declined
fast-phase, >pour-choice S fast C, is C energy, ~pour S fast
fast-phase, >pour-choice S fast C, is C (repeat P), ~pour S fast
slow-phase, >pour-choice S slow C, is C energy, ~pour S slow
slow-phase, >pour-choice S slow C, is C (repeat P), ~pour S slow

-- ---------------------------------------------------------------- scenario
setup
  +spirit downpour, +spirit:special downpour drench, +spirit:special downpour pour
  +presence-of downpour d1, +presence-of downpour d2
  +gain-energy downpour 2
  +power rain, +power:speed rain fast, +power:element rain water, +power:cost rain 1
  +power:range rain 0, +power:target-terrain rain wetland
  +power flood, +power:speed flood slow, +power:element flood water, +power:cost flood 1
  +power:range flood 0, +power:target-terrain flood wetland
  +power drizzle, +power:speed drizzle slow, +power:element drizzle water, +power:cost drizzle 0
  +power gust, +power:speed gust fast, +power:element gust water, +power:cost gust 0
-- a Sacred Site in the mountain l3: wetland-only Powers at range 0 can
-- target it (Drench); 4 Water -> 2 uses of Pour Down Power this turn
scenario, ~>move d1 l3, ~move d2 l3
scenario, +played downpour rain
scenario, +played downpour flood
scenario, +played downpour drizzle
scenario, +played downpour gust
fast-phase, targetable downpour P T, ^can-target P T
fast-phase, terrain-for C l3 wetland, ^l3-wet-for C
report, energy downpour E, ^energy-report E
