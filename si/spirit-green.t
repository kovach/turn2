-- A Spread of Rampant Green (Base). Special rules, verbatim:
--   CHOKE THE LAND WITH GREEN: "Whenever Invaders would Ravage or Build in a
--   land with your [Sacred Site], you may prevent it by destroying one of
--   your [Presence] in that land."
--   STEADY REGENERATION: "When adding [Presence] to the board via Growth, you
--   may optionally use your destroyed [Presence]. If the island is Healthy,
--   do so freely. If the island is Blighted, doing so costs 1 Energy per
--   destroyed [Presence] you add."

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- Energy (p13)
#acc energy : spirit @sum
spirit S / energy S 0
energy-change S N / energy S N
-- Growth (p8 "Grow: Choose one option"): only the "add a Presence" part
growth S, ~add-presence S
-- Blight Card (p15): the island starts Healthy (flipping not modeled)
setup, +island-state healthy

-- ---------------------------------------------------------------- CHOKE THE LAND WITH GREEN
setup, +yes-no yes, +yes-no no
-- "Whenever Invaders would Ravage ... in a land with your Sacred Site, you
--  may prevent it": the question is asked when the land is chosen to Ravage
--  (base: ravage-chosen), before the Ravage is emitted ...
ravage-chosen C, is C L, spirit:special S choke-the-land, sacred-site S L
  ?[rng] Y
  !(yes-no Y)
  ~choke-ask S L ravage Y
-- ... and only a "yes" installs the exception. "by destroying one of your
-- Presence in that land" is its replacement.
ravage-chosen C, is C L, (choke-ask S L ravage Y), is Y yes, { ravage L => ~choke L }
-- "... or Build": same, asked at the start of the Build step
-- (the base has no build-target view, so its condition is restated here)
build-step, spirit:special S choke-the-land, sacred-site S L, has-invaders L,
  invader-card:build C, card:terrain C T, land:terrain L T
  ?[rng] Y
  !(yes-no Y)
  ~choke-ask S L build Y
build-step, (choke-ask S L build Y), is Y yes, { build L => ~choke L }
-- (the RHS may only use the intercepted tuple's variables, so the Spirit is
--  looked up again)
choke L, spirit:special S choke-the-land
  ?[rng] P
  !(presence-of S P, at P L)
  ~destroy-presence P

-- ---------------------------------------------------------------- STEADY REGENERATION
-- needs core-green.t: the base takes the Presence to add from a
-- presence-source view instead of hard-coding the supply (see core_diff)
-- "When adding Presence to the board via Growth, you may optionally use
--  your destroyed Presence. If the island is Healthy, do so freely."
growth S, add-presence S, spirit:special S steady-regeneration,
  presence-of S P, at P destroyed, island-state healthy
  / presence-source S P
-- "If the island is Blighted, doing so costs 1 Energy per destroyed
--  Presence you add."
growth S, add-presence S, spirit:special S steady-regeneration,
  presence-of S P, at P destroyed, island-state blighted, energy S E, ge E 1
  / presence-source S P
growth S, spirit:special S steady-regeneration, island-state blighted,
  placing S C X, is C P, at P destroyed, +energy-change S -1

-- scenario: Green has a Sacred Site in l2 (the City+Town land, Ravages and
-- Builds) and one destroyed Presence; it Grows (adds a Presence).
setup
  +spirit green, +spirit:special green choke-the-land, +spirit:special green steady-regeneration
  +presence-of green g1, +presence-of green g2, +presence-of green g3, +presence-of green g4
scenario, ~>move g1 l2, ~>move g2 l2, ~>move g3 destroyed, ~move g4 supply
spirit-phase, ~growth green
report, presence-of green P, at P L, ^green-presence P L
