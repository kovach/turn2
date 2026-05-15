plan: plans/presentation-software.md

let's build some simple presentation software here.
goals:

- describe a presentation consisting of slides using plain text
- integrate basic features, like text highlighting and `[pause]` command
- navigation either bullet by bullet or whole slide at a time
- integration with turn evaluator, so we can have inline program and program output, or timeline viz

here's an example document:
```
[metadata][%
  title: Turn Intro
  author: Scott Kovach
  date: [today]
%]

[slide][%Purpose%]
- Turn is for describing situations [pause]
- It does stuff

[slide][%The Now%]
A query describes a point in time, reading from top to bottom:
[code][%
turn T       -- during some Turn... [pause]
play-card C  -- a card is played... [pause]
action C     -- that is an action... [pause]
~activate C  -- so activate the card.
%]

[slide][%Demo%]
[code][%
~turn T       -- during some Turn...
~play-card C  -- a card is played...
~action C     -- that is an action...
%][timeline,tuples]
```

- bracket commands: `[name]`, `[name][%body%]`, or `[name][%body%][opts]`
- `[%` … `%]` bodies nest, so they can contain blank lines and brackets
- slides are introduced by `[slide][%Title%]`; blank lines are not structural
- `[metadata]` is not rendered; an auto title slide is built from its `title`/`author`/`date`
- `[code][%...%]` is monospaced and editable; `[pause]` inside it splits the reveal
- `[code][%...%][opts]` options:
  - timeline: small timeline view from web-v2
  - tuples: display output like in `DISPLAY` component from web-v2
- the code is editable in-place; edits stick across slide changes but aren't persisted
- `- ` lines become list items
- `[pause]` anywhere cuts the reveal at exactly that point
