-- Serpent Slumbering Beneath the Island (Jagged Earth). Special rule (wiki, verbatim):
--  DEEP SLUMBER: "You start off limited to 5 [Presence] on the island. Raise
--   this with your "Absorb Essence" Power Card. Each use covers the lowest
--   revealed number; your [Presence] limit is the lowest uncovered number.
--   5 7 8 10 11 12 13"

-- DEEP SLUMBER
-- The track printed on the panel: position I shows limit M.
setup
  +slumber-track 0 5, +slumber-track 1 7, +slumber-track 2 8, +slumber-track 3 10
  +slumber-track 4 11, +slumber-track 5 12, +slumber-track 6 13
-- "Raise this with your Absorb Essence Power Card. Each use covers the
--  lowest revealed number"  (each use is one +absorbed fact)
#acc absorb-uses : spirit @sum
spirit:special S deep-slumber / absorb-uses S 0
absorbed S U / absorb-uses S 1
-- "your Presence limit is the lowest uncovered number."
#acc presence-limit : spirit @sum
absorb-uses S A, slumber-track A M / presence-limit S M
-- "You start off limited to 5 Presence on the island."
#acc on-island : spirit @sum
spirit:special S deep-slumber / on-island S 0
presence-of S P, at P L, land L / on-island S 1
#acc under-limit : spirit
on-island S N, presence-limit S M, lt N M / under-limit S
-- narrows the base add-presence choice: with no room, no land qualifies and
-- the choice resolves to nothing
add-presence S, spirit:special S deep-slumber, (presence-choice S C), !(presence-dest S C, under-limit S)

-- scenario: Serpent has 5 Presence on the island and 1 in its supply.
-- Growth in the Spirit Phase adds nothing (limit 5); in the Slow Phase it
-- uses Absorb Essence once (limit 7) and grows again: now it may add.
setup
  +spirit serpent, +spirit:special serpent deep-slumber
  +presence-of serpent s1, +presence-of serpent s2, +presence-of serpent s3
  +presence-of serpent s4, +presence-of serpent s5, +presence-of serpent s6
scenario, ~>move s1 l3, ~>move s2 l3, ~>move s3 l3, ~>move s4 l2, ~>move s5 l1, ~move s6 supply
spirit-phase, ~add-presence serpent
slow-phase
  ~>absorb-essence serpent
  ~add-presence serpent
absorb-essence S, +absorbed S once
report, presence-of serpent P, at P L, ^serpent-presence P L
report, presence-limit serpent M, ^serpent-limit M
