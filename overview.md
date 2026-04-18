# todo
things to add to overview below:

- very basic code overview
  - (ts plugin?) to enumerate all function names
    - and print their size in expressions
- keybinding to generate new test
  - file format for a behavioral unit test: program + expected output
  - keybinding to take current file, write it out as a unit test with its current output concatenated
  - editor can load unit test; displays warning if output differs from expected
    - keybinding to update expectation

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
    - for each path from a node in pattern to the root of pattern, the corresponding reference nodes also lie on a path in reference
      - **note**: the path need not be in order. the pattern `(foo (bar))` should match the reference `(bar (foo))`

to compute unify-tree:
  - init empty substitution
  - traverse the nodes in pattern in any order
    - for each, enumerate candidates from reference, constrained by the path condition and the substitution so far
  - return set of all reference terms that unify

notes:
  - we are ignoring the atom-type for now. assume all atoms that show up have type match

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

the syntax is `*[<term>]` where `*` stands for a literal type.
this should be a minimal change to the parser

# evaluation
plan: plans/evaluation.md

## filling in `.id`
1) id-expand
  given: a pattern tree and a *name* string
  each tree node needs an id value, depending on literal type.
  these are filled in top to bottom (starting from the first line of the pattern and going down)
  - `match` node gets a fresh id variable (generate var string in some syntactic way)
  - each `assert` node gets an atom term; the atom has the following form:
    `[sym("id"), sym(name), ...previous_vars]`, where
      - `previous_vars` :=  the preceeding id variables and the variables appearing within the earlier atoms
  - `ask` and `constrain` treated same as assert

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
      + g (id r1 X)
        - h X2
          + i (id r1 X1 (id r1 X) X2)
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

deepestAncestorImage: see tree.ts

step(pattern, reference) // mutates ref
- compute unify-tree to get a set of substitutions
- for each substitution S:
  - generate a copy of reference
  - for each node N containing a positive literal L in pattern:
    - A := S applied to L.atom
    - I := S applied to N.id
    - P := deepestAncestorImage applied to the parent of N
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

## terminology
define a line to be *weak* if it consists of optinoal whitespace, optional literal type marker (!/+/?/-), optional whitespace
rule text is *valid* if it parses and fixpoint runs to a result without exhausting gas

## keybindings
<tab>
  if everything before the cursor is whitespace: inserts two spaces
  if the current line is weak and has a type marker: inserts two spaces before the literal type marker
  if text is highlighted, insert two spaces at the start of each highlighted line
<shift-tab>
  if first two characters of line are whitespace, delete them
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
