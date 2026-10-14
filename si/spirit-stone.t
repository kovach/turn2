-- Stone's Unyielding Defiance (Jagged Earth). Special rules (verbatim):
--  BESTOW THE ENDURANCE OF BEDROCK
--   "When [Blight] is added to one of your lands, unless the [Blight] then
--    outnumbers your [Presence], it does not cascade or destroy [Presence]
--    (yours or others')."
--  DEEP LAYERS EXPOSED TO THE SURFACE
--   "The first time you uncover each of your "+1 Card Play" [Presence]
--    spaces, gain a Minor Power. (They're marked with [Minorsymbol] as a
--    reminder.)"

#js-def plus +A +B -C { yield [A + B] }

-- ---------------------------------------------------------------- Bedrock
-- "When Blight is added to one of your lands, unless the Blight then
--  outnumbers your Presence, it does not cascade or destroy Presence
--  (yours or others')."
-- Read at the start of add-blight: B blight before, so B+1 "then"; N is
-- Stone's Presence there. Both consequences of the base rule are
-- intercepted inside this add-blight only.
add-blight L, spirit:special S bedrock, presence-count S L N
  land:count L blight B, plus B 1 B1, le B1 N
  { destroy-presence _ => }
  { cascade _ => }

-- ---------------------------------------------------------------- Deep Layers
-- BASE-EXT (rulebook, not this spirit): Presence track spaces are locations;
-- taking Presence off a space "uncovers" it. Gaining a Power Card is just
-- recorded (no deck model).
gain-power S D, ^gained-power S D

-- "The first time you uncover each of your "+1 Card Play" Presence spaces,
--  gain a Minor Power."
-- uncover = a move whose piece was on the space when the move began
#acc deep-layers-done : space
uncovered Sp / deep-layers-done Sp
move P To, at P Sp, space:owner Sp S, space:bonus Sp card-play
  spirit:special S deep-layers, not deep-layers-done Sp
  +uncovered Sp
  ~gain-power S minor

-- ---------------------------------------------------------------- scenario
-- Stone has 2 Presence in l2 (which starts with 1 Blight; river's p1 is
-- there too). The wetland Ravage adds a 2nd Blight: 2 Blight vs 2 Presence
-- does not outnumber, so no cascade and no Presence (Stone's or river's) is
-- destroyed. A 3rd Blight (from a scenario Power) would outnumber.
setup
  +spirit stone, +spirit:special stone bedrock, +spirit:special stone deep-layers
  +presence-of stone s1, +presence-of stone s2, +presence-of stone s3
  +space sp-card, +space:owner sp-card stone, +space:bonus sp-card card-play
scenario, ~>move s1 l2, ~>move s2 l2, ~move s3 sp-card

-- Deep Layers: uncover the card-play space, cover it again, uncover again:
-- only one Minor Power.
spirit-phase, ~>move s3 l3, ~>move s3 sp-card, ~move s3 l3

-- After the Invader phase, a Power adds Blight to l2 again: now 3 Blight vs
-- 2 Presence, so it outnumbers and the base rules apply.
slow-phase, ~add-blight l2
