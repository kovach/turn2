-- JE p7-8, Badlands: "Deal this Damage to Dahan. If 1 or more Damage is done
-- to Dahan, they take +1 Damage per Badlands."
#js-def plus +A +B -C { yield [A + B] }
ravage L, land:count L badlands B, gt B 0, { damage-dahan L D => ~badlands-boost L D }
badlands-boost L D, gt D 0, land:count L badlands B, plus D B D2, ~damage-dahan L D2

setup, +kind badlands
scenario, ~add-piece l1 badlands
