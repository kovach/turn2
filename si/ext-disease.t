-- Branch & Claw, Disease: "When Invaders would Build in a land with Disease,
-- instead Remove one Disease from that land."
#acc has-disease : land
at P L, piece:kind P disease / has-disease L
build-step, has-disease L, { build L => ~remove-one L disease }
remove-one L K, ?[rng] P, !(at P L, piece:kind P K), ~removing P
removing P, is P X, ~move X supply

-- scenario
setup, +kind disease
setup, ~add-piece l1 disease
