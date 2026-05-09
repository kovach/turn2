node --cpu-prof --cpu-prof-name=ttt.cpuprofile --import tsx src/profile-ttt-v2.ts
#node scripts/collapse-frame.mjs ttt.cpuprofile dispatch,matchAt,unifyConstraintsAt ttt.collapsed2.cpuprofile
node scripts/collapse-frame.mjs ttt.cpuprofile "evalSeq,(anonymous)" ttt.collapsed2.cpuprofile
