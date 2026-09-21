-- `#acc` relations (plans/v2-acc-relations.md): computed by `body / head`
-- rules from the state alive at each moment, read by ordinary rules at the
-- start of their anchor.

#acc damage    : e @sum
#acc at        : e (@last location)
#acc occupancy : location @count
#acc crowded   : location
#acc distance  : location location @min
#acc min-path  : location location (@arg-min location)

hit X A / damage X (@sum A)
move A B / at A B
at _ X / occupancy X ()
occupancy X (s (s _)) / crowded X

edge A B / distance A B (s z)
edge A B, distance B C L / distance A C (s L)
edge A B / min-path A B (pair B (s z))
edge A B, min-path B C (pair _ L) / min-path A C (pair B (s L))

^edge here there
^edge there beyond
^edge here beyond
^edge beyond here

~game
  ~setup; ~turn; ~check

setup, +move me here
setup, +move you here
setup, +move it there
setup, +hit me 3

turn, +hit me 4
turn, +move me there

check, damage X D, ^report-damage X D
check, at X L, ^report-at X L
check, occupancy L N, ^report-occupancy L N
check, crowded L, ^report-crowded L
check, distance here beyond D, ^report-distance D
check, min-path here beyond P, ^report-path P
