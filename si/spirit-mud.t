-- Fathomless Mud of the Swamp (Horizons of Spirit Island), special rule:
--   OFFER NO FIRM FOUNDATIONS
--   "At your [Sacred Site], Build actions add [Explorer] instead of
--    [Town] / [City]."

-- "At your Sacred Site, Build actions add Explorer instead of Town / City."
build L, sacred-site S L, spirit:special S no-firm-foundations
  { add-piece L town => ~add-piece L explorer }
build L, sacred-site S L, spirit:special S no-firm-foundations
  { add-piece L city => ~add-piece L explorer }

-- scenario: Mud has a Sacred Site in l1 (wetland, builds this turn: one
-- Town and no City there, so the base rule would add a City)
setup
  +spirit mud, +spirit:special mud no-firm-foundations
  +presence-of mud q1, +presence-of mud q2, +presence-of mud q3
scenario, ~>move q1 l1, ~>move q2 l1, ~move q3 l1
