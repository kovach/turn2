#acc dmg : e @sum
hit X A / dmg X A

~setup; ~t1; ~t2; ~check

setup, +thing T, +thing:name T a
setup, +thing T, +thing:name T b

t1, +hit me 3
t2, +hit me 3
check, dmg X D, ^report X D
check, thing T, thing:name T N, ^names N
