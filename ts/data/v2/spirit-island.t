-- If target land has Dahan, gain a Major Power.
-- If you Forget this Power, gain Energy equal to Dahan and
-- you may play the Major Power immediately, paying its cost.
-- https://sick.oberien.de/?query=call%20on%20midnight
-- https://spiritislandwiki.com/index.php?title=Call_on_Midnight%27s_Dream
activate .(it.is This, card:name This call) .(target T)
  ( ~this-is This );
  ( ~look, has-dahan T );
  ( ~gain-power.(^type major).(it.is Gained)
    forget-power.forgot.is This );
  ~play-power.^it.^is Gained


-- Setup --


#agg at e -> last
#def move move It To, +at It -> To

~game
  ( ~setup );
  ( ~activate .(^it.^is call) .(^target l1) );
  ( ~move d2 l2 );
  ~look

setup
  +card c
  +card call, +card:name call call
  +land l1
  +land l2
  +dahan d1, ~move d1 l1
  +dahan d2, ~move d2 l1
  +card to-gain, +in-deck to-gain

gain-power E, type E major
  ( ?P, ~it E P, !in-deck P );
  ( ~forget-power _ );

forget-power E, ?P, ~forgot E P, !card P

#agg dahan-count land -> count

look, ~locations, ~counts

locations
  at X -> L
  ^ here X L

here D L, dahan D, ^has-dahan L, ^dahan-count L -> ()

counts, land L, dahan-count L -> (s _), ^alt-has-dahan L

look
  (counts, dahan-count L -> N)
  ^ok L N
