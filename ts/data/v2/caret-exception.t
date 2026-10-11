+first a
  ~ctx

ctx, ^move a b

#def r
  ctx
  first X
  {move X _ => ^nope}
  second Y
  {move Y _ => ^boom}
