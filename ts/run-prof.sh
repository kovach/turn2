node --cpu-prof --cpu-prof-name=ttt.cpuprofile --import tsx src/profile-ttt.ts
node scripts/collapse-frame.mjs ttt.cpuprofile dispatch,matchAt,unifyConstraintsAt ttt.collapsed2.cpuprofile
