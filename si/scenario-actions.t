-- Scenario for ext-actions.t / ext-badlands-je.t.
-- Two test Powers (not real cards) aimed at l1:
--   call-ravage (Fast): "1 Damage to Dahan. Then Invaders Ravage in l1."
--     (JE p25: "anything that causes a Ravage ... causes a separate Invader
--      Action to happen")
--   twin-strike (Slow): "1 Damage to Dahan. Then 1 Damage to Dahan."
setup
  +power:speed call-ravage fast, +played river call-ravage
  +power:speed twin-strike slow, +played river twin-strike
use-power S call-ravage, ~>damage-dahan l1 1, ~ravage l1
use-power S twin-strike, ~>damage-dahan l1 1, ~damage-dahan l1 1

-- l1 gets 4 more Dahan (5 in all); with ext-badlands-je.t, 1 Badlands
scenario, ~>add-piece l1 dahan, ~>add-piece l1 dahan, ~>add-piece l1 dahan, ~add-piece l1 dahan
scenario, kind badlands, ~add-piece l1 badlands
-- Defend 2 in l1, as in the rulebook's Badlands example: Ravage there deals
-- 1 Damage, too little for Blight
setup, +defend l1 2
