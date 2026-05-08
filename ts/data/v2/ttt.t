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

-- aggregate decls
% fills -> count

% turn-counter -> count

turn
+ turn-counter -> x

turn
turn-counter -> N
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

-- a cell is eligible for a turn if it hasn't been filled in this game
cell R C
turn
fills (cell R C) -> z
+ eligible (cell R C)

-- choose an eligible cell to mark. `?` introduces a choice term Cell;
-- `!` constrains it to eligible cells in the current turn's anchor.
turn
? Cell
^ choice Cell
! eligible Cell

-- mark the chosen cell as filled. The cell-choice tuple carries the
-- resolved Cell value once the harness writes the corresponding `is` row.
turn
actor P
choice A
is A Cell
~ filled Cell P

-- a filled counts toward the per-turn filleds aggregate
filled Cell _, + fills Cell -> 1

-- turn-complete: a turn with at least one filled is finished
turn
filled _ _
~ turn-complete

-- after turn is complete, the other player's turn begins
game, other P Op
  ( turn, (actor P, turn-complete) );
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


= V1 (*mom r3 1 l)
= V2 (*mom r3 1 r)
= V3 (*mom r3 2 V1 V2 l)
= V4 (*mom r3 2 V1 V2 r)
= V5 (cell (s z) z)
= V6 (*id r7 2 (*mom r3 3 V1 V2 V3 V4 l) (*mom r3 3 V1 V2 V3 V4 r) cell)
^ is V6 V5

= V1 (*mom r3 1 l)
= V2 (*mom r3 1 r)
= V3 (*mom r3 2 V1 V2 l)
= V4 (*mom r3 2 V1 V2 r)
= V5 (*mom r3 3 V1 V2 V3 V4 l)
= V6 (*mom r3 3 V1 V2 V3 V4 r)
= V7 (*mom r4 2 V3 V4 l)
= V8 (*mom r4 3 V3 V4 V7 top l)
= V9 (*mom r4 5 V3 V4 V7 top V8 top (*mom r4 4 V3 V4 V7 top V8 top l) top l)
= V10 (s z)
= V11 (cell V10 z)
= V12 (cell (s V10) z)
= V13 (*id r7 2 V5 V6 cell)
= V14 (*mom r7 2 V5 V6 l)
= V15 (*mom r8 5 V5 V6 V5 V6 o V14 V6 V13 bot top V11 l)
= V16 (*mom r8 5 V5 V6 V5 V6 o V14 V6 V13 bot top V11 r)
= V17 (*mom r10 3 V5 V6 V15 V16 l)
= V18 (*mom r10 3 V5 V6 V15 V16 r)
= V19 (*id r7 2 (*mom r11 6 V1 V2 V9 top o x V5 V6 V5 V6 V17 V18 l) (*mom r11 6 V1 V2 V9 top o x V5 V6 V5 V6 V17 V18 r) cell)
^ is V19 V12

= V1 (*mom r3 1 l)
= V2 (*mom r3 1 r)
= V3 (*mom r3 2 V1 V2 l)
= V4 (*mom r3 2 V1 V2 r)
= V5 (*mom r3 3 V1 V2 V3 V4 l)
= V6 (*mom r3 3 V1 V2 V3 V4 r)
= V7 (*mom r4 2 V3 V4 l)
= V8 (*mom r4 3 V3 V4 V7 top l)
= V9 (*mom r4 4 V3 V4 V7 top V8 top l)
= V10 (*mom r4 5 V3 V4 V7 top V8 top V9 top l)
= V11 (s z)
= V12 (cell V11 z)
= V13 (cell V11 V11)
= V14 (cell (s V11) z)
= V15 (*id r7 2 V5 V6 cell)
= V16 (*mom r7 2 V5 V6 l)
= V17 (*mom r8 5 V5 V6 V5 V6 o V16 V6 V15 bot top V12 l)
= V18 (*mom r8 5 V5 V6 V5 V6 o V16 V6 V15 bot top V12 r)
= V19 (*mom r10 3 V5 V6 V17 V18 l)
= V20 (*mom r10 3 V5 V6 V17 V18 r)
= V21 (*mom r11 6 V1 V2 V10 top o x V5 V6 V5 V6 V19 V20 l)
= V22 (*mom r11 6 V1 V2 V10 top o x V5 V6 V5 V6 V19 V20 r)
= V23 (*id r7 2 V21 V22 cell)
= V24 (*mom r7 2 V21 V22 l)
= V25 (*mom r8 5 V21 V22 V21 V22 x V24 V22 V23 bot top V14 l)
= V26 (*mom r8 5 V21 V22 V21 V22 x V24 V22 V23 bot top V14 r)
= V27 (*mom r10 3 V21 V22 V25 V26 l)
= V28 (*mom r10 3 V21 V22 V25 V26 r)
= V29 (*id r7 2 (*mom r11 6 V1 V2 V9 top x o V21 V22 V21 V22 V27 V28 l) (*mom r11 6 V1 V2 V9 top x o V21 V22 V21 V22 V27 V28 r) cell)
^ is V29 V13

= V1 (*mom r3 1 l)
= V2 (*mom r3 1 r)
= V3 (*mom r3 2 V1 V2 l)
= V4 (*mom r3 2 V1 V2 r)
= V5 (*mom r3 3 V1 V2 V3 V4 l)
= V6 (*mom r3 3 V1 V2 V3 V4 r)
= V7 (*mom r4 2 V3 V4 l)
= V8 (*mom r4 3 V3 V4 V7 top l)
= V9 (*mom r4 4 V3 V4 V7 top V8 top l)
= V10 (*mom r4 5 V3 V4 V7 top V8 top V9 top l)
= V11 (s z)
= V12 (s V11)
= V13 (cell V11 z)
= V14 (cell V11 V11)
= V15 (cell V12 z)
= V16 (cell V12 V12)
= V17 (*id r7 2 V5 V6 cell)
= V18 (*mom r7 2 V5 V6 l)
= V19 (*mom r8 5 V5 V6 V5 V6 o V18 V6 V17 bot top V13 l)
= V20 (*mom r8 5 V5 V6 V5 V6 o V18 V6 V17 bot top V13 r)
= V21 (*mom r10 3 V5 V6 V19 V20 l)
= V22 (*mom r10 3 V5 V6 V19 V20 r)
= V23 (*mom r11 6 V1 V2 V10 top o x V5 V6 V5 V6 V21 V22 l)
= V24 (*mom r11 6 V1 V2 V10 top o x V5 V6 V5 V6 V21 V22 r)
= V25 (*id r7 2 V23 V24 cell)
= V26 (*mom r7 2 V23 V24 l)
= V27 (*mom r8 5 V23 V24 V23 V24 x V26 V24 V25 bot top V15 l)
= V28 (*mom r8 5 V23 V24 V23 V24 x V26 V24 V25 bot top V15 r)
= V29 (*mom r10 3 V23 V24 V27 V28 l)
= V30 (*mom r10 3 V23 V24 V27 V28 r)
= V31 (*mom r11 6 V1 V2 V9 top x o V23 V24 V23 V24 V29 V30 l)
= V32 (*mom r11 6 V1 V2 V9 top x o V23 V24 V23 V24 V29 V30 r)
= V33 (*id r7 2 V31 V32 cell)
= V34 (*mom r7 2 V31 V32 l)
= V35 (*mom r8 5 V31 V32 V31 V32 o V34 V32 V33 bot top V14 l)
= V36 (*mom r8 5 V31 V32 V31 V32 o V34 V32 V33 bot top V14 r)
= V37 (*mom r10 3 V31 V32 V35 V36 l)
= V38 (*mom r10 3 V31 V32 V35 V36 r)
= V39 (*id r7 2 (*mom r11 6 V1 V2 V10 top o x V31 V32 V31 V32 V37 V38 l) (*mom r11 6 V1 V2 V10 top o x V31 V32 V31 V32 V37 V38 r) cell)
^ is V39 V16