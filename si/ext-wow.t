-- Words of Warning (Thunderspeaker, fast, range 1, target: Dahan):
-- "Defend 3. During Ravage, Dahan in target land deal damage simultaneously
-- with Invaders."
-- (power resolution not modeled: the scenario plays it on l2)
play-words-of-warning L, +defend L 3, +warned L
-- "simultaneously": the Dahan who fight back are the ones present when the
-- Invaders start dealing Damage, not the survivors. (The count is read at
-- the start of invaders-deal-damage and kept as a fact, so the fight-back
-- that follows sees it; a `ravage L, …, ^dahan-at-start` view would start
-- concurrently with the fight-back.)
invaders-deal-damage L, warned L, land:count L dahan C, +dahan-at-start L C
ravage L, warned L, { dahan-fight-back L => ~dahan-fight-back-simultaneously L }
dahan-fight-back-simultaneously L, dahan-at-start L C, gt C 0, ~kill-invaders L C

scenario, ~play-words-of-warning l2
