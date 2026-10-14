-- Rising Heat of Stone and Sand (Horizons of Spirit Island), special rule:
--   BLISTERING HEAT
--   "At your [Sacred Site], Invaders have -1 Health (min. 1)."
-- needs bx-damage.t (Health, Power Damage):  run.sh core.t bx-damage.t spirit-heat.t

-- "At your Sacred Site, Invaders have -1 Health (min. 1)."
-- (min. 1: only Invaders whose Health is above 1 get the -1; correct while
--  this is the only Health modifier, see notes)
at P L, piece:kind P K, invader K, kind:health K H, gt H 1,
  sacred-site S L, spirit:special S blistering-heat
  / health P -1

-- scenario: Heat has a Sacred Site in l3; l3 has a Town and a City; Heat
-- plays a Fast Power "2 Damage" there. With Health 2/3 the 2 Damage
-- destroys only the Town; with -1 it can destroy the City (Health 2) or
-- the Town (Health 1) and then 1 Damage is left for the other... (rng picks)
setup
  +spirit heat, +spirit:special heat blistering-heat
  +presence-of heat h1, +presence-of heat h2
  +power scorch, +power:speed scorch fast, +power:damage scorch 2
  +power-target heat scorch l3
scenario, ~>move h1 l3, ~>move h2 l3, ~>add-piece l3 town, ~add-piece l3 city
scenario, +played heat scorch
report, at P l3, health P H, ^health-report P H
