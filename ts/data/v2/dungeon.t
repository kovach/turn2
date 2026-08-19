~setup; ~init; ~main

-- max_hp 10.
setup
  +max-hp 10

#agg days -> last
#agg hp -> last
#agg treasure -> last
#agg weapon-damage -> last

-- i : init_tok * max_hp N -o health N * treasure z * ndays z * weapon_damage 4.
init
  +hp 10
  +treasure 0
  +days 0
  +weapon-damage 4
main-option X, ^icon X

main
  ?X, !main-option X, ~main-choice X

-- quit definition
-- do/quit : main_screen -o quit.
-- qui * stage main * quit -o ().
setup
  +main-option do/quit  -- no further rules

-- rest definition
-- do/rest : main_screen -o rest_screen.
-- qui * stage main * $rest_screen -o stage rest.
main-choice.is do/rest, ~rest

setup
  +main-option do/rest
  +recharge-hp 3

#js-def cplus +A +B +Max -Out { yield [Math.min(Max, A+B)] }

-- recharge : rest_screen * health HP * max_hp Max * recharge_hp Recharge
--           * cplus HP Recharge Max N * ndays NDAYS
--           -o health N * ndays (NDAYS + 1).
rest
  hp -> Hp
  max-hp Max, recharge-hp R
  cplus Hp R Max Hp'
  days -> N, plus N 1 N'
  +hp Hp'
  +days N'

-- qui * stage rest -o stage main * main_screen.
(main, (rest)); ~main

-- shop definition
-- do/shop : main_screen -o shop_screen.
-- qui * stage main * $shop_screen -o stage shop.
main-choice.is do/shop, ~shop

setup
  +main-option do/shop
  +shop-item sword
  +damage-of sword 5
  +cost sword 10    -- damage sword 4. cost sword 10.
  +shop-option leave
  +shop-option buy
shop-option X, ^icon X
shop-item X, ^icon X

shop, ?X, !shop-option X, ~shop-choice X

-- partial subtract
#js-def subtract +X +Y -R { if (X >= Y) yield [X-Y] }

-- buy : treasure T * cost W C * damage_of W D * weapon_damage _ 
--     * subtract T C (some T’) -o treasure T’ * weapon_damage D.
shop-choice.is buy
  ?X, !shop-item X, is X W,
  treasure -> T, cost W C, damage-of W D, subtract T C T'
  +treasure T', +weapon-damage D,

-- leave : shop_screen -o main_screen.
-- qui * stage shop * $main_screen -o stage main.
(main, (shop)); ~main

-- adventure definition
-- do/adventure : main_screen -o adventure_screen.
-- qui * stage main * $adventure_screen -o stage adventure.
main-choice.is do/adventure, ~adventure

setup
  +main-option do/adventure
  +fight-option do/fight
  +fight-option do/flee
  +win-option go-home
  +win-option continue
  +die-option do/quit
  +die-option do/restart
fight-option X, ^icon X
win-option X, ^icon X
die-option X, ^icon X

-- monster_size Size is random in the paper; here a fixed pseudo-random
-- sequence indexed by how many monsters have been generated so far
#agg fights -> sum
#js-def monster-size +N -Size { yield [1 + (N * 7 + 3) % 5] }
-- drop_amount X X. % for now
#js-def drop-amount +M -N { yield [M] }
#js-def plus +X +Y -Z { yield [X + Y] }
#js-def positive +X { if (X > 0) yield [] }

#agg monster-hp -> last
#agg spoils -> last

-- init : adventure_screen -o spoils z.
adventure, +spoils 0, ~fight

-- gen_a_monster : gen_monster * monster_size Size -o monster Size * monster_hp Size.
-- the monster's stats are emitted before the first round so every round can see them
fight F
  fights -> N, monster-size N Size
  +fights 1
  +monster F Size
  +monster-hp F -> Size
  ~round

-- qui * stage fight_init -o stage fight * choice.
-- each round the player chooses to fight or flee
round, ?X, !fight-option X, ~round-choice X

-- do_flee : choice * fight_in_progress -o flee_screen.
round-choice.is do/flee, ~flee

-- do_fight : choice * $fight_in_progress -o try_fight.
-- the player strikes first; if the monster survives it strikes back.
round-choice.is do/fight, ~try-fight

-- fight/hit : try_fight * $fight_in_progress * monster_hp MHP * $weapon_damage D
--           * subtract MHP D (some MHP') -o monster_hp MHP'.
try-fight, fight F, monster F Size
  monster-hp F -> MHP, weapon-damage -> D
  subtract MHP D MHP', positive MHP'
  +monster-hp F -> MHP'
  ~monster-strikes

-- win : try_fight * fight_in_progress * monster_hp MHP * $weapon_damage D
--     * subtract MHP D none -o win_screen.
try-fight, fight F
  monster-hp F -> MHP, weapon-damage -> D
  subtract D MHP _
  ~win

-- fight/miss : try_fight * $fight_in_progress * $monster Size * health HP
--            * subtract HP Size (some HP') -o health HP'.
monster-strikes, fight F, monster F Size
  hp -> HP, subtract HP Size HP', positive HP'
  +hp HP'
  ~round-continue

-- fight/die : try_fight * fight_in_progress * monster Size * health HP
--           * subtract HP Size none -o die_screen.
monster-strikes, fight F, monster F Size
  hp -> HP, subtract Size HP _
  +hp 0
  ~die

-- another round follows a round survived
fight, (round, (round-continue)); ~round

-- win : win_screen * monster Size * drop_amount Size Drop -o drop Drop.
-- collect_spoils : drop X * spoils Y * plus X Y Z -o spoils Z * go_home_or_continue.
win, fight F, monster F Size
  drop-amount Size Drop
  spoils -> S, plus Drop S S'
  +spoils S'
  ?X, !win-option X, ~win-choice X

-- continue : go_home_or_continue -o fight_screen.
adventure, (fight, (win, (win-choice.is continue))); ~fight

-- go_home : go_home_or_continue * spoils X * treasure Y * plus X Y Z -o treasure Z * main_screen.
win-choice.is go-home
  spoils -> S, treasure -> T, plus S T T'
  +treasure T'

-- do/flee : flee_screen * spoils X * monster _ * monster_hp _ -o ().
-- fleeing (or going home) ends the adventure and returns to the main screen
(main, (adventure, (win-choice.is go-home))); ~main
(main, (adventure, (flee))); ~main

-- quit : die_screen -o end.
-- qui * stage die * end -o ().
-- restart : die_screen * monster_hp _ * spoils _ * health _ * treasure _
--         * weapon_damage _ -o init_tok.
-- quit ends the game; restart starts over from init
die, ?X, !die-option X, ~die-choice X

(main, (adventure, (die-choice.is do/restart))); ~init; ~main
