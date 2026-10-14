-- Branch & Claw, Wilds: "When Invaders would Explore into a land with Wilds,
-- instead Remove one Wilds from that land."
#acc has-wilds : land
at P L, piece:kind P wilds / has-wilds L
explore-step, has-wilds L, { explore L => ~remove-one L wilds }

setup, +kind wilds
setup, ~add-piece l3 wilds
