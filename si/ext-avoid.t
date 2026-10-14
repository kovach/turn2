-- Fear card "Avoid the Dahan", level 1: "Invaders do not Explore into lands
-- with at least 2 Dahan."
explore-step, fear-effect avoid-the-dahan 1, land:count L dahan N, ge N 2, { explore L => }

-- scenario: earned and resolved this turn; 2 Dahan in l3 (the explore target)
scenario, +fear-effect avoid-the-dahan 1, ~>add-piece l3 dahan, ~add-piece l3 dahan
