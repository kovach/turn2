-- Volcano Looming High (Jagged Earth). Special rules (verbatim):
--  MOUNTAIN HOME
--   "Your [Presence] may only be added/moved into Mountains."
--  COLLAPSE IN A BLAST OF LAVA AND STEAM
--   "When your [Presence] is destroyed, in that land, deal 1 Damage per
--    destroyed [Presence] to both Invaders and to [Dahan]."
--  VOLCANIC PEAKS TOWER OVER THE LANDSCAPE
--   "Your Power Cards gain +1 [Range] if you have 3 or more [Presence] in
--    the origin land."

#js-def plus +A +B -C { yield [A + B] }

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit)
-- p15/p18 Damage and Health: "If an Invader has taken Damage equal to or
-- greater than its Health, it is destroyed immediately." Damage lasts until
-- the end of the turn (Time Passes), so it is a turn-scoped tuple.
#acc damage-on : e @sum
dmg P N / damage-on P N
-- (the mark is a persistent fact on deal-damage-to's own chain, so the
--  destroy check that follows it sees it; a `turn, >damage-mark P N, ^dmg`
--  view would start concurrently with the check. core has one turn, so
--  "until Time Passes" is not modeled.)
deal-damage-to P N
  ~>damage-mark P N
  +dmg P N
  ~check-destroyed P
check-destroyed P, damage-on P D, piece:kind P K, kind:health K H, ge D H, ~destroy P
-- "N Damage to Invaders in L": the player divides it, one point at a time
damage-invaders L N, gt N 0, has-invaders L
  ?[rng] V
  !(at V L, piece:kind V K, invader K)
  is V X
  ~>deal-damage-to X 1
  minus N 1 N1
  ~damage-invaders L N1
damage-dahan-in L N, gt N 0, land:count L dahan C, gt C 0
  ?[rng] V
  !(at V L, piece:kind V dahan)
  is V X
  ~>deal-damage-to X 1
  minus N 1 N1
  ~damage-dahan-in L N1

-- p16 Range: "How many lands away from your Presence this Power can reach."
#acc reach : land land num
land L / reach L L 0
reach A M K, adjacent M B, land B, plus K 1 K1, le K1 3 / reach A B K1
#acc power-range : spirit power land @sum
played S P, power:range P R, has-presence S O / power-range S P O R
#acc targetable : spirit power land
power-range S P O R, reach O T K, le K R / targetable S P T

-- ---------------------------------------------------------------- Mountain Home
-- "Your Presence may only be added/moved into Mountains."  (narrows the
-- base add-presence choice; moves are not modeled beyond add-presence)
add-presence S, spirit:special S mountain-home, (presence-choice S C)
  !(land:terrain C mountain)

-- ---------------------------------------------------------------- Collapse
-- "When your Presence is destroyed, in that land, deal 1 Damage per
--  destroyed Presence to both Invaders and to Dahan."
-- (at X L is read at the start of destroy-presence: where it was)
destroy-presence C, is C X, presence-of S X, spirit:special S collapse, at X L
  ~damage-invaders L 1
  ~damage-dahan-in L 1

-- ---------------------------------------------------------------- Volcanic Peaks
-- "Your Power Cards gain +1 Range if you have 3 or more Presence in the
--  origin land."  (an extra @sum contribution to the range at that origin)
played S P, power-card P, spirit:special S peaks, presence-count S O N, ge N 3
  / power-range S P O 1

-- ---------------------------------------------------------------- scenario
setup
  +kind:health explorer 1, +kind:health town 2, +kind:health city 3, +kind:health dahan 2
  +spirit volcano
  +spirit:special volcano mountain-home, +spirit:special volcano collapse, +spirit:special volcano peaks
  +presence-of volcano v1, +presence-of volcano v2, +presence-of volcano v3, +presence-of volcano v4
  +power lava-flows, +power-card lava-flows, +power:speed lava-flows slow, +power:range lava-flows 0
-- 3 Presence in the mountain l3 (Volcanic Peaks active), 1 in the supply;
-- a Dahan in l3. The Explore step adds an Explorer to l3.
scenario, ~>move v1 l3, ~>move v2 l3, ~>move v3 l3, ~>move v4 supply, ~add-piece l3 dahan
-- the cards played this turn: a turn-scoped acc view (holds at every moment
-- of the turn, so the phases' reads see it)
#acc played : spirit power
turn / played volcano lava-flows
-- Mountain Home: Growth adds a Presence; only l3 qualifies
spirit-phase, ~add-presence volcano
-- Volcanic Peaks: what can the range-0 card target?
fast-phase, targetable volcano lava-flows T, ^can-target lava-flows T
-- Collapse: in the Slow phase a Blight lands on l3, destroying a Presence
slow-phase, ~add-blight l3
