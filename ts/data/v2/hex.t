-- Hex: a two-wizard card duel, in the extensible-card-game style.
--
-- Base rules: wizards alternate turns; each turn you cast one card from
-- your hand. A strike deals damage; damage leaves persistent wounds; four
-- wounds kill you. Effect cards never edit these rules — they modify them
-- from the outside with exceptions:
--   venom    doubles damage locally (activation-scoped exception)
--   amplify  doubles your damage persistently (aura: fact-anchored exception)
--   mirror   redirects damage you'd take to your foe (aura, via ~reflect)
--   seal     enchantments no longer attach (bare-suppression aura)
-- Priority is exception source order: venom, then amplify, then mirror.
--
-- Design notes:
--  * exception RHSs use only LHS-bound variables. (A context variable in
--    the RHS gives the generated default rule a wildcard-key flag read,
--    which never fires when the flag was never set — the tuple vanishes.)
--    mirror threads its context through the exception-free `reflect` rule
--    instead.
--  * interception is temporal, not relational: a flag covers the
--    intercepted tuple's span, and any renamed tuple nested inside a set
--    flag is intercepted regardless of its arguments. A reflected `~dmg`
--    lands inside the flag that reflected it and loops; reflect emits
--    `+dmg` instead, whose to-top interval no bounded flag contains.

~game

game
  ( ~setup );
  ( ~turn T, ^:actor T me, ^:fuel T (s (s (s (s (s (s (s (s (s (s z)))))))))) )

setup
  +player me
  +player you
  +player:foe me you
  +player:foe you me

-- === the card pool (ground ids; owner and name are attributes) ===

setup
  +card za1, +card:name za1 zap,     +card:owner za1 me
  +card za2, +card:name za2 zap,     +card:owner za2 me
  +card vn1, +card:name vn1 venom,   +card:owner vn1 me
  +card am1, +card:name am1 amplify, +card:owner am1 me, +card:kind am1 enchant
  +card sl1, +card:name sl1 seal,    +card:owner sl1 me
  +card zb1, +card:name zb1 zap,     +card:owner zb1 you
  +card zb2, +card:name zb2 zap,     +card:owner zb2 you
  +card zb3, +card:name zb3 zap,     +card:owner zb3 you
  +card mr1, +card:name mr1 mirror,  +card:owner mr1 you, +card:kind mr1 enchant

-- === turn structure ===

-- the phases start after the turn's attributes (`^:actor`, then `^:fuel`),
-- so the attributes are visible in them
turn.:fuel _
  ~upkeep; ~main

-- the actor and their foe, as of a moment in the turn
#acc actor : player
turn.:actor P / actor P
#acc foe : player
turn.:actor P, player:foe P Op / foe Op

-- wounds taken so far (distinct damage ids: a wound is re-derived in every
-- later turn, and must count once), and whether anyone has won
#acc hit : player dmg
wound P I / hit P I
#acc wounds : player @count
hit P _ / wounds P ()
#acc winner : player
won W / winner W

-- upkeep: a wizard with four wounds dies; their foe wins
upkeep, (player P), (player:foe P W)
  wounds P (s (s (s (s _))))
  +won W

-- main: unless the game is over, the actor casts one card
main, not winner _
  ?X
  !can-play X

  is X C
    ~activate .^:card C
    ~did-cast

-- an unspent card in the actor's hand is playable; passing always is
#acc spent-card : card
spent C _ / spent-card C
#acc can-play : card
card:owner C P, turn.:actor P, not spent-card C / can-play C
turn _ / can-play pass

-- casting a real card spends it
activate .(:card C), (card C), +spent C _S

turn, did-cast, ~turn-complete

-- after a finished turn, the foe takes one (while fuel remains)
game, player:foe P Op
  ( turn .(:actor P) .(:fuel (s F)), (turn-complete) );
  ( ~turn T, ^:actor T Op, ^:fuel T F )

-- === base combat rules ===

-- a strike deals one damage to its target (the damage starts after the
-- target is named, inside any exception context set up around it)
strike.:target T, ~dmg T _I

-- damage leaves a persistent wound. Tallied per-turn (a bounded anchor,
-- so the wound is provably before later upkeeps — a rule anchored at a
-- to-top dmg fact would place it at a floating moment no later read can
-- see) and keyed by the damage id, so re-derivations in later turns
-- collapse under count's set semantics.
turn, (dmg T I), +wound T I

-- an enchantment attaches when cast
activate .(:card C), (card:kind C enchant), +in-play C

-- === cards ===

-- zap: strike your foe
activate .(:card C), (card:name C zap), foe Op
  ~strike .^:target Op

-- venom: strike your foe; this strike's damage counts double.
-- The exception is anchored at this activation, so only damage dealt
-- within it is doubled — the same right-hand side as amplify, with a
-- narrower temporal scope.
activate .(:card C), (card:name C venom), foe Op
  ~strike .^:target Op
  {dmg Op _ => ~dmg Op _A, ~dmg Op _B}

-- amplify (enchant): while in play, damage you deal is doubled.
-- Anchored at the in-play fact, the exception covers every later strike.
in-play C, (card:name C amplify), (card:owner C P), (player:foe P Op)
  {dmg Op _ => ~dmg Op _A, ~dmg Op _B}

-- mirror (enchant): while in play, damage you would take strikes your
-- foe instead. The RHS only knows P; the exception-free reflect rule
-- looks up the new target. Reflected damage is delivered as a `+` fact:
-- a fact's interval runs to top, so no bounded interception flag can
-- contain it — it falls through every default (reflected damage is
-- final, and two opposing mirrors cannot ping-pong).
in-play C, (card:name C mirror), (card:owner C P)
  {dmg P _ => ~reflect P}

reflect P, (player:foe P Op), +dmg Op _R

-- seal: from now on, enchantments fizzle — the attach fact is suppressed
activate .(:card C), (card:name C seal), +sealed C

sealed _C
  {in-play _ =>}
