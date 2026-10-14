-- Relentless Gaze of the Sun (Nature Incarnate), special rule:
--  RELENTLESS PUNISHMENT
--  "After using a Power Card, if you had at least 3 [Presence] in the origin
--   land, you may Repeat it any number of times on the same target land(s)
--   (ignoring origin, Range, and target requirements) by paying both:
--     the Energy cost of the Power, and
--     1 Energy per previous use of the Power this turn
--   each time you Repeat the Power.
--   (You may Repeat each Power Card multiple times, but its 1st Repeat costs
--   1 extra, its 2nd Repeat costs 2 extra, etc. Check if the origin has at
--   least 3 [Presence] when you target it the first time.)"

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- Energy (p13 "Energy and Card Plays"): a running total of gains and payments.
#js-def plus +A +B -C { yield [A + B] }
#js-def neg +A -B { yield [-A] }
#acc energy : spirit @sum
spirit S / energy S 0
energy-gain S N / energy S N
energy-spend S N, neg N M / energy S M
-- Power Cards have an Energy cost; a use has an origin land and a target land
-- (targeting/Range is not modeled: the scenario states origin and target).
-- "you may": a yes/no decision
setup, +may yes, +may no

-- ---------------------------------------------------------------- RELENTLESS PUNISHMENT
-- "After using a Power Card, if you had at least 3 Presence in the origin
--  land, ..." (checked when it is first targeted, i.e. at that first use)
turn, >use-power S P, spirit:special S relentless-punishment, power:card P
  power:origin S P O, presence-count S O N, ge N 3
  ~relentless S P 1
-- "... you may Repeat it any number of times ... by paying both the Energy
--  cost of the Power, and 1 Energy per previous use of the Power this turn"
relentless S P U, power:cost P C, plus C U Cost, energy S E, ge E Cost
  ?[rng] R
  !(may R)
  ~relentless-ask S P U Cost R
turn, >relentless-ask S P U Cost R, is R yes
  +energy-spend S Cost
  ~>repeat-power S P
  plus U 1 U1
  ~relentless S P U1
-- "on the same target land(s) (ignoring origin, Range, and target requirements)"
repeat-power S P, power:target S P T, ^resolved-again S P T

-- ---------------------------------------------------------------- scenario
-- Gaze has 3 Presence in l3 and 6 Energy; plays a cost-1 Fast card from l3
-- at l2. Repeats cost 1+1, then 1+2, then 1+3 (unaffordable after 2+3=5).
setup
  +spirit gaze, +spirit:special gaze relentless-punishment
  +presence-of gaze g1, +presence-of gaze g2, +presence-of gaze g3
  +power scorch, +power:card scorch, +power:speed scorch fast, +power:cost scorch 1, +power:element scorch fire
  +power:origin gaze scorch l3, +power:target gaze scorch l2
  +energy-gain gaze 6
scenario, ~>move g1 l3, ~>move g2 l3, ~move g3 l3
scenario, +played gaze scorch
report, energy gaze E, ^gaze-energy E
