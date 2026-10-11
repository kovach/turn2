-- take turns
-- (the turn's actor and `done` are read as side conditions: under `^` they
-- start at independent moments inside the turn)
opp A B, (turn T, (:actor T A), (done));
  ~turn.^:actor B

-- saying a color that hasn't been said
-- (a `!` sits at the moment its `?` was asked, so both constraints go here,
-- ahead of `~choice`, which moves the rule on to a later moment)
turn, ?C, !color C, !(not was-said C), ~choice C
choice C, is C _, ^done

choice C, is C V, +said V

-- colors said so far, as of a moment
#acc was-said : color
said C / was-said C

-- misc setup
~setup; ~turn.^:actor you
setup
  +color red, +color blue, +color green
  +opp me you, +opp you me
color X, ^icon X
