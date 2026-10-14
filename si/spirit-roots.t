-- Towering Roots of the Jungle (Nature Incarnate). Special rules, verbatim:
--  ENDURING VITALITY
--   "Some of your Actions Add Vitality Tokens ( [Vitality] ). (Each [Vitality]
--    in a land with no [Blight] prevents 1 [Blight] from being added, then is
--    Removed.)"
--  HEART-TREE GUARDS THE LAND
--   "You have an Incarna ( [Towering Roots of the Jungle] ).
--    Your Powers get +1 [Range] if [Towering Roots of the Jungle] is in the
--    origin land.
--    Invaders/ [Dahan] / [Beasts] can't be damaged or destroyed at
--    [Towering Roots of the Jungle] .
--    Empower [Towering Roots of the Jungle] the first time it's in a land with
--    3 or more [Vitality] .
--    Skip all Build Actions at empowered [Towering Roots of the Jungle] ."

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
#js-def plus +A +B -C { yield [A + B] }
-- Removing a token: "return it to the supply"
remove-token L K
  ?[rng] P
  !(at P L, piece:kind P K)
  ~remove-chosen P
remove-chosen P, is P X, ~move X supply

-- p16 Range: "How many lands away from your Presence this Power can reach."
-- (distance by bounded breadth-first reach; paths are not deduplicated,
--  only "N or fewer steps" is ever asked)
#acc reach : land land num
land-for power L / reach L L 0
reach A B N, adjacent B C, land-for power C, lt N 4, plus N 1 M / reach A C M
-- Range modifiers are summed per (spirit, power, origin land)
#acc range-bonus : spirit power land @sum
targeting S P, presence-of S X, at X Src, land Src / range-bonus S P Src 0
#acc power-target : spirit power land
targeting S P, presence-of S X, at X Src, power:range P R, range-bonus S P Src B,
  plus R B R2, reach Src L N, le N R2
  / power-target S P L
use-power S P, power:targets P land, ~targeting S P
targeting S P
  ?[rng] T
  !(power-target S P T)
  ~target-chosen S P T
target-chosen S P T, is T L, ~targeted S P L

-- An Incarna is a Spirit piece that also counts as Presence
-- (modelled by giving it a presence-of row in the scenario).

-- ---------------------------------------------------------------- ENDURING VITALITY
-- "Each Vitality in a land with no Blight prevents 1 Blight from being added,
--  then is Removed."  Guard read at the start of add-blight; the Blight
--  piece and the Presence destruction it would cause are replaced.
add-blight L, land:count L vitality V, gt V 0, land:count L blight 0,
  { add-piece L blight => ~remove-token L vitality }
add-blight L, land:count L vitality V, gt V 0, land:count L blight 0,
  { destroy-presence _ => }

-- ---------------------------------------------------------------- HEART-TREE GUARDS THE LAND
-- "Your Powers get +1 Range if [Incarna] is in the origin land."
targeting S P, spirit:special S heart-tree, incarna-of S I, at I Src
  / range-bonus S P Src 1
-- "Invaders/Dahan/Beasts can't be damaged or destroyed at [Incarna]."
-- Approximation: only destruction during Ravage is covered (the guard has
-- to be read when the context starts; see notes).
ravage L, spirit:special S heart-tree, incarna-of S I, at I L, { destroy X => }
-- "Empower [Incarna] the first time it's in a land with 3 or more Vitality."
-- (checked inside each event that can make it true: the Incarna moving into
--  a land, and a Vitality arriving in the Incarna's land. Anchoring the check
--  on `game, >add-piece ...` instead lets +empowered float to a moment not
--  ordered before later steps.)
move I L, incarna-of S I, spirit:special S heart-tree,
  land:count L vitality N, ge N 3, +empowered I
add-piece L vitality, >move V L, incarna-of S I, spirit:special S heart-tree, at I L,
  land:count L vitality N, ge N 3, +empowered I
-- "Skip all Build Actions at empowered [Incarna]."
build-step, incarna-of S I, empowered I, at I L, { build L => }

-- ---------------------------------------------------------------- scenario
-- Roots: Presence r1 in l3, Incarna (also Presence) in l1 (no Blight).
-- Spirit phase: 3 Vitality added in l1 (empowers the Incarna). Fast phase: a
-- range-0 land Power is used. Ravage in l1 then tries to add Blight and
-- destroy pieces at the Incarna; Build in l1 should be skipped.
setup
  +kind vitality
  +spirit roots, +spirit:special roots heart-tree
  +presence-of roots r1, +presence-of roots tree
  +incarna-of roots tree
  +power grow, +power:speed grow fast, +power:targets grow land, +power:range grow 0
scenario, ~>move r1 l3, ~move tree l1
spirit-phase, ~>add-piece l1 vitality, ~>add-piece l1 vitality, ~add-piece l1 vitality
scenario, +played roots grow
targeting S P, power-target S P L, ^could-target S P L
report, empowered I, ^is-empowered I
