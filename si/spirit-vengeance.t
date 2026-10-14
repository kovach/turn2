-- Vengeance as a Burning Plague (Jagged Earth). Run with ext-disease.t:
--   ./run.sh core.t ext-disease.t spirit-vengeance.t
-- Special rules (verbatim):
--  THE TERROR OF A SLOWLY UNFOLDING PLAGUE
--   "When [Disease] would prevent a Build on a board with your [Presence],
--    you may let the Build happen (removing no [Disease]). If you do, 1 [Fear]."
--  LINGERING PESTILENCE
--   "When your [Presence] is destroyed by anything except a Spirit action,
--    add 1 [Disease] where each destroyed [Presence] was."
--  WREAK VENGEANCE FOR THE LAND'S CORRUPTION
--   "Your actions treat [Blight] on the island as also being [Badlands]."

#js-def plus +A +B -C { yield [A + B] }

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit)
-- yes/no decisions
setup, +yes-no yes, +yes-no no
-- JE p8 Badlands: "The first time each Action Damages Invaders in a land,
-- increase that Damage by 1 per [Badlands]." Badlands are counted through a
-- per-actor view so "your actions treat X as Badlands" is a row addition.
#acc badlands-for : spirit land @sum
spirit S, land L / badlands-for S L 0
spirit S, at B L, piece:kind B badlands / badlands-for S L 1
-- a Power's "N Damage" in a land (if N >= 1, + Badlands)
power-damage S L N, gt N 0, badlands-for S L B, plus N B T, ^damage-total S L T
-- a Power's effects are rules keyed on the power's name
use-power S P, power:effect P (add-blight L), ~add-blight L
use-power S P, power:effect P (damage L N), ~power-damage S L N

-- ---------------------------------------------------------------- Unfolding Plague
-- "When Disease would prevent a Build on a board with your Presence, you
--  may let the Build happen (removing no Disease). If you do, 1 Fear."
-- The decision is made as the Build Step starts, for each land whose Build
-- Disease would prevent; "let it happen" intercepts what the Disease rule
-- does instead of the Build (remove-one ... disease) and performs the Build.
#acc has-any-presence : spirit
presence-of S P, at P L, land L / has-any-presence S
build-step, spirit:special S plague, has-any-presence S, has-disease L
  invader-card:build C, card:terrain C T, land:terrain L T, has-invaders L
  ?[rng] Y
  !(yes-no Y)
  ~plague-decides L Y
build-step, (plague-decides L Y), is Y yes, { remove-one L disease => ~plague-build L }
plague-build L, +fear-from (plague L) 1
-- "let the Build happen": Disease already consumed the base `build L`
-- tuple, so the Build's two base rules are restated for plague-build
plague-build L, land:count L town Nt, land:count L city Nc, gt Nt Nc, ~add-piece L city
plague-build L, land:count L town Nt, land:count L city Nc, le Nt Nc, ~add-piece L town

-- ---------------------------------------------------------------- Lingering Pestilence
-- "When your Presence is destroyed by anything except a Spirit action, add
--  1 Disease where each destroyed Presence was."
destroy-presence C, is C X, presence-of S X, spirit:special S lingering, at X L
  ~lingering S L
lingering S L, ~add-piece L disease
-- "except a Spirit action": inside any Spirit's Power the trigger is cancelled
use-power S P, { lingering _ _ => }

-- ---------------------------------------------------------------- Wreak Vengeance
-- "Your actions treat Blight on the island as also being Badlands."
spirit:special S wreak, at B L, piece:kind B blight / badlands-for S L 1

-- ---------------------------------------------------------------- scenario
setup
  +spirit plague
  +spirit:special plague plague, +spirit:special plague lingering, +spirit:special plague wreak
  +presence-of plague g1, +presence-of plague g2
  +power blight-curse, +power:speed blight-curse slow, +power:effect blight-curse (add-blight l3)
  +power fever, +power:speed fever fast, +power:effect fever (damage l2 1)
-- Ravage is fully Defended (keeps the core's unbounded cascades out of the
-- way). g1 in l2 is destroyed by an Event-style Blight (not a Spirit
-- action): Disease appears in l2. g2 in l3 is destroyed by plague's own
-- Power: no Disease. Disease in l1 (ext-disease) would prevent l1's Build.
setup, +defend l1 9, +defend l2 9
scenario, ~>move g1 l2, ~move g2 l3
slow-phase, ~add-blight l2
-- the cards played this turn: a turn-scoped acc view (holds at every moment
-- of the turn, so the phases' reads see it)
#acc played : spirit power
turn / played plague blight-curse
-- Wreak: fever's 1 Damage in l2 (1 Blight at the start) becomes 2
turn / played plague fever
report, damage-total S L T, ^damage-report S L T
