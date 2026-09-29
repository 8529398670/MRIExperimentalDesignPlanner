"""PsychoPy task configs at their own addresses.

Every run design compiles to one PsychoPy config - the run is the thing the
presentation computer actually executes - so each one can have a URL rather
than only existing behind a download button.  This module turns a design name
and a slug into YAML text, and keeps the last few designs' worth of work in
memory so listing a design does not re-run the solver once per config.

A config is addressable three ways, and ``find`` tries them in this order:

* its **file stem** - ``run-aim-2-question-run`` - which is readable but
  follows the run design's name, so renaming the run moves the link;
* the run design's **id** - ``run-mtubax2r-1di`` - which is ugly and
  permanent, and so the one to keep in a protocol;
* its **position**, 0-based, which is the least stable of the three: adding or
  deleting a run design shifts every one after it.

Nothing collides: stems and ids both begin ``run-``, and a position is a bare
integer.

Unlike a figure, a config is an *export* - a file to take away - so these
addresses need a sign-in or an API key: the index because it is a list of
files to fetch, each config because it is one of them.  See ``EXPORT_READS``
in ``planner/access.py``.
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from planner.figures import SLUG, Lru

#: How many (design, rev) sets of configs to keep.  Each is a handful of small
#: strings, so this can be more generous than the figure cache.
DESIGN_CACHE = 8


class Configs:
    """PsychoPy configs for a design, cached against the design's revision.

    ``engine`` and ``boot`` are the same ones the API uses; ``read`` takes a
    design name and returns ``(state, rev)`` exactly as the store does.
    """

    def __init__(self, engine: Any, read: Callable[[str], Tuple[Dict[str, Any], str]],
                 boot: Callable[[], Dict[str, Any]]) -> None:
        self._engine = engine
        self._read = read
        self._boot = boot
        self._lock = threading.Lock()
        self._sets = Lru(DESIGN_CACHE)

    # ------------------------------------------------------------ compiling

    def _compile(self, state: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Every config for one revision of one design. Costs a QuickJS run."""
        ctx = self._engine.open(state, self._boot())
        made = ctx.execute({"action": "export.psychopy"})
        if not isinstance(made, list):
            return []
        return [dict(item, index=index) for index, item in enumerate(made)]

    def sheet(self, name: str) -> Tuple[List[Dict[str, Any]], str]:
        """``(configs, rev)`` for a design, compiled once per revision.

        Raises ``FileNotFoundError`` for a name the store does not have.
        """
        state, rev = self._read(name)
        key = (name, rev)
        with self._lock:
            cached = self._sets.take(key)
        if cached is not None:
            return cached, rev
        made = self._compile(state)
        with self._lock:
            self._sets.put(key, made)
        return made, rev

    # --------------------------------------------------------- addressing

    @staticmethod
    def find(configs: List[Dict[str, Any]], slug: str) -> Optional[Dict[str, Any]]:
        """One config by file stem, by run design id, or by position.

        The stem is tried first: it is what the download buttons and the export
        bundle name the file, so a link built from a filename keeps working.
        """
        wanted = str(slug or "").strip().lower()
        if not wanted:
            return None
        for config in configs:
            if stem(config).lower() == wanted:
                return config
        for config in configs:
            if str(config.get("id", "")).lower() == wanted:
                return config
        if wanted.isdigit():
            position = int(wanted)
            if 0 <= position < len(configs):
                return configs[position]
        return None

    @staticmethod
    def valid_slug(slug: str) -> bool:
        return bool(SLUG.match(str(slug or "")))

    def forget(self, name: Optional[str] = None) -> None:
        """Drop cached work, for one design or for all of them."""
        with self._lock:
            if name is None:
                self._sets.clear()
                return
            for key in [k for k in self._sets if k[0] == name]:
                del self._sets[key]


def stem(config: Dict[str, Any]) -> str:
    """The config's file name without its extension: its readable address."""
    name = str(config.get("file") or "")
    return name[:-5] if name.lower().endswith(".yaml") else name
