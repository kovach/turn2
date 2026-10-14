~turn
turn, ~>fast-phase, ~>invader-phase, ~slow-phase
fast-phase, ~play-power p l2
play-power P L, ^defend-a L 4
-- (a) a view inside the power's episode: scoped to the power, so the
--     invader phase does not see it
-- (b) "for this turn": a turn-scoped acc view keyed by a fact the power
--     leaves. (Formerly `turn, (play-power P L), ^defend-b L 4`; a `^` view
--     under `turn` now starts concurrently with the phases, so they never see
--     it.)
-- (c) "from the power on": a fact on the phase's chain after the power.
--     (Formerly `turn, >play-power P L, ^defend-c L 4`, likewise concurrent
--     with the later phases.)
play-power P L, +power-played-in L
#acc defend-b : land num
turn, power-played-in L / defend-b L 4
invader-phase, defend-a L N, ^sees-a L N
invader-phase, defend-b L N, ^sees-b L N
fast-phase, >play-power P L, +defend-c L 4
invader-phase, defend-c L N, ^sees-c L N
fast-phase, defend-c L N, ^fast-sees-c L N
