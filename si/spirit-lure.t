-- Lure of the Deep Wilderness (Jagged Earth). Special rules (wiki, verbatim):
--  HOME OF THE ISLAND'S HEART: "Your [Presence] may only be added/moved to
--   lands that are Inland."
--  ENTHRALL THE FOREIGN EXPLORERS: "For each of your [Presence] in a land,
--   up to 2 [Explorer] do not participate in Ravage."

#js-def mul +A +B -C { yield [A * B] }

-- BASE-EXT (rulebook, not this spirit): Inland is printed on the board
-- (a land not adjacent to an Ocean). Turn has no negation in acc bodies, so
-- it is board data rather than derived from `coastal`.
setup, +inland l2, +inland l3

-- HOME OF THE ISLAND'S HEART
-- "Your Presence may only be added/moved to lands that are Inland."
-- (narrows the base add-presence choice with an extra constraint; "moved"
-- has no base verb for Presence movement yet, so only "added" is covered)
add-presence S, spirit:special S home-of-the-islands-heart, (presence-choice S C), !(inland C)

-- ENTHRALL THE FOREIGN EXPLORERS
-- "For each of your Presence in a land, up to 2 Explorer do not participate
--  in Ravage."
-- Explorers are interchangeable, so instead of choosing which ones sit out,
-- suppress every Explorer's damage and add back the damage of those that
-- still participate: max(0, Explorers - 2 * Presence).
#acc enthralled-land : spirit land
spirit:special S enthrall-the-foreign-explorers, presence-count S L N, land L / enthralled-land S L
invaders-deal-damage L, enthralled-land S L, at P L, piece:kind P explorer, { deals L P D => }
invaders-deal-damage L, enthralled-land S L, presence-count S L N,
  land:count L explorer E, mul N 2 Out, minus E Out R0, pos R0 R,
  kind:damage explorer D, mul R D X
  / invader-damage L X

-- scenario: Lure has 1 Presence in l1 (2 Explorers there: both sit out) and
-- grows; Home of the Island's Heart forbids l1 (coastal) and sea.
setup
  +spirit lure, +spirit:special lure home-of-the-islands-heart
  +spirit:special lure enthrall-the-foreign-explorers
  +presence-of lure u1, +presence-of lure u2
scenario, ~>move u1 l1, ~>add-piece l1 explorer, ~move u2 supply
spirit-phase, ~add-presence lure
report, presence-of lure P, at P L, ^lure-presence P L
