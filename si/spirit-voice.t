-- Wandering Voice Keens Delirium (Nature Incarnate), special rules:
--  A CLARION VOICE GIVEN FORM
--  "You have an Incarna ( [Wandering Voice Keens Delirium] ). If Empowered,
--   it Isolates its land."
--  SPREAD TUMULT AND DELUSION
--  "When your Actions add/move [Incarna] to a land with Invaders, Add 1
--   [Strife] in the destination land.
--   In lands with or adjacent to [Incarna] : if [Strife] is present, [Dahan]
--   do not participate in Ravage. (They do not take Damage or counterattack.
--   Isolate has no effect on [Incarna] and [Dahan] being adjacent.)"
--  SENSELESS ROAMING
--  "When your Actions add [Strife] to an [Explorer] / [Town] , you may Push it."

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- Strife (B&C / JE p7): a token beneath an Invader; "When you add a Strife in
-- a particular land, you choose which Invader it's added to."
-- (Strife's own Ravage effect lives in ext-strife.t; not needed here.)
setup, +kind strife
#acc strife-in : land
at S P, piece:kind S strife, at P L, land L / strife-in L
add-strife-in A L
  ?[rng] V
  !(at V L, piece:kind V K, invader K)
  ~add-strife-on A V
add-strife-on A V, is V X, ~add-piece X strife
-- Isolate (JE p10): "1. Invaders do not Explore Isolated lands and Isolated
-- lands are not a source of Explorers."
#acc isolated : land
explore-step, isolated L, { explore L => }
-- (second half, "not a source of Explorers", is not expressible additively:
--  see notes)
-- "you may": a yes/no decision
setup, +may yes, +may no

-- ---------------------------------------------------------------- A CLARION VOICE GIVEN FORM
-- "You have an Incarna" (a piece of its own, with a location)
-- "If Empowered, it Isolates its land."
incarna-of S I, empowered I, at I L, land L / isolated L

-- ---------------------------------------------------------------- SPREAD TUMULT AND DELUSION
-- "When your Actions add/move [Incarna] to a land with Invaders, Add 1
--  [Strife] in the destination land."
-- (`action-move S I To`: a move made by Spirit S's Action, vs. any `move`)
action-move S I To, ~move I To
action-move S I To, incarna-of S I, has-invaders To, ~add-strife-in S To
-- "In lands with or adjacent to [Incarna]: if [Strife] is present, [Dahan]
--  do not participate in Ravage. (They do not take Damage or counterattack.)"
#acc voice-near : land
spirit:special S clarion-voice, incarna-of S I, at I L, land L / voice-near L
spirit:special S clarion-voice, incarna-of S I, at I M, adjacent M L, land L / voice-near L
ravage L, voice-near L, strife-in L, { damage-dahan L _ => }
ravage L, voice-near L, strife-in L, { dahan-fight-back L => }

-- ---------------------------------------------------------------- SENSELESS ROAMING
-- "When your Actions add [Strife] to an [Explorer] / [Town], you may Push it."
#acc roamer : e
piece:kind V explorer / roamer V
piece:kind V town / roamer V
add-strife-on S C, spirit:special S senseless-roaming, is C V, roamer V, at V L
  ?[rng] R
  !(may R)
  ~roam-ask S V L R
roam-ask S V L R, is R yes, ~push S V L

-- ---------------------------------------------------------------- scenario
-- Voice's empowered Incarna starts in l2; in the Fast phase a Power of Voice
-- moves it to l1 (Town + Explorer + Dahan). Expect: Strife added in l1 (and
-- possibly that piece Pushed); l1 is Isolated, so l1 does not Explore under
-- the extra wetland Explore card; at l1's Ravage the Dahan neither take Damage
-- nor fight back (l2 is adjacent too: its Dahan sit out if l2 has Strife).
setup
  +spirit voice, +spirit:special voice clarion-voice, +spirit:special voice senseless-roaming
  +incarna-of voice wv, +empowered wv
  +invader-card:explore w
scenario, ~move wv l2
fast-phase, ~action-move voice wv l1
report, at wv L, ^incarna-at L
report, at S P, piece:kind S strife, at P L, ^strife-report P L
