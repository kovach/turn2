-- Eyes Watch from the Trees (Horizons of Spirit Island), special rule:
--   DAHAN TRUST THE WATCHERS
--   "After one of your Powers adds Defend to a single land, Gather up to
--    1 [Dahan] into that land.
--    ("Power" includes both your Innate Power and your Power Cards. Can be
--     used with any number of Defend Powers each turn.)"

-- BASE-EXT (rulebook, not this spirit):
-- A Power's "Defend N" (p18) is its own step, attributed to the Spirit and
-- Power using it; it lasts for the rest of the turn.
use-power S P, power-target S P L, power:defend P N, ~add-defend S P L N
turn, >add-defend S P L N, ^defend L N
-- Gather (p30 glossary): "move pieces into the target land from adjacent
-- lands". "up to 1": declining is an option.
#acc gather-option : land kind e
gather-up-to-1 L K, adjacent From L, at V From, piece:kind V K / gather-option L K V
gather-up-to-1 L K / gather-option L K decline
gather-up-to-1 L K
  ?[rng] V
  !(gather-option L K V)
  ~gather-choice L V
gather-choice L C, is C V, piece:kind V K, ~move V L

-- "After one of your Powers adds Defend to a single land, Gather up to 1
--  Dahan into that land."
-- (every add-defend here targets a single land; a multi-land Defend Power
--  would need a power:single-land fact to exclude it)
turn, >add-defend S P L N, spirit:special S dahan-trust-the-watchers
  ~gather-up-to-1 L dahan

-- scenario: Eyes plays a Fast "Defend 2" on l3 (no Dahan there, l2 has 2)
setup
  +spirit eyes, +spirit:special eyes dahan-trust-the-watchers
  +power watchful, +power:speed watchful fast, +power:defend watchful 2
  +power-target eyes watchful l3
scenario, +played eyes watchful
