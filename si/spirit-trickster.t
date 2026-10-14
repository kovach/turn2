-- Grinning Trickster Stirs Up Trouble (Jagged Earth). Special rules (wiki, verbatim):
--  A REAL FLAIR FOR DISCORD: "After one of your Powers adds [Strife] in a
--   land, you may pay 1 Energy to add 1 [Strife] within 1 [Range] of that
--   land."
--  CLEANING UP MESSES IS A DRAG: "After one of your Powers Removes
--   [Blight], Destroy 1 of your [Presence]. Ignore this rule for Let's See
--   What Happens."

#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- BASE-EXT (rulebook, not this spirit) ---------------------------------
-- Energy (p13): a running total; gains and payments are contributions.
#acc energy : spirit @sum
spirit S / energy S 0
energy-change S X N / energy S N
gain-energy S N, +energy-change S gain N
pay-energy S N, minus 0 N M, +energy-change S pay M
-- Strife (B&C) is added to a specific Invader: its location is the Invader.
-- `add-strife V` is the game verb, `add-piece V strife` the physical act.
setup, +kind strife
add-strife V, ~add-piece V strife
-- Removing Blight (p18): "return it to the Blight Card".
remove-blight L, at B L, piece:kind B blight, ~remove-one-blight L
remove-one-blight L
  ?[rng] B
  !(at B L, piece:kind B blight)
  ~removing-blight B
removing-blight C, is C B, ~move B blight-card
-- Range 1 (p16): the land itself or an adjacent one.
setup, +same l1 l1, +same l2 l2, +same l3 l3
#acc within-1 : land land
same L L2 / within-1 L L2
adjacent L L2, land L2 / within-1 L L2
-- Powers resolve in the Fast and Slow phases; an "after the Power" trigger
-- runs in the same phase, after the Power's `use-power` episode. (A generic
-- `^phase` window no longer works: each `^phase` starts at its own moment,
-- concurrent with the phase's `use-power` episodes.)
-- ---------------------------------------------------------------------

-- A REAL FLAIR FOR DISCORD
-- "After one of your Powers adds Strife in a land, ..."
use-power S Pw, spirit:special S flair-for-discord, (add-strife V), at V L
  ^strife-added-by S Pw L
fast-phase, (strife-added-by S Pw L), >use-power S Pw
  ~flair S L
slow-phase, (strife-added-by S Pw L), >use-power S Pw
  ~flair S L
-- "... you may pay 1 Energy to add 1 Strife within 1 Range of that land."
#acc flair-option : e
flair S L, at V L2, within-1 L L2, piece:kind V K, invader K / flair-option V
flair S L / flair-option decline
flair S L, energy S E, ge E 1
  ?[rng] V
  !(flair-option V)
  ~flair-choice S V
-- the extra Strife is added by the special rule, not by a Power, so it
-- uses the physical act and does not re-trigger this rule
flair-choice S C, is C V, piece:kind V K, invader K
  ~>pay-energy S 1
  ~add-piece V strife

-- CLEANING UP MESSES IS A DRAG
-- "After one of your Powers Removes Blight, Destroy 1 of your Presence.
--  Ignore this rule for Let's See What Happens."
use-power S Pw, spirit:special S cleaning-up-messes, neq Pw lets-see-what-happens,
  (remove-blight L)
  ^blight-removed-by S Pw
fast-phase, (blight-removed-by S Pw), >use-power S Pw
  ?[rng] P
  !(presence-of S P, at P L, land L)
  ~cleanup-destroy S P
slow-phase, (blight-removed-by S Pw), >use-power S Pw
  ?[rng] P
  !(presence-of S P, at P L, land L)
  ~cleanup-destroy S P
cleanup-destroy S C, is C P, ~destroy-presence-of P
destroy-presence-of P, ~move P destroyed

-- scenario: Trickster (2 Energy, Presence in l3) plays two Fast Powers:
-- one adds Strife to l1's Town, one removes a Blight from l2; and Let's See
-- What Happens, which also removes a Blight (from l2) but costs nothing.
setup
  +spirit trickster, +spirit:special trickster flair-for-discord
  +spirit:special trickster cleaning-up-messes
  +presence-of trickster t1, +presence-of trickster t2
  +power incite, +power:speed incite fast
  +power cleanse, +power:speed cleanse fast
  +power lets-see-what-happens, +power:speed lets-see-what-happens slow
scenario, ~>move t1 l3, ~>move t2 l2, ~gain-energy trickster 2
-- the cards played this turn: a turn-scoped acc view (holds at every moment
-- of the turn, so the phases' reads see it)
#acc played : spirit power
turn / played trickster incite
turn / played trickster cleanse
turn / played trickster lets-see-what-happens
use-power trickster incite, at V l1, piece:kind V town, ~add-strife V
use-power trickster cleanse, ~remove-blight l2
use-power trickster lets-see-what-happens, ~remove-blight l2
report, presence-of trickster P, at P L, ^trickster-presence P L
report, energy trickster E, ^trickster-energy E
report, at S V, piece:kind S strife, at V L, ^strife-in S V L
