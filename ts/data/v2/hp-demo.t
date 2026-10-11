-- Acc relations under the moment walk (plans/v2-acc-relations.md).
-- `hp-loss` is computed at every moment from the `lost` facts alive there;
-- a read `hp-loss N` samples the total at the START of the reading rule's
-- anchor.

#acc hp-loss : @sum
lost N / hp-loss N

~fight
  ( ~hit-a
    + lost 3 );
  ( ~hit-b
    + lost 4 );
  ~after

-- A read inside `hit-b` sees only the loss before hit-b started: 3.
hit-b, hp-loss N, ^during-b N

-- A rule does not read its own write: this fires with N = 3, not 7.
hit-b, hp-loss N, + lost 1, ^wrote-after-reading N

-- `after` starts once both hits are done: 3 + 4 + 1 = 8.
after, hp-loss N, ^total N

-- A literal filters at the read point.
after, hp-loss 8, ~dead
after, hp-loss 7, ~impossible
