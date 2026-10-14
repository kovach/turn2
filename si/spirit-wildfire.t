-- Heart of the Wildfire (Promo Pack 1). Special rules (wiki, verbatim):
--  BLAZING PRESENCE: "Post-Setup, after your [Presence] is added/moved, in
--   the land it goes to: For each [Fire] showing on your [Presence] Tracks,
--   do 1 Damage. If 2 [Fire] or more are showing on your [Presence] Tracks,
--   add 1 [Blight]. Push all [Beasts] and any number of [Dahan]. If you add
--   multiple [Presence] into a land at the same time, only do the above
--   effects once."
--  DESTRUCTIVE NATURE: "[Blight] added due to Spirit effects ( Powers,
--   Special Rules, Scenario-based Rituals, etc ) does not destroy your
--   [Presence]. (This includes cascades.)"

-- BASE-EXT (rulebook, not this spirit) ---------------------------------
-- Presence tracks: only the number of Fire showing is modeled (a fact).
-- p15 Health; p18 "Damage ... divided among them however you choose. If an
-- Invader has taken Damage equal to or greater than its Health, it is
-- destroyed immediately."  One point at a time, rng's choice of target.
setup, +kind:health explorer 1, +kind:health town 2, +kind:health city 3
#acc piece:damage : e @sum
hit P N / piece:damage P N
deal-damage L N, gt N 0, has-invaders L
  ?[rng] V
  !(at V L, piece:kind V K, invader K)
  is V X
  ~>damage-one X
  ~>check-destroyed X
  minus N 1 N1
  ~deal-damage L N1
damage-one X, +hit X 1
check-destroyed X, piece:damage X D, piece:kind X K, kind:health K H, ge D H, ~destroy X
-- ---------------------------------------------------------------------

-- BLAZING PRESENCE
-- "Post-Setup, after your Presence is added/moved, in the land it goes to:"
-- (moves inside a turn's phases are "Post-Setup"; the blaze runs in the same
--  phase, after the move. A generic `^phase` window no longer works: each
--  `^phase` starts at its own moment, concurrent with the moves inside the
--  phase; and anchoring on `turn` would make the blaze concurrent with the
--  later phases.)
spirit-phase, (move P L), presence-of S P, spirit:special S blazing-presence, land L
  >move P L
  ^blaze-trigger S L P
  ~blaze S L
fast-phase, (move P L), presence-of S P, spirit:special S blazing-presence, land L
  >move P L
  ^blaze-trigger S L P
  ~blaze S L
invader-phase, (move P L), presence-of S P, spirit:special S blazing-presence, land L
  >move P L
  ^blaze-trigger S L P
  ~blaze S L
slow-phase, (move P L), presence-of S P, spirit:special S blazing-presence, land L
  >move P L
  ^blaze-trigger S L P
  ~blaze S L
-- "For each Fire showing on your Presence Tracks, do 1 Damage."
blaze S L, track-fire S F, ~deal-damage L F
-- "If 2 Fire or more are showing on your Presence Tracks, add 1 Blight."
blaze S L, track-fire S F, ge F 2, ~add-blight L
-- "Push all Beasts and any number of Dahan."
blaze S L, beasts-at B L, ~push S B L
#acc blaze-dahan-option : e
blaze-dahan S D / blaze-dahan-option push
blaze-dahan S D / blaze-dahan-option stay
blaze S L, at D L, piece:kind D dahan, ~blaze-dahan S D
blaze-dahan S D
  ?[rng] C
  !(blaze-dahan-option C)
  ~blaze-dahan-choice S D C
blaze-dahan-choice S D C, is C push, at D L, ~push S D L
-- "If you add multiple Presence into a land at the same time, only do the
--  above effects once."  -- not modeled (see findings)

-- DESTRUCTIVE NATURE
-- "Blight added due to Spirit effects (Powers, Special Rules, ...) does not
--  destroy your Presence. (This includes cascades.)"
-- The contexts are the Spirit-effect episodes; any `move X destroyed` of
-- this Spirit's Presence inside them is dropped. Cascades are nested inside
-- the add-blight that caused them, so they are covered.
blaze S L, presence-of S X, spirit:special S destructive-nature, { move X destroyed => }
use-power _ _, presence-of S X, spirit:special S destructive-nature, { move X destroyed => }

-- scenario: Wildfire (2 Fire showing) has 1 Presence in l3 and adds a 2nd
-- there; l3 also has an Explorer and a Beasts. Blazing Presence: 2 Damage
-- (the Explorer dies), 1 Blight (which destroys neither Presence), Beasts
-- pushed. (core has no Blight supply / loss, so later Ravage cascades can
-- loop once every land is blighted: run with a small GAS.)
setup
  +spirit wildfire, +spirit:special wildfire blazing-presence
  +spirit:special wildfire destructive-nature
  +track-fire wildfire 2
  +presence-of wildfire w1, +presence-of wildfire w2
  +eq-land l3 l3
scenario, ~>move w1 l3, ~>add-piece l3 beasts, ~>add-piece l3 explorer, ~move w2 supply
spirit-phase, ^add-presence-target wildfire l3, ~add-presence wildfire
add-presence S, add-presence-target S T, (presence-choice S C), !(presence-dest S C, eq-land C T)
report, presence-of wildfire P, at P L, ^wildfire-presence P L
