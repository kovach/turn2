-- Jagged Earth, Actions (JE rulebook p. 10 and Appendix p. 24-25), retrofitted
-- onto the base slice. core.t was written without the concept; each rule
-- below names a base episode that JE's table lists as one Action. Nothing in
-- core.t changes.

-- p24 "An Action is a group of game instructions performed as a unit – e.g.,
--  one use of a Power, or a single land's Ravage."
-- An Action is named by the base episode's own term, and is in progress
-- exactly while that episode is: acc rows are computed from the tuples alive
-- at each moment, and an episode is alive at every moment nested inside it.
#acc action : e kind

-- table: "Using a Power."  -- Spirit Action
use-power S P / action (power-use S P) spirit

-- table: "One Ravage, Build, or Explore in one land"  -- Invader Action
-- (the "each land" rule (*) needs nothing extra: the base already runs one
--  ravage/build/explore episode per land)
ravage L / action (ravage-in L) invader
build L / action (build-in L) invader
explore L / action (explore-in L) invader

-- p25 "Not everything is an Action; some game effects are just ongoing rules"
-- (nothing to write: ravage-step, invader-phase, the acc views, ... are
--  simply not listed above)

-- p25 "a few things can initiate base Actions in the middle of other
--  Actions ... you pause the current Action, Resolve the entire new
--  Action-tree ..., then return to the original Action."
-- Both are then in progress; the current one is the innermost, the one that
-- started last.
#acc current-action : (@last e)
action A K / current-action A

-- Trace: tag a few base events with the Action they happened in.
destroy P, piece:kind P K, current-action A, ^during A (destroyed K)
add-blight L, current-action A, ^during A (blight-added L)
damage-dahan L D, current-action A, ^during A (dahan-damaged L D)
