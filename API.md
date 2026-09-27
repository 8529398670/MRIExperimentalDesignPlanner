# MRI Experimental Design Planner: design API

Everything a button in the planner does is also an **action**: a small JSON object you can
send over HTTP. An agent can build, solve and export a complete study with no browser.
Every action runs the same JavaScript the buttons run. The server executes it in an embedded
interpreter, so the API and the interface always agree.

- Live index (JSON, machine-readable): `GET /api/v1`
- This document, with a regenerated action reference: `GET /api/v1/docs`
- Base URL: wherever the planner runs, e.g. `http://127.0.0.1:8761` (Docker) or
  `http://127.0.0.1:8760` (`./run.sh`)

## Authentication

Reading is open: anyone may use every `GET`, except the exports. Every write (any other method,
including a batch of read-only actions) and every `GET .../export/<format>` needs an **API key**
(or a person's session). Without one the answer is `401` with `"viewOnly": true`.

Someone signed in makes the key: **People → API keys**, name it for what will use it
**Make a key**. It is shown once, so copy it then; only a hash is kept. Send
it with every call:

```bash
KEY=mrip_...                 # the key, as shown once in People
curl -s -H "Authorization: Bearer $KEY" localhost:8761/api/auth/me
# -> {"id": "key:3f9c...", "name": "req-1", "key": "3f9c...", "by": "asdf"}
```

A key can do everything a person signed in can: change any design, run actions, change the
acquisition cards, save and delete designs, and export. It cannot manage people, login links or
keys (`/api/auth/*` answers `403`, except `GET /api/auth/me`), so revoking a key that got out
is the end of it. A key does not expire. It stops working when someone revokes it in
**People**, or when the person who made it is removed; the answer is then `401` saying the token
is not recognised. Keys are only accepted in the `Authorization` header, never as a cookie.

A person's session token (from spending a login link with `POST /api/auth/redeem`) works as a
Bearer token too, but a key can be named, listed and revoked on its own, so prefer one.

## Quick start

```bash
KEY=mrip_...                 # an API key: see Authentication

# 1. Look at the working design, the one at / in the interface (ids, names, and a solved summary)
curl -s localhost:8761/api/v1/designs/current

# 2. Change it: a list of actions, run in order, then solved and saved
curl -s -X POST localhost:8761/api/v1/designs/current/actions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"actions": [
        {"action": "budget.update", "totalScannerHours": 80},
        {"action": "run.update", "run": "Event-related run", "trialsPerBlock": 12}
      ]}'

# 3. Take the results away
curl -s -H "Authorization: Bearer $KEY" localhost:8761/api/v1/designs/current/export/methods
curl -s -H "Authorization: Bearer $KEY" -o study.zip \
  localhost:8761/api/v1/designs/current/export/bundle
```

Any page open on the design shows the change within a few seconds. Every design has a page of
its own: `/` for the working design `current`, and `/designs/<name>` for each saved design.
That page works on its design - edits made there save to it - so the link is the way to hand
a design to a person. Inside a design, each panel and item has an address too, so a link can
point at exactly the thing to look at. Use the ids `design.get` returns: `/sessions/<id>`,
`/trials/<id>`, `/runs/<id>`, `/experiments/<id>`, `/acquisition/<card slug>`, or
`/designs/<name>/sessions/<id>` in a saved design.

## The shape of a call

**Request:** `POST /api/v1/designs/<name>/actions`

```json
{
  "actions": [
    {"action": "trial.add", "name": "Main trial", "objective": "estimation"},
    {"action": "phase.update", "trial": "Main trial", "phase": "Delay", "min": 8, "max": 12}
  ],
  "dryRun": false,
  "include": ["design"]
}
```

- Each action is `{"action": "<name>", ...arguments}`. You can also nest the arguments as
  `{"action": "<name>", "args": {...}}`.
- The body may also be a bare list of actions, or a single action object.
- `dryRun: true` runs the batch and answers, but saves nothing. Use it for what-if questions
  such as "how many sessions would 120 hours buy?".
- `include` can ask for `"design"` (the full saved state) and/or `"report"` (the full solved
  report). By default you get the summary only.

**Response** (HTTP 200, or 422 if an action was refused):

```json
{
  "ok": true,
  "name": "current",
  "rev": "31dd8c89128d",
  "saved": true,
  "applied": 2,
  "results": [
    {"action": "trial.add", "result": {"id": "trial-muh5...", "name": "Main trial", "phases": ["..."]}},
    {"action": "phase.update", "result": {"index": 2, "phase": {"name": "Delay", "min": 8, "max": 12}}}
  ],
  "summary": {"totals": {"sessions": 60, "usableHours": 54, "...": "..."}, "experiments": ["..."]},
  "warnings": []
}
```

On a refusal, `ok` is false and `error` says which action failed and why, for example
`{"index": 1, "action": "run.update", "message": "run.update has no argument \"trialsPerBlocks\". It takes: run, name, ..."}`.

## Rules worth knowing

| Rule | Detail |
|---|---|
| **Order, and the first refusal stops the batch** | Actions run in order. If one is refused, the ones before it are kept (and saved), and the rest are not run. Fix the call and resend from `error.index`. |
| **Refer to things by name or id** | `trial`, `run`, `session` and `experiment` arguments accept an id or a name (exact first, then ignoring case). `card` accepts a slug or a card name, and is also accepted as `protocol`, the name the design stores it under. |
| **Send back what you read** | Any item from `design.get` can go back to its `*.update` action as it is, changed or not. Its `id` names it, so the item argument can be left out. The lists (`phases`, `blocks`, `plan`) go back whole the same way, and block ids you send back are kept. A field sent back with the value it already has is always accepted, even one the action cannot change. A changed field an action cannot take is refused, and the refusal names the action that can. |
| **Names are unique** | Adding or renaming refuses a name already used at the same level, so names stay safe to refer to. |
| **Positions are 0-based** | Phases are addressed by position or by a unique phase name. Session blocks are addressed by block id or position. Plan rows are addressed by position or by the session's name. |
| **Moves** | Every `*.move` takes `to` (a 0-based position) or `delta` (-1 is one earlier, +1 one later). The target is clamped to the list. |
| **Every batch ends with a solve** | Repairs the solver makes against the caps (with auto-clamp on) are saved, just as in the interface, and reported in `warnings`. |
| **Plan counts are a mix** | An experiment's plan counts are a ratio that the solver scales to the budget or the goal, unless `lockPlan` is true. With `lockPlan` they are literal session counts. |
| **Refusals explain themselves** | An unknown action suggests close names. An unknown argument lists the valid ones and names the action that takes it. An unknown name lists what exists. |
| **Server actions** | `card.*`, `design.saveAs` and `design.loadPreset` change files on the server. They are refused in a dry run. Acquisition cards are shared by every design. |
| **Speed** | Most batches take well under a second. `trial.optimiseTiming` is a grid search and can take up to about 30 s on a slow host; `trial.solveSeparation` is the fast, analytic alternative. |

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1` | Index: endpoints, conventions and every action with its arguments |
| GET | `/api/v1/docs` | This document, with the action reference regenerated from the code |
| GET | `/api/v1/designs` | Saved designs, each with the `url` that opens it in the interface. `current` is the working design, at `/` |
| POST | `/api/v1/designs` | Create a design: `{"name": "...", "from": "default" \| "blank" \| "<design>", "design": {...}?, "overwrite": false}` |
| GET | `/api/v1/designs/<name>` | The stored design, its revision, its `url` and a solved summary |
| DELETE | `/api/v1/designs/<name>` | Delete a saved design (not `current`) |
| POST | `/api/v1/designs/<name>/actions` | Run actions (above) |
| GET | `/api/v1/designs/<name>/report?view=summary\|full\|warnings` | Solve and report without changing anything |
| GET | `/api/v1/designs/<name>/export/<format>` | `markdown`, `methods` (text), `psychopy` (JSON, or `?run=<run>` for one YAML file), `json`, `figures` (SVG), `xlsx`, `bundle` (zip) |

Workbooks and bundles built through the API are archived in `exports/`, as they are from the
interface. The bundle has SVG figures but no PNGs, because the server has no browser to
rasterise them.

## A study from scratch

Create a separate design, so the one open in the interface is untouched, then build it in
one batch:

```bash
curl -s -X POST localhost:8761/api/v1/designs \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"name": "pilot", "from": "blank"}'
```

`from: "blank"` gives one of each level, wired together: `Trial design` → `Run design` →
`Session` → `Experiment`. Rename and extend them:

```json
{"actions": [
  {"action": "study.update", "studyTitle": "Inner speech pilot", "investigator": "A. Researcher"},
  {"action": "budget.update", "totalScannerHours": 60, "contingencyPct": 10},

  {"action": "trial.update", "trial": "Trial design", "name": "Main trial", "controlPct": 10},
  {"action": "trial.setPhases", "trial": "Main trial", "phases": [
    {"name": "Fixation", "role": "baseline", "min": 2, "max": 6},
    {"name": "Question", "role": "stimulus", "min": 4},
    {"name": "Delay",    "role": "delay",    "min": 6, "max": 10},
    {"name": "Answer",   "role": "response", "min": 3},
    {"name": "Tail",     "role": "baseline", "min": 10, "max": 14}
  ]},
  {"action": "trial.solveSeparation", "trial": "Main trial", "tolerancePct": 10},

  {"action": "run.update", "run": "Run design", "name": "Main run",
   "card": "EPI-TR1000-Task", "trialsPerBlock": 12, "blocksPerRun": 3},

  {"action": "session.update", "session": "Session", "name": "Scan day"},
  {"action": "block.add", "session": "Scan day", "kind": "break", "label": "Stretch", "minutes": 2},
  {"action": "block.add", "session": "Scan day", "kind": "run", "run": "Main run"},

  {"action": "experiment.update", "experiment": "Experiment", "name": "Decoding",
   "unit": {"noun": "question"}, "targetUnits": 800},

  {"action": "report"}
]}
```

Send that to `POST /api/v1/designs/pilot/actions`. To show it to a person, give them the `url`
from the create answer (`http://<host>:<port>/designs/pilot`): it opens the planner on `pilot`,
and a page left open there follows each batch you send. To bring it into the working design
instead, run `design.loadPreset` with `name` set to `pilot` against `current`.

## From inside the page

An agent that drives a browser can use the same actions from the page's console:

```js
await PlannerAPI.run([{action: 'budget.update', totalScannerHours: 80}])  // same answer as HTTP
PlannerAPI.actions()                                                       // the catalogue
```

`PlannerAPI.run` saves anything pending in the page, runs the batch through the server on the
design the page has open (`current` at `/`, `<name>` at `/designs/<name>`), and shows the result.

## Controls with no action

These only change what is on screen, not the design: the panel rail, plot zoom and pan, figure
downloads (use `export.figures`), and the Copy Markdown and Copy for Word buttons under tables
(use `export.markdown`). Plain field edits have no action of their own; each belongs to its
level's `*.update` action, and the `ui` field of every catalogue entry names the controls it
covers.

## Action reference

Generated from `static/js/api.js`. Regenerate it with `python server.py --write-api-docs`;
`GET /api/v1/docs` always serves a fresh copy. Required arguments are in **bold**; the
same information, machine-readable, is the `actions` list in `GET /api/v1`.

<!-- action-reference:start -->

### Design

#### `design.get` _(read-only)_
The whole design as stored: every trial, run, session, experiment and setting, with ids. Button: _Report and export > Download working design_

#### `design.reset`
Start again. The shipped example study, or with blank=true one trial, run, session and experiment wired together. Button: _Report and export > Reset to defaults_

- `blank` (boolean, default `false`): One of each level instead of the three-experiment example

#### `design.replace`
Replace the design with a JSON design (a bare design or a downloaded {design, report} file); anything missing is filled from the defaults. Button: _Report and export > Import JSON file_

- **`design`** (object): The design object, as design.get returns it

#### `design.set`
Escape hatch: write one value at a dot path such as "budget.totalScannerHours" or "runs.0.leadIn". No validation beyond the path existing - prefer the typed actions. Button: _Any field, by its path in the design_

- **`path`** (string): Dot path from the top of the design, e.g. "caps.maxRunMinutes"
- **`value`** (any): The value to write

#### `design.saveAs` _(server)_
Save a copy of this design under another name (the design you are editing is saved automatically). Button: _Report and export > Saved designs > Save as_

- **`name`** (string): Name for the saved copy; letters, digits, dot, dash, underscore

#### `design.loadPreset` _(server)_
Replace this design with a saved one. Button: _Report and export > Saved designs > Load_

- **`name`** (string): Name of the saved design (GET /api/v1/designs lists them)


### Study

#### `study.update`
Titles and identifiers printed on every export. Takes its item back as `design.get` returns it. Button: _Study details panel_

- `studyTitle` (string): Study title
- `investigator` (string): Investigator
- `institution` (string): Institution
- `participantId` (string): Participant ID
- `designId` (string): Design ID
- `notes` (string): Free notes


### Budget

#### `budget.update`
Scanner hours, contingency, calendar and how session counts are decided. Takes its item back as `design.get` returns it. Button: _Budget panel > Solve mode and Scanner-time envelope; Overview > Drive the sliders in_

- `solveMode` (`budget` | `fill` | `target` | `manual`): budget: spend the hours; fill: one study-wide goal; target: each experiment to its own goal; manual: session counts set by hand
- `targetUnitsTotal` (integer, at least 0): The study-wide goal used by solveMode "fill"
- `countOverheadAgainstBudget` (boolean): Charge setup, structurals and breaks to the hours
- `autoClamp` (boolean): Let the solver reduce blocks, trials or runs that break a cap
- `totalScannerHours` (number, at least 0.1): Scanner hours available
- `contingencyPct` (number, 0 to 90): Reserve held back from the hours, percent
- `sessionsPerWeek` (number, at least 0.1): Sessions per week, for the calendar
- `weeksAvailable` (number, at least 0.1): Weeks available, for the calendar
- `allocationUnit` (`percent` | `hours` | `sessions`): What the allocation sliders are driven in. "sessions" seeds each experiment's session count from the current solution and switches to solveMode "manual", as the interface does

#### `caps.update`
The caps the solver repairs against. Takes its item back as `design.get` returns it. Button: _Budget panel > Constraint envelope_

- `applyTo` (`expected` | `longest`): Judge caps against the expected or the longest duration
- `maxRunMinutes` (number, at least 0.1): Longest a run may be, minutes
- `maxSessionMinutes` (number, at least 0.1): Longest a session may be, minutes
- `maxRunsPerSession` (integer, at least 1): Most runs in one session
- `maxSessionsTotal` (integer, at least 1): Most sessions in the whole study
- `maxContinuousMinutes` (number, at least 0.1): Continuous-scanning comfort limit, minutes
- `minUnitsPerExperiment` (integer, at least 0): Floor on what each experiment collects


### Allocation

#### `allocation.set`
Set one experiment's share of scanner time; the unlocked others redistribute so shares total 100. Give exactly one of percent, hours or sessions. Button: _Overview > Time split between experiments (the slider, in any unit)_

- **`experiment`** (experiment id or name): Which experiment
- `percent` (number, 0 to 100): Share of scanner time, percent
- `hours` (number, at least 0): Hours of the usable budget
- `sessions` (integer, at least 0): Session count; switches solveMode to "manual"

#### `allocation.lock`
Hold an experiment's share while the others redistribute. Button: _Overview > Lock / Locked; Experiments > Lock this share_

- **`experiment`** (experiment id or name): Which experiment
- `locked` (boolean, default `true`): true to lock, false to unlock

#### `allocation.balanceToGoals`
Set every share from what each experiment's own goal costs in scanner time. Button: _Overview > Balance to the goals_

#### `allocation.evenSplit`
Give every switched-on experiment the same share, unlocking them all. Button: _Overview > Even split_


### Trials

#### `trial.add`
A new trial design with the recommended phases for its objective. Button: _Trials > Add trial design_

- `name` (string): Name (default "Trial design", numbered if taken)
- `objective` (`detection` | `estimation` | `separation`, default `estimation`): detection, estimation or separation; sets the starting phases and tolerance
- `note` (string): Free note

#### `trial.duplicate`
Copy a trial design and place the copy right after it. Button: _Trials > Duplicate_

- **`trial`** (trial id or name, also `id`): The trial design to copy
- `name` (string): Name for the copy (default: "<name> (copy)")

#### `trial.remove`
Delete a trial design. Refused while a run design uses it, or if it is the last one. Button: _Trials > Delete_

- **`trial`** (trial id or name, also `id`): The trial design to delete

#### `trial.move`
Reorder the trial design list. Button: _Trials > up / down arrows_

- **`trial`** (trial id or name, also `id`): The trial design to move
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `trial.update`
Change any of a trial design's fields. Takes its item back as `design.get` returns it. Button: _Trials > Identity, Embedded control slider, Separation solver slider, Trial phases_

- **`trial`** (trial id or name, also `id`): Which trial design
- `name` (string): New name
- `note` (string): Free note
- `objective` (`detection` | `estimation` | `separation`): The objective alone; trial.setObjective also adopts its recommended timing
- `phases` (array): Every phase, as in trial.setPhases
- `controlPct` (number, 0 to 100): Embedded control / null trials, percent of trials
- `separationTolerancePct` (number, 0.25 to 90): Residual allowed at the next event, percent

#### `trial.setObjective`
Change what the trial design is for. Like the interface, this adopts the timing and tolerance that objective implies unless adoptDefaults is false. Button: _Trials > Objective_

- **`trial`** (trial id or name, also `id`): Which trial design
- **`objective`** (`detection` | `estimation` | `separation`): detection, estimation or separation
- `adoptDefaults` (boolean, default `true`): Replace the phases with the objective's recommended timing

#### `trial.setPhases`
Replace every phase. Each phase is {name, role, min, max, jitter}; max defaults to min and jitter to max > min. Takes its item back as `design.get` returns it. Button: _Trials > Trial phases (the whole table at once)_

- **`trial`** (trial id or name, also `id`): Which trial design
- **`phases`** (array): The phases in order, at least one

#### `trial.resetTiming`
Replace the phases with the recommended timing for the trial's objective. Button: _Trials > Reset to the objective default_

- **`trial`** (trial id or name, also `id`): Which trial design

#### `trial.optimiseTiming`
Grid-search the delay and post-response fixation for the objective. Slow on the server (up to ~30 s); trial.solveSeparation is the fast analytic alternative. Button: _Trials > Optimise delay and tail_

- **`trial`** (trial id or name, also `id`): Which trial design

#### `trial.solveSeparation`
Solve the delay and tail fixation from the HRF so no response exceeds the tolerance at the next event, and write them into the trial. Button: _Trials > Separation solver > Apply this solution, and the 1 / 4 / 10 / 25 / 45 % presets_

- **`trial`** (trial id or name, also `id`): Which trial design
- `tolerancePct` (number, 0.25 to 90): Allowed residual, percent (default: the trial's own setting)

#### `trial.inspect` _(read-only)_
Timing, the separation solver's answer at a tolerance, and where each response peaks - without changing anything. Button: _Trials > Trial responses and Separation solver readouts_

- **`trial`** (trial id or name, also `id`): Which trial design
- `tolerancePct` (number, 0.25 to 90): Tolerance to preview the separation solver at

#### `phase.add`
Add a phase (default: appended, a fixed 2 s baseline). Button: _Trials > Add phase_

- **`trial`** (trial id or name): Which trial design
- `name` (string): Phase name
- `role` (`baseline` | `stimulus` | `delay` | `response` | `other`): What the regressor model reads: baseline, stimulus, delay, response or other
- `min` (number, at least 0): Shortest duration in seconds
- `max` (number, at least 0): Longest duration in seconds; equal to min means no jitter
- `jitter` (boolean): Whether the wait varies trial to trial inside min..max
- `index` (integer, at least 0): 0-based position to insert at (default: the end)

#### `phase.update`
Edit one phase. As in the table, max is lifted to min if it would fall below it (the result notes it). Takes its item back as `design.get` returns it. Button: _Trials > Trial phases (a row's name, role, min, max and jitter)_

- **`trial`** (trial id or name): Which trial design
- **`phase`** (position or name, also `index`): 0-based position in the trial, or a phase name only one phase carries; trial.inspect calls it "index"
- `name` (string): Phase name
- `role` (`baseline` | `stimulus` | `delay` | `response` | `other`): What the regressor model reads: baseline, stimulus, delay, response or other
- `min` (number, at least 0): Shortest duration in seconds
- `max` (number, at least 0): Longest duration in seconds; equal to min means no jitter
- `jitter` (boolean): Whether the wait varies trial to trial inside min..max

#### `phase.move`
Reorder a phase within its trial. Button: _Trials > Trial phases > up / down arrows_

- **`trial`** (trial id or name): Which trial design
- **`phase`** (position or name, also `index`): 0-based position in the trial, or a phase name only one phase carries; trial.inspect calls it "index"
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `phase.remove`
Delete a phase; a trial keeps at least one. Button: _Trials > Trial phases > x_

- **`trial`** (trial id or name): Which trial design
- **`phase`** (position or name, also `index`): 0-based position in the trial, or a phase name only one phase carries; trial.inspect calls it "index"


### Runs

#### `run.add`
A new run design: a trial design laid into blocks and bound to an acquisition card. Button: _Runs > Add run design_

- `name` (string): Name (default "Run design", numbered if taken)
- `trial` (trial id or name): Trial design it runs (default: the first one)
- `card` (card slug or name, also `protocol`): Acquisition card it is bound to, stored as "protocol" (default: the first functional card)
- `note` (string): Free note
- `trialsPerBlock` (integer, at least 1): Trials per block
- `blocksPerRun` (integer, at least 1): Blocks per run
- `interTrialGap` (number, at least 0): Gap between trials, seconds
- `interBlockRest` (number, at least 0): Rest between blocks, seconds
- `dummyVolumes` (integer, at least 0): Volumes discarded while magnetisation settles
- `leadIn` (number, at least 0): Lead-in, seconds
- `leadOut` (number, at least 0): Lead-out, seconds

#### `run.duplicate`
Copy a run design and place the copy right after it. Button: _Runs > Duplicate_

- **`run`** (run id or name, also `id`): The run design to copy
- `name` (string): Name for the copy (default: "<name> (copy)")

#### `run.remove`
Delete a run design. Refused while a session uses it. Button: _Runs > Delete_

- **`run`** (run id or name, also `id`): The run design to delete

#### `run.move`
Reorder the run design list. Button: _Runs > up / down arrows_

- **`run`** (run id or name, also `id`): The run design to move
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `run.update`
Change any of a run design's fields. Takes its item back as `design.get` returns it. Button: _Runs > Identity and Run structure sliders_

- **`run`** (run id or name, also `id`): Which run design
- `name` (string): New name
- `note` (string): Free note
- `trial` (trial id or name): Trial design it runs
- `card` (card slug or name, also `protocol`): Acquisition card it is bound to (sets TR, matrix, slices); stored as "protocol"
- `trialsPerBlock` (integer, at least 1): Trials per block
- `blocksPerRun` (integer, at least 1): Blocks per run
- `interTrialGap` (number, at least 0): Gap between trials, seconds
- `interBlockRest` (number, at least 0): Rest between blocks, seconds
- `dummyVolumes` (integer, at least 0): Volumes discarded while magnetisation settles
- `leadIn` (number, at least 0): Lead-in, seconds
- `leadOut` (number, at least 0): Lead-out, seconds

#### `run.optimiseStructure`
Search trials per block and blocks per run for the trial's objective, within the run-length cap. Button: _Runs > Optimise blocks and trials_

- **`run`** (run id or name, also `id`): Which run design

#### `run.inspect` _(read-only)_
The solved run: durations, volumes, data, efficiency diagnostics and what "Apply solved timing" would write to its card. Button: _Runs > Solved run and Design efficiency readouts_

- **`run`** (run id or name, also `id`): Which run design


### Sessions

#### `session.add`
A new session: the default setup steps and structural scans, then one run block. Button: _Sessions > Add session_

- `name` (string): Name (default "Session", numbered if taken)
- `run` (run id or name, or null): Run design for the first run block (default: the first one; null for none)
- `count` (integer, at least 0, default `1`): How many of that run, back to back
- `defaultBlocks` (boolean, default `true`): Start with the default setup steps and structural scans; false starts empty
- `note` (string): Free note
- `autoBreak` (boolean): Insert a break between back-to-back runs
- `breakMinutes` (number, at least 0): Length of that automatic break, minutes

#### `session.duplicate`
Copy a session and place the copy right after it. Button: _Sessions > Duplicate_

- **`session`** (session id or name, also `id`): The session to copy
- `name` (string): Name for the copy (default: "<name> (copy)")

#### `session.remove`
Delete a session. Refused while an experiment's plan uses it. Button: _Sessions > Delete_

- **`session`** (session id or name, also `id`): The session to delete

#### `session.move`
Reorder the session list. Button: _Sessions > up / down arrows_

- **`session`** (session id or name, also `id`): The session to move
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `session.update`
Change any of a session's fields, blocks included. Takes its item back as `design.get` returns it. Button: _Sessions > Identity, Automatic break, Session sequence_

- **`session`** (session id or name, also `id`): Which session
- `name` (string): New name
- `note` (string): Free note
- `autoBreak` (boolean): Insert a break between back-to-back runs
- `breakMinutes` (number, at least 0): Length of that automatic break, minutes
- `blocks` (array): Every block, as in session.setBlocks

#### `session.setBlocks`
Replace the block list, in blocks as design.get shows them: {id, kind, ...}. Prep and break take label and minutes; structural takes card (or protocol) and count; run takes run and count; all take enabled. An id sent back is kept; leave it out and a block gets a new one. Takes its item back as `design.get` returns it. Button: _Sessions > Session sequence (the whole list at once)_

- **`session`** (session id or name, also `id`): Which session
- **`blocks`** (array): The blocks in console order

#### `session.resetOrder`
Sort the blocks: setup, then structurals, then runs, then breaks. Button: _Sessions > Reset to the default order_

- **`session`** (session id or name, also `id`): Which session

#### `block.add`
Add a block to a session (default: appended). Structural defaults to the first card, run to the first run design. Button: _Sessions > + Setup step / + Structural / reference / + Run / + Break_

- **`session`** (session id or name): Which session
- **`kind`** (`prep` | `structural` | `run` | `break`): prep (a setup step), structural, run or break
- `index` (integer, at least 0): 0-based position to insert at (default: the end)
- `label` (string): Setup or break blocks: what it is
- `minutes` (number, at least 0): Setup or break blocks: how long, in minutes
- `card` (card slug or name, also `protocol`): Structural blocks: the acquisition card to run (stored as "protocol")
- `run` (run id or name): Run blocks: the run design to run
- `count` (integer, at least 0): Structural or run blocks: how many back to back
- `enabled` (boolean): Off keeps the block in the design without running it

#### `block.update`
Edit one block. Only the fields that belong to its kind can change. Takes its item back as `design.get` returns it. Button: _Sessions > Session sequence (a row's switch, subject, count or minutes)_

- **`session`** (session id or name): Which session
- **`block`** (position or name, also `id`): Block id (from design.get), or its 0-based position
- `label` (string): Setup or break blocks: what it is
- `minutes` (number, at least 0): Setup or break blocks: how long, in minutes
- `card` (card slug or name, also `protocol`): Structural blocks: the acquisition card to run (stored as "protocol")
- `run` (run id or name): Run blocks: the run design to run
- `count` (integer, at least 0): Structural or run blocks: how many back to back
- `enabled` (boolean): Off keeps the block in the design without running it

#### `block.move`
Move a block to another place in the session. Button: _Sessions > Session sequence > drag handle and up / down arrows_

- **`session`** (session id or name): Which session
- **`block`** (position or name, also `id`): Block id (from design.get), or its 0-based position
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `block.duplicate`
Copy a block and place the copy right after it. Button: _Sessions > Session sequence > duplicate_

- **`session`** (session id or name): Which session
- **`block`** (position or name, also `id`): Block id (from design.get), or its 0-based position

#### `block.remove`
Delete a block from a session. Button: _Sessions > Session sequence > x_

- **`session`** (session id or name): Which session
- **`block`** (position or name, also `id`): Block id (from design.get), or its 0-based position


### Experiments

#### `experiment.add`
A new experiment with one session in its plan and a 0% share (the others redistribute). Button: _Experiments > Add experiment_

- `name` (string): Name (default "Experiment", numbered if taken)
- `session` (session id or name, or null): Session for the first plan row (default: the first one; null for none)
- `short` (string): Short name for the masthead chip
- `note` (string): Free note
- `enabled` (boolean): Include in the budget
- `unit` (object): What the experiment counts: {noun, plural, short}; plural defaults to noun + "s"
- `targetUnits` (integer, at least 0): Goal, in the experiment's own unit
- `requestedPct` (number, 0 to 100): Share of scanner time, percent; the unlocked others redistribute
- `locked` (boolean): Hold the share while the others redistribute
- `manualSessions` (integer, at least 0): Total sessions, used when solveMode is "manual"
- `lockPlan` (boolean): Run the plan counts literally, whatever the budget says

#### `experiment.duplicate`
Copy a experiment and place the copy right after it. Button: _Experiments > Duplicate_

- **`experiment`** (experiment id or name, also `id`): The experiment to copy
- `name` (string): Name for the copy (default: "<name> (copy)")

#### `experiment.remove`
Delete an experiment; a study keeps at least one. Button: _Experiments > Delete_

- **`experiment`** (experiment id or name, also `id`): The experiment to delete

#### `experiment.move`
Reorder the experiment list. Button: _Experiments > up / down arrows_

- **`experiment`** (experiment id or name, also `id`): The experiment to move
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `experiment.update`
Change any of an experiment's fields, its plan included. Takes its item back as `design.get` returns it. Button: _Experiments > Identity, Unit, Goal and share, Session plan_

- **`experiment`** (experiment id or name, also `id`): Which experiment
- `name` (string): New name
- `plan` (array): Every plan row, as in experiment.setPlan
- `short` (string): Short name for the masthead chip
- `note` (string): Free note
- `enabled` (boolean): Include in the budget
- `unit` (object): What the experiment counts: {noun, plural, short}; plural defaults to noun + "s"
- `targetUnits` (integer, at least 0): Goal, in the experiment's own unit
- `requestedPct` (number, 0 to 100): Share of scanner time, percent; the unlocked others redistribute
- `locked` (boolean): Hold the share while the others redistribute
- `manualSessions` (integer, at least 0): Total sessions, used when solveMode is "manual"
- `lockPlan` (boolean): Run the plan counts literally, whatever the budget says

#### `experiment.setPlan`
Replace the session plan: [{session, count}]. Counts are a mix the solver scales, unless lockPlan is on. Takes its item back as `design.get` returns it. Button: _Experiments > Session plan (the whole table at once)_

- **`experiment`** (experiment id or name, also `id`): Which experiment
- **`plan`** (array): Rows of {session, count}

#### `plan.add`
Append a session to an experiment's plan. Button: _Experiments > Add session to the plan_

- **`experiment`** (experiment id or name): Which experiment
- **`session`** (session id or name): Session to add
- `count` (integer, at least 0, default `1`): Its weight in the mix (or literal count with lockPlan)

#### `plan.update`
Change one row of an experiment's plan. Takes its item back as `design.get` returns it. Button: _Experiments > Session plan (a row's session or count)_

- **`experiment`** (experiment id or name): Which experiment
- **`row`** (position or name): 0-based row, or the session (id or name) if it is in the plan once
- `session` (session id or name): Session for this row
- `count` (integer, at least 0): Its weight in the mix (or literal count with lockPlan)

#### `plan.move`
Reorder a row of an experiment's plan. Button: _Experiments > Session plan > up / down arrows_

- **`experiment`** (experiment id or name): Which experiment
- **`row`** (position or name): 0-based row, or the session (id or name) if it is in the plan once
- `to` (integer, at least 0): New 0-based position (clamped to the list)
- `delta` (integer): Steps to move: -1 is one earlier, +1 one later

#### `plan.remove`
Take a row out of an experiment's plan. Button: _Experiments > Session plan > x_

- **`experiment`** (experiment id or name): Which experiment
- **`row`** (position or name): 0-based row, or the session (id or name) if it is in the plan once


### Jitter and HRF

#### `jitter.update`
How jittered waits are drawn: flat across the window, or a truncated geometric in whole TRs. Takes its item back as `design.get` returns it. Button: _Jitter panel > Jitter sampling_

- `mode` (`uniform` | `geometric`): uniform (flat window) or geometric
- `p` (number, 0.02 to 0.98): Geometric p: low approaches flat, high pins to the minimum
- `truncation` (`window` | `trs`): Cap the longest delay at each phase's max, or at nMaxCap TRs
- `nMaxCap` (integer, at least 0): Longest delay allowed in TRs, when truncation is "trs"

#### `hrf.update`
The double-gamma response every separation and efficiency figure is solved against, and (as objectives) what each objective counts as separated. Takes its item back as `design.get` returns it. Button: _HRF model > Response shape sliders and objective definitions_

- `peakDelay` (number, 2 to 14): Peak delay, seconds
- `peakDispersion` (number, 0.3 to 3): Peak dispersion
- `undershootDelay` (number, 6 to 34): Undershoot delay, seconds
- `undershootDispersion` (number, 0.3 to 3): Undershoot dispersion
- `undershootRatio` (number, 1 to 24): Peak to undershoot ratio
- `spanSeconds` (number, 12 to 120): How far out the response is evaluated, seconds
- `readLagSeconds` (number, 0 to 20): Where an earlier event's residual is read, seconds after onset
- `objectives` (object): {<objective>: {label, blurb, tolerancePct, separationSeconds}}, as in objective.update

#### `hrf.reset`
Back to the SPM double gamma (peak 6 s, undershoot 16 s, ratio 6); objective definitions are kept. Button: _HRF model > Reset to the canonical response_

#### `objective.update`
What "separated" means for one objective: its name, description, residual tolerance, or a pinned recovery duration. Takes its item back as `design.get` returns it. Button: _HRF model > objective definitions_

- **`objective`** (`detection` | `estimation` | `separation`): detection, estimation or separation
- `label` (string): Name shown throughout the planner
- `blurb` (string): Description
- `tolerancePct` (number, 0.25 to 90): A response under this share of its peak counts as gone, percent
- `separationSeconds` (number, at least 0): Pinned recovery duration in seconds; 0 solves it from the tolerance


### Acquisition cards

#### `card.list` _(read-only)_
Every card with its role, TR, TE, series duration and what in this design uses it. Button: _Acquisition panel > card list_

#### `card.get` _(read-only)_
One card with every parameter, grouped by console page. Button: _Acquisition panel > card editor_

- **`card`** (card slug or name): Card slug or name

#### `card.create` _(server)_
A new card, blank or copied from a base card. Cards are shared by every design. Button: _Acquisition > New card, and New card from this one_

- **`label`** (string): Card name
- `role` (`functional` | `reference` | `structural` | `other`, default `functional`): What the card is for
- `note` (string): Free note
- `base` (card slug or name): Copy every parameter from this card
- `slug` (string): File name to use (default: derived from the label)

#### `card.duplicate` _(server)_
Copy a card. Button: _Acquisition > Duplicate_

- **`card`** (card slug or name): Card to copy
- `label` (string): Name for the copy

#### `card.rename` _(server)_
Rename a card. With renameFile the slug follows the name and every run and structural block in this design is repointed. Button: _Acquisition > Rename (optionally renaming the file)_

- **`card`** (card slug or name): Card to rename
- **`label`** (string): New name
- `renameFile` (boolean, default `false`): Rename the file (and so the slug) too

#### `card.setMeta` _(server)_
Set a card's name, role or note. Button: _Acquisition > name, role and note fields_

- **`card`** (card slug or name): Which card
- `label` (string): Name
- `role` (`functional` | `reference` | `structural` | `other`): Role
- `note` (string): Note

#### `card.setParameters` _(server)_
Write parameter values by name, e.g. {"Act. TR/TE (ms)": "2000 / 30"}. Names match case-insensitively; every name must exist on the card. Button: _Acquisition > parameter values, then Save card_

- **`card`** (card slug or name): Which card
- **`values`** (object): Parameter name to new value

#### `card.replace` _(server)_
Replace a card's whole JSON (pages and rows). Take it from card.get, edit, send it back. Button: _Acquisition > add, rename, indent, reorder or delete parameters and pages, then Save card_

- **`card`** (card slug or name): Which card
- **`data`** (object): The card JSON: {"_meta": {...}, "PAGE": [{"parameter", "value", ...}]}

#### `card.delete` _(server)_
Delete a card. Refused while this design uses it, or if it is the last card. Button: _Acquisition > Delete_

- **`card`** (card slug or name): Card to delete

#### `card.applySolvedTiming` _(server)_
Write the solved dyn scans, dummy scans and total scan duration of a run design into the card it is bound to. Button: _Acquisition > Apply solved timing_

- **`run`** (run id or name): Run design whose solved timing to write

#### `card.backups` _(read-only, server)_
The snapshots taken before each save of a card, newest first. Button: _Acquisition > Backups_

- **`card`** (card slug or name): Which card

#### `card.restore` _(server)_
Put a snapshot back (the current card is itself backed up first). Button: _Acquisition > Backups > restore_

- **`card`** (card slug or name): Which card
- **`file`** (string): Snapshot file name from card.backups


### Results and export

#### `report` _(read-only)_
Solve the design. view "summary" (default) is the key numbers; "full" is the whole report; "warnings" is the constraint report alone. Button: _Overview, and every Solved ... readout_

- `view` (`summary` | `full` | `warnings`, default `summary`): How much to return

#### `export.markdown` _(read-only)_
The report as Markdown: every table, or one by name. Button: _Report and export > Copy every table / Download .md / table picker_

- `table` (string): One table by name, e.g. "Study summary" (default: the whole report)

#### `export.methods` _(read-only)_
The paste-ready methods paragraph generated from the solved design. Button: _Report and export > Copy methods text_

#### `export.psychopy` _(read-only)_
The PsychoPy YAML for every run design, or for one. Button: _Report and export > PsychoPy task config_

- `run` (run id or name): One run design (default: all)

#### `export.figures` _(read-only)_
The figures as SVG markup: study scanner time, one timeline per trial design, one assembly figure per experiment. Button: _Every figure card > Download SVG_

- `name` (string): One figure by file stem (default: all)

<!-- action-reference:end -->
