# v2 design notes
see notes/v2-design.md (living document for cross-file v2 invariants)

# v2 — tag compiler-generated identity terms as Id
plan: plans/v2-id-tagging.md

# v2 timeline view
plan: plans/v2-timeline-view.md

- a visualization pane that lays moments out left-to-right by partial order
- `~` episodes as labeled bars between their endpoints
- `+` facts as vertical lines at their left endpoint with the tuple text below
- arrows between moments along the Hasse reduction of the moment order
- `^` tuples align automatically since identical moments share an x-coordinate

# update editor keybindings
plan: plans/v2-editor-keybindings.md

# update editor
plan: plans/v2-editor-ttt.md

# redo choice
plan: plans/redo-choice.md

- port the choice syntax to v2
  - see end of notes/turn-program-1.t and the edit inside it to `!` tuples

- re-establish the "scheduling" pattern
  - rules with an aggregate as their next operation should block until other rules reach a fixpoint
  - any `_choose` tuple is also "blocked"
  - earliest blocked _choose or aggregate may proceed. to proceed:
    - aggregate is computed
    - in case of choice, computation is just stuck. the harness waits for a new user choice and restarts computation from scratch

# new semantics
plan: plans/new-semantics.md

this proposes major changes to the syntax and semantics.
this should be implemented parallel to the existing project code until ready to switch over.
there is substantial conceptual overlap with the existing language and editing tools, so we are not initiating a fresh project

see this program for a tutorial:
notes/turn-program-1.t

# rule name parsing
plan: plans/rule-name-parsing.md

- add a step to the parser that parses an optional rulename prefix for each rule
  ```
  : rule
  - foo
    + bar
  ```

  - new `:` node
  - at most one per rule, must be first statement
  - if missing, do the current auto-gen behavior (r1, r2, ...)

- before expansion, check that the initial program has unique name per rule

# static dispatch
plan: plans/static-dispatch.md
status: waiting

# new flat relational IR
plan: plans/flat-relational-ir.md

- new IR called TurnExpr (*TE* for short); convert tree into TurnExpr before evaluation
- TE is a list of constraints, each of which is an *atom* or an *episode relationship*
- key idea is that the temporal relationships handled by parent/child and before/after (via TreeBody.children) are more explicit
- episode relationships:
  before:after, contains, prior, overlap
- atoms: same as now: an id and a list of terms, usually the first one being a symbol
- each of Assert, Constrain, Aggregate, Ask will become a leaf node in the new type
- there will be only one negative leaf node
- the current negative nodes (Match, Before, Overlap) will be translated to one leaf node + whatever constraints on their children
- key question: where in pipeline do we implement this

# reifying choice option tuples
plan: plans/reify-choice-options.md
status: pending refactorings to simplify. abandoned

- instead of evaluating choice "components" outside of the fixpoint loop,
  materialize the option query as a pattern and evaluate it "normally"
- first step: add a general method for adding a new pattern rule to a fixpoint in progress.
  the new rule should see all tuples it would have seen had it been present all along;
  we will assume that this feature is only used on *safe* rules that would not have changed the course of the program, that is (in pseudocode):
    -- running join program from empty set = running joint program from fixpoint of base program
    fix(P+P', {}) = fix(P+P', fix(P))

# separate id terms from atom
plan: plans/separate-id-terms.md

- it is dangerous to ever recursively traverse id nodes, because they grow exponentially in absolute size
- currently they are represented using the same term node type (Atom) as user defined compound values, which typically do not grow exponentially
- we will add a new Term constructor, `Id`: `| { tag: "Id"; atom: Atom }`,
  which will behave like `Atom` in most respects, but individual functions will likely treat differently

# implement constraint tuples pt1
plan: plans/constraint-tuples.md

## step 0: refactor `Ask`
- ask becomes a node without TreeBody; instead it has two fields: an id and an array of Variable
  - represent this array as an Atom, but check during parsing that each is a variable
- it is a positive node type, and subject to the step where `id` and unbound variable terms are expanded into Atom terms, just like `id`
  - that is, the atom of terms will be expanded into `id` atom terms
- similar to how aggregate nodes are expanded into Assert of `agg-instance`, expand these nodes into Assert of `choose` with given id and atom of arguments

## step 1: recognizing active choices
- we are going to stop fixpoints early if there is an *unresolved choice* that is *earlier* than any pending aggregate
  - an unresolved choice is a term C which was asserted by an `Ask` atom like `?choose C` that
    does not have a corresponding `is C Value` tuple in the store.
- recall that, while evaluating aggregates, we only resolve a pending aggregate that has no earlier pending aggregate
- we are going to consider all unresolved choices and pending aggregates together
  - if any of the earliest things are aggregates, resolve those aggregates
  - if all of the earliest things are choices, break out from the fixpoint.
- the fixpoint now returns a tagged union indicating the reason for breaking
  - if pending choices, it should return the set of all pending/"active" choices (e.g., a list containign the actual atom bound to `C`)
  - if it runs out of gas, returns number of steps run
  - otherwise it returns a default case indicating completion

## step 2: processing Constrain tuples in the output
- the `Constrain` tuples should behave similar to Assert during fixpoint calculation
  - Constrain nodes are positive
  - match nodes do not match `Constrain` tuples in ref store
- if the fixpoint breaks due to a pending choice, we will analyze the choice term
  - calculate the fringe (see below) for the choice term
  - filter to only the `Constrain` tuples in the fringe
- interpret the fringe as a query
  - each tuple is like a `match` atom
  - each choice term becomes a variable
  - combine the fringe tuples as siblings within the match root.
    - so e.g. `card C` and `prop C` becomes the pattern
      ```
      - card C
      - prop C
      ```
  - normally this pattern would do nothing (since it contains no positive node).
    instead, run this as a one-off query wrt the current tuple store
  - display the options as a list to the user

## step 3: web.ts interface
- the `web.ts` interface will change somewhat significantly
- instead of the existing code for locating choices and binding them to clicks, we will extract the available choice(s) from the fixpoint output
  - e.g. in the ttt.sl/ttt.js example, clicking will respond to the currently active choice
- the fringe query will be displayed

# refactor Tree type pt 4
split connective/positivity coupling

# refactor Tree type pt 3
plan: plans/refactor-tree-type-pt3.md

- now remove the id, atom, and children fields from TreeBase; every case still needs them except for Equal
- check that no behavior depends on Equal having those fields

# refactor Tree type pt 2
plan: plans/refactor-tree-type-pt2.md

goal: simplify NodeRow

- the nilTree should have an assert tag, not Match
- check this claim: the only calls to buildRefStore pass in the nil tree
  - if true: we can get rid of buildRefStore (which takes an arbitrary Tree), and rewrite it to just construct the canonical empty store
- check this claim: every other insert inserts either an `Assert` or `Ask`
  - if true: we don't need the wide NodeRow type; we only need a couple of cases for positive tags

# refactor Tree type
plan: plans/refactor-tree-type.md

propose a refactor to the Tree type (types.ts) that merges together Tree, Literal, and LiteralType.
- afterwards, there should be one case of Tree per current case of LiteralType
- initially, the types should be isomorphic and all other code should behave the same
- note that as the project developed, Tree was used both for patterns and reference trees,
  but currently the reference is stored using a different type

# eliminate Variables in output
plan: plans/eliminate-variables-output.md

# fix agg-instance nesting
plan: TODO

- motivating case: the "last aggregate" test in `ts/src/fixpoint.test.ts`
  (currently skipped behind `if (false)`) trips the
  `sortBindings` throw for non-commutative aggregators. The three
  `agg-binding` siblings under a single `agg-instance` are not
  orderable via `before`: each `bnd_i` gets only `before:after(t_i, bnd_i)`
  and nothing links `bnd_a → bnd_b → bnd_c` to each other.
  Transitive-closing `before` does not fix it — the graph is divergent
  (`t_a → {bnd_a, t_b}`), not a linear chain through the bindings.
- fixing this requires redoing how `agg-binding` rules are constructed.
  we need the `agg-binding` to be localized at the result of the query,
  but we don't have pattern definitions that let us express this yet.

# new temporal relationships/removing totally ordered child requirement
plan: plans/temporal-relationships.md

- currently we assume each new node is inserted as a "last" child of its parent, and each node has a unique tree path from the root to itself by following these parent/child links
- we want to change the semantics to remove these restrictions:
  - after the change, it will be possible to assert `parent:child(x, y)` for any pair of nodes, although we expect this relation to be a valid partial order
  - we will keep the `children` array as an index optimization to efficiently iterate the child nodes of a parent,
    - but (!) the index ordering no longer connotes temporal order
    - instead, a new `before:after(x, y)` relation will hold atomic facts about temporal order
  - the logic for matching candidate nodes will mostly stay the same, but the implementation will differ.
  - first we introduce some new ideas about what the nodes represent

- This change will make more explicit several temporal relationships that are implicit in the code so far.
  In brief, each tree node represents an interval of time, and these intervals can be nested or sequential:
  - Example (1):
    ```
    + [A] a
      + [B] b
      + [C] c
    ```
    - this pattern creates three intervals. A contains B, and A contains C.
    - we interpret sequential `+` sibling nodes as being temporally sequential: so the interval B is before C
    - graphically, the result looks like `(A (B --) (C --) )`
    - a query like
      ```
      - [A] a
        - [C] c
        - [B] b
      ```
      - matches any `c` and `b` both contained within an `a` — two
        Match siblings impose no ordering constraint between
        themselves.
  - Overview of temporal relationships:
    - *containment*: A contains B if A=B or A is an immediate parent of C and C contains B (transitive reflexive closure of parent:child)
    - *before*: A is before B if there exist A',B' with `before:after(A',B')` and A' contains A and B' contains B
    - *prior*: A is prior to B if A is before B or B contains A
    - *overlap*: A and B overlap if there exists a C such that A contains C and B contains C
      - note that every interval contains itself, so overlaps itself, and if A contains B, then they overlap
  - We will introduce a new literal type, `,`, which matches so long as the given atom overlaps the parent anchor
    ```
    - [A] a
      , [C] c
      , [B] b
    ```
    this matches against example (1).

# relational storage
plan: plans/relational-storage.md

- currently we use a tree alongside a set of indexes to handle queries and hold state over time
- the structure of the tree is used for pattern matching:
  - the hierarchy is used to resolve `-a\n  -b` (b must match a descendent of a)
  - and `-a\n<b` (b must match a predecessor of a)
- idea: store reference tree relationally. each node is a tuple stored in a flat set.
  each parent relationship is an explicit fact `(parent:child A B)`
  each sibling relationship is also explicit `(before:after A B)`
- most of unify becomes database queries

# string interning
done

since each node has a unique parent, this is well-defined
`... root -> a ...  -->  ... root -> b -> a ...`

# semi-naive evaluation
plan: plans/seminaive.md

# further perf
plan: TODO

- pre-filter by children of node in case of `-a\n  -b` query (currently we only filter by `b` tuples)

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
- parse this from a comment block at the file top:

```
/ display: ttt.ts
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
