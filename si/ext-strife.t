-- Branch & Claw / JE p7, Strife: "Whenever Invaders Damage the Dahan and/or
-- the land, each attacking Invader with any number of Strife deals exactly 0
-- Damage and Removes one Strife."
-- A Strife token sits "beneath that Invader": its location is the invader.
#acc has-strife : e
at S P, piece:kind S strife / has-strife P
invaders-deal-damage L, has-strife P, { deals L P D => ~remove-one P strife }

-- scenario: strife on l2's city
setup, +kind strife
scenario, at P l2, piece:kind P city, ~add-piece P strife
