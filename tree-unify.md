# algorithm
Overview of tree unification types and algorithm

- a *term* is one of
  - Symbol(String)
  - Variable(String)
- an *atom-type* is one of `match, assert, ask, constrain`
- an *atom* is an atom-type and a vec of terms
- a *tree* is an atom and a set of trees

unify-atom:
  two atoms unify if they unify in the usual sense (producing a substitution of variables to symbols)

unify-term:
  takes a *pattern* term and a *reference* term
  a solution consists of
    - for each `N = Node(A,Ns)` in pattern, a Node `f(N) = Node(A',Ns')` in reference
    - a single substitution s such that, for all nodes, s(A) = s(A')
    - for each path from a node in pattern to the root of pattern, the corresponding reference nodes also lie on a path in reference

to compute unify-term:
  - init empty substitution
  - traverse the nodes in pattern in any order
    - for each, enumerate candidates from reference, constrained by the path condition and the substitution so far
  - return set of all reference terms that unify

notes:
  - we are ignoring the atom-type for now. assume all atoms that show up have type match

# tree syntax
see `example.sl`
- the format is whitespace sensitive
- each line denotes a node. the first character determines atom-type:
  - = match
  + = assert
  ? = ask
  ! = constrain
- the rest of the line is the atom for that node. a lower-case token is a symbol, upper-case for variable
- indentation is the parent/child relationship. so
  ```
  - foo
    ! bar X
  ```
  should become `Tree(Atom(Match, [foo]), [Tree(Atom(Constrain, [bar, X]))])`

