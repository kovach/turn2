-- Many Minds Move as One (Branch & Claw). Special rules, as I remember the
-- panel (FAQ confirms the gist):
--  "A Joining of Swarms and Flocks: Your Sacred Sites may also count as
--   Beasts. If something changes a Beasts that is also your Sacred Site, it
--   affects 2 of your Presence there."
--  "Fly Fast as Thought: When you Gather or Push Beasts, they may come from
--   or go to lands up to 2 distant."

-- Joining: a Sacred Site contributes one Beasts piece, the pair (swarm S L)
-- (FAQ, JE p29: one pair of Presence per Sacred Site)
sacred-site S L, spirit:special S joining / beasts-at (swarm S L) L
-- "it affects 2 of your Presence there": moving / destroying the swarm
-- moves / destroys two Presence instead.
game, { move (swarm S L) To => ~move-pair S L To }
game, { destroy (swarm S L) => ~destroy-pair S L }
move-pair S L To
  ?[rng] A
  !(presence-of S A, at A L)
  ~pair-first S L To A
pair-first S L To A, is A X
  ~>move X To
  ?[rng] B
  !(presence-of S B, at B L)
  ~pair-second B To
pair-second B To, is B X, ~move X To
destroy-pair S L, ~move-pair S L destroyed

-- Fly Fast as Thought: two steps of adjacency for Beasts this Spirit pushes
#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }
push S B From, spirit:special S fly-fast, beasts-at B From,
  adjacent From M, adjacent M To, neq From To, land-for power To
  / push-dest S B From To

-- scenario: Many Minds has a Sacred Site (2 Presence) in l3 and pushes a
-- Beasts from it with a Power
setup
  +spirit mm, +spirit:special mm joining, +spirit:special mm fly-fast
  +presence-of mm m1, +presence-of mm m2, +presence-of mm m3
scenario, ~>move m1 l3, ~>move m2 l3, ~move m3 l3
fast-phase, beasts-at B l3, ~push mm B l3
report, beasts-at B L, ^beasts-report B L
report, presence-of mm P, at P L, ^mm-presence P L
