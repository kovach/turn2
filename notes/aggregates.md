
see plans/aggregates.md

Introduce a new syntax to compute an *aggregate* at a particular point of the tree.
The aggregate is determined by folding a function over the result of a certain local query.

## Example 1
  ```
  - root
    + move a here
    + move b there
    + move a there
    # count -> N
      < move _ _
    + note N -- N = 3
    # count -> N
      < move a _
    + note N -- N = 2
  ```

## Example 2
  pattern =
  ```
  - foo X
    + bar a 1
      + ok
    + bar a 3
      + ok
    + bar b 5
    # sum Y -> Total
      < bar X Y
        - ok
    + result Total
  ```
  reference =
  ```
    + foo a
  ```
  asserts `result 4`
  but if reference =
  ```
    + foo b
  ```
  then asserts `result 0`

## Example 3
  ```
  + move a here
  + move b there
  # last L -> L1
    < move a L
  + note L1 -- here
  + move a there
  # last L -> L2
    < move a L
  + note L2 -- there
  ```

## Definition
- the syntax is `# agg-expr\n indented local-pattern ...`
  - we evaluate local-pattern on every temporal previous tuple, treating each like a root.
    - any variables appearing in local-pattern that were bound earlier in the
      outer pattern (in which this expr appears) are fixed; others that are
      free before this line are bound by the aggregation query.
    - the result of the local-pattern query is an ordered (by temporal order) list of substitutions
  - then we evaluate the agg-expr on the result of the local-pattern query
    - an agg-expr is the name of a ts function followed by zero or more terms followed by "->" and a Term
      - e.g. `sum X -> Total`
    - in this case, `function sum(accumulator: Term, X: Term): Term { ... }` is assumed to be a ts function in particular module
    - the ts function is a fold function, and the end result comes from folding over the local-pattern substitutions
    - the terms before "->" specify how to map bound values from a given local-pattern substitution to the positional arguments of the agg function
      - e.g. say the local pattern binds `X=1,Y=2,Z=3`, and the agg-expr is `operate (p X Y) Z`.
        then the function operate will be called like `operate(acc, t1, t2)` where `t1 = atom(p,1,2)` and `t2=3`
    - each agg function is also marked by an initial zero value to initialize `accumulator`
    - the result of the fold is unified against the term to the right of "->"
- initial aggregate functions to implement:
  - `count -> N`: count the number of matches
  - `sum X -> N`: take `X` values bound by local-pattern and sum them
    - assume that all the `X` values will be `sym(...)` terms applied to string representations of integers; runtime error otherwise
  - `last A -> B`: takes only the most recent node matching local-pattern. binds that substitution's A value to B

## Definition attempt 2
  - each occurrence of `# name ...` generates three rules:
    - the prefix leading up to this node
    - a query rule containing the local-pattern
    - and a suffix which matches the aggregate result and contains every node after this one
  - we explain this with an example:
    ```
    -- sum up all the `t X` values appearing below the `foo` node just before a `bar` node, and record the total under `bar`:
    - foo
      ...
      # sum X -> N
        - t X
    - bar
      + note N
    ```
    becomes 3 rules total:
    ```
    - foo
      ...
      +[Id] agg-instance lexId

    - foo
      ...
      -[Id] agg-instance lexId
      - t X
      + agg-binding lexId Id X

    - foo
      ...
      - agg-result lexId Id N
    - bar
      + note N
    ```
  - the Id can be allocated as usual during `idExpand`, treating a `#` node like a `+` node
  - the rest of the process is similar to `expand`, except that the suffix refers to `- agg-result` instead of `- agg-instance`
  - this expansion needs to be done within the `expand` method
    - they are handled just like `+` nodes, except that when we `pruneAndConvert`, the node goes from `+ agg-instance` to `- agg-result`
  - in general, `- foo` may be some arbitrary context, and `-t X` may be some arbitrary pattern expression. the latter can refer to variables bound by the former, and the `agg-binding` may capture whichever variables it wishes
    - this does not require any special handling; it should fall out from the simple manipulation suggested above

  - the agg-result tuple is constructed via special handling inside `fixpoint`
  - after all rules have hit a fixpoint, we check for any `[Id]agg-instance lexId` that is missing the corresponding `agg-result lexId Id Y`
  - to compute result,
    - first collect all `agg-binding Id X` nodes
    - *sort* them by temporal ordering
      - if they cannot be ordered, runtime error
    - fold over them, by temporal ordering, using the approach given in Definition above
    - save final result N via `+agg-binding Id N`

## Misc notes
- NB: none of the local bound variables are in scope for the remainder of the query pattern; only things to right of "->" are bound
