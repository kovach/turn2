-- Fractured Days Split the Sky (Jagged Earth). Special rules (verbatim):
--  FRAGMENTS OF SHATTERED TIME
--   "Each [Presence] on this ability represents 1 Time. Many of your Powers
--    require Time as an additional cost. Spend it when you Resolve the Power.
--    (Not when you play it.)
--    When you Gain 1 Time , put 1 of your [Presence] here from your
--    [Presence] track (or, optionally, the island). When you Spend 1 Time ,
--    return it to a [Presence] track - or if you have no free spaces,
--    Destroy it."
--  DAYS THAT NEVER WERE
--   "Your 3rd Growth option lets you gain any one Power Card from a special
--    set you create during Setup. When you gain a Power Card any other way,
--    you may add one unchosen card to this set."

#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit)
-- Presence tracks as one location per Spirit, with a number of spaces;
-- free spaces = spaces - Presence on the track.
#acc track-free : spirit @sum
track-spaces S N / track-free S N
presence-of S P, at P (track S) / track-free S -1
-- p18 "Gain a Power Card": draw (here: a fixed 4-card draw per gain),
-- keep one, discard the rest
gain-power-draw S G
  ?[rng] C
  !(drawn G C)
  ~kept S G C
kept S G C, is C K, +owns S K

-- ---------------------------------------------------------------- Fragments of Shattered Time
-- "Each Presence on this ability represents 1 Time."
#acc time : spirit @sum
spirit:special S fragments / time S 0
presence-of S P, at P (time-panel S) / time S 1

-- "When you Gain 1 Time, put 1 of your Presence here from your Presence
--  track (or, optionally, the island)."
gain-time S
  ?[rng] P
  !(presence-of S P, at P (track S))
  ~time-from S P
-- (the island option, as a second source; a real UI would offer both)
gain-time-from-island S
  ?[rng] P
  !(presence-of S P, at P L, land L)
  ~time-from S P
time-from S C, is C P, ~move P (time-panel S)

-- "When you Spend 1 Time, return it to a Presence track - or if you have no
--  free spaces, Destroy it."
spend-time S N, gt N 0
  ?[rng] P
  !(presence-of S P, at P (time-panel S))
  ~>spend-one S P
  minus N 1 N1
  ~spend-time S N1
spend-one S C, is C P, track-free S F, gt F 0, ~move P (track S)
spend-one S C, is C P, track-free S 0, ~move P destroyed

-- "Many of your Powers require Time as an additional cost. Spend it when you
--  Resolve the Power."
use-power S P, power:time-cost P N, ~spend-time S N
-- not enough Time: the Power cannot be resolved (checked at the phase start)
fast-phase, played S P, power:time-cost P N, time S T, lt T N, { use-power S P => ^unaffordable S P }
slow-phase, played S P, power:time-cost P N, time S T, lt T N, { use-power S P => ^unaffordable S P }

-- ---------------------------------------------------------------- Days That Never Were
-- "Your 3rd Growth option lets you gain any one Power Card from a special
--  set you create during Setup."
growth-3 S
  ?[rng] C
  !(days-set S C)
  ~days-gain S C
days-gain S C, is C K, +owns S K, ^left-days-set S K
-- "When you gain a Power Card any other way, you may add one unchosen card
--  to this set."  (`any other way` = any other episode that gains: here the
--  draw; the set is a relation that only grows, removal is not modeled)
kept S G C, spirit:special S days, is C K
  ?[rng] U
  !(drawn G U, neq U K)
  ~days-add S U
days-add S C, is C U, +days-set S U

-- ---------------------------------------------------------------- scenario
setup
  +spirit fractured, +spirit:special fractured fragments, +spirit:special fractured days
  +presence-of fractured f1, +presence-of fractured f2, +presence-of fractured f3
  +track-spaces fractured 1
  +power slip, +power:speed slip fast, +power:time-cost slip 1
  +power rewind, +power:speed rewind slow, +power:time-cost rewind 1
  +power eon, +power:speed eon slow, +power:time-cost eon 3
  +days-set fractured visions-of-a-shifting-future
  +drawn draw1 card-a, +drawn draw1 card-b, +drawn draw1 card-c, +drawn draw1 card-d
-- f1 on the (1-space) track, f2 and f3 on the island
scenario, ~>move f1 (track fractured), ~>move f2 l3, ~move f3 l3
-- Spirit phase: gain 2 Time (one from the track, one from the island),
-- gain a Power Card the normal way (Days adds an unchosen card), then use
-- Growth 3 to take a card from the set
spirit-phase, ~>gain-time fractured, ~>gain-time-from-island fractured, ~>gain-power-draw fractured draw1, ~growth-3 fractured
scenario, +played fractured slip
scenario, +played fractured rewind
scenario, +played fractured eon
report, time fractured T, ^time-report T
report, presence-of fractured P, at P L, ^where P L
report, days-set fractured C, ^days-report C
report, owns fractured C, ^owns-report C
