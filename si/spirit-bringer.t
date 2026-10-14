-- Bringer of Dreams and Nightmares (Base). Special rule, verbatim:
--   TO DREAM A THOUSAND DEATHS: "Your Powers never cause Damage, nor can they
--   Destroy anything other than your own [Presence]. When your Powers would
--   Destroy (or deal enough Damage to Destroy) [Explorer] / [Town] / [City],
--   instead generate 0/2/5 [Fear]. The Power Pushes all [Explorer] / [Town]
--   it would Destroy.
--   Notes: A single Power cannot Destroy a given Invader more than once.
--   Powers that cause Damage via [Dahan] are affected just like all others.
--   All effects other than Damage/Destroy work as usual."

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- p15 Health: "To destroy an Invader, you must deal Damage that meets or
-- exceeds its Health" (single-hit approximation: no accumulated Damage)
damage-piece X N, piece:kind X K, kind:health K H, ge N H, ~destroy X

-- ---------------------------------------------------------------- the special rule
-- "Your Powers never cause Damage, nor can they Destroy anything other than
--  your own Presence."  -- both instructions are replaced while one of this
--  Spirit's Powers is being used (the exception's context is the use-power
--  episode). Presence destruction goes through destroy-presence, so it is
--  untouched.
use-power S P, spirit:special S dream-a-thousand-deaths, { destroy X => ~dream-destroy X }
use-power S P, spirit:special S dream-a-thousand-deaths, { damage-piece X N => ~dream-damage X N }
-- "(or deal enough Damage to Destroy)"
dream-damage X N, piece:kind X K, kind:health K H, ge N H, ~dream-destroy X
-- "instead generate 0/2/5 Fear"
dream-destroy X, piece:kind X K, dream-fear K F, +fear-from X F
-- "The Power Pushes all Explorer / Town it would Destroy."
-- (the exception RHS cannot mention the Spirit, so the pusher is looked up)
dream-destroy X, piece:kind X K, dream-pushes K, at X L,
  spirit:special S dream-a-thousand-deaths, ~push S X L

-- scenario: Bringer plays one Fast Power that destroys the Town in l1, deals
-- 1 Damage to the Explorer in l1, and destroys a Dahan in l2.
setup
  +kind:health explorer 1, +kind:health town 2, +kind:health city 3, +kind:health dahan 2
  +dream-fear explorer 0, +dream-fear town 2, +dream-fear city 5
  +dream-pushes explorer, +dream-pushes town
  +spirit bringer, +spirit:special bringer dream-a-thousand-deaths
  +power night-terrors, +power:speed night-terrors fast
scenario, +played bringer night-terrors
use-power S night-terrors, at T l1, piece:kind T town, ~destroy T
use-power S night-terrors, at E l1, piece:kind E explorer, ~damage-piece E 1
use-power S night-terrors, at D l2, piece:kind D dahan, ~destroy D
report, piece:kind P K, at P L, ^where K L
