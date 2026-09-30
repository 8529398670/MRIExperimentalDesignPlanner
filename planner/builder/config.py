"""YAML configuration loading.

Every config is merged over `config/defaults.yaml`, which holds every setting
the task reads, so a config only needs the keys it changes. Mappings merge key
by key; a list, a scalar and the whole `conditions` block replace. The loader
then fills every remaining default in, so the config snapshot in each run
record says exactly what ran.
"""
import copy
from pathlib import Path

import yaml

DEFAULTS = Path(__file__).resolve().parent.parent / "config" / "defaults.yaml"
REPLACED = {"conditions"}              # top-level blocks a config replaces whole
BUILTIN_SHOWS = ("question", "cue", "blank")
JITTERS = ("uniform", "exponential", "geometric")
RESPONSES = ("answer", "opposite", "none", "constant", "ready")   # ready = constant
TOKEN_CASES = ("upper", "lower", "as_is")
LEADS = ("lead_in", "lead_out")


class Config(dict):
    """A dict with attribute access and a `root` (the project directory)."""

    def __init__(self, data, root):
        super().__init__(data)
        self.root = Path(root)

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)

    def path(self, key):
        """Resolve a `paths:` entry against the project root."""
        return self.root / self["paths"][key]


def short_name(path):
    """`config/experiment-glm.yaml` -> `glm`, `config/experiment.yaml` -> `experiment`."""
    stem = Path(path).stem
    return stem[len("experiment-"):] if stem.startswith("experiment-") else stem


def local_configs(config_dir):
    """Short name -> path for every config in `config_dir`; never the defaults."""
    return {short_name(p): p for p in Path(config_dir).glob("*.yaml")
            if p.name != DEFAULTS.name}


def defaults():
    with open(DEFAULTS, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def ignored(cfg):
    """`run:` keys the planner writes that the task does not implement."""
    return sorted(f"run.{k}" for k in set(cfg["run"]) - set(defaults()["run"]))


def load(path, root=None):
    """`root` resolves `paths:`; by default the directory above the config's own
    (`config/x.yaml` -> the project). Configs mirrored from the planner sit
    deeper, so their caller passes it."""
    path = Path(path).resolve()
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    for key in LEADS:                  # `lead_in: 12.0` sets only the duration
        run = data.get("run") or {}
        if isinstance(run.get(key), (int, float, list)):
            run[key] = {"dur": run[key]}
    base = defaults()
    cfg = Config(_merge(copy.deepcopy(base), data), root or path.parent.parent)
    _required(cfg, base)
    _resolve(cfg)
    _validate(cfg)
    return cfg


def _merge(base, over, top=True):
    """`over` on top of `base`: mappings merge key by key, anything else replaces."""
    out = dict(base)
    for key, value in over.items():
        if (isinstance(value, dict) and isinstance(out.get(key), dict)
                and not (top and key in REPLACED)):
            out[key] = _merge(out[key], value, top=False)
        else:
            out[key] = value
    return out


def _nulls(tree, where=()):
    """Every key path whose value is `~` in the defaults: the required keys."""
    for key, value in tree.items():
        if value is None:
            yield where + (key,)
        elif isinstance(value, dict):
            yield from _nulls(value, where + (key,))


def _required(cfg, base):
    missing = []
    for keys in _nulls(base):
        node = cfg
        for key in keys:
            node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            missing.append(".".join(keys))
    if missing:
        raise ValueError(f"config must set {', '.join(missing)}")


def timed_phases(cfg):
    """Every phase with a duration: the lead-in, the trial's phases, the lead-out."""
    run = cfg["run"]
    return [run["lead_in"], *cfg["trial"]["phases"], run["lead_out"]]


def _resolve(cfg):
    """Fill every default in, from `condition_defaults`, `text` and `trial`."""
    for name, spec in cfg["conditions"].items():
        cfg["conditions"][name] = {**cfg["condition_defaults"], **spec}

    clash = set(cfg["screens"]) & {"fixation", *BUILTIN_SHOWS}
    if clash:
        raise ValueError(f"screens: {sorted(clash)} are built in and cannot be redefined "
                         "(the fixation cross is set under `fixation:`)")
    text = cfg["text"]
    style = {"font": text["font"], "height": text["height"], "color": text["color"],
             "pos": [0, 0]}
    cfg["screens"] = {name: {**style, **spec} for name, spec in
                      {"fixation": cfg["fixation"], **cfg["screens"]}.items()}
    paused = cfg["messages"]["paused"]
    cfg["messages"]["paused"] = {"font": text["font"], "color": text["color"], **paused}

    trial = cfg["trial"]
    for phase in timed_phases(cfg):
        if not isinstance(phase["dur"], (list, tuple)):
            continue
        phase.setdefault("jitter", trial["jitter"])
        if phase["jitter"] == "geometric":
            phase.setdefault("p", trial["jitter_p"])
        elif phase["jitter"] == "exponential":
            phase.setdefault("scale", trial["exponential_scale"])


def _validate(cfg):
    run, trial = cfg["run"], cfg["trial"]
    n = run["n_blocks"] * run["trials_per_block"]
    total = sum(c["per_run"] for c in cfg["conditions"].values())
    if total != n:
        raise ValueError(
            f"conditions per_run sums to {total} but the run has {n} trials"
        )

    screens = set(cfg["screens"])
    unknown = {p["show"] for p in trial["phases"]} - screens - set(BUILTIN_SHOWS)
    if unknown:
        raise ValueError(f"unknown phase `show` values: {sorted(unknown)} "
                         f"(use {', '.join(sorted(screens | set(BUILTIN_SHOWS)))})")
    for key in LEADS:
        show = run[key]["show"]
        if show not in screens | {"blank"}:
            raise ValueError(f"run.{key}: `show` must be blank or a screen "
                             f"({', '.join(sorted(screens))}), got `{show}`")

    labels = cfg["responses"]["labels"]
    if (not isinstance(labels, list) or len(labels) != 2
            or not all(isinstance(x, str) for x in labels) or labels[0] == labels[1]):
        hint = (' - quote them, as ["yes", "no"]: bare yes / no are booleans in YAML'
                if isinstance(labels, list) and any(isinstance(x, bool) for x in labels)
                else "")
        raise ValueError(f"responses.labels must be two different words, got {labels}{hint}")
    if not 0 <= run["label_balance_pct"] <= 100:
        raise ValueError(f"run.label_balance_pct must be 0 to 100, "
                         f"got {run['label_balance_pct']}")
    if cfg["cue"]["token_case"] not in TOKEN_CASES:
        raise ValueError(f"cue.token_case must be one of {', '.join(TOKEN_CASES)}, "
                         f"got `{cfg['cue']['token_case']}`")
    for name, c in cfg["conditions"].items():
        if c["response"] not in RESPONSES:
            raise ValueError(f"condition `{name}`: unknown response `{c['response']}` "
                             "(use answer, opposite, none or constant)")
        if c["response"] in ("constant", "ready") and not (
                isinstance(c["word"], str) and c["word"]):
            raise ValueError(f"condition `{name}`: a constant response needs a `word`, "
                             f"got {c['word']!r}")

    tr = cfg["scanner"]["tr"]
    for phase in timed_phases(cfg):
        name = phase["name"]
        if isinstance(phase["dur"], (list, tuple)):
            if len(phase["dur"]) != 2 or phase["dur"][0] > phase["dur"][1]:
                raise ValueError(f"phase `{name}`: a jittered `dur` is [lo, hi], "
                                 f"got {phase['dur']}")
        kind = phase.get("jitter")
        if kind is None:
            continue
        if kind not in JITTERS:
            raise ValueError(f"phase `{name}`: unknown jitter `{kind}` "
                             "(use uniform, exponential or geometric)")
        if kind == "exponential" and not phase["scale"] > 0:
            raise ValueError(f"phase `{name}`: exponential scale must be above 0, "
                             f"got {phase['scale']}")
        if kind != "geometric":
            continue
        if not 0 < phase["p"] < 1:
            raise ValueError(f"phase `{name}`: geometric p must be between 0 and 1, "
                             f"got {phase['p']}")
        lo, hi = phase["dur"]
        if hi - lo < tr - 1e-9:
            raise ValueError(f"phase `{name}`: geometric jitter steps in whole TRs, "
                             f"but [{lo}, {hi}] is shorter than one TR ({tr} s)")


def rebalance(cfg):
    """Scale condition counts to a shortened run. Always sums to the trial count."""
    n = cfg["run"]["n_blocks"] * cfg["run"]["trials_per_block"]
    # a condition at 0 (the planner lists every one) stays at 0
    conds = {k: c for k, c in cfg["conditions"].items() if c["per_run"]}
    if n < len(conds):
        raise ValueError(f"a {n}-trial run cannot hold {len(conds)} conditions")
    total = sum(c["per_run"] for c in conds.values())
    counts = {k: 1 for k in conds}          # keep every condition represented
    share = {k: c["per_run"] / total * (n - len(conds)) for k, c in conds.items()}
    for key, value in share.items():
        counts[key] += int(value)
    # hand the rounding leftovers to the largest fractional parts
    order = sorted(share, key=lambda k: share[k] - int(share[k]), reverse=True)
    for key in order[: n - sum(counts.values())]:
        counts[key] += 1
    for key, value in counts.items():
        conds[key]["per_run"] = value
