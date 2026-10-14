-- Devouring Teeth Lurk Underfoot (Horizons of Spirit Island), special rule:
--   TERRITORIAL AGGRESSION
--   "Your Damage-Dealing Powers do +1 Damage.
--    (This adds +1 Damage total for the Power, even if the Power Damages
--     multiple Invaders or "each Invader". It can boost Minor/Major Power
--     Cards, too, not just your Uniques + Innate.)"
-- needs bx-damage.t (Health, Power Damage):  run.sh core.t bx-damage.t spirit-teeth.t

-- "Your Damage-Dealing Powers do +1 Damage." (+1 to the Power's total)
power-strike S P L, spirit:special S territorial-aggression, power:damage P N, gt N 0
  / power-damage S P L 1

-- scenario: Teeth plays a Minor Power "1 Damage" (Fast) at l3, which holds
-- a Town (Health 2): 1 Damage alone cannot destroy it, 1+1 can.
setup
  +spirit teeth, +spirit:special teeth territorial-aggression
  +power gnaw, +power:speed gnaw fast, +power:damage gnaw 1
  +power-target teeth gnaw l3
scenario, ~add-piece l3 town
scenario, +played teeth gnaw
