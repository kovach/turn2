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

-- start: assert game with setup and turn (and initial actor o)
+ game
+ setup
+ turn
+ actor o

-- setup: when setup exists, populate players, grid numbers, then cells
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
fills -> 0
+ eligible Cell

-- choose an eligible cell to mark.
-- old syntax used `?` for a host-supplied choice atom; we model it as a
-- `choose` relation the environment must populate (matching by turn id is
-- not expressible without interval-id capture; relying on overlap with the
-- current turn anchor instead).
turn
choose R C
eligible (cell R C)
+ chose R C

-- mark the chosen cell as filled
turn
actor P
chose R C
cell R C
+ fill (cell R C) P

-- a fill counts toward the per-turn fills aggregate
fill _ _
+ fills -> 1

-- turn-complete: a turn with at least one fill is finished
turn
fill _ _
+ turn-complete

-- after turn is complete, the other player's turn begins
game
other P Op
turn
actor P
turn-complete
~ turn
+ actor Op

-- 4 win-condition rules

game
fill (cell R z) M
fill (cell R (s z)) M
fill (cell R (s (s z))) M
+ won M (row R)

game
fill (cell z C) M
fill (cell (s z) C) M
fill (cell (s (s z)) C) M
+ won M (col C)

game
fill (cell z z) M
fill (cell (s z) (s z)) M
fill (cell (s (s z)) (s (s z))) M
+ won M diag1

game
fill (cell (s (s z)) z) M
fill (cell (s z) (s z)) M
fill (cell z (s (s z))) M
+ won M diag2
