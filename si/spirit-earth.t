-- Vital Strength of the Earth (Base). Special rule, verbatim:
--   EARTH'S VITALITY: "Defend 3 in every land where you have [Sacred Site]."

-- "Defend 3 in every land where you have Sacred Site."
-- (a static ability: a standing contribution to the base Defend total,
--  computed per moment, so it follows the Sacred Site as Presence moves)
spirit:special S earths-vitality, sacred-site S L / defend-total L 3

-- scenario: Earth has a Sacred Site (2 Presence) in l2, the land with a City
-- and a Town (5 Damage when it Ravages)
setup
  +spirit earth, +spirit:special earth earths-vitality
  +presence-of earth e1, +presence-of earth e2
scenario, ~>move e1 l2, ~move e2 l2
