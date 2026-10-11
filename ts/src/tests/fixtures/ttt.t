-- display: ttt-display.js

-- ttt translated to v2 syntax.
--
-- mapping notes (old -> v2):
--   /            -- (line comment)
--   - X          X       (match by overlap)
--   , X          X       (match — old "overlap" same as default v2 match)
--   + X          + X     (fact, l = fresh, r = top)
--   ~ X          ~ X     (episode — new in v2; used here for game/turn)
--   ! X          ! X     (output / external)
--   [X] cell R C — no v2 equivalent for capturing interval id; rules that
--                   relied on a captured id (`[X] cell R C ... is A X`) are
--                   reworked to use a derived `chose A R C` relation.
--   # count -> z
--     < fill ...   weighted match `fill ... -> N` + `% fill -> count`
--   ? Cell        no v2 equivalent — kept as a placeholder `choose` relation
--                   that the host environment is expected to fill.
--   : name        — (label-only in old syntax; dropped)

-- acc relations (computed at each moment)
#acc taken : cell
was-filled Cell / taken Cell

#acc turn-counter : @count
turn _ / turn-counter ()

turn
  turn-counter N
  ~ foo N

-- start: assert game with setup and turn (and initial actor o).
~ game
  ( ~ setup );
  ( ~ turn, ^ actor o)

-- setup: when setup exists, populate players, grid numbers, then cells.
-- All emissions use `+` because they are facts: they should overlap with every following turn
--
setup
  + player x
  + player o
  + other x o
  + other o x
  + n z
  + n (s z)
  + n (s (s z))

-- one rule per (R, C) pair. v2 has no `for each` aggregator beyond
-- weighted matches, so we just match two n tuples.
setup
  n R
  n C
  + cell R C

-- a cell is eligible if it hasn't been filled yet (an acc view, so it is
-- readable at the moment the choice is asked)
turn
  ( ~ el-check );
  ~ do-choice

#acc eligible : cell
cell R C, not taken (cell R C) / eligible (cell R C)

do-choice
  ? C
  ! eligible C
  ^ choice C


-- mark the chosen cell as filled. The cell-choice tuple carries the
-- resolved Cell value once the harness writes the corresponding `is` row.
turn
  (actor P)
  choice A
  is A Cell
  ~ filled Cell P

-- a filled cell stays taken
filled Cell _, + was-filled Cell

-- turn-complete: a turn with at least one filled is finished
turn
  filled _ _
  ~ turn-complete

-- after turn is complete, the other player's turn begins
game, other P Op
  ( turn, (actor P), (turn-complete) );
  ( ~ turn, ^ actor Op )

-- 4 win-condition rules

filled (cell R z) M
  filled (cell R (s z)) M
  filled (cell R (s (s z))) M
  + won M (row R)

filled (cell z C) M
  filled (cell (s z) C) M
  filled (cell (s (s z)) C) M
  + won M (col C)

filled (cell z z) M
  filled (cell (s z) (s z)) M
  filled (cell (s (s z)) (s (s z))) M
  + won M diag1

filled (cell (s (s z)) z) M
  filled (cell (s z) (s z)) M
  filled (cell z (s (s z))) M
  + won M diag2

