-- Starlight Seeks Its Form (Jagged Earth). Special rules (verbatim):
--  GROWTH BEGETS GROWTH
--   "You have 6 [Presence] tracks. (As usual, you may add [Presence] from
--    any track.) 4 of the [Presence] tracks are next to rows of Growth
--    choices: these choices start unavailable. Upon emptying a Growth track,
--    pick one of its two Growth choices to be immediately available. The
--    other stays unavailable for the rest of the game (cover with a spare
--    piece). After you add [Presence] from a space marked [Energyplus1],
--    gain 1 Energy."
--  SLOWLY COALESCING NATURE
--   "After revealing an [Element], place 1 Element Marker of your choice on
--    it. That element is permanent and is constantly available (As if
--    pre-printed on the [Presence] track.)"

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit)
-- Presence tracks: each Presence starts on a space; a space belongs to a
-- track. Adding Presence takes one from a track space (core's add-presence
-- takes from `supply`, which has no tracks).
#acc energy : spirit @sum
spirit S / energy S 0
gain-energy S N / energy S N
#acc track-count : track @sum
track T / track-count T 0
presence-of S P, at P Sp, space:track Sp T / track-count T 1
add-from-track S P L
  ~>uncover S P
  ~move P L
-- `uncover` remembers which space the Presence left (read at its start)
uncover S P, at P Sp, ^uncovered S Sp
-- Growth: choose one available option
growth S
  ?[rng] G
  !(growth-available S G)
  ~grows S G
grows S C, is C G, ^grew S G

-- ---------------------------------------------------------------- Growth Begets Growth
-- "4 of the Presence tracks are next to rows of Growth choices: these
--  choices start unavailable."  (availability only ever gets rows added)
-- "Upon emptying a Growth track, pick one of its two Growth choices to be
--  immediately available. The other stays unavailable for the rest of the game."
add-from-track S P L, at P Sp, space:track Sp T, track:growth T
  >uncover S P
  track-count T N, le N 1
  ?[rng] G
  !(track:choice T G)
  ~unlock S G
unlock S C, is C G, +growth-available S G
-- "After you add Presence from a space marked Energy+1, gain 1 Energy."
add-from-track S P L, at P Sp, space:bonus Sp energy+1
  +gain-energy S 1

-- ---------------------------------------------------------------- Slowly Coalescing Nature
-- "After revealing an Element, place 1 Element Marker of your choice on it.
--  That element is permanent and is constantly available."
add-from-track S P L, at P Sp, space:bonus Sp element
  ?[rng] E
  !(element E)
  ~marker S E
marker S C, is C E, +permanent-element S E
permanent-element S E / elements S E 1

-- ---------------------------------------------------------------- scenario
setup
  +spirit starlight
  +presence-of starlight a1, +presence-of starlight b1, +presence-of starlight b2
  +track tg, +track:growth tg, +track:choice tg gain-power-and-energy, +track:choice tg add-two-presence
  +track te
  +space sa1, +space:track sa1 tg, +space:bonus sa1 energy+1
  +space sb1, +space:track sb1 te, +space:bonus sb1 element
  +space sb2, +space:track sb2 te
  +growth-available starlight reclaim
scenario, ~>move a1 sa1, ~>move b1 sb1, ~move b2 sb2
-- add a1 (the growth track's only space, an Energy+1 space), then b1 (an
-- Element space); then Growth sees the unlocked option
spirit-phase, ~>add-from-track starlight a1 l3, ~>add-from-track starlight b1 l3, ~growth starlight
report, growth-available starlight G, ^available G
report, energy starlight E, ^energy-report E
report, elements starlight E N, gt N 0, ^starlight-element E N
