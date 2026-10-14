-- Sun-Bright Whirlwind (Horizons of Spirit Island), special rule:
--   A STIFF WIND AT THEIR BACKS
--   "After you Add [Presence] during Growth, Push up to 1 [Explorer] /
--    [Dahan] from that land.
--    (Let other players know this is due to your Special Rule, so they know
--     you're still in the Spirit Phase and not using a [Fast] power.)"

-- BASE-EXT (rulebook, not this spirit):
-- p8 "Grow: Choose one option ... next to 'Growth'": Growth is its own step
-- of the Spirit Phase, so rules can tell Presence added by Growth apart.
-- (the scenario picks the option "Add a Presence")
spirit-phase, spirit S, growth-option S add-presence, ~growth S
growth S, ~add-presence S

-- "After you Add Presence during Growth, Push up to 1 Explorer / Dahan
--  from that land."
growth S, spirit:special S stiff-wind, >presence-choice S C, is C L
  ~stiff-wind S L
#acc stiff-wind-option : spirit e
stiff-wind S L, at V L, piece:kind V explorer / stiff-wind-option S V
stiff-wind S L, at V L, piece:kind V dahan / stiff-wind-option S V
stiff-wind S L / stiff-wind-option S decline
stiff-wind S L
  ?[rng] V
  !(stiff-wind-option S V)
  ~stiff-wind-choice S L V
stiff-wind-choice S L C, is C V, at V L, ~push S V L

-- scenario: Whirlwind (Presence in l2) grows by adding a Presence; core's
-- add-presence offers any land, so the land may hold an Explorer / Dahan
setup
  +spirit whirl, +spirit:special whirl stiff-wind
  +presence-of whirl w1, +presence-of whirl w2
  +growth-option whirl add-presence
scenario, ~>move w1 l2, ~move w2 supply
