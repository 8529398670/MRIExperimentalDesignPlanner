# Tutorial — planning a study, start to finish

`README.md` is the reference: what every control does. This is the walkthrough: what to do,
in what order, and why. Follow it once from top to bottom and you will have a costed design
and a PsychoPy config to run it with.

---

## 0. What this tool is for

It answers one question: **how much scanner time does my design need, and does it fit?**

It decides timing, run structure, session shape and hours. It deliberately does **not**
decide what a participant is shown or in what order — no stimulus lists, no condition
labels, no trial randomisation. That belongs to the presentation software, and the planner
hands it over in the exported PsychoPy YAML.

Rule of thumb for whether a thing belongs here: **does it change how many hours the study
needs?** Trial length does, so it lives here. Which picture appears on trial 12 does not, so
it does not.

---

## 1. Start it

```bash
./run.sh
```

Then open <http://127.0.0.1:8760>. If that port is busy:

```bash
./run.sh --port 8791
```

First time on a new machine:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Your work autosaves to `presets/current.json` as you go. You do not need to press save.

---

## 2. The one idea you need

Everything is built out of the level below it:

```
Phase      a stretch of one trial: "Fixation, 2-6 s"
  |
Trial      an ordered list of phases: what one trial looks like, second by second
  |
Run        a trial design laid out into blocks, bound to one acquisition card
  |
Session    setup, structurals, runs and breaks, in the order the console does them
  |
Experiment a plan of sessions, with a goal and a share of scanner time
  |
Study      every experiment inside one budget
```

Each level is a **library**, not a fixed slot. Add, duplicate, rename and delete freely.
Build "Main task day" once and several experiments can use it; edit it and they all change.

The left rail follows this order, roughly top-down. When you are building something new it
is easiest to work **bottom-up**: acquisition card → trial → jitter → run → session →
experiment → budget.

---

## 3. Walkthrough

### Step 1 — Acquisition panel: pick or make the scanner card

The card supplies **TR**, TE, voxel size and scan duration. TR matters more than it looks:
it sets how many volumes a run produces, how long dummy scans take, and — if you use
geometric jitter — the step size every jittered wait moves in.

The shipped cards (`EPI-TR2000-Task`, `EPI-TR1000-Task`, `EPI-TR800-Task`) are real exported
parameter sets. Duplicate one and edit rather than starting blank.

### Step 2 — Trials panel: describe one trial

A trial is a list of phases. Each phase has:

| Field | Meaning |
|---|---|
| **Name** | Whatever you call it — "Fixation", "Cue", "Response" |
| **Role** | What the regressor model does with it (see below) |
| **Min / Max** | Duration in seconds. **Equal min and max means a fixed phase.** |
| **Jitter** | Tick it and this phase's wait varies between min and max |

The **role** is the part that matters statistically:

- **Stimulus / cue** and **Response / probe window** each get their own regressor.
- **Fixation / baseline** and **Delay / retention** get none — they are the gaps.

So a minimal event-related trial is: Fixation (baseline) → Stimulus → Delay → Response →
Fixation.

Underneath, the **Trial timeline** figure draws the trial to scale, and **Copy sequence**
gives you a one-line text version.

### Step 3 — HRF model panel: decide what "separated" means

Skip this on a first pass; the defaults are the canonical SPM double gamma.

Come back when you care about whether one trial's response is contaminating the next. The
**objective** you set on a trial (Detection / Single-trial estimation / Full HRF separation)
is really a residual tolerance — how much leftover signal from the previous event you will
accept. The **separation solver**, on the Trials panel, reads that tolerance off the
response shape and tells you the delay and tail fixation it implies. "Apply this solution"
writes those numbers into the trial.

### Step 4 — Jitter panel: decide how the gaps are drawn

**This panel does not choose which phases vary** — that is the Jitter tick box on each phase,
back in Trials. It chooses how the varying ones are *drawn*. See §4 for the whole story;
the short version is that it is off by default and the default is fine.

### Step 5 — Runs panel: lay trials out into a run

A run binds one trial design to one acquisition card and sets:

- **Trials per block** and **blocks per run**
- **Inter-trial gap** — dead time between trials, on top of the phases
- **Inter-block rest** — the longer breather between blocks
- **Dummy volumes** — discarded at the start; `t = 0` is the last dummy pulse
- **Lead-in / lead-out** — fixation at each end of the run

Watch the run length here. If it exceeds your run cap, **auto-clamp** (Budget panel) will
quietly reduce blocks or trials per block and tell you it did — check the constraint report
rather than wondering why your trial count dropped.

### Step 6 — Sessions panel: build a scanning day

A session is an ordered list of what the console actually does: setup steps, structurals
(T1, field map, SBRef), functional runs and breaks. Drag them into the order you will run
them. A break is inserted automatically between two back-to-back functional runs unless you
put something between them yourself.

### Step 7 — Experiments panel: set the goal and the share

An experiment is a plan of sessions plus:

- **Goal** — how many trials (or your own unit) you are trying to collect
- **Share of scanner time** — a percentage, lockable, with the rest redistributing

### Step 8 — Budget panel: say how much time exists, and solve

Set total scanner hours, a contingency reserve, sessions per week and weeks available.
Then pick a **solve mode**:

| Mode | Meaning |
|---|---|
| **Hours available** | Spend the budget; the count collected is whatever it buys |
| **One total goal** | Fill one study-wide goal as far as the hours allow |
| **Per-experiment goals** | Each experiment runs until it hits its own goal |
| **Session counts** | You set the number of sessions directly |

The **constraint envelope** — max run minutes, max session minutes, runs per session,
continuous-scanning comfort limit — is what auto-clamp enforces.

### Step 9 — Overview panel: read the answer

Committed hours, utilisation, sessions, runs, trials, weeks needed, data volume, and a
warnings list. **Read the warnings.** They are where auto-clamp confesses to changing your
structure.

### Step 10 — Report and export

- **PsychoPy task config** — one YAML per run design, ready to drive presentation
- **Workbook (.xlsx)** — every table, every sheet
- **Copy methods text** — a paste-ready methods narrative
- **Design JSON / full zip** — the whole state, reloadable

---

## 4. Jitter, properly

### Why jitter at all

If every event lands on the same TR phase, the rows of your design matrix repeat, and you
can only recover *sums* of betas — never the individual ones. Varying the gaps makes every
row different. In a rapid event-related design this is not a refinement, it is the
difference between an estimable design and an unestimable one.

### The two distributions

**Flat window (default).** A wait is uniform between min and max, so it averages the
midpoint. A 2–6 s fixation costs 4 s.

**Truncated geometric (optional).** A wait is a whole number of TRs above the minimum, drawn
so that the chance the stimulus arrives on the next TR stays `p` *however long the
participant has already waited*. It is the only discrete distribution with that property,
which is the entire reason for using it: under a flat window every blank TR that passes
tells the participant the stimulus is more likely next, and at the top of the window they
know it with certainty.

Turning it on **shortens the study**, because the geometric mean sits well below the
midpoint. That is why the choice lives in the planner and not in PsychoPy — it changes the
hours.

### The thing that confuses everyone: how many steps a phase gets

A geometric wait moves in **whole TRs**. So:

```
steps (n_max) = (max - min) / TR
```

The number of steps depends on **how wide the window is**, not on how long the waits are.
Two phases with completely different timings get the same number of steps if their windows
are the same width. In the shipped design every jittered phase happens to have a 4 s window:

| Phase | Window | TR | Steps | Possible waits |
|---|---|---|---|---|
| Fixation 2–6 s | 4 s | 2 s | 4 / 2 = **2** | 2, 4, 6 s |
| Delay 6–10 s | 4 s | 2 s | 4 / 2 = **2** | 6, 8, 10 s |
| Fixation 10–14 s | 4 s | 2 s | 4 / 2 = **2** | 10, 12, 14 s |
| Fixation 24–28 s | 4 s | 2 s | 4 / 2 = **2** | 24, 26, 28 s |

— which is why they all show 2 steps despite looking very different. **Want more steps?
Widen the window.** At TR 2 s: 4 s buys 2 steps, 6 s buys 3, 8 s buys 4. The Jitter panel
prints both tables — the derivation per phase, and what window buys how many steps.

Two consequences worth knowing:

- **A window narrower than one TR has nowhere to step**, so the phase becomes a fixed wait at
  its minimum. The shipped GLM Delay (1–2 s at TR 2 s) does exactly this. The panel names it
  rather than silently shortening your trial.
- **A 2–7 s window at TR 2 s tops out at 6 s**, because 7 is not on the ladder. The planner
  sizes and exports the 6.

### Reading the distribution table

```
| No. of TRs in delay | Wait | P(delay) | Running total | P(next TR) |
|                   0 |  2 s |   0.5714 |        0.5714 |     0.5714 |
|                   1 |  4 s |   0.2857 |        0.8571 |     0.6667 |
|                   2 |  6 s |   0.1429 |        1.0000 |  1 (certain)|
```

- **P(delay)** — how often that wait comes up.
- **Running total** — the sampling recipe. Draw a uniform (0, 1); take the first row whose
  running total covers it.
- **P(next TR)** — the chance the stimulus arrives on the next TR *given the participant has
  already waited this long*. Untruncated this would be flat at `p`. It climbs because the
  distribution is truncated, and hits certainty on the last row.

### The two settings

**`p`** — the shape. Low approaches a flat window, 0.5 is the textbook default, high pins
every wait to its minimum.

**Truncation** — where the longest delay is capped. Either at each phase's own max (the
default) or at one stated number of TRs for the whole design. A stated cap can only ever
*tighten*; it never overrides a max you typed.

Tightening the cap buys shorter, cheaper runs and costs anticipation. The **Anticipatable
trials** readout prices that exactly: it is the share of trials landing on the last row,
where the participant knows the stimulus is next. On the shipped GLM trial, going from a
2 TR cap to a 1 TR cap takes it from 14.3 % to 33.3 %.

---

## 5. Common confusions

**"My trial count dropped and I didn't touch it."** Auto-clamp hit a cap. Check the warnings
on the Overview panel — it says exactly what it changed.

**"Two phases have the same steps but totally different durations."** Steps come from window
width ÷ TR. See §4.

**"I ticked Jitter but the phase isn't varying."** Its min and max are equal, or (with
geometric on) its window is narrower than one TR.

**"The hours changed when I turned geometric jitter on."** That is the point — it is a
shorter design. Turn it off to compare.

**"Where did the Conditions card go?"** Removed deliberately. Condition labels, balance and
ordering are the presentation software's job. If two trial types genuinely differ in
*timing*, model them as two trial designs combined at the run level.

---

## 6. Where things live

| Path | What |
|---|---|
| `presets/current.json` | Your autosaved working design |
| `presets/*.json` | Named designs you saved |
| `scanner-parameters/*.json` | Acquisition cards |
| `scanner-parameters/.backups/` | Timestamped snapshot before every card save |
| `exports/` | Every workbook and zip you generated |

To reload an old design: **Report and export → Saved designs → Import JSON file**.
