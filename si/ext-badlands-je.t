-- JE p8, Badlands: "The first time each Action (see p. 10) Damages Invaders
--  in a land, increase that Damage by 1 per [Badlands]. The first time each
--  Action Damages Dahan in a land, increase that Damage by 1 per [Badlands]."
-- Needs ext-actions.t. Dahan half only: core.t's Dahan fight back destroys
-- outright, so it never Damages Invaders.
#js-def plus +A +B -C { yield [A + B] }
setup, +kind badlands

-- "the first time each Action Damages Dahan in a land"
#acc damaged-dahan : e land
dahan-damage-by A L / damaged-dahan A L

-- every Damage to Dahan is checked against the Action dealing it
game, { damage-dahan L D => ~badlands-dahan L D }
badlands-dahan L D, gt D 0, current-action A, not damaged-dahan A L
  land:count L badlands B
  +dahan-damage-by A L
  plus D B D2
  ~deal-dahan L D2
badlands-dahan L D, gt D 0, current-action A, damaged-dahan A L, ~deal-dahan L D
badlands-dahan L D, not current-action _, ~deal-dahan L D
-- "If Damage is reduced to 0 ... [Badlands] aren't relevant": D = 0 does
-- nothing and does not use up the first time.

-- core p9 "Every 2 points of Damage destroys one Dahan."  Restated: the
-- replacement can't re-emit damage-dahan, which the exception would catch
-- again (report §4).
deal-dahan L D, half D N, ~kill-dahan L N

-- trace (the intercepted damage-dahan never appears; show what was dealt)
deal-dahan L D, current-action A, ^during A (dahan-damaged L D)
