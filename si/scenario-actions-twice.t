-- Known failure (load after scenario-actions.t): l1 keeps Invaders after
-- call-ravage's Ravage, so the Invader Phase Ravages l1 a second time. Both
-- Ravages are the Action (ravage-in l1), so the second finds the first's
-- "already Damaged Dahan" mark and gets no Badlands bonus (10 instead of 11).
-- An Action is named by its episode's term; Turn can't bind which instance.
scenario, ~>add-piece l1 city, ~>add-piece l1 city, ~add-piece l1 city
