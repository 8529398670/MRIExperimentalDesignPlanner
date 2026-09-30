#!/usr/bin/env python3
"""Play a run through the vendored PsychoPy stage, with no browser.

``static/player/stage.js`` is the lab's own stage, copied verbatim, and it is
the one part of the demo player that cannot be checked by reading: what it
paints depends on a clock, a frame loop and a schedule.  This runs it - the
real file, not a model of it - under QuickJS on the small DOM in
``tools/dom_stub.js``, drives the frames from a synthetic clock, and records
what is on screen through every segment of a run.

The dev host has no node and no headless browser, so this is how a claim like
"the fixation cross never showed" gets an answer rather than an opinion.  It
stays as a regression test for the vendored player::

    python3 tools/stage_harness.py                  # every run of every design
    python3 tools/stage_harness.py --design V2
    python3 tools/stage_harness.py --examples       # the lab's own configs too
    python3 tools/stage_harness.py --design V2 --run 2 --trace

Exit status is 0 when every segment painted what its `show` asked for.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

import quickjs  # noqa: E402

from planner import demo  # noqa: E402
from planner.builder import bank as builder_bank  # noqa: E402

PLAYER = BASE / "static" / "player"
STUB = BASE / "tools" / "dom_stub.js"

#: `show` -> the element that must be visible.  Since f141c38 the stage keeps
#: one element per `screens:` entry, `fixation` among them, so a name that is
#: not built in is a screen and is checked by that name.
PAINTS = {"cue": "cue", "question": "qtext", "blank": None}

FRAME_MS = 1000.0 / 60.0
#: A guard, not a budget: a 15-minute run at 60 fps is ~54k frames.
MAX_FRAMES = 400_000


def module_source(path: pathlib.Path) -> str:
    """One player file as a plain script: QuickJS evaluates scripts, not
    modules, and these two only import from each other."""
    src = path.read_text(encoding="utf-8")
    # [^;\n] on purpose: a negated class matches newlines too, and a greedy
    # one would swallow everything up to the next statement end.
    src = re.sub(r"^\s*import[^;\n]*;[ \t]*$", "", src, flags=re.M)
    return re.sub(r"^export[ \t]+", "", src, flags=re.M)


DRIVER = r"""
/* The harness's own side: a feed that only remembers, and a loop that steps
   the clock a frame at a time and writes down what is on screen. */
var __events = [];
var __feed = {
  begin: function (meta, plan) { __events.push({ kind: 'begin' }); },
  emit: function (kind, payload) { __events.push({ kind: kind, payload: payload }); },
  tick: function () {},
  idle: function () { __events.push({ kind: 'idle' }); },
};

/* What one screen element draws: its line of text, or - since c4deb46, a
   screen may be a picture - the picture it was given, or none. */
function __drawn(el) {
  if (el.tagName === 'IMG') return 'picture:' + (el.src || '(none)');
  return el.textContent;
}

/* Since f141c38 the stage holds one element per `screens:` entry in
   stage.screens, keyed by name, beside the three it builds itself. */
function __visible(stage) {
  var on = [];
  var named = stage.screens || {};
  for (var name in named) {
    if (named[name] && !named[name].hidden) on.push({ el: name, text: __drawn(named[name]) });
  }
  var built = { cue: stage.cue, qtext: stage.qtext, message: stage.message };
  for (var key in built) {
    if (built[key] && !built[key].hidden) on.push({ el: key, text: built[key].textContent });
  }
  return on;
}

/* Fire every timer that has come due, innermost first. */
function __runTimers() {
  for (var guard = 0; guard < 100; guard++) {
    var due = __timers.filter(function (t) { return t.due <= __now; });
    if (!due.length) return;
    due.sort(function (a, b) { return a.due - b.due; });
    var next = due[0];
    __timers = __timers.filter(function (t) { return t.id !== next.id; });
    next.fn();
  }
}

function __play(plan, opts, maxFrames) {
  var root = document.createElement('div');
  var stage = new Stage(root, __feed, { onBack: function () {}, onReplay: function () {},
                                        openDebug: function () {} });
  __now = 0;
  __frame = null;
  __timers = [];
  stage.start(plan, opts, { label: 'harness', seed: plan.seed, command: '' });

  /* segment index -> what was on screen while it was the current one */
  var seen = {};
  var frames = 0;
  while (frames < maxFrames) {
    __now += FRAME_MS;
    __runTimers();
    var fn = __frame;
    if (!fn) break;
    __frame = null;
    fn(__now);
    frames++;
    if (stage.idx >= 0 && (stage.state === 'running' || stage.state === 'paused')) {
      var key = String(stage.idx);
      if (!seen[key]) seen[key] = { painted: [], frames: 0 };
      var on = __visible(stage);
      seen[key].frames++;
      var label = on.map(function (x) { return x.el + '=' + x.text; }).join('|') || '(blank)';
      if (seen[key].painted.indexOf(label) < 0) seen[key].painted.push(label);
    }
    if (stage.state === 'done' || stage.state === 'aborted') break;
  }

  /* What each screen is set to draw, so the check compares a segment with
     the design's own mark rather than a cross it assumes. */
  var marks = {};
  for (var name in (stage.screens || {})) marks[name] = __drawn(stage.screens[name]);

  var segs = stage.segs.map(function (seg, i) {
    var got = seen[String(i)] || { painted: [], frames: 0 };
    return {
      i: i, name: seg.name, show: seg.show,
      trial: seg.trial ? seg.trial.trial : null,
      cue: seg.trial ? seg.trial.cue : null,
      t0: seg.t0, t1: seg.t1,
      painted: got.painted, frames: got.frames,
    };
  });
  return JSON.stringify({ state: stage.state, frames: frames, total: stage.total,
                          marks: marks, segs: segs, events: __events.length });
}
"""


def context() -> quickjs.Context:
    ctx = quickjs.Context()
    ctx.eval(STUB.read_text(encoding="utf-8"))
    ctx.eval("var FRAME_MS = %r;" % FRAME_MS)
    ctx.eval(module_source(PLAYER / "feed.js"))
    ctx.eval(module_source(PLAYER / "stage.js"))
    ctx.eval(DRIVER)
    return ctx


def play(ctx: quickjs.Context, plan: dict, opts: dict | None = None) -> dict:
    """Run one plan through the stage and return what each segment painted."""
    opts = {"scanner": "none", "speed": 1, "auto": True, "debug": False,
            "fullscreen": False, "hud": False, **(opts or {})}
    ctx.eval("var __plan = %s; var __opts = %s;"
             % (json.dumps(plan, ensure_ascii=True), json.dumps(opts, ensure_ascii=True)))
    return json.loads(ctx.eval("__play(__plan, __opts, %d)" % MAX_FRAMES))


def check(result: dict) -> list:
    """Every way a segment can have failed to paint what it asked for."""
    problems = []
    for seg in result["segs"]:
        show = seg["show"]
        want = PAINTS[show] if show in PAINTS else show   # a screen, by its own name
        painted = seg["painted"]
        where = f"segment {seg['i']} ({seg['name']}, show: {seg['show']})"
        if not seg["frames"]:
            # Too short to catch a frame; only worth saying when it had time.
            if seg["t1"] - seg["t0"] > FRAME_MS / 1000 * 2:
                problems.append(f"{where}: lasted {seg['t1'] - seg['t0']:.2f}s but never "
                                "held a frame")
            continue
        if want is None:
            if painted != ["(blank)"]:
                problems.append(f"{where}: should be blank, painted {painted}")
            continue
        for label in painted:
            if not label.startswith(want + "="):
                problems.append(f"{where}: should paint `{want}`, painted {label!r}")
        if want in result["marks"]:
            if result["marks"][want] == "picture:(none)":
                # The stage draws an empty picture and warns; the task stops.
                problems.append(f"{where}: its picture is not in the question bank's "
                                "screens/, so nothing was drawn (PsychoPy would stop here)")
            # A screen draws whatever the design set it to, which may be nothing.
            expected = f"{want}={result['marks'][want]}"
            for label in painted:
                if label != expected:
                    problems.append(f"{where}: painted {label!r}, not {expected!r}")
        if want == "cue" and seg["cue"] is not None:
            for label in painted:
                if label != f"cue={seg['cue']}":
                    problems.append(f"{where}: cue should be {seg['cue']!r}, painted {label!r}")
    if result["state"] != "done":
        problems.append(f"the run ended in state {result['state']!r}, not 'done'")
    return problems


def summarise(result: dict) -> str:
    counts = {}
    for seg in result["segs"]:
        counts[seg["show"]] = counts.get(seg["show"], 0) + 1
    order = ", ".join(f"{k} ×{v}" for k, v in sorted(counts.items()))
    return (f"{len(result['segs'])} segments ({order}), {result['frames']} frames, "
            f"{result['total']:.1f}s, {result['events']} events")


def trace(result: dict, limit: int = 14) -> None:
    print(f"    {'#':>3}  {'segment':22s} {'show':9s} {'secs':>7s}  painted")
    for seg in result["segs"][:limit]:
        print(f"    {seg['i']:3d}  {seg['name'][:20]:22s} {seg['show']:9s} "
              f"{seg['t1'] - seg['t0']:7.2f}  {', '.join(seg['painted']) or '-'}")
    if len(result["segs"]) > limit:
        print(f"    … {len(result['segs']) - limit} more")


# ------------------------------------------------------------------ inputs

def design_plans(name: str, banks: demo.Banks, seed: int, run_only):
    """(label, plan) for every run design of one planner design."""
    import server  # imported late: it builds the engine and reads the cards
    sheet, _rev = server.psychopy.sheet(name)
    for item in sheet:
        if run_only is not None and item["index"] != run_only:
            continue
        label = f"{name} / {item.get('run') or item.get('file')}"
        source = {"source": "planner", "design": name, "id": item.get("id", ""),
                  "file": item.get("file", "")}
        yield label, demo.plan(item.get("yaml", ""), banks, source, seed=seed,
                               files_base="/demo/files")


def example_plans(banks: demo.Banks, seed: int):
    """The lab's own configs, which its player is known to handle."""
    _key, root = banks.root(None)
    for path in sorted((BASE / "psychopy-builder-config-examples").glob("*.yaml")):
        cfg = demo.load_text(path.read_text(encoding="utf-8"), root)
        questions = builder_bank.load(cfg.path("bank"), cfg["responses"]["labels"])
        import random
        rng = random.Random(seed)
        trials, reused = builder_bank.build_run(questions, cfg, rng)
        leads = builder_bank.lead_durations(cfg, rng)   # after the trials, as session.py
        total = sum(leads.values()) + sum(sum(t["durations"].values()) for t in trials)
        yield f"lab / {path.name}", {
            "seed": seed, "source": {"source": "local", "file": path.name},
            "cfg": dict(cfg), "trials": trials, "leads": leads, "reused": reused,
            "n_questions": len(questions), "total": round(total, 4)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--design", action="append", help="a design name; repeatable")
    ap.add_argument("--run", type=int, help="only this run design, by position")
    ap.add_argument("--examples", action="store_true",
                    help="also play the lab's own configs")
    ap.add_argument("--bank", default=None, help="question bank (default: built-in)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--speed", type=float, default=1)
    ap.add_argument("--trace", action="store_true", help="print every segment")
    args = ap.parse_args()

    banks = demo.Banks(BASE / "demo-bank", demo.default_bank_dir(str(BASE)))
    if args.bank:
        banks.root(args.bank)                       # fail early on a bad name

    plans = []
    names = args.design
    if names is None:
        import server
        names = sorted(entry["name"] for entry in server.designs.list())
    for name in names:
        plans.extend(design_plans(name, banks, args.seed, args.run))
    if args.examples:
        plans.extend(example_plans(banks, args.seed))
    if not plans:
        print("nothing to play", file=sys.stderr)
        return 2

    ctx = context()
    failed = 0
    for label, plan in plans:
        result = play(ctx, plan, {"speed": args.speed})
        problems = check(result)
        mark = "ok  " if not problems else "FAIL"
        print(f"{mark} {label}")
        print(f"     {summarise(result)}")
        if args.trace:
            trace(result)
        for problem in problems:
            print(f"     - {problem}")
        failed += bool(problems)
    print(f"\n{len(plans) - failed}/{len(plans)} runs painted what they asked for")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
