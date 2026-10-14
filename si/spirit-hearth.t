-- Hearth-Vigil (Nature Incarnate). Special rules, verbatim:
--  ROOTED IN THE COMMUNITY
--   "[Blight] added in your lands does not Destroy your [Presence] if [Dahan]
--    are present. (Ravage Actions Destroy [Dahan] before added [Blight]
--    destroys [Presence] and cascades.)"
--  FORTIFY HEART AND HEARTH
--   "[Dahan] have +4 Health (each) while in your lands. Event and Blight Card
--    Actions don't damage, destroy, or replace [Dahan] in your lands.
--    (Ravages are not Event Actions even if caused by Events.)"
--  LOYAL GUARDIAN
--   "When all [Dahan] leave one of your lands, your [Presence] may Move with
--    those [Dahan] . (Each [Dahan] can Bring any number of [Presence] .)"
--
-- Runs against core-hearth.t (core.t with Dahan Health exposed as
-- dahan-health, and Ravage damaging Dahan before the land).

#js-def neq +A +B { if (JSON.stringify(A) !== JSON.stringify(B)) yield [] }

-- ---------------------------------------------------------------- ROOTED IN THE COMMUNITY
-- "Blight added in your lands does not Destroy your Presence if Dahan are
--  present."  The guard is read at the start of add-blight, which (in
--  core-hearth.t) comes after the Ravage has destroyed Dahan.
add-blight L, spirit:special S rooted, has-presence S L, land:count L dahan C, gt C 0,
  presence-of S X, at X L, { move X destroyed => }

-- ---------------------------------------------------------------- FORTIFY HEART AND HEARTH
-- "Dahan have +4 Health (each) while in your lands."
spirit:special S fortify, has-presence S L / dahan-health L 4
-- "Event and Blight Card Actions don't damage, destroy, or replace Dahan in
--  your lands."
event-action E, spirit:special S fortify, has-presence S L, at V L, piece:kind V dahan,
  { destroy V => }
blight-card-action E, spirit:special S fortify, has-presence S L, at V L, piece:kind V dahan,
  { destroy V => }

-- ---------------------------------------------------------------- LOYAL GUARDIAN
-- "When all Dahan leave one of your lands, your Presence may Move with those
--  Dahan."  Approximation: the trigger is the move of the last Dahan in the
--  land (Dahan moved together by one action are not grouped).
move V To, piece:kind V dahan, at V From, land From, neq From To,
  land:count From dahan 1, spirit:special S loyal, has-presence S From
  ~loyal-follow S From To
-- "(Each Dahan can Bring any number of Presence.)" -- one yes/no per Presence
loyal-follow S From To, presence-of S P, at P From
  ?[rng] Y
  !(yes-no Y)
  ~loyal-answer P To Y
loyal-answer P To Y, is Y yes, ~move P To

-- ---------------------------------------------------------------- BASE-EXT (rulebook, not this spirit):
-- Event cards: an Event Action is an episode; this one destroys 1 Dahan in a land.
event-action E, event:destroys-dahan-in E L
  ?[rng] V
  !(at V L, piece:kind V dahan)
  ~event-destroy V
event-destroy V, is V X, ~destroy X

-- ---------------------------------------------------------------- scenario
-- Hearth has Presence in l1 (1 Dahan) and l2 (2 Dahan, already Blighted).
-- Ravage in both: l1 takes 3 Damage, l2 takes 5; Dahan Health is 6 there.
-- Spirit phase: an Event tries to destroy a Dahan in l2; Hearth's Power
-- pushes l1's only Dahan in the Slow phase.
setup
  +spirit hearth, +spirit:special hearth rooted, +spirit:special hearth fortify, +spirit:special hearth loyal
  +presence-of hearth h1, +presence-of hearth h2, +presence-of hearth h3
  +yes-no yes, +yes-no no
  +event ev1, +event:destroys-dahan-in ev1 l2
scenario, ~>move h1 l1, ~>move h2 l2, ~move h3 l2
spirit-phase, ~event-action ev1
slow-phase, at V l1, piece:kind V dahan, ~push hearth V l1
report, presence-of hearth P, at P L, ^hearth-presence P L
report, at V L, piece:kind V dahan, ^dahan-at V L
