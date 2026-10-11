#acc seen : @count

~ game
  + rng-seed 1
  ( ~setup ); ( ~later )

setup, +opt a

later, ?[rng] C, !opt C, ~choice C

setup, is C M, +foo M

foo _ / seen ()

later, seen N, ^seen-at-later-start N

later, foo M, ^foo-during-later M
