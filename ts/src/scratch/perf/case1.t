-- display: si-display.js
-- gas: 20000 600000
-- Spirit Island, solo: Board A, River Surges in Sunlight.
-- Rules follow the base rulebook (page numbers below) and the Branch & Claw
-- Disease token printed on Board A. Formalization notes:
-- ts/src/scratch/si/report (published report "Spirit Island in Turn").
--
-- Every decision a player makes is a `?` choice named by `~ask <kind> C ...`;
-- the display finds the `ask` tuple for each pending choice to know what to
-- draw. Decisions the rulebook leaves to "the game" (which identical piece,
-- order of Ravage) are `?[rng]`.

#js-def plus +A +B -C { yield [A + B] }
#js-def minus +A +B -C { yield [A - B] }
#js-def half +A -C { yield [Math.floor(A / 2)] }
#js-def quarter +A -C { yield [Math.floor(A / 4)] }
#js-def pos +A -C { yield [Math.max(0, A)] }
#js-def neg +A -C { yield [-A] }
-- neq is only for symbols: a fresh object passed to a js relation is decoded
-- with its whole derivation history (exponential), so pieces never go here
#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- ================================================================ pieces
-- Every piece and card is an object with a location; nothing is retracted.
#acc at : e (@last location)
move It To, +moved It To
moved It To / at It To

add-piece L K, +piece P, +piece:kind P K, ~move P L

#acc count : location kind @sum
at P L, land L, piece:kind P K / count L K 1
-- zero rows only where a rule compares Town and City counts
build L, building-kind K / count L K 0
resolve S P L, building-kind K / count L K 0

#acc has-invaders : land
at P L, piece:kind P K, invader K / has-invaders L
#acc invader-at : e land
assign-damage L _, at P L, piece:kind P K, invader K / invader-at P L
auto-damage L _, at P L, piece:kind P K, invader K / invader-at P L

-- the turn number, readable anywhere
#acc now : (@last n)
turn N / now N

-- ================================================================ the board
-- Board A (wiki "Island Boards"): terrain, adjacency, coast, setup icons.
board
  +land a1, +land:terrain a1 mountain, +coastal a1
  +land a2, +land:terrain a2 wetland, +coastal a2
  +land a3, +land:terrain a3 jungle, +coastal a3
  +land a4, +land:terrain a4 sands, +inland a4
  +land a5, +land:terrain a5 wetland, +inland a5
  +land a6, +land:terrain a6 mountain, +inland a6
  +land a7, +land:terrain a7 sands, +inland a7
  +land a8, +land:terrain a8 jungle, +inland a8
  +ocean sea
  +edge a1 a2, +edge a1 a4, +edge a1 a5, +edge a1 a6
  +edge a2 a3, +edge a2 a4
  +edge a3 a4
  +edge a4 a5
  +edge a5 a6, +edge a5 a7, +edge a5 a8
  +edge a6 a8
  +edge a7 a8
  +edge sea a1, +edge sea a2, +edge sea a3
board, edge A B, +adjacent A B, +adjacent B A

-- p30 Range: "how many lands away". Board A adjacency, by breadth-first
-- search (a js relation is timeless, so it costs nothing per moment).
#js-def land-dist +A +B -D {
  const adj = { a1: ["a2","a4","a5","a6"], a2: ["a1","a3","a4"], a3: ["a2","a4"],
    a4: ["a1","a2","a3","a5"], a5: ["a1","a4","a6","a7","a8"], a6: ["a1","a5","a8"],
    a7: ["a5","a8"], a8: ["a5","a6","a7"] };
  const seen = { [A]: 0 }; const q = [A];
  while (q.length) { const x = q.shift(); for (const y of adj[x] || []) if (!(y in seen)) { seen[y] = seen[x] + 1; q.push(y); } }
  if (B in seen) yield [seen[B]];
}

-- ================================================================ setup
setup
  ~>board
  ~>kinds
  ~>populate
  ~>spirit-setup
  ~>invader-deck
  ~>match-cards
  ~fear-deck

kinds
  +kind explorer, +kind town, +kind city, +kind dahan, +kind blight
  +kind presence, +kind disease, +kind beasts
  +invader explorer, +invader town, +invader city
  +health explorer 1, +health town 2, +health city 3, +health dahan 2
  +kind:damage explorer 1, +kind:damage town 2, +kind:damage city 3
  +building-kind town, +building-kind city
  +kind-in explorer-town explorer, +kind-in explorer-town town, +kind-in dahan-only dahan
  +blight-card-start 3

-- p6 "Populate the Island Boards with Invaders, Dahan, and Blight ... as
-- indicated by the icons in each land." (Board A, plus its B&C tokens)
populate
  ~>add-piece a2 city
  ~>add-piece a2 dahan
  ~>add-piece a3 dahan
  ~>add-piece a3 dahan
  ~>add-piece a4 blight
  ~>add-piece a6 dahan
  ~>add-piece a7 dahan
  ~>add-piece a7 dahan
  ~>add-piece a8 town
  ~>add-piece a1 beasts
  ~add-piece a2 disease

-- p6 Making the Invader Deck: "3 Stage I cards on top, then 4 Stage II
-- cards, then 5 Stage III cards on the bottom." (order fixed here)
invader-deck
  +invader-card 0 c-jungle, +card:terrain c-jungle jungle, +card:stage c-jungle 1
  +invader-card 1 c-wetland, +card:terrain c-wetland wetland, +card:stage c-wetland 1
  +invader-card 2 c-sands, +card:terrain c-sands sands, +card:stage c-sands 1
  +invader-card 3 c-mountain2, +card:terrain c-mountain2 mountain, +card:stage c-mountain2 2
  +invader-card 4 c-coastal, +card:coastal c-coastal, +card:stage c-coastal 2
  +invader-card 5 c-jungle2, +card:terrain c-jungle2 jungle, +card:stage c-jungle2 2
  +invader-card 6 c-wetland2, +card:terrain c-wetland2 wetland, +card:stage c-wetland2 2
  +invader-card 7 c-mountain-jungle, +card:terrain c-mountain-jungle mountain, +card:terrain c-mountain-jungle jungle, +card:stage c-mountain-jungle 3
  +invader-card 8 c-sands-wetland, +card:terrain c-sands-wetland sands, +card:terrain c-sands-wetland wetland, +card:stage c-sands-wetland 3
  +invader-card 9 c-jungle-sands, +card:terrain c-jungle-sands jungle, +card:terrain c-jungle-sands sands, +card:stage c-jungle-sands 3
  +invader-card 10 c-mountain-wetland, +card:terrain c-mountain-wetland mountain, +card:terrain c-mountain-wetland wetland, +card:stage c-mountain-wetland 3
  +invader-card 11 c-mountain-sands, +card:terrain c-mountain-sands mountain, +card:terrain c-mountain-sands sands, +card:stage c-mountain-sands 3

-- which lands a card shows: its terrains, or (Stage II) every Coastal land
match-cards, card:terrain C T, land:terrain L T, +card-matches C L
match-cards, card:coastal C, coastal L, +card-matches C L

-- ================================================================ blight
-- p6 "Place the shown amount of Blight onto the [Blight] card": 2 per
-- player + 1.  p15 "If you run out of Blight on the card ... lose".
#acc blight-on-card : @sum
blight-card-start N / blight-on-card N
blight-taken B / blight-on-card -1
blight-returned B / blight-on-card 1

#acc has-blight : land
at B L, piece:kind B blight, land L / has-blight L

-- p15 "whenever you add Blight to a land ... two bad things happen"
add-blight L, blight-on-card N, gt N 0
  ~>add-piece L blight
  ~>take-blight L
  ~>blight-presence L
  ~blight-cascade L
take-blight L, +blight-taken L
-- p15 "If you run out of Blight on the card, follow its instructions -
-- either 'lose' or 'flip the card over'": the Healthy side flips to
-- Blighted Island (simplified: 5 more Blight, no other effect); running
-- out again loses.
#acc flipped : island
did-flip _ / flipped island
add-blight L, blight-on-card 0, not flipped island
  ~>flip-blight-card
  ~add-blight L
flip-blight-card, +blight-card-start 5, +did-flip, +blighted-island
add-blight L, blight-on-card 0, flipped island, ~lose blight

-- "1. Destroy Presence: In that land, destroy one Presence from each
--     Spirit with Presence there."
blight-presence L, spirit S, presence-count S L N, gt N 0
  ?[rng] P
  !(presence-of S P, at P L)
  ~destroy-presence-choice P
destroy-presence-choice P, is P X, ~move X destroyed

-- "2. Cascade: If the land already had any Blight, also add one Blight to
--     an adjacent land."  The player chooses where.
blight-cascade L, count L blight B, gt B 1
  ?C
  !(adjacent L C, land C)
  ~ask cascade C L
ask cascade C L, is C X, ~add-blight X

-- ================================================================ fear
-- p12 Fear: "Each time the Fear Pool empties, a Fear Card is earned."
-- (4 Fear per Fear Card with one player)
#acc fear-generated : @sum
game / fear-generated 0
fear-from F N / fear-generated N
#acc fear-cards-earned : @sum
fear-generated F, quarter F E / fear-cards-earned E
#acc fear-cards-resolved : @sum
game / fear-cards-resolved 0
fear-resolved C / fear-cards-resolved 1

gain-fear N, +fear-from gain N

-- p15 "Whenever a Town is destroyed, it generates 1 Fear. Whenever a City
--      is destroyed, it generates 2 Fear."
destroy P, ~move P destroyed
destroy P, piece:kind P town, +fear-from P 1
destroy P, piece:kind P city, +fear-from P 2

fear-deck
  +fear-card 0 avoid-the-dahan
  +fear-card 1 wary-of-the-interior
  +fear-card 2 emigration-accelerates
  +fear-card 3 dahan-on-their-guard
  +fear-card 4 avoid-the-dahan-2

-- ================================================================ damage
-- p15 "To destroy an Invader, you must deal Damage that meets or exceeds
-- its Health in one turn."  Damage is keyed by turn, so it clears when
-- Time Passes.
#acc damage : e @sum
turn T, dmg P N T / damage P N

hurt P N, now T, +dmg P N T
damage-piece P N
  ~>hurt P N
  ~check-destroyed P
check-destroyed P, damage P D, piece:kind P K, health K H, ge D H, at P L, land L, ~destroy P

-- "Damage ... divided among them however you choose": one point at a time
assign-damage L N, gt N 0, has-invaders L
  ?V
  !(invader-at V L)
  ~ask damage V L N
ask damage V L N, is V X
  ~>damage-piece X 1
  minus N 1 N1
  ~assign-damage L N1

-- the same, decided by the game (Dahan counterattack)
auto-damage L N, gt N 0, has-invaders L
  ?[rng] V
  !(invader-at V L)
  ~auto-pick V L N
auto-pick V L N, is V X
  ~>damage-piece X 1
  minus N 1 N1
  ~auto-damage L N1

-- p18 Defend: "reduce the total amount of Damage they do by N. If multiple
-- Defend effects are used in one land, they add together."
#acc defend-total : land @sum
invaders-deal-damage L / defend-total L 0
turn T, defend L N T / defend-total L N
add-defend L N, now T, +defend L N T

-- ================================================================ turns
~game
game
  ~>setup
  ~>initial-explore
  ~turn 1

#acc over : outcome
lost _ / over lost
won _ / over won
lose Why, +lost Why
win Why, +won Why

-- the next turn follows the last one, unless the game is over
game, >turn N, not over _, plus N 1 M, ~turn M

-- p8 "Each turn has the following phases"
turn N
  ~>spirit-phase N
  ~>fast-phase N
  ~>invader-phase N
  ~>slow-phase N
  ~time-passes N

-- p6 Invaders' Starting Action: "Reveal the top card of the Invader Deck.
-- The Invaders Explore in that land type."
initial-explore, >exploring 0, invader-card 0 C, card-matches C L, explorable L, ~explore L

-- ================================================================ invader phase
-- p9 "The Invader phase has the following parts: 1. Blighted Island
-- 2. Fear 3. Invader Actions (Ravage, Build, Explore) 4. Advance"
invader-phase N
  ~>fear-phase N
  ~>ravage-step N
  ~>build-step N
  ~explore-step N

-- p9 Fear: "resolve the cards one at a time in the order they were earned"
fear-phase N, ~resolve-fear N
resolve-fear N, fear-cards-earned E, fear-cards-resolved R, lt R E, fear-card R C
  ~>fear-effect N C
  ~>mark-fear-resolved C
  ~resolve-fear N
mark-fear-resolved C, +fear-resolved C

-- Ravage: the card two turns back.  Build: one turn back.  Explore: this turn.
#acc card-at : n step card
turn N, minus N 2 I, invader-card I C / card-at N ravage C
turn N, minus N 1 I, invader-card I C / card-at N build C
turn N, invader-card N C / card-at N explore C

-- p9 Ravage: "Invaders Ravage in each land of the shown type only", one
-- land at a time (order by the game).
#acc ravage-target : n land
card-at N ravage C, card-matches C L, has-invaders L / ravage-target N L
#acc ravaged : land n
did-ravage L N / ravaged L N
ravage-step N, ~ravage-next N
ravage-next N
  ?[rng] L
  !(ravage-target N L, not ravaged L N)
  ~ravage-chosen N L
ravage-chosen N C, is C L
  ~>ravage L
  +did-ravage L N
  ~ravage-next N

-- "First, Invaders deal Damage to the land and Dahan. Then, any surviving
-- Dahan fight back."
ravage L
  ~>invaders-deal-damage L
  ~dahan-fight-back L

-- "Invaders deal Damage: 1 per Explorer, 2 per Town, and 3 per City."
-- (the per-piece views are derived inside `tally`, the step the damage total
--  waits for, so each holds at `tally`'s end where the total is read)
tally L, at P L, piece:kind P K, kind:damage K D, ^deals L P D
#acc invader-damage : land @sum
invaders-deal-damage L / invader-damage L 0
deals L P D / invader-damage L D
invaders-deal-damage L
  ~>tally L
  invader-damage L Raw, defend-total L Def, minus Raw Def D0, pos D0 D
  ~>damage-dahan L D
  ~damage-land L D
tally L, ^tallied L

-- "1. If 2 or more Damage is dealt, add a Blight to the land."
damage-land L D, ge D 2, ~add-blight L
-- "2. Every 2 points of Damage destroys one Dahan."
damage-dahan L D, half D N, ~kill-dahan L N
kill-dahan L N, gt N 0, count L dahan C, gt C 0
  ?[rng] V
  !(at V L, piece:kind V dahan)
  ~kill-dahan-pick L N V
kill-dahan-pick L N V, is V X
  ~>destroy X
  minus N 1 N1
  ~kill-dahan L N1

-- "Each Dahan deals 2 Damage to the Invaders."
dahan-fight-back L, count L dahan C, gt C 0, plus C C D, ~auto-damage L D

-- p10 Build: "Wherever there are Invaders in the specified type of land,
-- they add either one City or one Town"
build-step N, card-at N build C, card-matches C L, has-invaders L, ~build L
-- "If the land has more Towns than Cities, add a City."
build L, count L town Nt, count L city Nc, gt Nt Nc, ~add-piece L city
-- "In all other cases, add a Town."
build L, count L town Nt, count L city Nc, le Nt Nc, ~add-piece L town

-- Branch & Claw, Disease (Board A starts with one in land 2):
-- "When Invaders would Build in a land with Disease, instead Remove one
-- Disease from that land."
#acc has-disease : land
at P L, piece:kind P disease, land L / has-disease L
build-step N, has-disease L, { build L => ~remove-one L disease }
remove-one L K, ?[rng] P, !(at P L, piece:kind P K), ~remove-pick P
remove-pick P, is P X, ~move X supply

-- p10 Explore: "Add an Explorer to every land of the shown type which
-- either: Contains a Town or City; or Is adjacent to a Town, City, or Ocean."
-- (computed only while exploring; `exploring N` is keyed by turn because
--  `>exploring` would otherwise match every earlier turn's)
#acc explore-source : land
exploring _, at P L, piece:kind P town, land L / explore-source L
exploring _, at P L, piece:kind P city, land L / explore-source L
exploring _, ocean L / explore-source L
#acc explorable : land
exploring _, land L, explore-source L / explorable L
exploring _, land L, adjacent L L2, explore-source L2 / explorable L
explore-step N, ^exploring N
initial-explore, ^exploring 0
explore-step N, >exploring N, card-at N explore C, card-matches C L, explorable L, ~explore L
explore L, ~add-piece L explorer
-- "If there is no card to turn up, time has run out and you lose."
explore-step N, gt N 11, ~lose time

-- ================================================================ fear cards (Terror Level 1)
-- Avoid the Dahan: "Invaders do not Explore into lands with at least 2 Dahan."
fear-effect N avoid-the-dahan, +fear-active avoid-the-dahan N
fear-effect N avoid-the-dahan-2, +fear-active avoid-the-dahan N
explore-step N, fear-active avoid-the-dahan N, count L dahan D, ge D 2, { explore L => }

-- Wary of the Interior: "Each player removes 1 Explorer from an Inland land."
fear-effect N wary-of-the-interior
  ?V
  !(at V L, inland L, piece:kind V explorer)
  ~ask fear-remove V wary-of-the-interior
-- Emigration Accelerates: "Each player removes 1 Explorer from a Coastal land."
fear-effect N emigration-accelerates
  ?V
  !(at V L, coastal L, piece:kind V explorer)
  ~ask fear-remove V emigration-accelerates
ask fear-remove V C, is V X, ~move X supply

-- Dahan on their Guard: "In each land, Defend 1 per Dahan."
fear-effect N dahan-on-their-guard, land L, count L dahan D, gt D 0, ~add-defend L D

-- ================================================================ victory and defeat
-- p12 Terror Level 1: "No Invaders on the island."  Fear deck empty: win.
#acc invaders-on-island : @sum
time-passes N / invaders-on-island 0
time-passes N, at P L, land L, piece:kind P K, invader K / invaders-on-island 1
time-passes N, invaders-on-island 0, ~win no-invaders
time-passes N, fear-cards-resolved 5, ~win fear
-- p12 "if any Spirit is destroyed completely"
time-passes N, spirit S, presence-on-island S 0, ~lose presence
#acc presence-on-island : spirit @sum
time-passes N, spirit S / presence-on-island S 0
presence-of S P, at P L, land L / presence-on-island S 1

-- ================================================================ River Surges in Sunlight
spirit-setup
  +spirit river
  +spirit:special river rivers-domain
  +track energy, +track cards
  +track-size energy 6, +track-size cards 6
  -- Presence tracks (wiki panel). Value shown once U spaces are uncovered.
  +slot-value energy 0 1, +slot-value energy 1 2, +slot-value energy 2 2, +slot-value energy 3 3
  +slot-value energy 4 4, +slot-value energy 5 4, +slot-value energy 6 5
  +slot-value cards 0 1, +slot-value cards 1 2, +slot-value cards 2 2, +slot-value cards 3 3
  +slot-value cards 4 3, +slot-value cards 5 4, +slot-value cards 6 5
  ~>presence-pieces
  ~>unique-cards
  ~>minor-deck
  -- Setup: "Put 1 Presence on your starting board in the highest-numbered Wetlands."
  ~start-presence

presence-pieces
  +presence-of river pe1, +presence-of river pe2, +presence-of river pe3
  +presence-of river pe4, +presence-of river pe5, +presence-of river pe6
  +presence-of river pc1, +presence-of river pc2, +presence-of river pc3
  +presence-of river pc4, +presence-of river pc5, +presence-of river pc6
  +presence-of river p0
  +piece:kind pe1 presence, +piece:kind pe2 presence, +piece:kind pe3 presence
  +piece:kind pe4 presence, +piece:kind pe5 presence, +piece:kind pe6 presence
  +piece:kind pc1 presence, +piece:kind pc2 presence, +piece:kind pc3 presence
  +piece:kind pc4 presence, +piece:kind pc5 presence, +piece:kind pc6 presence
  +piece:kind p0 presence
  ~>move pe1 (slot river energy 1)
  ~>move pe2 (slot river energy 2)
  ~>move pe3 (slot river energy 3)
  ~>move pe4 (slot river energy 4)
  ~>move pe5 (slot river energy 5)
  ~>move pe6 (slot river energy 6)
  ~>move pc1 (slot river cards 1)
  ~>move pc2 (slot river cards 2)
  ~>move pc3 (slot river cards 3)
  ~>move pc4 (slot river cards 4)
  ~>move pc5 (slot river cards 5)
  ~move pc6 (slot river cards 6)
start-presence, ~move p0 a5

-- Unique Power Cards (SICK card catalog).
unique-cards
  +card flash-floods, +power:cost flash-floods 2, +power:speed flash-floods fast
  +power:range flash-floods 1, +power:source flash-floods presence, +power:target flash-floods any-land
  +power:element flash-floods sun, +power:element flash-floods water
  +card wash-away, +power:cost wash-away 1, +power:speed wash-away slow
  +power:range wash-away 1, +power:source wash-away presence, +power:target wash-away any-land
  +power:element wash-away water, +power:element wash-away earth
  +card boon-of-vigor, +power:cost boon-of-vigor 0, +power:speed boon-of-vigor fast
  +power:target boon-of-vigor spirit
  +power:element boon-of-vigor sun, +power:element boon-of-vigor water, +power:element boon-of-vigor plant
  +card rivers-bounty, +power:cost rivers-bounty 0, +power:speed rivers-bounty slow
  +power:range rivers-bounty 0, +power:source rivers-bounty presence, +power:target rivers-bounty any-land
  +power:element rivers-bounty sun, +power:element rivers-bounty water, +power:element rivers-bounty animal
  ~>move flash-floods (hand river)
  ~>move wash-away (hand river)
  ~>move boon-of-vigor (hand river)
  ~move rivers-bounty (hand river)

-- A small Minor Power deck (order fixed).
minor-deck
  +card uncanny-melting, +power:cost uncanny-melting 1, +power:speed uncanny-melting slow
  +power:range uncanny-melting 1, +power:source uncanny-melting sacred-site, +power:target uncanny-melting any-land
  +power:element uncanny-melting sun, +power:element uncanny-melting moon, +power:element uncanny-melting water
  +card rain-of-blood, +power:cost rain-of-blood 0, +power:speed rain-of-blood slow
  +power:range rain-of-blood 1, +power:source rain-of-blood sacred-site, +power:target rain-of-blood invader-land
  +power:element rain-of-blood air, +power:element rain-of-blood water, +power:element rain-of-blood animal
  +card encompassing-ward, +power:cost encompassing-ward 1, +power:speed encompassing-ward fast
  +power:target encompassing-ward spirit
  +power:element encompassing-ward sun, +power:element encompassing-ward water, +power:element encompassing-ward earth
  +card devouring-ants, +power:cost devouring-ants 1, +power:speed devouring-ants slow
  +power:range devouring-ants 1, +power:source devouring-ants sacred-site, +power:target devouring-ants any-land
  +power:element devouring-ants sun, +power:element devouring-ants earth, +power:element devouring-ants animal
  +minor-index uncanny-melting 1, +minor-index rain-of-blood 2
  +minor-index encompassing-ward 3, +minor-index devouring-ants 4
  ~>move uncanny-melting minor-deck
  ~>move rain-of-blood minor-deck
  ~>move encompassing-ward minor-deck
  ~move devouring-ants minor-deck

-- ---------------------------------------------------------------- presence
#acc presence-count : spirit land @sum
presence-of S P, at P L, land L / presence-count S L 1
#acc presence-at : spirit land
presence-of S P, at P L, land L / presence-at S L
-- p13 "A Sacred Site is a land where you have 2 or more Presence."
#acc sacred-site : spirit land
presence-count S L N, ge N 2 / sacred-site S L
-- River's Domain: "Your Presence in Wetlands counts as Sacred Site."
spirit:special S rivers-domain, presence-at S L, land:terrain L wetland / sacred-site S L

-- p8 Presence tracks: "Energy equal to the highest uncovered number"
#acc track-left : spirit track @sum
spirit S, track Tr / track-left S Tr 0
presence-of S P, at P (slot S Tr I) / track-left S Tr 1
#acc income : spirit track @sum
track-left S Tr Left, track-size Tr Size, minus Size Left U, slot-value Tr U V / income S Tr V
-- the next Presence a track gives up is its leftmost covered space
#acc track-top : spirit track e
track-left S Tr Left, gt Left 0, track-size Tr Size, minus Size Left U, plus U 1 I,
  presence-of S P, at P (slot S Tr I)
  / track-top S Tr P

-- Add a Presence (range R): take it from a track, put it within range R
add-presence S R
  ?T
  !(track-top S T _)
  ~ask track T S R
ask track T S R, is T Tr, ~place-presence S Tr R
#acc presence-dest : spirit land n
add-presence S R, presence-at S L0, land L, land-dist L0 L D, le D R / presence-dest S L R
place-presence S Tr R, track-top S Tr P
  ?L
  !(presence-dest S L R)
  ~ask place L S P
ask place L S P, is L X, ~move P X

-- ---------------------------------------------------------------- energy, cards
#acc energy : spirit @sum
spirit S / energy S 0
energy-delta S N / energy S N
gain-energy-amt S N, +energy-delta S N
pay S K, neg K NK, +energy-delta S NK

#acc elements : spirit element @sum
turn T, played S C T, power:element C E / elements S E 1

reclaim S, at C (discard S), ~move C (hand S)

-- p18 Gaining Power Cards (simplified): draw the top two Minors, keep one,
-- discard the other.  Draw k takes deck cards 2k+1 and 2k+2.
#acc minor-draws : @sum
minor-drawn S / minor-draws 1
#acc in-top2 : card
gain-card S, minor-draws K, plus K K K2, plus K2 2 Lim, at C minor-deck, minor-index C I, le I Lim / in-top2 C
gain-card S
  ?C
  !(in-top2 C)
  ~ask gain-card C S
ask gain-card C S, is C X
  ~>move X (hand S)
  ~>discard-other X
  +minor-drawn S
discard-other X, in-top2 Y, neq X Y, ~move Y minor-discard

-- ---------------------------------------------------------------- spirit phase
-- p8 "Each Spirit does three things, in the following order: 1. Grow
-- 2. Gain Energy 3. Play and Pay for Power Cards"
spirit-phase N, spirit S
  ~>growth S N
  ~>gain-energy S
  ~play-cards S N

-- River's Growth (pick one)
spirit-setup
  +growth-option river reclaim-card-energy
  +growth-option river two-presence
  +growth-option river card-presence
growth S N
  ?G
  !(growth-option S G)
  ~ask growth G S N
ask growth G S N, is G reclaim-card-energy
  ~>reclaim S
  ~>gain-card S
  ~gain-energy-amt S 1
ask growth G S N, is G two-presence
  ~>add-presence S 1
  ~add-presence S 1
ask growth G S N, is G card-presence
  ~>gain-card S
  ~add-presence S 2

gain-energy S, income S energy V, ~gain-energy-amt S V

#acc cards-played : spirit n @sum
play-cards S T / cards-played S T 0
turn T, played S C T / cards-played S T 1
#acc play-option : spirit e
play-cards S T, at C (hand S), power:cost C K, energy S E, ge E K,
  cards-played S T U, income S cards V, lt U V
  / play-option S C
play-cards S T / play-option S done
play-cards S T
  ?C
  !(play-option S C)
  ~ask play C S T
ask play C S T, is C X, power:cost X K
  ~>move X (played S)
  ~>pay S K
  ~>mark-played S X T
  ~play-cards S T
mark-played S X T, +played S X T

-- ---------------------------------------------------------------- powers
-- p8 Fast/Slow Power Phase: resolve in any order; you may skip a Power.
fast-phase N, spirit S, ~power-phase S N fast
slow-phase N, spirit S, ~power-phase S N slow

#acc power-ready : spirit e n speed
turn T, played S C T, power:speed C Sp / power-ready S C T Sp
power-phase S T Sp / power-ready S done T Sp
#acc used : e n
did-use C T / used C T
power-phase S T Sp
  ?C
  !(power-ready S C T Sp, not used C T)
  ~ask resolve C S T Sp
ask resolve C S T Sp, is C X, neq X done
  +did-use X T
  ~>use-power S X T
  ~power-phase S T Sp

-- targeting: a land within range of your Presence / Sacred Sites
#acc target-option : spirit e land
#acc source-land : spirit e land
use-power S P T, power:source P presence, presence-at S L0 / source-land S P L0
use-power S P T, power:source P sacred-site, sacred-site S L0 / source-land S P L0
use-power S P T, power:target P any-land, source-land S P L0, power:range P R,
  land L, land-dist L0 L D, le D R
  / target-option S P L
use-power S P T, power:target P invader-land, source-land S P L0, power:range P R,
  has-invaders L, land-dist L0 L D, le D R
  / target-option S P L
use-power S P T, power:target P any-land, ~choose-target S P T
use-power S P T, power:target P invader-land, ~choose-target S P T
choose-target S P T
  ?L
  !(target-option S P L)
  ~ask target L S P T
ask target L S P T, is L X, ~resolve S P X
use-power S P T, power:target P spirit, ~resolve S P S

-- Flash Floods: "1 Damage. If target land is Coastal, +1 Damage."
resolve S flash-floods L, inland L, ~assign-damage L 1
resolve S flash-floods L, coastal L, ~assign-damage L 2
-- Wash Away: "Push up to 3 Explorer / Town"
resolve S wash-away L, ~push-up-to L 3 explorer-town
-- Boon of Vigor: "If you target yourself, gain 1 Energy."
resolve S boon-of-vigor S, ~gain-energy-amt S 1
-- River's Bounty: "Gather up to 2 Dahan. If there are now at least 2 Dahan,
-- add 1 Dahan and gain 1 Energy."
resolve S rivers-bounty L
  ~>gather-up-to L 2 dahan-only
  ~bounty-check S L
bounty-check S L, count L dahan D, ge D 2
  ~>add-piece L dahan
  ~gain-energy-amt S 1
-- Uncanny Melting: "If Invaders are present, 1 Fear. If target land is
-- Sands / Wetland, remove 1 Blight"
resolve S uncanny-melting L, has-invaders L, ~gain-fear 1
resolve S uncanny-melting L, land:terrain L sands, ~remove-blight L
resolve S uncanny-melting L, land:terrain L wetland, ~remove-blight L
-- Rain of Blood: "2 Fear. If target land has at least 2 Town / City, +1 Fear."
resolve S rain-of-blood L, ~gain-fear 2
resolve S rain-of-blood L, count L town Tw, count L city Ci, plus Tw Ci B, ge B 2, ~gain-fear 1
-- Encompassing Ward: "Target Spirit provides Defend 2 in each of its lands."
resolve S encompassing-ward S, presence-at S L, ~add-defend L 2
-- Devouring Ants: "1 Fear. 1 Damage. Destroy 1 Dahan. If target land is
-- Jungle / Sands, +1 Damage."
resolve S devouring-ants L
  ~>gain-fear 1
  ~>ants-damage L
  ~kill-dahan L 1
ants-damage L, land:terrain L jungle, ~assign-damage L 2
ants-damage L, land:terrain L sands, ~assign-damage L 2
ants-damage L, land:terrain L mountain, ~assign-damage L 1
ants-damage L, land:terrain L wetland, ~assign-damage L 1

-- Innate: Massive Flooding (slow, Sacred Site range 1)
--   1 Sun 2 Water: Push 1 Explorer / Town.
--   2 Sun 3 Water: Instead, 2 Damage. Push up to 3 Explorer / Town.
spirit-setup
  +power:speed massive-flooding slow, +power:range massive-flooding 1
  +power:source massive-flooding sacred-site, +power:target massive-flooding any-land
  +innate massive-flooding
turn T, spirit S, elements S sun Su, elements S water W, ge Su 1, ge W 2
  / power-ready S massive-flooding T slow
resolve S massive-flooding L, elements S sun Su, elements S water W, ge Su 2, ge W 3
  ~>assign-damage L 2
  ~push-up-to L 3 explorer-town
resolve S massive-flooding L, elements S sun Su, elements S water W, lt Su 2, ~push-up-to L 1 explorer-town
resolve S massive-flooding L, elements S sun Su, elements S water W, ge Su 2, lt W 3, ~push-up-to L 1 explorer-town

-- remove Blight: back onto the Blight card (p18)
remove-blight L, has-blight L
  ?[rng] B
  !(at B L, piece:kind B blight)
  ~remove-blight-pick B
remove-blight-pick B, is B X
  ~>move X supply
  +blight-returned X

-- ---------------------------------------------------------------- push / gather
-- p30 Push: "move the piece to an adjacent land"; up to N, one at a time
#acc push-candidate : land kinds e
push-up-to L N Ks, at V L, piece:kind V K, kind-in Ks K / push-candidate L Ks V
push-up-to L N Ks / push-candidate L Ks done
push-up-to L N Ks, gt N 0
  ?V
  !(push-candidate L Ks V)
  ~ask push V L N Ks
ask push V L N Ks, is V X, piece X
  ~>push-piece X L
  minus N 1 N1
  ~push-up-to L N1 Ks
push-piece X L
  ?D
  !(adjacent L D, land D)
  ~ask push-to D X L
ask push-to D X L, is D Y, ~move X Y

-- p30 Gather: "move pieces from adjacent lands into the target land"
#acc gather-candidate : land kinds e
gather-up-to L N Ks, adjacent L A, land A, at V A, piece:kind V K, kind-in Ks K / gather-candidate L Ks V
gather-up-to L N Ks / gather-candidate L Ks done
gather-up-to L N Ks, gt N 0
  ?V
  !(gather-candidate L Ks V)
  ~ask gather V L N Ks
ask gather V L N Ks, is V X, piece X
  ~>move X L
  minus N 1 N1
  ~gather-up-to L N1 Ks

-- ---------------------------------------------------------------- time passes
-- p10 "Discard: Players discard all Power Cards played this turn ...
-- All Damage done during the turn goes away" (damage and Defend are keyed
-- by turn, so they lapse on their own)
time-passes N, spirit S, at C (played S), ~move C (discard S)

-- what the display shows when nothing is pending
game, >turn N, ^turn-ended N

-- ================================================================ choices
-- The web page records each choice by appending `is` rows below; delete
-- everything after this line to start a new game.

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*chain V19 V20 1 (*mom r117 2 (*chain V22 V23 V22 V23) l) top V19 V20 river)
  = V25 (*mom r146 3 V24 l)
  = V26 (*mom r146 3 V24 r)
  = V27 (*id r148 2 (*chain V25 V26 V25 V26 river 1) :G)
  ^ is V27 two-presence

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*chain V19 V20 1 (*mom r117 2 (*chain V22 V23 V22 V23) l) top V19 V20 river)
  = V25 (*mom r146 3 V24 l)
  = V26 (*mom r146 3 V24 r)
  = V27 (*id r148 2 (*chain V25 V26 V25 V26 river 1) :G)
  = V28 (*chain V25 V26 V25 V26 river 1 V27 V25 V26 V25 V26)
  = V29 (*mom r148 4 V28 l)
  = V30 (*mom r148 4 V28 r)
  = V31 (*chain V29 V30 V27 river 1 V25 top V29 V30)
  = V32 (*mom r150 3 V31 l)
  = V33 (*mom r150 3 V31 r)
  = V34 (*id r130 2 (*chain V32 V33 V32 V33 river 1) :T)
  ^ is V34 cards

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*chain V19 V20 1 (*mom r117 2 (*chain V22 V23 V22 V23) l) top V19 V20 river)
  = V25 (*mom r146 3 V24 l)
  = V26 (*mom r146 3 V24 r)
  = V27 (*id r148 2 (*chain V25 V26 V25 V26 river 1) :G)
  = V28 (*chain V25 V26 V25 V26 river 1 V27 V25 V26 V25 V26)
  = V29 (*mom r148 4 V28 l)
  = V30 (*mom r148 4 V28 r)
  = V31 (*chain V29 V30 V27 river 1 V25 top V29 V30)
  = V32 (*mom r150 3 V31 l)
  = V33 (*mom r150 3 V31 r)
  = V34 (*id r130 2 (*chain V32 V33 V32 V33 river 1) :T)
  = V35 (*chain V32 V33 V32 V33 river 1 V34 V32 V33 V32 V33)
  = V36 (*mom r130 4 V35 l)
  = V37 (*mom r130 4 V35 r)
  = V38 (*chain V36 V37 V34 river 1 V32 top V36 V37 cards)
  = V39 (*mom r131 3 V38 l)
  = V40 (*mom r131 3 V38 r)
  = V41 (*id r133 3 (*chain V39 V40 V39 V40 river cards 1 pc1) :L)
  ^ is V41 a4

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*chain V19 V20 1 (*mom r117 2 (*chain V22 V23 V22 V23) l) top V19 V20 river)
  = V25 (*mom r146 3 V24 l)
  = V26 (*mom r146 3 V24 r)
  = V27 (*id r148 2 (*chain V25 V26 V25 V26 river 1) :G)
  = V28 (*chain V25 V26 V25 V26 river 1 V27 V25 V26 V25 V26)
  = V29 (*mom r148 4 V28 l)
  = V30 (*mom r148 4 V28 r)
  = V31 (*chain V29 V30 V27 river 1 V25 top V29 V30)
  = V32 (*chain V29 V30 V27 river 1 V25 top V30 (*mom r150 3 V31 l) (*mom r150 3 V31 r))
  = V33 (*mom r150 4 V32 l)
  = V34 (*mom r150 4 V32 r)
  = V35 (*id r130 2 (*chain V33 V34 V33 V34 river 1) :T)
  ^ is V35 cards

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*chain V19 V20 1 (*mom r117 2 (*chain V22 V23 V22 V23) l) top V19 V20 river)
  = V25 (*mom r146 3 V24 l)
  = V26 (*mom r146 3 V24 r)
  = V27 (*id r148 2 (*chain V25 V26 V25 V26 river 1) :G)
  = V28 (*chain V25 V26 V25 V26 river 1 V27 V25 V26 V25 V26)
  = V29 (*mom r148 4 V28 l)
  = V30 (*mom r148 4 V28 r)
  = V31 (*chain V29 V30 V27 river 1 V25 top V29 V30)
  = V32 (*chain V29 V30 V27 river 1 V25 top V30 (*mom r150 3 V31 l) (*mom r150 3 V31 r))
  = V33 (*mom r150 4 V32 l)
  = V34 (*mom r150 4 V32 r)
  = V35 (*id r130 2 (*chain V33 V34 V33 V34 river 1) :T)
  = V36 (*chain V33 V34 V33 V34 river 1 V35 V33 V34 V33 V34)
  = V37 (*mom r130 4 V36 l)
  = V38 (*mom r130 4 V36 r)
  = V39 (*chain V37 V38 V35 river 1 V33 top V37 V38 cards)
  = V40 (*mom r131 3 V39 l)
  = V41 (*mom r131 3 V39 r)
  = V42 (*id r133 3 (*chain V40 V41 V40 V41 river cards 1 pc2) :L)
  ^ is V42 a2

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*mom r117 2 (*chain V22 V23 V22 V23) l)
  = V25 (*chain V19 V20 1 V24 top V19 V20 river)
  = V26 (*mom r146 3 V25 l)
  = V27 (*mom r146 3 V25 r)
  = V28 (*chain V19 V20 1 V24 top V20 river V26 V27)
  = V29 (*chain V19 V20 1 V24 top V20 river V26 V27 (*mom r146 4 V28 l) (*mom r146 4 V28 r))
  = V30 (*mom r146 5 V29 l)
  = V31 (*mom r146 5 V29 r)
  = V32 (*id r157 2 (*chain V30 V31 V30 V31 river 1) :C)
  ^ is V32 wash-away

= V1 (*chain)
  = V2 (*mom r54 1 V1 l)
  = V3 (*mom r54 1 V1 r)
  = V4 (*chain V2 V3 V2 V3)
  = V5 (*mom r55 2 V4 l)
  = V6 (*mom r55 2 V4 r)
  = V7 (*chain V5 V6 V5 V6)
  = V8 (*mom r13 2 V7 l)
  = V9 (*mom r13 2 V7 r)
  = V10 (*chain V2 V3 V3 V5 V6)
  = V11 (*chain V5 V6 V6 V8 V9)
  = V12 (*mom r13 3 V11 l)
  = V13 (*mom r13 3 V11 r)
  = V14 (*chain V2 V3 V3 V5 V6 (*mom r55 3 V10 l) (*mom r55 3 V10 r))
  = V15 (*mom r55 4 V14 l)
  = V16 (*mom r55 4 V14 r)
  = V17 (*chain V5 V6 V6 V8 V9 V12 V13)
  = V18 (*chain V15 V16 V15 V16 1)
  = V19 (*mom r61 2 V18 l)
  = V20 (*mom r61 2 V18 r)
  = V21 (*chain V5 V6 V6 V8 V9 V12 V13 (*mom r13 4 V17 l) (*mom r13 4 V17 r))
  = V22 (*mom r13 5 V21 l)
  = V23 (*mom r13 5 V21 r)
  = V24 (*mom r117 2 (*chain V22 V23 V22 V23) l)
  = V25 (*chain V19 V20 1 V24 top V19 V20 river)
  = V26 (*mom r146 3 V25 l)
  = V27 (*mom r146 3 V25 r)
  = V28 (*chain V19 V20 1 V24 top V20 river V26 V27)
  = V29 (*chain V19 V20 1 V24 top V20 river V26 V27 (*mom r146 4 V28 l) (*mom r146 4 V28 r))
  = V30 (*mom r146 5 V29 l)
  = V31 (*mom r146 5 V29 r)
  = V32 (*id r157 2 (*chain V30 V31 V30 V31 river 1) :C)
  = V33 (*mom r117 3 (*chain V22 V23 V23 V24 top) l)
  = V34 (*mom r117 4 (*chain V22 V23 V23 V24 top V33 top) l)
  = V35 (*mom r117 5 (*chain V22 V23 V23 V24 top V33 top V34 top) l)
  = V36 (*mom r117 6 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top) l)
  = V37 (*mom r117 7 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top) l)
  = V38 (*mom r117 8 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top) l)
  = V39 (*chain V30 V31 V30 V31 river 1 V32 V30 V31 V30 V31)
  = V40 (*mom r157 4 V39 l)
  = V41 (*mom r157 4 V39 r)
  = V42 (*mom r117 9 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top) l)
  = V43 (*mom r117 10 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top) l)
  = V44 (*mom r117 11 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top) l)
  = V45 (*mom r117 12 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top) l)
  = V46 (*mom r117 13 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top) l)
  = V47 (*mom r117 14 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top) l)
  = V48 (*mom r117 15 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top) l)
  = V49 (*mom r117 16 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top) l)
  = V50 (*mom r117 17 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top) l)
  = V51 (*mom r117 18 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top V50 top) l)
  = V52 (*mom r117 19 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top V50 top V51 top) l)
  = V53 (*mom r117 20 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top V50 top V51 top V52 top) l)
  = V54 (*mom r117 21 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top V50 top V51 top V52 top V53 top) l)
  = V55 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top V50 top V51 top V52 top V53 top V54 top)
  = V56 (*chain V22 V23 V23 V24 top V33 top V34 top V35 top V36 top V37 top V38 top V42 top V43 top V44 top V45 top V46 top V47 top V48 top V49 top V50 top V51 top V52 top V53 top V54 top (*mom r117 22 V55 l) (*mom r117 22 V55 r))
  = V57 (*mom r117 23 V56 l)
  = V58 (*mom r117 23 V56 r)
  = V59 (*mom r120 2 (*chain V57 V58 V57 V58) l)
  = V60 (*mom r120 3 (*chain V57 V58 V58 V59 top) l)
  = V61 (*mom r120 4 (*chain V57 V58 V58 V59 top V60 top) l)
  = V62 (*mom r120 5 (*chain V57 V58 V58 V59 top V60 top V61 top) l)
  = V63 (*mom r120 6 (*chain V57 V58 V58 V59 top V60 top V61 top V62 top) l)
  = V64 (*mom r120 7 (*chain V57 V58 V58 V59 top V60 top V61 top V62 top V63 top) l)
  = V65 (*mom r120 8 (*chain V57 V58 V58 V59 top V60 top V61 top V62 top V63 top V64 top) l)
  = V66 (*mom r120 9 (*chain V57 V58 V58 V59 top V60 top V61 top V62 top V63 top V64 top V65 top) l)
  = V67 (*mom r120 11 (*chain V57 V58 V58 V59 top V60 top V61 top V62 top V63 top V64 top V65 top V66 top (*mom r120 10 (*chain V57 V58 V58 V59 top V60 top V61 top V62 top V63 top V64 top V65 top V66 top) l) top) l)
  = V68 (*chain V40 V41 V32 river 1 V30 top wash-away V67 top V40 V41 1)
  = V69 (*mom r158 4 V68 l)
  = V70 (*mom r158 4 V68 r)
  = V71 (*chain V40 V41 V32 river 1 V30 top wash-away V67 top V41 1 V69 V70)
  = V72 (*mom r158 5 V71 l)
  = V73 (*mom r158 5 V71 r)
  = V74 (*chain V40 V41 V32 river 1 V30 top wash-away V67 top V41 1 V69 V70 V72 V73)
  = V75 (*chain V40 V41 V32 river 1 V30 top wash-away V67 top V41 1 V69 V70 V72 V73 (*mom r158 6 V74 l) (*mom r158 6 V74 r))
  = V76 (*mom r158 7 V75 l)
  = V77 (*mom r158 7 V75 r)
  = V78 (*id r157 2 (*chain V76 V77 V76 V77 river 1) :C)
  ^ is V78 boon-of-vigor
