"""Saved designs: one JSON file per design under the presets directory.

``current`` is the interface's working design, open at ``/``.  Every other
name is a saved design with its own address, ``/designs/<name>``, where the
interface works on that design instead.  Several writers can reach the same
file - the autosave of every page open on it, and the HTTP API - so each read
reports a revision (a hash of the file) and a write can name the revision it
was based on; a write against a stale revision is refused rather than silently
discarding the other writer's change.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from typing import Any, Dict, List, Optional, Tuple

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class DesignConflict(Exception):
    """The design changed since the revision the writer started from."""

    def __init__(self, name: str, rev: Optional[str]) -> None:
        super().__init__(f"The design {name} changed since revision you started from.")
        self.name = name
        self.rev = rev


def clean_name(name: Any) -> str:
    """The file-safe form of a design name, which is the name it is stored under."""
    return SAFE_NAME.sub("-", str(name or "").strip())[:80] or "untitled"


def page_path(name: Any) -> str:
    """Where a design opens in the interface: ``/`` for the working design,
    ``/designs/<name>`` for any other.  A clean name needs no escaping."""
    name = clean_name(name)
    return "/" if name == "current" else f"/designs/{name}"


def _rev_of(blob: bytes) -> str:
    return hashlib.sha1(blob).hexdigest()[:12]


def _serialise(design: Any) -> bytes:
    return (json.dumps(design, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


class DesignStore:
    def __init__(self, directory: str) -> None:
        self.directory = os.path.abspath(directory)
        os.makedirs(self.directory, exist_ok=True)
        self._locks: Dict[str, threading.RLock] = {}
        self._guard = threading.Lock()

    def path(self, name: Any) -> str:
        return os.path.join(self.directory, f"{clean_name(name)}.json")

    def lock(self, name: Any) -> threading.RLock:
        """One lock per design, held across a read-modify-write."""
        key = clean_name(name)
        with self._guard:
            if key not in self._locks:
                self._locks[key] = threading.RLock()
            return self._locks[key]

    def exists(self, name: Any) -> bool:
        return os.path.exists(self.path(name))

    def rev(self, name: Any) -> Optional[str]:
        try:
            with open(self.path(name), "rb") as handle:
                return _rev_of(handle.read())
        except OSError:
            return None

    def read(self, name: Any) -> Tuple[Dict[str, Any], str]:
        """``(design, rev)``; raises ``FileNotFoundError`` for an unknown name."""
        with open(self.path(name), "rb") as handle:
            blob = handle.read()
        return json.loads(blob.decode("utf-8")), _rev_of(blob)

    def write(self, name: Any, design: Dict[str, Any], base_rev: Optional[str] = None) -> str:
        """Store a design and return its new revision.

        With ``base_rev``, refuse when the file has moved on since.  Writing
        what is already there is a no-op, so an autosave that changes nothing
        does not look like a change to anyone watching the revision.
        """
        path = self.path(name)
        blob = _serialise(design)
        with self.lock(name):
            current = self.rev(name)
            if base_rev is not None and current is not None and base_rev != current:
                raise DesignConflict(clean_name(name), current)
            if current == _rev_of(blob):
                return current
            fd, tmp = tempfile.mkstemp(dir=self.directory, suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(blob)
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        return _rev_of(blob)

    def delete(self, name: Any) -> bool:
        path = self.path(name)
        with self.lock(name):
            if not os.path.exists(path):
                return False
            os.unlink(path)
            return True

    def list(self) -> List[Dict[str, Any]]:
        entries = []
        for filename in sorted(os.listdir(self.directory)):
            if not filename.endswith(".json"):
                continue
            path = os.path.join(self.directory, filename)
            label = os.path.splitext(filename)[0]
            title = label
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    blob = json.load(handle)
                title = (blob.get("meta") or {}).get("studyTitle") or label
            except (OSError, json.JSONDecodeError, AttributeError):
                pass
            entries.append(
                {"name": label, "title": title, "modified": os.path.getmtime(path)}
            )
        return entries
