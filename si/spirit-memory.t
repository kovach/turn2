-- Shifting Memory of Ages (Jagged Earth). Special rules (wiki, verbatim):
--  LONG AGES OF KNOWLEDGE AND FORGETFULNESS: "When you would Forget a Power
--   Card from your hand, you may instead discard it. (Max. once per Action.)"
--  INSIGHTS INTO THE WORLD'S NATURE: "Some of your Actions let you Prepare
--   Element Markers, which are kept here until used. Choose the Elements
--   freely. (I.e., you are not limited to Elements you have at the time.)
--   Each Element Marker spent grants 1 of that Element for a single Action.
--   (E.g., one Power use.)"

-- BASE-EXT (rulebook, not this spirit) ---------------------------------
-- Power Cards live in a hand / discard / forgotten pile (p18: "Forget -
-- permanently lose - one of your Power Cards").  Card locations reuse `at`.
forget S C, ~move C forgotten
discard S C, ~move C discard
#acc in-hand : spirit power
card-of S C, at C hand / in-hand S C
-- ---------------------------------------------------------------------

-- LONG AGES OF KNOWLEDGE AND FORGETFULNESS
-- "When you would Forget a Power Card from your hand, you may instead
--  discard it."  The Action is the context; the cards in hand are read at
--  its start and filter which `forget` tuples are intercepted.
action S A, spirit:special S long-ages, in-hand S C, { forget S C => ~forget-or-discard S C }
-- the "may": choose. Both outcomes use the physical move (re-emitting
-- `forget` inside the context would be intercepted again and loop).
#acc long-ages-option : e
forget-or-discard S C / long-ages-option discard
forget-or-discard S C / long-ages-option forget
forget-or-discard S C
  ?[rng] O
  !(long-ages-option O)
  ~long-ages-choice S C O
long-ages-choice S C O, is O discard, ~move C discard
long-ages-choice S C O, is O forget, ~move C forgotten
-- "(Max. once per Action.)"  -- not enforced (see findings)

-- INSIGHTS INTO THE WORLD'S NATURE
-- "Some of your Actions let you Prepare Element Markers, which are kept
--  here until used. Choose the Elements freely."
prepare-marker S
  ?[rng] E
  !(element E)
  ~marker-choice S E
marker-choice S C, is C E, +piece M, +piece:kind M element-marker, +marker:element M E, ~move M memory-mat
-- "Each Element Marker spent grants 1 of that Element for a single Action."
-- spending moves the marker away and records it on the Action; the grant
-- is extra rows of the base `elements` sum, alive only while the Action is.
-- (`spent-on` is recorded when the marker is spent, so it precedes the
--  Action's later steps; the acc rule's `action S A` keeps the grant to the
--  Action's lifetime)
spend-marker S A M, +spent-on S A M, ~move M spent
spent-on S A M, action S A, marker:element M E / elements S E 1

-- scenario: Memory prepares a marker in the Spirit Phase; in the Fast Phase
-- it takes an Action (a Power that also makes it forget a card from hand)
-- and spends the marker on it; its elements are read during and after.
setup
  +spirit memory, +spirit:special memory long-ages
  +power old-lore, +card-of memory old-lore
  +power boon, +power:speed boon fast
scenario, ~move old-lore hand
spirit-phase, ~prepare-marker memory
scenario, +played memory boon
use-power S boon, ~action S boon-use
action memory boon-use
  ~>spend-a-marker memory boon-use
  ~>check-elements memory during
  ~forget memory old-lore
spend-a-marker S A, at M memory-mat, piece:kind M element-marker, ~spend-marker S A M
check-elements S W, elements S E N, gt N 0, ^element-count W E N
slow-phase, ~check-elements memory after
report, at old-lore L, ^old-lore-at L
