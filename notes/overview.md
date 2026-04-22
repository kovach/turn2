# choice constraints

# string interning
done

# semi-naive evaluation
plan: plans/seminaive.md

# unification perf - index
plan: plans/unify-index.md

- most tree node atoms start with a sym
- while adding nodes, maintain an index on the side mapping a sym to all the tree nodes whose atoms start with that
  - e.g. if we `+[Id] foo bar`, we insert `(foo, ObjId)` where ObjId is the node
- We check `pat` inside `matchSubtree`, before line 207.
  If its first term is a sym, we use the index. otherwise we do a full scan as now.
- this is purely a performance optimization

# nice display for natural numbers

# display as ttt board
plan: plans/display-ttt.md

- a program might have program-specific display functions written in ts
- parse this from a triple-dash-comment block at the file top:
```
---
--- display: ttt.ts
---
```

## notes on ttt demo
display functions for the tic-tac-toe application written at `ts/data/ttt.sl`
- a `cell R C` should be a square at row R (vertical) and column C (horizontal) across page
- a `fill (cell R C) M` should show `x` or `o` (value of `M`) on top of the cell
- clicking a cell that is not filled should carry out what is currently done by clicking the most recent ask followed by clicking a tuple in the result pane

# hashcons for ids
plan: plans/hashcons.md

- new term type ref
- for each atom term occurring within a node being asserted to output tree, hashcons it
  - example: hashcons dictionary empty. output contains (id x y). this gets hashcon's to ref(1).
    output node contains only ref(1)
  - new tuple contains (id (id x y) z)
    first arguments are hashconzed, yielding ref(1) and sym(z)
    now tuple (sym(id) ref(1) sym(z)) is hashconsed to ref(2)

- invariant: atom term never refers to other atom terms (only refs)
  - thus: hashcons dictionary is not needed during unification.
    we know that unequal refs refer to distinct atoms, and when unifying a variable with a ref, we just bind it to the ref

# fringe
define the *fringe* of a value to be the set of all nodes in a tree whose atoms contain that value
```
  + root
    + card c
    + card:name c n
    + card c2
```
the fringe of `c` is `(card c) (card:name c n)`.

the union-fringe of a set of values is the union of their fringes;
the intersection-fringe of a set of values is the set of nodes that each refer to all the values.

TODO: use this for constraining choices

# query algorithm
Overview of tree unification types and algorithm

- a *term* is one of
  - Symbol(String)
  - Variable(String)
  - Atom(Atom)
- an *literal-type* is one of `match, assert, ask, constrain`
  - `match` is called *negative*
  - `assert, ask, constrain` called *positive*
- an *atom* is a vec of terms
- an *literal* is a literal-type and an atom
- a *tree* is (a "node" containing) an *id* term, a literal and an *ordered* list of child trees

unify-atom:
  two atoms unify if they unify in the usual sense (producing a substitution of variables to symbols)

unify-tree:
  takes a *pattern* tree and a *reference* tree
  a solution consists of
    - for each `N = Node(I,A,Ns)` in pattern, a Node `f(N) = Node(I',A',Ns')` in reference
    - a single substitution s that unifies each (I,I') and (A,A')
    - for each path from a node in pattern to the root of pattern, the corresponding reference nodes also lie on a path in reference, *in the same ancestor order*.
      that is, if A is an ancestor of B in pattern, then f(A) must be an ancestor of f(B) in reference. so `(foo (bar))` does not match `(bar (foo))`.

to compute unify-tree:
  - init empty substitution
  - traverse the nodes in pattern in any order
    - for each, enumerate candidates from reference, constrained by the path condition and the substitution so far
  - return set of all reference terms that unify

notes:
  - we are ignoring the atom-type for now. assume all atoms that show up have type match

## other literal types
### before
- plans/before.md

- add a new literal-type: `before`, denoted with the marker `<`
- this is a negative literal, like match.
  it behaves like match, except that it matches nodes that are *temporally before* (see ordering def below) its *previous sibling*, or its parent if it has no previous sibling
  ```
  + a
    + b
    + c
  ```
  the previous sibling of c is b

```
- turn A
  < move X
    + note A X
```
applied to reference tree
```
+ root
  + move a
  + move b
  + turn
```
yields

```
+ root r
  + move a
    + note r a
  + move b
    + note r b
  + turn
```

```
- a
  - c
  < b
  + ok
```
applied to
```
+ a
  + b
  + c
  + d
```

adds `ok` to the tree


# temporal semantics of reference trees
an ordering on nodes within a tree:
- if nodes A and B are siblings, and A is before B as a child, then A < B
- if C is a (nested) child of A, and A < B, then C < B.

```
- root
  - a
    - b
  - c
  - d
    - e
```

in this tree, the temporal ordering relation is the transitive closure of
  - a < c
  - b < c
  - c < d
  - c < e

## for substitutions
we define that a substitution `s` is before a node `n` if every id value in the range of `s` is before `n`

# Temporal semantics of aggregate nodes
see notes/aggregates.md

# tree syntax

## basic syntax
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
- a parenthesized expression is an atom term
  ```
  - foo (cons X Y)
    + bar X Y
  ```

## matching the node id
the following syntax allows a pattern to bind the node id explicitly:
```
-[Id] foo
  + bar Id
```
```
- [(id X)] foo
  + bar X
```

The syntax is `*[<term>]` where `*` stands for a literal type.

# evaluation
plan: plans/evaluation.md

## filling in `.id`
1) id-expand
  given: a pattern tree and a *name* string
  each tree node needs an id value, depending on literal type.
  these are filled in top to bottom (starting from the first line of the pattern and going down)
  - `match` node gets a fresh id variable (generate var string in some syntactic way)
  - each positive node (`assert,ask,constrain`) gets an atom term; the atom has the following form:
    `[sym("id"), sym(name), sym(line) ...previous_vars]`, where
      - `name` is the name passed to this function
      - `line` is a value that is unique per positive node within the rule (1,2,...)
      - `previous_vars` :=  the preceding id variables and the variables appearing within the earlier atoms
  - explanation:
    - todo

  e.g. if name = "r1"
    ```
    - f
      + g
        - h
          + i
    ```
    becomes
    ```
    - f X1
      + g (id r1 id1 X)
        - h X2
          + i (id r1 id2 X1 X2)
    ```

## step algorithm v2
1) expand
  given: a pattern
  - compute each prefix of the pattern that ends with a positive node
    e.g.
      ```
      - f
        - x X
        + g X
          - h
            + i X
      ```
      has two prefixes:
      ```
      - f
        - x X
        + g X
      ```
      ```
      - f
        - x X
        + g X
          - h
            + i X
      ```
      (note: this step applies after the id-expand step, but we omit those from examples)
  - for each prefix, replace each assert (+) marker with match (-) for the nodes before the head
    e.g.
      ```
      - f
        - x X
        + g X
      ```
      ```
      - f
        - x X
        - g X
          - h
            + i X
      ```
  - yield these rules

2) expandAll
  given: a set of (name, pattern) pairs
  apply `expand` to each, and take the set of results

# step algorithm
define literal-type match *negative*
define literal-type assert, ask, constrain *positive*

step(pattern, reference) // mutates ref
- compute unify-tree to get a set of substitutions
- for each substitution S:
  - generate a copy of reference
  - for each node N containing a positive literal L in pattern:
    - A := S applied to L.atom
    - I := S applied to N.id
    - P := the reference node whose id is S applied to parent(N).id
    - inserts node(I,A,[]) as a child of P in reference

# fixpoint algorithm

nilTree := a tree with one node, whose atom is empty
  (canonical root)

suppose a list of patterns and a reference tree R, initially nilTree
  changed = false
  do
    for P in patterns:
      changed = step(P, R)
  while changed

# editor GUI notes
- use standard text area actions so that any text insertion or keybinding action (see below) can be undone with ctrl+z

## linking source code with output
plan: plans/source-output-linking.md

when cursor is on a `+` line, highlight the set of corresponding assertions in the result.
- use the span info from the parser to determine the pattern node
- from the pattern node, get the id term
- from the id term structure, find the result nodes matching it

example: suppose pattern text is
```
- foo X       (line 1)
  + bar X     (line 2)
```
after idExpand with name "r1", the `+ bar X` node gets id `(id r1 id1 X1)`.
when this rule fires (say X=a), the result tree gets a node with id `(id r1 id1 a)`.
the prefix `(id r1 id1 ...)` is stable — it identifies the source pattern node.
so: parse the result node id, extract `r1` and `id1`, look up which source line produced that (line 2).

heuristics:
- try to scroll so that they are all in view. if they don't fit, scroll to the earliest ones
- apply css class to highlight their background

## terminology
define a line to be *weak* if it consists of optinoal whitespace, optional literal type marker (!/+/?/-), optional whitespace
rule text is *valid* if it parses and fixpoint runs to a result without exhausting gas

## keybindings
<tab>
  if everything before the cursor is whitespace: inserts two spaces
  if the current line is weak and has a type marker: inserts two spaces before the literal type marker
  if text is highlighted, insert two spaces at the start of each highlighted line
<shift-tab>
  if text is highlighted, remove two leading spaces from each highlighted line (if present)
  otherwise, if first two characters of line are whitespace, delete them
<return>
  if current line is weak, replace it entirely with a newline
  otherwise, insert newline, indent to level of previous line, insert copy of previous literal type marker followed by space
<ctrl-]> <ctrl-[>
  cycle to next or previous file available from server. only carried out if current editor contents are valid *and* synchronized with server
<ctrl-s>
  if attached(see below): force a save, even if invalid
  if detached(see below): save to new file
<ctrl-space>
  reset the file parameter, enter detached mode, and clear the editor
<+,-,!,?>
  if current line is weak, delete back until the current literal type is removed; add the typed literal type; then add a space
<ctrl-x>
  if text is selected, cut it (to the clipboard)
  if no text is selected, cut the current line
<ctrl-b> <ctrl-f>
  move cursor back or forward one character
<ctrl-a> <ctrl-e>
  move cursor to beginning or end of current line
<ctrl-p> <ctrl-n>
  move cursor to previous or next line, preserving column

# editor web server
plan: plans/editor-web-server.md
- serve (one or more) rule files.
- set of files stored in ts/data/ directory. any `.sl` file is available
- editor has a state, either *attached* or *detached*
  - in attached mode, the current editor is kept synchronized with a file on the server
    - synchronize whenever the current file content is *valid*
    - the file url parameter is set to the name of the file
  - in detached mode, editor is not synchronized. pressing <ctrl-s> saves to a fresh file on the server
    - the file url parameter can be anything. when <ctrl-s> is pressed, this is used as the filename. the server checks that this does not overwrite a file
      - if there is no url parameter or it is invalid, use current unix timestamp + `.sl` suffix as name
- when client initially loads, attempts to load file specified by url parameter. if it doesn't exist, open empty editor in detached mode

# gui interpretation of programs
plan: plans/gui-interpretation.md
now we implement handling of the `?` `Ask` literal type, which takes user input
- `?` nodes behave initially like `+` nodes
- in the result view, register click handlers for all nodes
- in response to <click> node N:
  - if N is a `?` node, remember it as the last `?` node clicked
  - if N is a `+` node and most recent `?` is M, then assert a tuple `click M N`, where M and N stand for the id's of the nodes
    - assert this new tuple by appending it to the list of input patterns
