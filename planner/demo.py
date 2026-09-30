"""Play a run design in the browser, built by the PsychoPy builder's own code.

A run design compiles to a PsychoPy config (``planner/psychopy.py``); this
module takes that YAML and does to it exactly what the presentation computer
would: loads it through the builder's ``config.load``, draws a run out of
``bank.build_run``, and hands the trial list to the player in ``static/player/``
to act out.  Nothing here is a model of the task - it *is* the task's code,
vendored in ``planner/builder/``.

So the point of the demo is not the animation.  It is that a config the builder
would refuse - conditions that do not sum, a ``show`` outside the four it
knows, a geometric window narrower than the run's TR - is refused **here**, in
the planner, in the builder's own words, next to the design that produced it.

Questions are not the planner's business, so the bank is a choice:

* ``demo-bank/`` ships with the planner - eighty placeholder propositions, no
  stimulus content, enough to exercise every timing path;
* any directory under ``PLANNER_DEMO_BANK_DIR`` holding ``questions/bank.json``
  is offered too.  That is the builder's own layout, so installing the lab's
  real bank is one copy, or two when the design has picture screens::

      cp -R <builder>/V1/questions demo-banks/lab/questions
      cp -R <builder>/V1/screens   demo-banks/lab/screens

Nothing here writes anything.
"""

from __future__ import annotations

import math
import os
import random
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from planner.builder import bank as builder_bank
from planner.builder import config as builder_config

#: The bank that ships with the planner, chosen when nothing else is asked for.
BUILTIN = "builtin"
BUILTIN_LABEL = "Built-in placeholders"

#: Where a bank keeps its questions, relative to the bank's own directory.
#: Fixed by the config the planner writes: ``paths.bank: questions/bank.json``.
BANK_FILE = Path("questions") / "bank.json"

#: What ``/demo/files/`` will serve, and the only folders of a bank it reads
#: from: the lab server's own ``FILE_DIRS`` (``web.py``), less ``overview/``,
#: which a bank does not carry.  A path is project-relative, as a config
#: writes it - ``questions/images/x.png``, ``screens/rest.png``.
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".gif": "image/gif", ".webp": "image/webp"}
FILE_DIRS = ("questions", "screens")

#: A bank's directory name, so a name from the address cannot walk out of it.
SAFE_BANK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

MAX_BLOCKS = 200


class DemoError(Exception):
    """Something the page asked for that cannot be done; the message says why."""


# --------------------------------------------------------------- the config

def load_text(text: str, root: Any) -> builder_config.Config:
    """``builder.config.load`` for YAML that is already in hand.

    The planner compiles a config into a string and never writes it down, so
    there is no file for ``load`` to open - and the loader does rather a lot
    after the read: it merges over ``defaults.yaml``, names any required key
    that is missing, fills in every condition and screen, and validates.
    Re-implementing that here is how a planner drifts away from the task it
    is planning for, so the file is written out and the loader called.  It
    costs one small temporary file per demo and nothing is left to keep in
    step.
    """
    if not text.strip():
        raise DemoError("That config is empty.")
    with tempfile.TemporaryDirectory(prefix="planner-demo-") as where:
        path = Path(where) / "config.yaml"
        path.write_text(text, encoding="utf-8")
        cfg = builder_config.load(path, root)
    # `root` is the bank's directory, so `paths:` still resolves once the
    # temporary directory is gone; only the config file itself was there.
    return cfg


# ---------------------------------------------------------------- the banks

class Banks:
    """The question banks on offer: the built-in one, then any dropped in."""

    def __init__(self, builtin_dir: str, drop_in_dir: str) -> None:
        self._builtin = Path(builtin_dir)
        self._drop_in = Path(drop_in_dir) if drop_in_dir else None
        self._lock = threading.Lock()
        #: file -> (mtime, questions), so listing the banks does not re-read
        #: every one of them on every page.
        self._counts: Dict[str, Tuple[int, int]] = {}

    # ------------------------------------------------------------ listing

    def listed(self) -> List[Dict[str, Any]]:
        """Every bank the page can offer, the built-in one first."""
        found = [self._entry(BUILTIN, BUILTIN_LABEL, self._builtin)]
        for path in self._dropped_in():
            found.append(self._entry(path.name, path.name, path))
        return [item for item in found if item is not None]

    def _dropped_in(self) -> List[Path]:
        if self._drop_in is None:
            return []
        try:
            here = sorted(self._drop_in.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return []
        return [p for p in here
                if p.name != BUILTIN and self._named_safely(p.name)
                and (p / BANK_FILE).is_file()]

    def _entry(self, key: str, label: str, path: Path) -> Optional[Dict[str, Any]]:
        """One bank as the picker shows it, or None when it is not readable.

        A bank that will not load is still listed, with what went wrong: a
        typo in a dropped-in file is worth seeing, not hiding.
        """
        source = path / BANK_FILE
        if not source.is_file():
            return None
        entry = {"key": key, "label": label, "questions": 0, "error": None}
        try:
            entry["questions"] = self._count(source)
        except Exception as exc:  # noqa: BLE001 - a bad bank must not hide the others
            entry["error"] = f"{type(exc).__name__}: {exc}"
        return entry

    def _count(self, source: Path) -> int:
        """How many questions a bank holds, remembered until the file changes."""
        key, stamp = str(source), source.stat().st_mtime_ns
        with self._lock:
            known = self._counts.get(key)
        if known is not None and known[0] == stamp:
            return known[1]
        # The picker is design-independent, so it counts against the labels a
        # config gets when it does not choose its own.  A bank written for
        # other labels says so here rather than at play time.
        labels = builder_config.defaults()["responses"]["labels"]
        total = len(builder_bank.load(source, labels))
        with self._lock:
            self._counts[key] = (stamp, total)
        return total

    # ------------------------------------------------------------ resolving

    @staticmethod
    def _named_safely(key: str) -> bool:
        return bool(key) and not set(key) - SAFE_BANK and not key.startswith(".")

    def root(self, key: Optional[str]) -> Tuple[str, Path]:
        """``(key, directory)`` for a bank, which ``paths:`` resolves against."""
        key = str(key or BUILTIN).strip() or BUILTIN
        if key == BUILTIN:
            return BUILTIN, self._builtin
        if not self._named_safely(key):
            raise DemoError(f"No question bank called {key!r}.")
        if self._drop_in is None:
            raise DemoError("No drop-in question banks: PLANNER_DEMO_BANK_DIR is not set.")
        path = self._drop_in / key
        if not (path / BANK_FILE).is_file():
            raise DemoError(f"No question bank called {key!r}: "
                            f"nothing at {key}/{BANK_FILE.as_posix()}.")
        return key, path

    def file(self, key: str, relative: str) -> Optional[Path]:
        """A picture at a project-relative path in one bank, or None.

        Confined twice over, as the lab's own server confines ``/files/``: to
        the bank's ``questions/`` and ``screens/``, and to the suffixes the
        page can show.  Anything else is not there as far as the planner is
        concerned, whatever the address says.
        """
        try:
            _key, root = self.root(key)
        except DemoError:
            return None
        try:
            return _servable(root / relative, root)
        except (OSError, ValueError):
            return None

    def find(self, relative: str) -> Optional[Path]:
        """The picture from the first bank that has it - the built-in one, then
        the drop-ins - for a preview that has no bank of its own to ask."""
        for key in [BUILTIN] + [path.name for path in self._dropped_in()]:
            found = self.file(key, relative)
            if found is not None:
                return found
        return None


# ------------------------------------------------------------------ the run

def _whole_number(value: Any, name: str, least: int, most: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise DemoError(f"{name} must be a whole number, not {value!r}.") from None
    if not least <= number <= most:
        raise DemoError(f"{name} must be between {least} and {most}.")
    return number


def read_seed(value: Any) -> int:
    """The seed asked for, or a fresh one.  A demo is reproducible on purpose:
    the same seed rebuilds the same run here and in PsychoPy."""
    if value in (None, ""):
        return random.SystemRandom().randrange(2 ** 31)
    return _whole_number(value, "seed", 0, 2 ** 31 - 1)


def read_blocks(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    return _whole_number(value, "blocks", 1, MAX_BLOCKS)


def plan(text: str, banks: Banks, source: Dict[str, Any], *, bank_key: Optional[str] = None,
         seed: Any = None, blocks: Any = None, files_base: str = "") -> Dict[str, Any]:
    """One run of one config, built the way the presentation computer builds it.

    ``source`` is what the page should say about where the config came from;
    the rest of the answer is the builder's.  The shape matches the lab
    player's own ``/api/plan``, so the vendored stage plays it unchanged.
    """
    key, root = banks.root(bank_key)
    cfg = load_text(text, root)
    asked = read_blocks(blocks)
    if asked is not None:
        # A demo shortens a run, never lengthens it: more blocks than the
        # design has would be a run the design does not describe.
        wanted = min(asked, int(cfg["run"]["n_blocks"]))
        if wanted != cfg["run"]["n_blocks"]:
            cfg["run"]["n_blocks"] = wanted
            builder_config.rebalance(cfg)

    number = read_seed(seed)
    questions = builder_bank.load(cfg.path("bank"), cfg["responses"]["labels"])
    # No `already_seen`: a demo is a fresh participant, so this seed rebuilds
    # this run in PsychoPy for anyone without earlier runs.
    rng = random.Random(number)
    trials, reused = builder_bank.build_run(questions, cfg, rng)
    # After the trials and from the same generator, exactly as session.py
    # draws them: any other order gives this seed a different run than the
    # scanner will.
    leads = builder_bank.lead_durations(cfg, rng)
    if files_base:
        # As web.py's plan(): a trial's picture comes from `paths.images_dir`,
        # a screen's from its own `image`, and either is None when the bank
        # does not have it - the stage then says which file is missing and
        # that PsychoPy would stop there, which is the answer worth having.
        images = cfg.path("images_dir")
        for trial in trials:
            if trial["view"] == "image":
                trial["image_url"] = _file_url(
                    images / trial["params"].get("image", ""), key, root, files_base)
        for screen in cfg["screens"].values():       # a screen that shows a picture
            if screen.get("image"):
                screen["image_url"] = _file_url(cfg.file(screen["image"]), key, root, files_base)

    total = sum(leads.values()) + sum(sum(t["durations"].values()) for t in trials)
    return {"seed": number,
            "source": {**source, "bank": key, "blocks": cfg["run"]["n_blocks"]},
            "cfg": dict(cfg), "trials": trials, "leads": leads, "reused": reused,
            "n_questions": len(questions), "total": round(total, 4)}


def _servable(path: Any, root: Any) -> Optional[Path]:
    """``path`` resolved, when it is a picture that exists inside one of a
    bank's ``FILE_DIRS``; else None.  web.py's ``_servable``, plus the file
    check its ``file_url`` makes."""
    path = Path(path).resolve()
    if path.suffix.lower() not in IMAGE_TYPES:
        return None
    for name in FILE_DIRS:
        if path.is_relative_to((Path(root) / name).resolve()):
            return path if path.is_file() else None
    return None


def _file_url(path: Any, key: str, root: Any, base: str) -> Optional[str]:
    """Where the page fetches one picture, or None when the bank has no such
    file - web.py's ``file_url``, under the design's own demo address."""
    found = _servable(path, root)
    if found is None:
        return None
    relative = found.relative_to(Path(root).resolve()).as_posix()
    return f"{base}/{quote(key)}/{quote(relative)}?v={int(found.stat().st_mtime)}"


# ----------------------------------------------------------------- the page

def summary(text: str, root: Any) -> Dict[str, Any]:
    """What the run picker shows about one config, or why it will not load.

    The same fields the lab player's own catalog shows, so the vendored stage
    and its stylesheet render them unchanged.  No bank and no draw: the phase
    bounds alone, which is what a picker needs.
    """
    item: Dict[str, Any] = {"error": None}
    try:
        cfg = load_text(text, root)
        run, scanner = cfg["run"], cfg["scanner"]
        tr = scanner["tr"]
        phases = []
        for phase in cfg["trial"]["phases"]:
            lo, hi = builder_bank.bounds(phase, tr)
            phases.append({"name": phase["name"], "show": phase["show"], "lo": lo, "hi": hi,
                           "jitter": phase.get("jitter") if hi > lo else None,
                           "p": phase.get("p") if hi > lo else None})
        n = run["n_blocks"] * run["trials_per_block"]
        # The lead-in and the lead-out are phases now, and can be jittered,
        # so they carry a range like any other.
        leads = [builder_bank.bounds(run[key], tr) for key in builder_config.LEADS]
        item.update(
            experiment=cfg.get("experiment"), tr=tr,
            trigger_key=str(scanner["trigger_key"]), dummies=scanner["wait_for_triggers"],
            n_blocks=run["n_blocks"], per_block=run["trials_per_block"], n_trials=n,
            lead_in=run["lead_in"], lead_out=run["lead_out"], phases=phases,
            leads=[{"name": run[key]["name"], "show": run[key]["show"],
                    "lo": bound[0], "hi": bound[1]}
                   for key, bound in zip(builder_config.LEADS, leads)],
            run_len=[round(math.fsum(b[i] for b in leads)
                           + math.fsum(p[k] for p in phases) * n, 2)
                     for i, k in enumerate(("lo", "hi"))],
            conditions={k: c["per_run"] for k, c in cfg["conditions"].items()},
            # What the planner books and the builder does not run, so the page
            # can say why its clock is shorter than the design's run length.
            skipped={"inter_block_rest": run.get("inter_block_rest", 0.0),
                     "inter_trial_gap": run.get("inter_trial_gap", 0.0)},
            ignored=builder_config.ignored(cfg))
    except Exception as exc:  # noqa: BLE001 - one bad run must not hide the others
        item["error"] = f"{type(exc).__name__}: {exc}"
    return item


def default_bank_dir(base_dir: str) -> str:
    return os.environ.get("PLANNER_DEMO_BANK_DIR", os.path.join(base_dir, "demo-banks"))
