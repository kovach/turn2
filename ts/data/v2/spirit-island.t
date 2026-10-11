~setup; ~test-call; ~test-entwine

#acc at : e @last
move It To, +moved It To
moved It To / at It To

setup
  +card c
  +card call, +card:name call call, ~move call hand
  +land l1
  +land l2
  +dahan d1, ~move d1 l1
  +dahan d2, ~move d2 l1

  +spirit:presence s1 p1
  +spirit:presence s2 p2
  ~move p1 l1
  ~move p2 l2
  
  +card to-gain, +in-deck to-gain

-- (`val` names the card an activation is about; `is` is reserved for the
-- harness's choice resolutions)
test-call
  ~activate .(^it.^val call) .(^target l1)

test-entwine
  ~activate .(^it.^val entwine) .(^target s2)

gain-power E, type E major
  ( ?P, !in-deck P, ~it E P, is P X );
  ~move X hand;
  ~forget-power

forget-power E, ?P, !(at P hand), ~forgot E P
  is P X, ~move X forgotten-pile

-- To target, choose a source and target land
target-power E
  ?X, !land X, ^:source E X
  ?Y, !land Y, ^:target E Y

-- The spirit must control the source land, and
-- the source and target must be within range.
target-power
  .(:source S) .(:target T)
  .(:actor Spirit)
  !spirit:land Spirit S

#acc spirit:land : spirit land
spirit:presence S P, at P L 
  / spirit:land S L
#acc has-dahan : land
dahan.at L / has-dahan L


target-power 
  .(:actor S, spirit:name S mists-shift-and-flow)
  .(:target.is T)
  ~may ( true )
  ~gather.(:to.^val T).(:it I, !spirit:presence S I)

may, ?X, !boolean X, is X true, ^true

-- If target land has Dahan, gain a Major Power.
-- If you Forget this Power, gain Energy equal to Dahan and
-- you may play the Major Power immediately, paying its cost.
-- https://sick.oberien.de/?query=call%20on%20midnight
-- https://spiritislandwiki.com/index.php?title=Call_on_Midnight%27s_Dream
activate .(it.val This, card:name This call) .(target T)
  ( ~this-is This );
  ( has-dahan T, ~ok );
  ( ~gain-power.(^type major).(it.is Gained)
    (forget-power.forgot.is This) );
  ~play-power.^it.^val Gained

target-power .(:actor S)
  entwined S T
  spirit:presence T P
  ^spirit:presence S P

turn T,
  ( activate .(it is entwined-power) .(target You) )
  ^ entwined 