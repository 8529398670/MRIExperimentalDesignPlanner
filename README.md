# MRI Experimental Design Planner

A design planner and scanner-time optimiser for MRI studies of any shape. Python backend,
browser front end, Wright State University palette.

The tool solves one question in both directions: **how much scanner time does this design
need**, and **what design fits the scanner time I have** — while keeping every level of the
hierarchy consistent with the acquisition parameters actually recorded on the cards.

## The hierarchy

Nothing in the planner is fixed in number. Every level is a named library you add to,
duplicate, rename, reorder and delete, and each level is built out of the one below it.

| Level | What it is | Panel |
|---|---|---|
| **Trial** | A list of phases: what one trial looks like, second by second | Trials |
| **Run** | A trial design laid out into blocks, bound to an acquisition card | Runs |
| **Session** | One sortable list of setup steps, structurals, runs and breaks, in console order | Sessions |
| **Experiment** | A plan of sessions, with its own unit, its own goal and a share of time | Experiments |
| **Study** | Every experiment together inside one scanner-time budget | Overview, Budget |

Sessions are a shared library: build "Main task day" once and any number of experiments can
pull it into their plan. Editing it changes every experiment that uses it, and the Sessions
panel says which those are.

## Running it

```bash
./run.sh
```

Then open <http://127.0.0.1:8760>. The launcher uses `.venv` if present and serves through
**waitress**, not the Flask development server. Options:

```bash
./run.sh --port 9000 --host 0.0.0.0
```

First-time setup on a machine without the virtual environment:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Layout

| Path | Purpose |
|---|---|
| `server.py` | Flask application and waitress entry point |
| `planner/protocols.py` | Loading, validation, atomic writes and backups for the acquisition cards |
| `planner/report.py` | XLSX workbook generation |
| `planner/bundle.py` | The full-export zip |
| `static/js/model.js` | Design state, constraint solver, optimisers, Markdown and methods text |
| `static/js/efficiency.js` | HRF convolution, contrast efficiency, design diagnostics |
| `static/js/ui.js` | Control factories, figures, overview and budget panels |
| `static/js/library.js` | The trial, run, session, experiment and HRF panels |
| `static/js/protocols.js` | Acquisition card editor |
| `static/js/export.js` | Clipboard, Markdown, PsychoPy, workbook and zip export |
| `scanner-parameters/*.json` | The acquisition cards, edited in place |
| `scanner-parameters/.backups/` | Timestamped snapshot before every save |
| `presets/` | Saved designs; `current.json` is the autosaved working design |
| `exports/` | Every generated workbook and zip is archived here |

## Trial designs

A trial is an ordered list of phases. Each phase has a name, a minimum and maximum duration
(equal durations mean no jitter) and a **role**, and the role is what the regressor model
reads:

| Role | Meaning | Regressor |
|---|---|---|
| Fixation / baseline | Nothing to model | none |
| Stimulus / cue | The event that starts the trial | stimulus |
| Delay / retention | Blank retention interval | none |
| Response / probe window | The event split by condition | condition A, condition B |
| Other | Anything else | none |

The two conditions are named on the trial design, so "yes / no", "old / new" or
"congruent / incongruent" all read correctly through the plots, the tables and the PsychoPy
config. An **embedded control share** withholds a fraction of trials as control or null
trials; trials minus that share is the count every goal is denominated in.

### Objective and the separation solver

Each trial design carries a decoding objective, and each objective carries its own idea of
what "separated" means:

| Objective | What the optimiser maximises | Typical timing |
|---|---|---|
| Detection (saturating) | Duty cycle and stacking gain per minute: same-condition trials run back to back with minimal delay so the response never settles | Fixation 2-6 s, stimulus 4 s, delay 1-2 s, response 3 s, fixation 2-6 s |
| Single-trial estimation | Least-squares-all trial-beta estimability, penalised for stimulus bleed into the response window | Fixation 2-6 s, stimulus 4 s, delay 6-10 s, response cue 3 s, fixation 10-14 s |
| Full HRF separation | Stimulus response and previous trial both back at baseline before the next response window | Fixation 2-6 s, stimulus 4 s, delay 14-16 s, response cue 3 s, fixation 24-28 s |

Every trial panel carries one smart slider — **allowed residual at the next event** — that
solves the delay and post-response fixation directly from the response shape rather than by
search. For a given tolerance it computes how long each event's predicted response stays
above that fraction of its own peak, undershoot included, then sets:

- the **delay** so the stimulus response has decayed below tolerance by the time the response
  peaks, and
- the **post-response fixation** so the response has decayed below tolerance by the next
  stimulus onset, counting the leading fixation already in the trial.

Existing jitter spreads are preserved and the minimum is what satisfies the constraint, so the
worst-case trial is still clean. Presets cover 1, 4, 10, 25 and 45 percent; the readout shows
the solved values, the residuals they deliver, and whether the trial matches the solution or
is only a preview.

## HRF model — what counts as separated

The **HRF model** panel is where the response itself lives, and where you decide what the
planner treats as recovered. Everything else re-solves against it.

- **Response shape** — peak delay, peak dispersion, undershoot delay, undershoot dispersion,
  the peak-to-undershoot ratio, and how far out the response is evaluated. Defaults are the
  canonical SPM double gamma, and one button puts them back.
- **Where residuals are read** — how long after an event's onset the leftover signal from the
  previous one is measured. This defaults to just before the peak.
- **Per objective**, the definition itself: the name shown throughout the planner, a
  description, a **residual tolerance**, and — this is the important one — an optional
  **pinned recovery duration**. Set that and "Full HRF separation" means exactly the number of
  seconds you typed, whatever the response shape says. Leave it at zero and it is solved from
  the tolerance.

The readouts under each objective say how long a 3 s and a 4 s event take to separate under
the current definition, and which trial designs are using it. A table at the foot of the panel
gives recovery time against tolerance for a range of event durations.

## Run designs

A run binds one trial design to one acquisition card and lays it out: trials per block, blocks
per run, inter-trial gap, inter-block rest, dummy volumes and lead-in / lead-out. Condition
ordering is a run-level choice — blocked, strictly alternating, or intermixed and balanced.

**Design efficiency** sits on every run panel, with the HRF-convolved regressor trace as its
centrepiece: shaded bands mark the stimulus and response windows, the mouse reads out all
three regressors at any time point, and the plot zooms (scroll wheel, zoom slider, `+`/`-`,
**Fit**, **First trial**) and pans (drag, double-click to fit) so a single trial can be
inspected inside a twenty-minute run. The vertical scale follows the visible window, so
zooming into a quiet stretch shows what happens there rather than a flat line.

It reports, from a simulated run at the bound TR:

- **Duty cycle** — median predicted task signal as a percentage of its 95th percentile.
  High means the response never settles (what detection wants); near zero means full
  recovery (what separation wants).
- **Stacking gain** — peak predicted signal divided by the peak of one isolated trial.
- **Single-trial efficiency** — reciprocal mean variance of least-squares-all trial betas.
- **Carryover** — previous response still present at the next stimulus onset.
- **Stimulus bleed** — stimulus response still present inside the response window.
- **Contrast efficiency** for A vs B, response vs baseline and stimulus vs response, plus the
  stimulus/response regressor correlation and variance inflation.

## Sessions

A session is a named block of scanner time held as **one ordered list of blocks**. There are
four kinds and they all sit in the same list:

| Block | What it is | What you set |
| --- | --- | --- |
| **Setup** | Time that is not a scan — screening, positioning, task practice, anything you name | A label and a duration |
| **Structural** | An acquisition card run as a structural or reference scan | Which card, how many |
| **Run** | A run design | Which run design, how many |
| **Break** | A break you place yourself | A label and a duration |

**Nothing in the list is pinned.** A new session opens with the setup steps, then the
structural and reference scans, then its runs — but that is only a starting position. Drag any
block by its handle (or use the arrows) to put structurals between runs, move task practice
into the middle of the session, or drop a break exactly where you want one. Every block can be
renamed, retimed, duplicated, deleted, or switched off to keep it in the design without running
it. The session solves in whatever order you leave it in.

The one thing the planner still does for you is the **automatic break**: when two runs end up
next to each other, it inserts a break of the length you set. Put anything between them — a
structural, a setup step, a break of your own — and no automatic break appears there. Turn the
setting off and every break in the session is a block you placed.

The solved session gives the shortest, expected and longest duration, the trial and event
counts, the data volume, and a console-order timeline you can copy straight into a scanner
protocol document.

## Experiments

An experiment names its own **unit** — trial, question, stimulus, item, whatever the study
actually counts — and every goal, floor and readout for it follows that name.

Its **session plan** is a list of sessions with counts. Those counts are a *mix*, not a total:
the solver buys as many whole sessions as the budget or the goal allows and splits them in
that ratio by largest remainder, so a plan of 6 parts "Main day" to 1 part "Retest day" holds
its shape at any budget. Tick **run the plan exactly as written** and the counts become
literal instead, whatever the budget says — the constraint report will tell you if that
overruns.

## Solver

- **Solve modes**
  - *Hours available* — spend the whole budget; the count collected is whatever the hours buy.
  - *One total goal* — fill as much of one study-wide goal as the hours allow, keeping the
    per-experiment split of scanner time. Sessions are indivisible, so the plan lands on the
    nearest whole session and says so in the constraint report.
  - *Per-experiment goals* — each experiment runs until it reaches its own goal, however long
    that takes.
  - *Session counts* — you set the number of sessions per experiment directly.
- **Allocation** — one set of per-experiment sliders, driven in whichever unit you are
  thinking in: **percent** of scanner time (with locks; the remainder always redistributes so
  the shares total 100), **hours** of the usable budget, or **number of sessions**. Choosing
  the session unit seeds the counts from the solved plan and moves the solver into
  session-count mode, so the sliders mean what they say.
- **Constraint envelope** — maximum run duration, session duration, runs per session, total
  sessions, continuous-scanning comfort limit and a minimum count per experiment. Caps apply
  either to the expected duration or to the worst-case longest duration.
- **Auto-clamp** — when a structure violates a cap the solver reduces blocks, trials per block
  or runs per session and reports exactly what it changed in the constraint report.

Mixing runs from several experiments into one session no longer needs a mode: build a session
that contains both, and put it in both plans.

## Acquisition parameter cards

Every parameter on every card under `scanner-parameters/` is editable in the Acquisition
panel, grouped by console page and indented as on the console. So is the set of parameters:

- **Add and delete parameters**, rename them, indent and outdent them, reorder them.
- **Add, rename and delete whole console pages.**
- **New card** — blank, or **new card from this one**, starting from an existing card's
  parameters.
- **Duplicate** a card, **rename** it (optionally renaming the file with it, which repoints
  every run design and session that referenced it), **delete** it.
- Each card carries its own **name, role and note**, saved inside the JSON, so the picker and
  every export stay in step.

The link to the design is bidirectional:

- **Card to design** — TR, TE, slices, reconstruction matrix, voxel size and series duration
  feed run lengths, dynamic counts, data volume and the efficiency simulation.
- **Design to card** — *Apply solved timing* writes the solved `dyn scans`, `dummy scans` and
  `Total scan duration` back into the JSON, leaving every other parameter untouched.

Saving writes a timestamped backup into `scanner-parameters/.backups/` first; the last 25 per
card are kept and any of them can be restored from the Backups view.

Repeated parameter names inside one page are expected, not an error — the indented sub-rows of
FOV, voxel size and slice geometry are all `AP (mm)` on a real console card. Lookups take the
first match, which is the console's own order.

## Tables

**Every table in the planner** carries the same two actions under it:

- **Copy Markdown** — a GitHub-flavoured table, alignment preserved.
- **Copy for Word** — rich text: paste into Word, Google Docs or LibreOffice and it lands as a
  real bordered table with a caption.

Tables with live inputs in them — the phase editor, the experiment plan — copy their *values*,
not their widgets, and drop the row-tools column. The session sequence is a sortable list
rather than a table; its solved timeline underneath copies as a table.

## Export

- **Download everything (.zip)** — one archive with the XLSX workbook, `design.json` and
  `report.json`, `report.md` and every table on its own as Markdown, `methods.txt`, one
  PsychoPy YAML per run design, every figure as both SVG and PNG, every acquisition card as
  saved, and a README listing what each file is. A copy is archived in `exports/`.
- **XLSX workbook** — summary, experiments, trial designs, run designs, sessions, session
  timelines, budget and allocation, efficiency diagnostics, data volume, methods text,
  Markdown tables, and one sheet per acquisition card with every parameter as saved.
- **PsychoPy task config** — one YAML per run design, on the lab template, with the scanner
  block (TR, dummy volumes), `run:` (lead-in and lead-out, blocks per run, trials per block,
  inter-block rest, condition ordering), `trial.phases:` (phase list, durations and jitter)
  and `conditions:` (per-run counts split between the two named conditions and the control
  share) taken from that run's solved design.
- **Copy methods text** — a paste-ready narrative generated from the solved design.
- **Design JSON** — the full state plus the solved report; it reloads through
  *Saved designs → Import JSON file*.

## Figures

Three figures, each downloadable as SVG or PNG and all of them included in the zip:

- **Trial timeline** (per trial design) — the phases as a strip of stimulus screens with their
  durations and cumulative onsets, then the same trial drawn to scale.
- **Assembly figure** (per experiment) — trial, block, run, session and experiment, each row
  to scale on its own axis, with the element the row above expands picked out and joined to it.
- **Scanner time** (the study) — every experiment as a band of sessions drawn against the
  usable budget, one division per session, with what the plan leaves unspent.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness and card count |
| GET | `/api/bootstrap` | Manifest, all cards, acquisition summary, saved design, presets |
| GET | `/api/protocols` | Card manifest |
| POST | `/api/protocols` | Create a card, blank or from a base |
| GET/PUT/DELETE | `/api/protocols/<slug>` | Read, save or delete one card |
| POST | `/api/protocols/<slug>/duplicate` | Copy a card |
| POST | `/api/protocols/<slug>/rename` | Rename a card, and optionally its file |
| POST | `/api/protocols/<slug>/meta` | Set a card's name, role or note |
| GET | `/api/protocols/<slug>/backups` | List snapshots |
| POST | `/api/protocols/<slug>/restore` | Restore a snapshot |
| POST | `/api/apply-derived` | Write solved acquisition values into a card |
| GET/POST | `/api/design` | Load or save a design (`?name=`, default `current`) |
| DELETE | `/api/design/<name>` | Delete a preset |
| POST | `/api/export/xlsx` | Build and download the workbook |
| POST | `/api/export/bundle` | Build and download the full-export zip |
| POST | `/api/export/json` | Download the design payload |

## Loading an older design

Designs saved by the earlier aim-based planner load unchanged and are converted on the way in:
each aim becomes a trial design, a run design, a session and an experiment; the question bank's
control share moves onto the trial designs; goals stay denominated in questions, because each
experiment names its own unit; and the renamed acquisition cards are repointed automatically.
