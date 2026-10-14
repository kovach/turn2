-- Shroud of Silent Mist (Jagged Earth). Special rules (verbatim):
--  GATHER POWER FROM THE COOL AND DARK
--   "Once a turn, when you Gain a Power Card without [Fire], gain 1 Energy."
--  MISTS SHIFT AND FLOW
--   "When targeting a land with a Power, you may Gather 1 of your [Presence]
--    into the target or an adjacent land. This can enable you to meet Range
--    and targeting requirements."
--  SLOW AND SILENT DEATH
--   "Invaders and [Dahan] in your lands don't heal Damage.
--    During Time Passes : 1 [Fear] (max. 5) per land of yours with Damaged
--    Invaders. Gain 1 Energy per 3 lands of yours with Damaged Invaders."

#js-def plus +A +B -C { yield [A + B] }
#js-def neg +A -C { yield [-A] }
#js-def min5 +A -C { yield [Math.min(5, A)] }
#js-def div3 +A -C { yield [Math.floor(A / 3)] }

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit)
-- Energy: a running @sum of gains (spending would be negative rows)
#acc energy : spirit @sum
spirit S / energy S 0
gain-energy S N / energy S N

-- Gaining a Power Card (no deck model: the card is named)
gain-power-card S P, +owns S P

-- Elements on a card, with a 0 default so "without Fire" is a value test
#acc power-fire : power @sum
power P / power-fire P 0
power:element P fire / power-fire P 1

-- Damage persists until something heals it; p10 Time Passes: "All Damage
-- done during the turn goes away" is an explicit heal event, so a Spirit
-- can intercept it.
#acc damage-on : e @sum
dmg P N / damage-on P N
deal-damage-to P N, +dmg P N
time-passes, damage-on P D, gt D 0, ~heal P
heal P, damage-on P D, neg D ND, +dmg P ND

-- p8/p10 Time Passes comes after the Slow phase (added after core's phases)
turn, >slow-phase, ~time-passes

-- Range and targeting
#acc reach : land land num
land L / reach L L 0
reach A M K, adjacent M B, land B, plus K 1 K1, le K1 3 / reach A B K1
#acc base-in-range : spirit power land
played S P, power:range P R, has-presence S O, reach O T K, le K R / base-in-range S P T
#acc targetable : spirit power land
base-in-range S P T / targetable S P T
-- targeting: choose a land, then resolve whatever the target needs
target-power S P
  ?[rng] T
  !(targetable S P T)
  ~targets S P T

-- ---------------------------------------------------------------- Cool and Dark
-- "Once a turn, when you Gain a Power Card without Fire, gain 1 Energy."
-- (core has one turn; with several, the flag would need a turn key)
#acc cool-dark-used : spirit
used-cool-dark S / cool-dark-used S
gain-power-card S P, spirit:special S cool-dark, power-fire P 0, not cool-dark-used S
  +used-cool-dark S
  +gain-energy S 1

-- ---------------------------------------------------------------- Mists Shift and Flow
-- "you may Gather 1 of your Presence into the target or an adjacent land.
--  This can enable you to meet Range and targeting requirements."
-- widen: T is targetable if some Presence can be gathered (from an adjacent
-- land) into a land Into, within 1 of T, from which T is in range
#acc mists-gather : spirit power land land land
played S P, spirit:special S mists, power:range P R, presence-of S X, at X From
  adjacent From Into, land Into, reach Into T J, le J 1, reach Into T K, le K R
  / mists-gather S P T From Into
mists-gather S P T From Into / targetable S P T
-- once targeted: gather (if that is what made it legal) or decline
#acc mists-option : spirit power land e
mists-gather S P T From Into / mists-option S P T (gather From Into)
base-in-range S P T / mists-option S P T decline
targets S P T, spirit:special S mists
  ?[rng] O
  !(mists-option S P T O)
  ~mists-choice S O
mists-choice S O, is O (gather From Into), ~mist-gather S From Into
-- Gather exactly one of your Presence from From
mist-gather S From Into
  ?[rng] X
  !(presence-of S X, at X From)
  ~mist-move X Into
mist-move X Into, is X P, ~move P Into

-- ---------------------------------------------------------------- Slow and Silent Death
-- "Invaders and Dahan in your lands don't heal Damage."
time-passes, spirit:special S slow-death, has-presence S L, at P L, { heal P => }
-- "During Time Passes: 1 Fear (max. 5) per land of yours with Damaged
--  Invaders. Gain 1 Energy per 3 lands of yours with Damaged Invaders."
#acc silent-land : spirit land
spirit:special S slow-death, has-presence S L, at P L, piece:kind P K, invader K
  damage-on P D, gt D 0 / silent-land S L
#acc silent-lands : spirit @sum
spirit:special S slow-death / silent-lands S 0
silent-land S L / silent-lands S 1
time-passes, silent-lands S N, gt N 0, min5 N F, +fear-from (slow-death S) F
time-passes, silent-lands S N, div3 N E, gt E 0, +gain-energy S E

-- ---------------------------------------------------------------- scenario
setup
  +spirit shroud
  +spirit:special shroud cool-dark, +spirit:special shroud mists, +spirit:special shroud slow-death
  +presence-of shroud h1, +presence-of shroud h2, +presence-of shroud h3
  +power mist-a, +power mist-b, +power ember, +power:element ember fire
  +power creeping-mist, +power:speed creeping-mist fast, +power:range creeping-mist 1
scenario, ~>move h1 l1, ~>move h2 l2, ~move h3 l2
-- the card played this turn: a turn-scoped acc view (holds at every moment
-- of the turn, so the phases' reads see it)
#acc played : spirit power
turn / played shroud creeping-mist
-- Cool and Dark: three gains this turn, two of them without Fire -> 1 Energy
spirit-phase, ~>gain-power-card shroud ember, ~>gain-power-card shroud mist-a, ~gain-power-card shroud mist-b
-- Mists: creeping-mist (range 1 from l1) targets the mountain l3, which is
-- only reachable by gathering h1 into l2
fast-phase, ~target-power shroud creeping-mist
target-power S P, (targets S P T), !(land:terrain T mountain)
-- Slow and Silent Death: a Power damages a piece in Shroud's land and one
-- elsewhere; only the first keeps its Damage after Time Passes
slow-phase, at P l2, piece:kind P city, ~deal-damage-to P 1
slow-phase, at P l1, piece:kind P town, ~deal-damage-to P 1
report, damage-on P D, gt D 0, at P L, ^still-damaged P L D
report, energy shroud E, ^energy-report E
