-- Breath of Darkness Down Your Spine (Nature Incarnate). Special rules,
-- verbatim (the scraped text is cut off mid-sentence at the end):
--  TERROR STALKS THE LAND
--   "You have an Incarna ( [Breath of Darkness Down Your Spine] ). Empower
--    [Incarna] after uncovering [Empowered] . You may Abduct 1 [Explorer] /
--    [Town] at empowered [Incarna] each [Fasticon] phase.
--    To Abduct a piece, Move it to The Endless Dark ( [Endless Dark] ). When
--    pieces Escape, Move them to non-Ocean lands with your [Presence] /
--    [Incarna] ; if they have no legal land to move to, you lose.
--    When your Powers would directly damage or directly destroy the only
--    Invader in a land, instead Abduct it. (Check if it is alone at the start
--    of the damage/destroy instruction. [Endless Dark] is not a land.)"
--  SHADOW-TOUCHED REALM
--   "Your land-targeting Powers can target [Endless Dark] as if it were a
--    land, ignoring Range. ( [Endless Dark] is Inland and has no terrain.)"
--  Rules for The Endless Dark — A SPACE OF STRANGE AND INFINITE DARKNESS
--   "The Endless Dark is on the island, but isn't a land and isn't on any
--    board. This can't be a [Sacred Site] . Spirits can't target this even if
--    they have [Presence] here. Adding [Blight] here doesn't destroy
--    [Presence] . Special rules that affect lands do nothing here. Invaders
--    can't take Actions here. Pieces here are on the island when checking for
--    Victory/Defeat."
--  TRAPPED IN THE ENDLESS DARK
--   "Fear Cards and Token Events affect pieces here as if this were an Inland
--    land, but can't remove Invaders here - when t[...truncated]"

#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- Range / land targeting (same machinery as spirit-roots.t)
#js-def plus +A +B -C { yield [A + B] }
#acc reach : land land num
land-for power L / reach L L 0
reach A B N, adjacent B C, land-for power C, lt N 4, plus N 1 M / reach A C M
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
-- Invaders per land
#acc land:invader-count : land @sum
land L / land:invader-count L 0
at X L, piece:kind X K, invader K / land:invader-count L 1

-- ---------------------------------------------------------------- TERROR STALKS THE LAND
-- "To Abduct a piece, Move it to The Endless Dark."
abduct X, ~move X endless-dark
-- "Empower [Incarna] after uncovering [Empowered]."
uncover S empowered-space, spirit:special S terror, incarna-of S I, +empowered I
-- "You may Abduct 1 Explorer/Town at empowered [Incarna] each Fast phase."
fast-phase, spirit:special S terror, incarna-of S I, empowered I, at I L, land L
  ~abduct-offer S L
#acc abduct-option : land e
abduct-offer S L / abduct-option L decline
abduct-offer S L, at X L, piece:kind X explorer / abduct-option L X
abduct-offer S L, at X L, piece:kind X town / abduct-option L X
abduct-offer S L
  ?[rng] A
  !(abduct-option L A)
  ~abduct-choice A
abduct-choice C, is C X, neq X decline, ~abduct X

-- "When pieces Escape, Move them to non-Ocean lands with your Presence /
--  Incarna; if they have no legal land to move to, you lose."
#acc escape-dest : e land
escape X, spirit:special S terror, presence-of S P, at P L, land L
  / escape-dest X L
#acc escape-dest-count : e @sum
escape X / escape-dest-count X 0
escape-dest X L / escape-dest-count X 1
escape X, escape-dest-count X 0, +defeat (escape X)
escape X
  ?[rng] L
  !(escape-dest X L)
  ~escape-to X L
escape-to X C, is C L, ~move X L

-- "When your Powers would directly damage or directly destroy the only
--  Invader in a land, instead Abduct it."  Approximation: "alone" is
--  checked at the start of the Power, not of the destroy instruction.
--  `land L` matters: land:invader-count also has rows for endless-dark
--  ("Endless Dark is not a land").
use-power S P, spirit:special S terror, land:invader-count L 1, land L,
  at X L, piece:kind X K, invader K,
  { destroy X => ~abduct X }

-- ---------------------------------------------------------------- SHADOW-TOUCHED REALM
-- "Your land-targeting Powers can target [Endless Dark] as if it were a land,
--  ignoring Range."
targeting S P, spirit:special S shadow-realm, power:targets P land
  / power-target S P endless-dark
-- "(Endless Dark is Inland and has no terrain.)" -- nothing to add: it has no
-- land:terrain row and is not adjacent to an ocean.

-- ---------------------------------------------------------------- THE ENDLESS DARK
-- Most of these hold because endless-dark has no `land` row: it cannot be a
-- Sacred Site (sacred-site requires land), it is no Range origin or target
-- (reach/land-for), Invaders never Ravage/Build/Explore it (those need a
-- terrain), and land-quantified special rules skip it.
-- "Pieces here are on the island when checking for Victory/Defeat."
#acc on-island : e
at X L, land L / on-island X
at X endless-dark / on-island X
-- "Fear Cards and Token Events affect pieces here as if this were an Inland
--  land" (no Fear Cards in core; the view is ready for them)
spirit:special S terror / land-for fear endless-dark

-- ---------------------------------------------------------------- scenario
-- Breath: Presence k1 in l3, Incarna in l1 (Town + Explorer). Spirit phase:
-- uncover the Empowered space. Fast: may abduct at l1, and a range-0 Power
-- "Destroy 1 Explorer" is aimed (test-only narrowing) at l3, which holds a
-- lone Explorer. Report: Invaders in the Endless Dark escape.
setup
  +spirit breath, +spirit:special breath terror, +spirit:special breath shadow-realm
  +context fear
  +presence-of breath k1
  +incarna-of breath bod, +presence-of breath bod
  +power dread, +power:speed dread fast, +power:targets dread land, +power:range dread 0
scenario, ~>move k1 l3, ~>move bod l1, ~add-piece l3 explorer
-- test-only: narrow the Power's target choice to l3
targeting S dread, (target-chosen S dread T), !(test-target T)
setup, +test-target l3
spirit-phase, ~uncover breath empowered-space
scenario, +played breath dread
targeted S dread L
  ?[rng] X
  !(at X L, piece:kind X explorer)
  ~power-destroy X
power-destroy C, is C X, ~destroy X
report, at X endless-dark, piece:kind X K, invader K, ~escape X
report, on-island X, piece:kind X K, invader K, ^invader-on-island X K
