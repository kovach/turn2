-- River Surges in Sunlight (Base). Special rule, verbatim:
--   RIVER'S DOMAIN: "Your [Presence] in Wetlands counts as [Sacred Site]."

-- "Your Presence in Wetlands counts as Sacred Site."
-- (counts-as: an extra row in the base sacred-site view; terrain is read
--  through terrain-for power, so an Ocean that Ocean's Hungry Grasp makes a
--  Coastal Wetland would also qualify)
spirit:special S rivers-domain, presence-of S P, at P L, terrain-for power L wetland
  / sacred-site S L

-- scenario: core's `river` has 1 Presence (p1) in wetland l2; give it one
-- more Presence, alone in mountain l3 (no Sacred Site there)
setup, +spirit:special river rivers-domain, +presence-of river p9
scenario, ~move p9 l3
fast-phase, sacred-site S L, ^ss-report S L
