-- BASE-EXT (rulebook, not a spirit): Invader Health and Power Damage.
-- Shared by spirit-teeth.t and spirit-heat.t (run: core.t bx-damage.t spirit-X.t).

#js-def plus +A +B -C { yield [A + B] }

-- p15 "Each type of Invader has a specified Health." (Explorer 1, Town 2, City 3)
-- Health is a sum so modifiers can add to it.
setup, +kind:health explorer 1, +kind:health town 2, +kind:health city 3
#acc health : e @sum
at P L, piece:kind P K, invader K, kind:health K H / health P H

-- A Power Card that deals Damage: its Damage total is a sum, so modifiers
-- can add to it.  (power:damage P N = printed "N Damage";
-- power-target S P L = the land S targets with P, chosen by the scenario)
#acc power-damage : spirit power land @sum
power-strike S P L / power-damage S P L 0
power-strike S P L, power:damage P N / power-damage S P L N
use-power S P, power-target S P L, power:damage P N, ~power-strike S P L
power-strike S P L, power-damage S P L D, ~assign-damage L D

-- p18 "When dealing Damage, it is done to any Invaders in the target land,
--  divided among them however you choose. If an Invader has taken Damage
--  equal to or greater than its Health, it is destroyed immediately."
-- (simplified: Damage is spent only on Invaders it can destroy outright;
--  leftover Damage smaller than every Health is lost, no partial Damage)
#acc assignable : land num e
assign-damage L D, at V L, piece:kind V K, invader K, health V H, le H D / assignable L D V
assign-damage L D, gt D 0
  ?[rng] V
  !(assignable L D V)
  ~assign V L D
assign V L D, is V X, health X H, minus D H D1
  ~>destroy X
  ~assign-damage L D1
