# MRI Experimental Design Planner

A design planner and scanner-time optimiser for MRI studies of any shape. Python backend,
browser front end, Wright State University palette.

The tool solves one question in both directions: **how much scanner time does this design
need**, and **what design fits the scanner time I have** — while keeping every level of the
hierarchy consistent with the acquisition parameters actually recorded on the cards.

New to the tool? **[TUTORIAL.md](TUTORIAL.md)** is a step-by-step walkthrough that builds a
costed study from scratch. This file is the reference for what every control does.
Building a study from a script or an agent? **[API.md](API.md)** covers the HTTP API: every
button is an action you can send as JSON.

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

### Signing in

Anyone who can reach the planner can **look** at it: every panel, every design, and
changes made elsewhere as they happen. Changing anything (a design, an acquisition card,
adding or deleting a design) and exporting anything (downloads, the zip, copying tables or configs) needs a
sign-in. Without one the page runs **view only**: the masthead says so, the edit, download and
copy buttons are gone, the fields are greyed out, and the server refuses every write and every
export with 401.

The only way in is a **one-time login link**. The first browser to open it is signed in for
good, and after that the link is spent. There are no passwords and no roles: everyone signed in
can do everything, including adding and removing people.

- **The first link** comes from the shell:

  ```bash
  ./dockerRun.sh --link "Your Name"                 # the container
  python3 -m planner.auth link "Your Name"          # a checkout run with ./run.sh
  ```

  The same command gets somebody back in if nobody left inside can make them a link.
  `./dockerRun.sh --users` (or `python3 -m planner.auth users`) lists who can sign in.
- **Every other link** comes from the **People** panel, which is only there when signed in.
  There you can add someone (their first link comes straight up), make anyone a new link,
  cancel an unused one, remove someone (their browsers are signed out at once), and sign out
  of this browser. Nobody can remove themselves.
- **Scripts and agents** get an **API key** instead, also from **People**: name it for what
  will use it, copy it (it is shown once), and the agent sends `Authorization: Bearer <key>`.
  A key can change and export anything a person can, but cannot add or remove people or make
  links or keys. Each key is listed with who made it and when it was last used, and can be
  revoked on its own; removing the person who made it revokes it too. See [API.md](API.md).
- Unopened links stop working after 7 days (`PLANNER_LINK_DAYS`).
- When the planner is reached through a proxy or a tunnel, set
  `PLANNER_PUBLIC_URL=https://planner.example.org` so that links are built on that address
  rather than on whatever address the person making them is using.

`accounts/users.json` (`PLANNER_AUTH_DIR`) keeps people, sessions, links and API keys. It
stores only sha256 hashes of the tokens and keys, so a copy of the file lets nobody in. The
session cookie is `HttpOnly` and `SameSite=Lax`, and it is renewed each time the planner is
opened. Writes from another origin, including another port on the same host, are refused.

### Designs and links

Every design is the same kind of thing: a name, a file `presets/<name>.json`, and its own
address. `/` lists them all, newest first. **Add new** (on that list, or in the masthead)
asks for a name and starts a design from the default settings. Any design can be deleted,
after a confirmation, from the list or from *Report and export → Designs*.

Every view has its own address, and the address bar follows what is on screen. To share
exactly what you are looking at, copy the address:

| Address | Opens |
|---|---|
| `/` | Every design, and **Add new** |
| `/designs/<name>` | The design `presets/<name>.json`, on the overview |
| `/designs/<name>/sessions/<id>` | One of its sessions; likewise `/trials/<id>`, `/runs/<id>`, `/experiments/<id>` |
| `/designs/<name>/acquisition/<card>` | One acquisition card |
| `/designs/<name>/budget`, `.../jitter`, `.../hrf`, `.../study`, `.../export` | That panel |

Clicking the rail or an item in a list adds a history entry, so Back and Forward move between
views. An id that is not in the design opens the first item instead and says so. The design's
name in the masthead goes back to the list.

The page works on the design its address names: edits made there save to that design as you
work, and every page open on the same design follows them within a few seconds. To keep a
version fixed while you experiment, save a copy under a new name first (*Report and export →
Designs → Save a copy as*). An address naming a design that does not exist says so and lists
the ones that do. A page open on a design that is deleted says so too, and cannot save it back.

Before this, `/` was a "working design" kept in `presets/current.json`. The first time this
version starts, that file is renamed after its study title (for example
`presets/Inner-Speech-Decoding.json`) and becomes a design like the others.

## Layout

| Path | Purpose |
|---|---|
| `server.py` | Flask application and waitress entry point |
| `planner/api.py` | The agent-facing design API under `/api/v1` |
| `planner/auth.py` | People, sessions, one-time login links and API keys; `python3 -m planner.auth link <name>` |
| `planner/access.py` | Who may do what: view-only for everyone, a session for writes and exports; `/login`, `/api/auth/*` |
| `planner/engine.py` | Runs the planner's own JavaScript on the server, in QuickJS |
| `planner/designs.py` | The designs, with revisions so the page and the API cannot overwrite each other, and the old working design renamed on first start |
| `planner/protocols.py` | Loading, validation, atomic writes and backups for the acquisition cards |
| `planner/report.py` | XLSX workbook generation |
| `planner/bundle.py` | The full-export zip |
| `static/js/model.js` | Design state, constraint solver, optimisers, Markdown and methods text |
| `static/js/api.js` | One named action per button, shared by the interface and the HTTP API |
| `static/js/efficiency.js` | HRF convolution, contrast efficiency, design diagnostics |
| `static/js/ui.js` | Control factories, figures, overview and budget panels |
| `static/js/library.js` | The trial, run, session, experiment, jitter and HRF panels |
| `static/js/protocols.js` | Acquisition card editor |
| `static/js/export.js` | Clipboard, Markdown, PsychoPy, workbook and zip export |
| `static/js/people.js` | The People panel: login links, API keys, removing people, signing out |
| `static/js/designs.js` | Adding a design from the defaults and deleting one; the list at `/` (`templates/designs.html`) |
| `static/js/login.js` | The page a login link opens |
| `scanner-parameters/*.json` | The acquisition cards, edited in place |
| `scanner-parameters/.backups/` | Timestamped snapshot before every save |
| `presets/` | The designs, each open at `/designs/<name>` and saved as you work |
| `exports/` | Every generated workbook and zip is archived here |
| `accounts/` | `users.json`: who can sign in (hashes only; not in git) |

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
planner treats as recovered. Everything else re-solves against it. How the wait in a
jittered phase is drawn has its own panel — see [Jitter](#jitter) below.

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

## Jitter

Which phases vary is set by the **Jitter** box on each phase, in the Trials panel. The
**Jitter** panel decides how the varying ones are drawn, and shows the resulting
distribution for every jittered phase in the design.

### How many steps a phase has

A geometric wait moves in whole TRs, so `steps = (max - min) / TR`. The count depends on the
**width** of the window, not on how long the waits are: two phases with quite different
timings get the same number of steps whenever their windows match. At TR 2 s a 4 s window
buys 2 steps, 6 s buys 3, 8 s buys 4. A window narrower than one TR has nowhere to step, so
the phase becomes a fixed wait at its minimum — the panel says so rather than shortening the
trial silently. The panel prints both directions: the derivation per phase, and the window a
given step count needs.

### Sampling

By default a jittered phase's wait is **flat** across its window, so it averages the midpoint —
a 2–6 s fixation costs 4 s. The **Jitter sampling** card offers the alternative: a truncated
geometric, following Ashby, *Statistical Analysis of fMRI Data*, ch. 5. It is **off by
default**.

Turned on, a wait becomes a whole number of TRs drawn from

```
P(delay = n TRs) = p(1-p)^n / SUM(i = 0..n_max) p(1-p)^i,    n = 0 .. n_max
```

The point is anticipation. Under a flat window every blank TR that passes makes the stimulus
more likely next, and at the top of the window the participant knows it with certainty. The
geometric is the only discrete distribution where that chance stays `p` however long they have
already waited, so it gives the participant nothing to anticipate on.

`p` sets the shape: low `p` approaches the flat window, 0.5 is the textbook default, high `p`
pins every wait to its minimum.

**Truncation** is the second choice, and the card exposes it because it is a real trade-off
rather than an implementation detail. An untruncated geometric puts some probability on
arbitrarily long waits — cheap in a psychology lab, expensive in a scanner — so the
distribution gets an upper limit. Two ways to say where it sits:

| Setting | The longest delay is |
|---|---|
| **At the phase max** (default) | whatever each phase's own maximum already allows |
| **At a stated number of TRs** | one limit for the whole design, applied on top of each phase's max, so it can only ever tighten |

Either way `n_max` is derived, never typed twice: it is
`min(stated limit, floor((max - min) / TR))`, with the TR coming from the run's acquisition
card. The card says which of the two constraints actually bit.

**What truncating costs is shown, not just asserted.** The distribution table's last column is
`P(next TR)` — the chance the stimulus arrives on the next TR given the participant has already
waited that long. Untruncated it would be flat at `p`, which is the entire reason for choosing
a geometric; truncated it climbs as the cap approaches and reaches 1 on the last rung, where an
ideal observer knows the stimulus is next. The **Anticipatable trials** readout is the share of
trials that land on that rung. Tightening the cap from 2 TRs to 1 on the shipped GLM trial
takes it from 14.3 % to 33.3 % — that is the price of guaranteeing no long delays, in a number.

The `Running total` column is not decoration either: it is literally the sampling recipe. Draw
a uniform (0, 1) and take the first rung whose running total covers it. At `p` = .5 truncated
at 4 TRs it reads .516, .774, .903, .968, 1 — the intervals the source quotes.

Two consequences worth knowing before you switch it on:

- **It shortens the study.** The geometric mean sits well below the midpoint, so trials get
  cheaper and the plan needs fewer hours. On the shipped GLM trial at TR 2 s and `p` = 0.5 the
  trial mean drops from 16.50 s to 14.29 s. That is why the distribution is chosen here rather
  than left to the presentation software — it changes the sizing. The draws themselves still
  belong to PsychoPy.
- **A window narrower than one TR stops being jittered.** It has a single rung, so the phase
  fixes at its minimum. The card names any phase this happens to rather than quietly
  shortening it. For the same reason a 2–7 s window at TR 2 s tops out at 6 s, and the planner
  sizes and exports the 6.

### Where the distribution is shown

- **Jitter panel**: every jittered phase in the design, rung by rung, grouped by trial, with
  the step arithmetic above it.
- **Markdown tables and the workbook**: one table per jittered phase, same columns.
- **PsychoPy YAML**: the builder's own `jitter: geometric` and `jitter_p`. The builder takes
  `n_max = floor((hi - lo) / TR)` from each phase's window, so the window is exported to stop
  on the top rung the planner sized against, at that run's TR - which also carries a stated
  TR cap. `n_max` is repeated as a comment on the phase line. A window narrower than one TR
  goes out as a fixed wait, since the builder refuses a geometric window that short.
- **Methods text**: a citable sentence naming `p`, the truncation and where it came from.

All of them come from one `truncGeometric()` in `static/js/model.js`, so they cannot drift
apart.

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
- **PsychoPy task config** — one YAML per run design for the lab's PsychoPy builder, on its
  template, with the scanner block (TR, dummy volumes), `run:` (lead-in and lead-out, blocks
  per run, trials per block, inter-block rest, inter-trial gap), `trial:` (jitter
  distribution, phase list and durations) and the `per_run` counts of `conditions:` (primary
  trials, and the control share spread over the four control conditions) taken from that
  run's solved design. The conditions themselves - names, cues, responses - are the lab
  template's. The builder loads these files unchanged. It does not yet run `inter_block_rest`
  or `inter_trial_gap`, so a multi-block run it presents is shorter than the planner books.
- **Copy methods text** — a paste-ready narrative generated from the solved design.
- **Design JSON** — the full state plus the solved report; it comes back as a new design through
  *Designs → Import JSON file*.

## Figures

One figure per level of the design, each pitched at that level and drawn for every item at
it, so nothing is ever collapsed into a representative example. All are downloadable as SVG
or PNG and all are included in the zip:

- **Trial timeline** (per trial design) — the phases as a strip of stimulus screens with their
  durations and cumulative onsets, then the same trial drawn to scale.
- **Run structure** (per run design) — the trial, the block it repeats into and the whole run,
  each row to scale on its own axis, with the element the row above expands picked out and
  joined to it.
- **Session overview** (per session) — the session as the console runs it, to scale in
  minutes: setup, the structural and reference scans, every run with its blocks ruled inside
  it, and the breaks between. Numbered to match the session timeline table, with a key, a
  jitter rule from shortest to longest, and a bar showing where the time goes.
- **Experiment overview** (per experiment) — every session design in the plan on one shared
  minutes axis, with how many of each the budget buys, what that costs, and the experiment's
  scanner time split between them.
- **Study overview** (the study) — every experiment as a band against the usable budget, each
  band split into the session designs its plan buys rather than into anonymous ticks, with
  what the plan leaves unspent. Switched-off experiments are hatched rather than dropped.

### Figures on the web

Every figure also has an address of its own under the design that draws it, so one can be
linked, embedded in a page, or opened in a tab rather than only downloaded:

```
/designs/V2/figures/                                    every figure, with its links
/designs/V2/figures/aim-2-mvpa-session-session.png      one figure, by file name
/designs/V2/figures/session-mtubalg3-14a.png            the same figure, by id
/designs/V2/figures/study.png                           the study figure, whatever the study is called
```

These are drawn from the design each time they are asked for, so a link pasted into a
protocol or a message keeps up with the design instead of going stale the way a pasted
picture does. Each figure card in the interface has a **Copy link** button, and *Report and
export* links the index.

A figure can be named two ways. Its **file name** is readable but follows the item's name, so
renaming a session moves that link; its **id** never changes. Both resolve, so pick the one
whose property matters — readable to paste into a document, permanent to keep in a protocol.

Figures are a view of the design, not an export, so anyone who can open the design can open
them; the exports under `/api/v1` still need a sign-in. Every answer carries an ETag off the
design revision, so a reader that already has the current picture gets a 304, and an edit
invalidates it with nothing to clear.

**Where the PNG comes from.** There are two ways to turn one of these figures into a PNG and
they do not look alike. The interface rasterises through a browser canvas with the fonts the
figures ask for — that is what **Download PNG** gives you. The server rasterises through
CairoSVG with whatever fonts its image ships, and CairoSVG honours only the *first* family of
a stack rather than walking it, so it is an approximation.

So the interface publishes what it drew, and that is what a link serves. **Copy link** on a
figure card publishes that figure as it does so, and *Report and export → Publish every
figure* does the whole set in one go; both need a sign-in. A figure nobody has published is
rendered by the server, and if the server cannot rasterise at all the `.png` address redirects
to the `.svg`. A link always answers with a picture, and answers with *the same* picture once
the figure has been published.

Published PNGs live in `PLANNER_FIGURE_DIR` (`/data/figure-cache` in the image), under the
design and the revision they were drawn for. Editing the design makes them stale immediately —
they are keyed by revision, so a stale one is never served — and publishing for a new revision
deletes the old one. Nothing needs clearing by hand, and somewhere unwritable just means the
server renders instead. Server-side rendering needs CairoSVG (in `requirements.txt`, with
`cairo` and `font-liberation` in the image).

## API

To build or change a design from a script or an agent, use the design API: see
**[API.md](API.md)**, or `GET /api/v1` on a running planner. The interface's own endpoints are
below. Anyone may use the GETs (the `/api/v1` exports excepted). Everything else needs a session,
either the cookie a login link sets or `Authorization: Bearer <token>`; without one the answer
is 401.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness and card count |
| GET | `/api/bootstrap` | Manifest, all cards, acquisition summary, the designs, and the design the page opens on (`?design=`) |
| GET | `/api/protocols` | Card manifest |
| POST | `/api/protocols` | Create a card, blank or from a base |
| GET/PUT/DELETE | `/api/protocols/<slug>` | Read, save or delete one card |
| POST | `/api/protocols/<slug>/duplicate` | Copy a card |
| POST | `/api/protocols/<slug>/rename` | Rename a card, and optionally its file |
| POST | `/api/protocols/<slug>/meta` | Set a card's name, role or note |
| GET | `/api/protocols/<slug>/backups` | List snapshots |
| POST | `/api/protocols/<slug>/restore` | Restore a snapshot |
| POST | `/api/apply-derived` | Write solved acquisition values into a card |
| GET/POST | `/api/design` | Load or save a design (`name` required); a save with `baseRev` is refused if the design changed since (409) or was deleted since (410) |
| GET | `/api/design/rev` | Revision of a design and of the card set, polled by the page |
| DELETE | `/api/design/<name>` | Delete a design |
| POST | `/api/export/xlsx` | Build and download the workbook |
| POST | `/api/export/bundle` | Build and download the full-export zip |
| POST | `/api/export/json` | Download the design payload |
| GET | `/designs/<name>/figures/` | Every figure this design draws, with the address of each |
| GET | `/designs/<name>/figures/<figure>.svg` | One figure as SVG, drawn from the design as it stands |
| GET | `/designs/<name>/figures/<figure>.png` | The same as PNG — the one the interface published if it has, otherwise rendered here (`?scale=1`–`4` always renders); redirects to the SVG where the server cannot rasterise |
| PUT | `/designs/<name>/figures/<figure>.png` | The interface handing over the PNG it drew, `?rev=` the revision it drew from. Needs a sign-in; 409 if the design has moved on |
| GET | `/login` | The page a login link (`/login#<token>`) opens |
| POST | `/api/auth/redeem` | Spend a login link's token: `{"token"}` → a session (cookie, and `token` in the body) |
| POST | `/api/auth/resume` | Hand back a session a browser kept, when its cookie went |
| GET | `/api/auth/me` | Who is signed in |
| POST | `/api/auth/logout` | Sign this browser out |
| GET/POST | `/api/auth/users` | List people; add someone (answers with their first link) |
| POST | `/api/auth/users/<id>/link` | A new one-time link for someone |
| DELETE | `/api/auth/users/<id>` | Remove someone, and every session they have |
| DELETE | `/api/auth/links/<id>` | Cancel a link nobody has opened |

## Loading an older design

Designs saved by the earlier aim-based planner load unchanged and are converted on the way in:
each aim becomes a trial design, a run design, a session and an experiment; the question bank's
control share moves onto the trial designs; goals stay denominated in questions, because each
experiment names its own unit; and the renamed acquisition cards are repointed automatically.
