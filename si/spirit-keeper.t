-- Keeper of the Forbidden Wilds (Branch & Claw). Special rule (wiki, verbatim):
--  FORBIDDEN GROUND: "After you create a [Sacred Site], Push all [Dahan]
--   from that land. Dahan Events never move [Dahan] to your [Sacred Site],
--   but Powers can do so."

-- BASE-EXT: presence-count has no row for a land without Presence; give it
-- a 0 row so "fewer than 2 Presence" (= not a Sacred Site) is expressible
-- without negation. (Adding 0 to an @sum is additive.)
land L, spirit S / presence-count S L 0
#acc not-sacred-site : spirit land
presence-count S L N, land L, lt N 2 / not-sacred-site S L

-- BASE-EXT: Dahan Events push with the actor `event` (core's push is keyed
-- by the pusher; an Event is not a Spirit, so it uses its own actor term).
setup, +spirit event

-- FORBIDDEN GROUND
-- "After you create a Sacred Site, ..."  The Presence that arrives is the
-- one that makes the count go 1 -> 2: note that at the start of the move,
-- then act after the move is over.
move P L, presence-of S P, spirit:special S forbidden-ground, land L, presence-count S L 1
  +creates-sacred-site S L P
-- The trigger resolves inside the phase the move happened in (anchoring on
-- `turn` instead leaves it unordered relative to the following phases), so
-- there is one rule per phase. (A generic `^phase` window no longer works:
-- a `^` view starts at its own moment inside the phase, incomparable with
-- the move.)
spirit-phase, creates-sacred-site S L P, >move P L, ^sacred-site-created S L P, ~forbidden-ground S L
fast-phase, creates-sacred-site S L P, >move P L, ^sacred-site-created S L P, ~forbidden-ground S L
invader-phase, creates-sacred-site S L P, >move P L, ^sacred-site-created S L P, ~forbidden-ground S L
slow-phase, creates-sacred-site S L P, >move P L, ^sacred-site-created S L P, ~forbidden-ground S L
-- "... Push all Dahan from that land."
forbidden-ground S L, at D L, piece:kind D dahan, ~push S D L

-- "Dahan Events never move Dahan to your Sacred Site, but Powers can do so."
-- (narrows the Event's push choice; Powers' pushes are untouched)
push event D From, piece:kind D dahan, spirit:special K forbidden-ground,
  (push-to D C), !(not-sacred-site K C)

-- scenario: Keeper has 1 Presence in l3 and adds a 2nd there (a Sacred
-- Site), so l3's Dahan are pushed out. Then a Dahan Event pushes a Dahan
-- from l2: l3 is Keeper's Sacred Site, so it can only go to l1.
setup
  +spirit keeper, +spirit:special keeper forbidden-ground
  +presence-of keeper k1, +presence-of keeper k2
scenario, ~>move k1 l3, ~>add-piece l3 dahan, ~move k2 supply
spirit-phase, add-presence-target keeper l3
spirit-phase, ^add-presence-target keeper l3, ~add-presence keeper
add-presence S, add-presence-target S T, (presence-choice S C), !(presence-dest S C, eq-land C T)
setup, +eq-land l3 l3
fast-phase, at D l2, piece:kind D dahan, ~push event D l2
report, at D L, piece:kind D dahan, ^dahan-at D L
