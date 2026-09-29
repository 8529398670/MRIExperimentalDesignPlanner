"""Figures at their own addresses.

Every figure the planner draws is a picture of the design as it stands, so it
can have a URL of its own rather than only existing inside a download button.
This module turns a design name and a figure slug into image bytes, and keeps
the last few designs' worth of work in memory so a page of thumbnails does not
re-run the solver sixteen times.

A figure is addressable two ways.  Its **stem** is readable - say
``aim-2-mvpa-session-session`` - but it follows the item's name, so renaming
the session moves the link.  Its **id** - ``session-mtubalg3-14a`` - is ugly and
permanent.  Both resolve here, so a link can be chosen for whichever property
matters: readable to paste into a document, or permanent to keep in a protocol.

There are two ways a figure becomes a PNG, and they do not look the same.

The interface rasterises one in the browser, through a canvas, with the fonts
the font stack actually asks for - that is what *Download PNG* hands you, and
it is the one that looks right.  CairoSVG renders the other here on the server,
through fontconfig, with whatever fonts the image happens to ship; it honours
only the first family in a stack, so it is a decent approximation and no more.

So the browser publishes what it drew, and that is what a link serves.  Server
rendering is the fallback for a figure nobody has published yet, and the SVG is
the fallback for that.  A link always answers with a picture; it answers with
*the same* picture once the figure has been opened in the interface.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional, Tuple

try:  # pragma: no cover - exercised by whether the image ships cairo
    import cairosvg
except Exception:  # ImportError, or an OSError when libcairo is missing
    cairosvg = None


SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")

#: Bigger than this and a link is a denial-of-service rather than a picture.
MIN_SCALE, MAX_SCALE, DEFAULT_SCALE = 1, 4, 2

#: How many (design, rev) figure sets to keep. Each is ~16 SVG strings.
DESIGN_CACHE = 4

#: How many rendered PNGs to keep in memory, across all designs.
PNG_CACHE = 48

#: The scale the interface rasterises at, and so the one it publishes at.
PUBLISHED_SCALE = 3

#: A published PNG bigger than this is refused. The largest figure in a busy
#: design is a couple of megabytes at 3x; this leaves room and still bounds it.
MAX_PUBLISHED_BYTES = 16 * 1024 * 1024

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# CairoSVG resolves a font-family through fontconfig, and takes only the FIRST
# family in the stack rather than walking it.  The figures ask for Inter and a
# programmer's monospace, neither of which a server image has any reason to
# ship, so every one of them misses - and a fontconfig with no match falls back
# to whatever font sorts first, which in an image carrying only Liberation is
# Liberation Mono.  That is how a whole figure ends up set in monospace.
#
# So the stacks are rewritten to ones the server can actually resolve before it
# rasterises.  Only the server's copy is touched: the SVG that goes to a
# browser keeps the stack the interface is designed in.
SERVER_SANS = "Liberation Sans, DejaVu Sans, Arial, Helvetica, sans-serif"
SERVER_MONO = "Liberation Mono, DejaVu Sans Mono, Courier New, monospace"

_FONT_ATTR = re.compile(r'font-family="([^"]*)"')


def _server_fonts(svg: str) -> str:
    """The same drawing, asking for fonts a server is likely to have."""
    def swap(match: "re.Match[str]") -> str:
        stack = match.group(1)
        return 'font-family="%s"' % (
            SERVER_MONO if "mono" in stack.lower() else SERVER_SANS
        )
    return _FONT_ATTR.sub(swap, svg)

#: Anything outside this is not going in a path component.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe(part: str) -> str:
    """One path component, with no way out of the directory it names."""
    cleaned = _UNSAFE.sub("-", str(part or "")).strip(".-")
    return cleaned[:120] or "unnamed"


def png_available() -> bool:
    """Whether this install can rasterise. False means SVG only."""
    return cairosvg is not None


class Lru(OrderedDict):
    """Smallest possible bounded cache; not a general-purpose container."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit

    def take(self, key: Any) -> Any:
        if key not in self:
            return None
        self.move_to_end(key)
        return self[key]

    def put(self, key: Any, value: Any) -> Any:
        self[key] = value
        self.move_to_end(key)
        while len(self) > self.limit:
            self.popitem(last=False)
        return value


class Figures:
    """Figure bytes for a design, cached against the design's revision.

    ``engine`` and ``boot`` are the same ones the API uses; ``read`` takes a
    design name and returns ``(state, rev)`` exactly as the store does.
    """

    def __init__(self, engine: Any, read: Callable[[str], Tuple[Dict[str, Any], str]],
                 boot: Callable[[], Dict[str, Any]],
                 published_dir: Optional[str] = None) -> None:
        self._engine = engine
        self._read = read
        self._boot = boot
        self._published_dir = published_dir
        self._lock = threading.Lock()
        self._sets = Lru(DESIGN_CACHE)
        self._pngs = Lru(PNG_CACHE)

    # ------------------------------------------------------------ drawing

    def _draw(self, name: str, rev: str, state: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Every figure for one revision of one design. Costs a QuickJS run."""
        ctx = self._engine.open(state, self._boot(), figures=True)
        figures = ctx.execute({"action": "export.figures"})
        return [dict(item) for item in figures] if isinstance(figures, list) else []

    def sheet(self, name: str) -> Tuple[List[Dict[str, Any]], str]:
        """``(figures, rev)`` for a design, drawn once per revision.

        Raises ``FileNotFoundError`` for a name the store does not have.
        """
        state, rev = self._read(name)
        key = (name, rev)
        with self._lock:
            cached = self._sets.take(key)
        if cached is not None:
            return cached, rev
        drawn = self._draw(name, rev, state)
        with self._lock:
            self._sets.put(key, drawn)
        return drawn, rev

    # --------------------------------------------------------- addressing

    @staticmethod
    def find(figures: List[Dict[str, Any]], slug: str) -> Optional[Dict[str, Any]]:
        """One figure by file stem or by the id of the thing it draws.

        The stem is tried first: it is what the download buttons and the export
        bundle use, so a link built from a filename keeps working.
        """
        wanted = str(slug or "").strip().lower()
        if not wanted:
            return None
        for figure in figures:
            if str(figure.get("name", "")).lower() == wanted:
                return figure
        for figure in figures:
            if str(figure.get("id", "")).lower() == wanted:
                return figure
        return None

    @staticmethod
    def valid_slug(slug: str) -> bool:
        return bool(SLUG.match(str(slug or "")))

    @staticmethod
    def png_available() -> bool:
        return png_available()

    @staticmethod
    def clamp_scale(value: Any) -> int:
        try:
            scale = int(value)
        except (TypeError, ValueError):
            return DEFAULT_SCALE
        return max(MIN_SCALE, min(MAX_SCALE, scale))

    # ---------------------------------------------------------- rendering

    def png(self, name: str, rev: str, figure: Dict[str, Any], scale: int) -> Optional[bytes]:
        """The figure as PNG, or None when this install cannot rasterise.

        Keyed on the design revision, so an edit invalidates it without anyone
        having to clear anything.
        """
        if cairosvg is None:
            return None
        key = (name, rev, figure.get("name"), scale)
        with self._lock:
            cached = self._pngs.take(key)
        if cached is not None:
            return cached
        blob = cairosvg.svg2png(
            bytestring=_server_fonts(str(figure["svg"])).encode("utf-8"),
            scale=scale,
            background_color="white",
        )
        with self._lock:
            self._pngs.put(key, blob)
        return blob

    # ------------------------------------------------- published by the page

    def _published_path(self, name: str, rev: str, stem: str) -> Optional[str]:
        if not self._published_dir:
            return None
        return os.path.join(self._published_dir, _safe(name), _safe(rev),
                            _safe(stem) + ".png")

    def published(self, name: str, rev: str, stem: str) -> Optional[bytes]:
        """What the interface drew for this figure at this revision, if it has.

        A revision it was not drawn for is not a near miss - the figure has
        changed - so nothing older is ever offered.
        """
        path = self._published_path(name, rev, stem)
        if not path or not os.path.exists(path):
            return None
        try:
            with open(path, "rb") as handle:
                return handle.read()
        except OSError:
            return None

    def publish(self, name: str, rev: str, stem: str, blob: bytes) -> None:
        """Keep what the interface drew, and drop what it drew for older ones.

        Raises ``ValueError`` for anything that is not a PNG of a sane size,
        and ``RuntimeError`` when there is nowhere to put it.
        """
        if not blob.startswith(PNG_MAGIC):
            raise ValueError("that is not a PNG")
        if len(blob) > MAX_PUBLISHED_BYTES:
            raise ValueError(f"a figure over {MAX_PUBLISHED_BYTES // (1024 * 1024)} MB "
                             "is not a figure")
        path = self._published_path(name, rev, stem)
        if not path:
            raise RuntimeError("no figure directory is configured")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Write beside and rename, so a reader never sees half a file.
        staging = path + ".part"
        with open(staging, "wb") as handle:
            handle.write(blob)
        os.replace(staging, path)
        self._prune(name, rev)

    def _prune(self, name: str, keep_rev: str) -> None:
        """Every other revision of this design's figures is dead weight."""
        if not self._published_dir:
            return
        root = os.path.join(self._published_dir, _safe(name))
        keep = _safe(keep_rev)
        try:
            revs = os.listdir(root)
        except OSError:
            return
        for rev in revs:
            if rev == keep:
                continue
            shutil.rmtree(os.path.join(root, rev), ignore_errors=True)

    def forget(self, name: Optional[str] = None) -> None:
        """Drop cached work, for one design or for all of them."""
        with self._lock:
            if name is None:
                self._sets.clear()
                self._pngs.clear()
                return
            for store in (self._sets, self._pngs):
                for key in [k for k in store if k[0] == name]:
                    del store[key]
