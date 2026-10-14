# Spirit Island FAQ as a test suite: design

The official Spirit Island FAQ on Querki has 853 entries. Each one exists
because a player read the rules one way and the designers meant another. This
sub-project turns the FAQ into two kinds of executable artifact for the Turn
formalization in `si/` (a sibling of `ts/`, untracked):

- a **scenario** per entry: a small game situation, run on the formalized
  rules, whose result must match the FAQ's answer;
- a **misconception** per wrong reading: the same rules with a few lines
  changed so they encode what the confused player believed. The scenario
  must fail on it.

The pair is mutation testing with the mutants chosen by people rather than by a
tool. The scenario shows the formalization gets the answer right; the
misconception shows the scenario can tell the difference, i.e. that it is
checking the thing the question was about and not passing by accident. The
misconceptions are also worth having for their own sake: a catalogue of the
ways the rules get misread, each stated precisely as a diff to a rule.

Status (2026-10-12): data fetched, TODO built, 3 scenarios and 3
misconceptions written, runner in place.

## Layout

All under `si/faq/`.

| Path | What |
|---|---|
| `index.json` | the 853 `{href, question}` pairs from the Querki `Question` page |
| `faq.json` | per entry: id, url, question, answer, category, tags, products, created, modified |
| `fetch_faq.py`, `parse_faq.py` | how the two files above were made (see Data) |
| `build-todo.py` | writes `TODO.md` from `faq.json`, keeping existing status marks |
| `TODO.md` | every entry, grouped by category, with a status mark |
| `tests/q-<id>.t` | one scenario per entry |
| `misconceptions/<id>.json` | one misconception per file |
| `DESIGN.md` | this file |
| `faq.test.ts` | the runner; not part of `./run-tests.sh` (the SI project is untracked, so the repo's suite must not need it); it imports the engine as `turn/src/v2/...` through `si/package.json` |

`<id>` for an entry is its Querki link name without the leading dot
(`.7w4g8qa` → `q-7w4g8qa`); entries with a readable link name keep it
(`q-how-mandatory-are-fear-cards`). The same id is the anchor in `TODO.md`.

## Data

Querki has no single page with every answer; the home page says the site is "a
searchable resource, not a printed document or browsable list". The list comes
from `https://querki.net/raw/darker/spirit-island-faq/Question`, which links
all entries, and each entry is fetched from its own raw page
(`fetch_faq.py <dir>`, one request per 0.4 s, skips pages already on disk;
about 6 minutes). `parse_faq.py <dir>` writes `faq.json`. The category pages
(e.g. `Effect+Rules`) carry full answers for 845 of 853 entries and are a
quicker fallback.

Re-fetching: run both scripts into a fresh directory, copy `faq.json` and
`index.json` here, re-run `python3 -I faq/build-todo.py` from
`si/`. New entries appear as `[ ]`; marks on existing ids
are kept. An entry whose `modified` date moved needs its scenario re-read
(not automated yet).

Snapshot: 853 entries fetched 2026-10-11; 21 categories (Spirits and Innate
Powers 223, Power Cards 146, Effect Rules 69, ...).

## Scenarios

A scenario is a Turn fragment appended to one or more rule files:

```
-- FAQ .7w4g8qa  https://querki.net/raw/darker/spirit-island-faq/.7w4g8qa
-- Q: ...the question, verbatim...
-- A: "...the answer, quoted..."
-- uses: core.t
--
-- what the setup is and why it decides the question
scenario, ~>add-piece l3 town, ~add-piece l3 city
-- expect: count l3 explorer 1
-- expect-not: count l3 explorer 2
```

- `-- uses:` lists files relative to `si/`, concatenated in
  order, then the scenario. Usually `core.t`; add `ext-*.t` files or a
  spirit file as needed.
- The fragment adds to `setup` (static facts: `+defend l1 2`, `+played river p`),
  to `scenario` (pieces placed after setup), and defines any Power it plays
  (`use-power S p, ...`). It does not edit the rule files.
- `-- expect: <tuple>` must appear and `-- expect-not: <tuple>` must not, at
  any time in the run, compared as rendered text with the interval dropped
  (compound terms printed, so `count l3 explorer 1`, `damage-land l1 0`).
  `core.t`'s `report` episode emits `count L K N` per land and kind, and
  `fear F`, at the end of the game; intermediate events (`damage-land`,
  `explore`) can be expected too.
- The run must also reach status `done`.
- Each expect line should be one that a plausible misreading would change.
  `count l1 blight 0` alone is weak if nothing in the scenario could have
  Blighted l1.

The base board (`core.t` setup): l1 and l2 Wetland, l3 Mountain, sea next to
l1; l1 has Town, Explorer, Dahan; l2 has City, Town, 2 Dahan, Blight and
River's Presence; the Invader cards Ravage and Build Wetland and Explore
Mountain. Decisions are `?[rng]` with seed 7, so runs are deterministic.

House rules for writing them:

- **Keep l2 quiet** with `+defend l2 9` unless the scenario is about it. l2
  starts Blighted, so its Ravage cascades Blight into a random neighbour, and
  `core.t`'s cascade has a known looping problem.
- Don't depend on which piece `rng` picks; set things up so every pick gives
  the same verdict (e.g. enough Invaders that losing any one doesn't matter).
- Quote the FAQ answer in the header and say which clause each expect checks.
  An answer with several clauses gets each one checked, or the entry is `[~]`.
- Know the simplifications in the rules you use: `core.t`'s Dahan fight back
  destroys one Invader each; Damage in `bx-damage.t` is single-hit (no
  accumulation over a turn); Blighted Island is simplified in `si-game.t`.
  A scenario that leans on a simplification records it in its header.

## Misconceptions

One JSON file per misconception, `misconceptions/<id>.json`:

```json
{
 "id": "defend-used-up",
 "misconception": "Defend is spent by the first Ravage in a land; a second Ravage there that turn is not reduced.",
 "rulebook": "FAQ .7w4geew \"Defend applies each time ... it isn't 'used up' in the first Ravage.\"",
 "caught_by": { "q-7w4geew": ["missing: count l1 blight 0", "missing: count l1 dahan 1"] },
 "edits": [ { "file": "core.t", "find": "defend L N / defend-total L N", "replace": "..." } ],
 "notes": "..."
}
```

| Field | Meaning |
|---|---|
| `id` | kebab-case name of the wrong belief; equals the file name |
| `misconception` | the belief, in a player's words |
| `rulebook` | the text that contradicts it (rulebook page, or the FAQ itself) |
| `caught_by` | scenario id → problems the runner must report for it (a subset; `[]` means "any failure") |
| `edits` | literal find/replace on a `uses` file; each `find` must occur exactly once |
| `notes` | how the encoding approximates the belief, Turn gotchas met |

Choices:

- **Find/replace on the rule text**, not a separate patch format: the
  snippets stay readable in the JSON, need no tooling, and the exact-once
  check turns a rule-file refactor into a loud failure ("edit must match
  exactly once") instead of a misconception that silently stops applying.
  When that happens, re-anchor the `find`.
- **The misconception edits the rules, not the scenario.** It is the player's
  model of the game that is wrong, so it lives where the rules live and can be
  tried against any scenario that uses that file.
- **Required problems are listed** so a misconception is caught *for the
  right reason*: `defend-used-up` must fail on Blight and Dahan in l1, not on
  something incidental. (While writing it, the first encoding read
  `damage-land` from an `#acc`, but that episode has ended by the next Ravage
  and an `#acc` only sees live tuples, so it changed nothing; the scenario
  passed and exposed the broken mutant. The fix is a `+defend-spent` fact.)
- **A misconception may be caught by several entries, and an entry may catch
  several misconceptions.** The FAQ often answers a question by contrast
  ("Concealing Shadows will only protect the Dahan"), which is a second
  misconception for the same entry.
- Misconceptions should be ones a real player could hold; the FAQ question
  usually states it. Arbitrary breakage ("delete the Build rule") isn't a
  misconception and doesn't belong here.

Current set:

| Misconception | Caught by |
|---|---|
| `explore-per-source`: one Explorer per source | `q-7w4g8qa` |
| `defend-guards-dahan-only`: Defend doesn't reduce Damage to the land | `q-7w4g8nu` |
| `defend-used-up`: Defend is spent by the first Ravage | `q-7w4geew` |

## Runner

`node --import tsx faq/faq.test.ts` (from `si/`).

1. Every `tests/*.t` runs on its `uses` files and must pass.
2. Every misconception runs against each scenario in its `caught_by`, with
   its edits applied, and must fail with at least the listed problems.

`FAQ=<substring>` limits both to matching names; `FAQ_DIR=<dir>` runs a
different folder of scenarios and skips step 2. Gas is 3000 moments / 200000
tuples, as in `run.sh`. Only the relations named in expect lines are
rendered: rendering every tuple ran out of memory, since rendering a fresh
object expands its whole derivation (see memory `turn-silent-timing-traps`).

Planned: a `--matrix` mode that runs every misconception against every
scenario that uses the edited file and prints which entries catch which
beliefs. Unlisted catches are interesting (the entry tests more than it
says), and a misconception no scenario catches marks a gap.

## Workflow and status

`TODO.md` is the work list. Marks: `[ ]` todo, `[x]` scenario passes,
`[~]` passes but some clause of the answer is untested, `[!]` written and
failing (a bug in the rules, the engine, or the scenario; say which),
`[-]` not a rules question (pronunciation, which box to buy) with a reason.
Edit the mark in `TODO.md` by hand; `build-todo.py` keeps it and recounts.

For one entry:

1. Read the question and the whole answer in `faq.json` (TODO shows 320
   characters).
2. If the rules it needs are missing, add them first, as an `ext-*.t` file that
   only adds rules. If that can't be done without rewriting `core.t`, it's a
   finding for the report ("what to change in the language").
3. Write `tests/q-<id>.t`; run `FAQ=<id> node --import tsx faq/faq.test.ts` (from `si/`).
4. Write the misconception the question implies; add it to `caught_by`; check
   it is caught for the listed reasons.
5. Set the mark.

### Order of work

An estimate from tags (each entry's tags against what is formalized:
spirit special rules from `findings/*.json`, base mechanics from `core.t`,
`ext-*.t`, `si-game.t`, and the few real cards in `si-game.t`): about 60
entries need nothing new, 38 on special rules that `findings` marks "works"
and 22 touching a "partial" one. Start there, then take features that unlock
the most entries. Tags that alone block an otherwise ready entry:

| Feature | Entries it alone blocks |
|---|---:|
| Deeps Aspect (Ocean) | 5 |
| Repeat, Presence track, Instruments of their Own Ruin, Ward the Shores | 4 each |
| France, Sweden (beyond level 1), Second Wave, Isolate, Claim, Timing, Ordering, Events | 3 each |

Most entries need several missing things at once: Aspects, Adversaries,
Scenarios, Events, Blighted Island cards, innate powers, the spirits' own
cards and Growth. Spirit files implement special rules only; their Powers are
placeholders. The tag estimate misses rules a question uses but isn't tagged
with; expect the ready set to shrink a little on reading.

## Open questions and risks

- **Errata.** 14 entries carry the tag "Changed rulings". A scenario follows
  the current ruling; the old ruling is a natural misconception (with a
  `rulebook` field citing the printing it came from).
- **rng dependence.** Seed 7 makes runs repeatable but can hide a scenario
  that only passes on one choice sequence. A later pass could run each
  scenario under several seeds (`run.sh` already supports `SEED`).
- **Which rules file.** Spirit files sometimes come with their own `core-*.t`
  variant (`core-green.t`, `core-hearth.t`); `uses` must name the variant, and
  a misconception edit names the file it edits.
- **Simplifications as false passes.** A scenario can pass because the rules
  are simpler than the game (Damage that never accumulates can't get
  accumulation wrong). The misconception step guards against this: if the
  wrong rule can't even be written against the current rules, the entry is
  `[~]` until the rules can express it.
- **Answers that are about players, not rules** ("can I take back a choice",
  "is the Fear Card text mandatory") may still be testable as constraints on
  choices; decide per entry before marking `[-]`.
- **Cost.** Each scenario is a full game turn on the small board, under a
  second. 850 of them in one run is fine; if it isn't, group them by
  `uses` and parse the rule files once.

---
Claude Opus 5.5 (claude-opus-5-5)
