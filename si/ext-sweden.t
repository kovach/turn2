-- Sweden, level 1, Heavy Mining: "If the Invaders do at least 6 Damage to the
-- land during Ravage, add an extra Blight. The extra Blight does not destroy
-- Presence or cause cascades."
damage-land L D, ge D 6, ~extra-blight L
extra-blight L, ~add-blight L
extra-blight L, { destroy-presence _ => }
extra-blight L, { cascade _ => }

-- scenario: a second city in l2 brings its ravage damage to 8; a presence there
setup, +presence-of river p2
scenario, ~>add-piece l2 city, ~move p2 l2
