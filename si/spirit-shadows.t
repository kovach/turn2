-- Shadows Flicker Like Flame (Base). Special rule, verbatim:
--   SHADOWS OF THE DAHAN: "Whenever you use a Power, you may pay 1 Energy to
--   target a land with [Dahan] regardless of the Power's Range. (Power Cards
--   or your Innate Powers.)"

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- Energy (p13): a running total; gains and payments are contributions.
#acc energy : spirit @sum
spirit S / energy S 0
energy-change S N / energy S N

-- Range (p16): "How many lands away from your Presence this Power can
-- reach ... A Range of 0 means a land where you have Presence."
-- within A B R: B is at most R (Peano) lands from A.
#acc within : land land nat
land L, range-value R / within L L R
adjacent A B, land-for power B, within B C R, range-value (s R) / within A C (s R)

-- Targeting (p16 #6): the target choice ranges over target-dest, which also
-- carries the Energy price of choosing that land (0 for ordinary targeting),
-- so Spirits can widen it -- and charge for it -- by adding rows.
#acc target-dest : spirit power land cost
targeting S P, power:range P R, presence-of S Q, at Q O, land-for power O,
  within O L R / target-dest S P L 0
targeting S P
  ?[rng] L C
  !(target-dest S P L C)
  ~target-choice S P L C
-- the chosen price is paid; the land is the Power's target for this use
targeting S P, >target-choice S P L C, is L X, is C K
  minus 0 K NK
  +energy-change S NK
  ^target S P X
-- land-targeting Powers target as the first thing they do
use-power S P, power:targets-land P, ~targeting S P

-- ---------------------------------------------------------------- the special rule
-- "Whenever you use a Power, you may pay 1 Energy to target a land with
--  Dahan regardless of the Power's Range."  (widen: extra target rows that
--  cost 1; offered only if the Spirit can pay)
spirit:special S shadows-of-the-dahan, targeting S P, land-for power L,
  land:count L dahan N, gt N 0, energy S E, ge E 1
  / target-dest S P L 1

-- scenario: Shadows has Presence only in mountain l3 (no Dahan) and 1
-- Energy; it plays a Range-0 Power. Ordinarily only l3 is targetable; with
-- the rule, l1 / l2 (which have Dahan) are too, for 1 Energy.
setup
  +range-value z, +range-value (s z), +range-value (s (s z))
  +spirit shadows, +spirit:special shadows shadows-of-the-dahan
  +presence-of shadows s1
  +power mantle, +power:speed mantle fast, +power:range mantle z, +power:targets-land mantle
  +energy-change shadows 1
scenario, ~move s1 l3
scenario, +played shadows mantle
report, energy S E, ^energy-report S E
