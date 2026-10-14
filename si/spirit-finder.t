-- Finder of Paths Unseen (Promo Pack 2), special rules:
--   RESPONSIBILITIES TO THE DEAD
--   "After one of your Actions Destroys 1 or more [Dahan] /Invaders, or
--    directly triggers their Destruction by moving them, Destroy 1 of your
--    [Presence] and lose 1 Energy. If you have no Energy to lose, Destroy
--    another [Presence]."
--   OPEN THE WAYS
--   "You may make up to two of your lands adjacent at a time. You may change
--    which lands are adjacent once between Actions."

#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- BASE-EXT (rulebook, not this spirit):
-- p13 Energy: a running total of gains and payments.
#acc energy : spirit @sum
spirit S / energy S 0
energy-change S N / energy S N
-- A Power Card "Destroy 1 Explorer" (target chosen by the scenario).
use-power S P, power-target S P L, power:destroys P K
  ?[rng] V
  !(at V L, piece:kind V K)
  ~destroy-choice V
destroy-choice C, is C V, ~destroy V
-- Who did it: every destroy nested inside a Power's use is that Action's.
-- (also covers "triggers their Destruction by moving them": a Drown happens
--  inside the move, inside the Power)
#acc human : kind
setup, +human-kind dahan, +human-kind explorer, +human-kind town, +human-kind city
use-power S P, destroy X, piece:kind X K, human-kind K, +action-destroyed S P X

-- "After one of your Actions Destroys 1 or more Dahan/Invaders, ...,
--  Destroy 1 of your Presence and lose 1 Energy."
#acc action-destroyed-some : spirit power
action-destroyed S P X / action-destroyed-some S P
turn, >use-power S P, action-destroyed-some S P,
  spirit:special S responsibilities-to-the-dead
  ~responsibility S
responsibility S
  ~>destroy-own-presence S
  energy S E
  ~lose-energy-or-presence S E
lose-energy-or-presence S E, gt E 0, +energy-change S -1
-- "If you have no Energy to lose, Destroy another Presence."
lose-energy-or-presence S E, le E 0, ~destroy-own-presence S
destroy-own-presence S
  ?[rng] P
  !(presence-of S P, at P L, land L)
  ~destroy-presence P

-- OPEN THE WAYS: "You may make up to two of your lands adjacent at a time."
-- (approximation: chosen once, at the start of the Fast phase, and holding
--  until the end of the turn. "change ... once between Actions" would need
--  retracting an adjacency; here a way can only end with its episode.)
#acc finder-land : spirit land
spirit:special S open-the-ways, has-presence S L, land L / finder-land S L
#acc way-option : spirit land land
open-ways S, finder-land S A, finder-land S B, neq A B / way-option S A B
open-ways S / way-option S none none
fast-phase, spirit:special S open-the-ways, ~open-ways S
open-ways S
  ?[rng] A B
  !(way-option S A B)
  ~way S A B
turn, >way S A B, is A X, is B Y, neq X Y
  ^adjacent X Y
  ^adjacent Y X

-- scenario: Finder has Presence in l1 and l3 (not adjacent) and 1 Energy,
-- and plays a Fast Power "Destroy 1 Explorer" on l1.
setup
  +spirit finder, +spirit:special finder responsibilities-to-the-dead
  +spirit:special finder open-the-ways
  +presence-of finder f1, +presence-of finder f2, +presence-of finder f3
  +power waylay, +power:speed waylay fast, +power:destroys waylay explorer
  +power-target finder waylay l1
scenario, ~>move f1 l1, ~>move f2 l3, ~>move f3 l3, +energy-change finder 1
scenario, +played finder waylay
report, energy finder E, ^energy-report E
report, presence-of finder P, at P L, ^finder-presence P L
