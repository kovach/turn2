-- Ember-Eyed Behemoth (Nature Incarnate). Special rules, verbatim:
--  THE BEHEMOTH RISES
--   "You have an Incarna ( [Ember-Eyed Behemoth] ). Once per turn, during the
--    Spirit, [Fasticon] , or [Slowicon] phase, you may either:
--    Push [Ember-Eyed Behemoth] ; or
--    Add or Move [Ember-Eyed Behemoth] to any of your [Sacred Site] on the
--    island."
--  UNRELENTING STRIDES
--   "On any turn that you don't use Innate Powers, you may use The Behemoth
--    Rises an additional time. (When you use an Innate Power, cover this
--    Special Rule with a Reminder Marker; when you use this Special Rule,
--    cover your Innate Power.)"

#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- ---------------------------------------------------------------- THE BEHEMOTH RISES
-- "Once per turn": uses are counted with @sum (a 0 row stands for "unused"),
-- the allowance is a separate @sum so Unrelenting Strides can add to it.
#acc rises-used : spirit @sum
spirit:special S behemoth-rises / rises-used S 0
rises-use S A / rises-used S 1
#acc rises-limit : spirit @sum
spirit:special S behemoth-rises / rises-limit S 1

-- "during the Spirit, Fast, or Slow phase, you may"
spirit-phase, spirit:special S behemoth-rises, ~rises-offer S
fast-phase, spirit:special S behemoth-rises, ~rises-offer S
slow-phase, spirit:special S behemoth-rises, ~rises-offer S

-- "either: Push [Incarna]; or Add or Move [Incarna] to any of your Sacred Sites"
#acc rises-option : spirit e
rises-offer S / rises-option S decline
rises-offer S, incarna-of S I, at I L, land L / rises-option S push
rises-offer S, sacred-site S L / rises-option S (to L)
rises-offer S, rises-used S U, rises-limit S Lim, lt U Lim
  ?[rng] A
  !(rises-option S A)
  ~rises-choice S A
-- a use is recorded inside the choice episode, so later reads see it
-- (+ to top: in a multi-turn game this would need a turn key); after a use
-- the same phase may offer again (only matters with Strides). The re-offer
-- is nested in the choice: `rises-offer S, >rises-choice S C, ...` would also
-- match choices of earlier offers (>p needs no overlap) and loop.
rises-choice S C, is C A, neq A decline
  +rises-use S A
  ~>rises-act S A
  ~rises-offer S
rises-act S push, incarna-of S I, at I L, ~push S I L
rises-act S (to L), incarna-of S I, ~move I L

-- ---------------------------------------------------------------- UNRELENTING STRIDES
-- "On any turn that you don't use Innate Powers, you may use The Behemoth
--  Rises an additional time."
#acc innate-used : spirit @sum
spirit S / innate-used S 0
used-innate S P / innate-used S 1
use-power S P, power:innate P, +used-innate S P
spirit:special S unrelenting, innate-used S 0 / rises-limit S 1
-- "when you use this Special Rule, cover your Innate Power": once the extra
-- use is taken, Innate Powers are not used.
slow-phase, spirit:special S unrelenting, rises-used S U, ge U 2, power:innate P,
  { use-power S P => }
fast-phase, spirit:special S unrelenting, rises-used S U, ge U 2, power:innate P,
  { use-power S P => }

-- ---------------------------------------------------------------- scenario
-- Behemoth: 2 Presence in l3 (a Sacred Site), the Incarna starts off the
-- island. Its Innate Power (Slow) is "played" this turn.
setup
  +spirit behemoth, +spirit:special behemoth behemoth-rises, +spirit:special behemoth unrelenting
  +presence-of behemoth b1, +presence-of behemoth b2
  +incarna-of behemoth eeb, +presence-of behemoth eeb
  +power smash, +power:speed smash slow, +power:innate smash
scenario, ~>move b1 l3, ~>move b2 l3, ~move eeb supply
scenario, +played behemoth smash
report, rises-use S push, ^rises-report S push
report, rises-use S (to L), ^rises-report S L
report, used-innate S P, ^innate-report S P
report, incarna-of S I, at I L, ^incarna-at I L
