"""Loading, validation and persistence of scanner acquisition parameter cards.

Each card is a JSON object of the form::

    {
      "_meta":     {"label": "Task EPI - TR 800 ms", "role": "functional", "note": ""},
      "INFO PAGE": [ {"parameter": "...", "value": "...", "indent": 0}, ... ],
      "GEOMETRY":  [ ... ],
      ...
    }

Keys beginning with an underscore carry card metadata; every other key is a
console page holding an ordered list of parameter rows.  Nothing about the set
of pages or the set of parameters is fixed: pages may be added, renamed and
removed, and so may the rows inside them.

The planner treats these files as the single source of truth for acquisition
settings.  The UI edits them in place; every write is preceded by a timestamped
backup so a bad edit is always recoverable.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from collections import OrderedDict
from datetime import datetime
from typing import Any, Dict, List, Optional

# Console page order for the cards that ship with the planner.  Pages that are
# not in this list keep the order they were created in and sort after it, so a
# card with pages of its own is never reshuffled.
SECTION_ORDER = [
    "INFO PAGE",
    "GEOMETRY",
    "CONTRAST",
    "POST/PROC",
    "MOTION",
    "DYN/ANG",
]

ROLES = ["functional", "reference", "structural", "other"]
ROLE_RANK = {role: index for index, role in enumerate(ROLES)}

ROLE_LABELS = {
    "functional": "Functional EPI",
    "reference": "Reference and field maps",
    "structural": "Structural and localiser",
    "other": "Other",
}

# A blank card still has to be a card: these are the pages a new one starts
# with, and the handful of rows the planner itself reads.
BLANK_SECTIONS = OrderedDict(
    (
        (
            "INFO PAGE",
            [
                {"parameter": "Total scan duration", "value": "05:00.0", "indent": 0},
                {"parameter": "Act. TR/TE (ms)", "value": "2000 / 30", "indent": 0},
                {"parameter": "ACQ voxel MPS (mm)", "value": "2.50 / 2.50 / 2.50", "indent": 0},
                {"parameter": "REC voxel MPS (mm)", "value": "2.50 / 2.50 / 2.50", "indent": 0},
            ],
        ),
        (
            "GEOMETRY",
            [
                {"parameter": "slices", "value": "36", "indent": 0},
                {"parameter": "Reconstruction matrix", "value": "96", "indent": 0},
                {"parameter": "Flip angle (deg)", "value": "75", "indent": 0},
            ],
        ),
        (
            "DYN/ANG",
            [
                {"parameter": "dyn scans", "value": "150", "indent": 0},
                {"parameter": "dummy scans", "value": "4", "indent": 0},
            ],
        ),
    )
)


class ProtocolError(ValueError):
    """Raised when a protocol payload fails structural validation."""


def _slug_of_file(filename: str) -> str:
    return os.path.splitext(os.path.basename(filename))[0]


def _safe_slug(slug: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", slug or ""):
        raise ProtocolError(f"Illegal protocol identifier: {slug!r}")
    return slug


def slugify(text: str, fallback: str = "New-Card") -> str:
    """Turn a human label into a filesystem-safe card identifier."""
    clean = re.sub(r"[^A-Za-z0-9]+", "-", str(text or "")).strip("-")
    return (clean or fallback)[:120]


def meta_of(data: Dict[str, Any], slug: str = "") -> Dict[str, str]:
    """Label, role and note for a card, falling back to the slug."""
    raw = data.get("_meta") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        raw = {}
    role = str(raw.get("role", "other")).strip().lower()
    return {
        "label": str(raw.get("label") or slug or "Untitled card"),
        "role": role if role in ROLE_RANK else "other",
        "note": str(raw.get("note") or ""),
    }


def sections_of(data: Dict[str, Any]) -> List[str]:
    """Page names in console order; unknown pages keep their own order."""
    keys = [k for k in data.keys() if not k.startswith("_") and isinstance(data[k], list)]
    known = [s for s in SECTION_ORDER if s in keys]
    extra = [s for s in keys if s not in SECTION_ORDER]
    return known + extra


class ProtocolStore:
    """Filesystem-backed store for the scanner acquisition cards."""

    def __init__(self, directory: str) -> None:
        self.directory = os.path.abspath(directory)
        self.backup_dir = os.path.join(self.directory, ".backups")
        os.makedirs(self.directory, exist_ok=True)
        os.makedirs(self.backup_dir, exist_ok=True)

    # ------------------------------------------------------------------ read

    def slugs(self) -> List[str]:
        if not os.path.isdir(self.directory):
            return []
        return sorted(
            _slug_of_file(f)
            for f in os.listdir(self.directory)
            if f.endswith(".json") and not f.startswith(".")
        )

    def path_for(self, slug: str) -> str:
        return os.path.join(self.directory, f"{_safe_slug(slug)}.json")

    def exists(self, slug: str) -> bool:
        try:
            return os.path.exists(self.path_for(slug))
        except ProtocolError:
            return False

    def load(self, slug: str) -> Dict[str, Any]:
        with open(self.path_for(slug), "r", encoding="utf-8") as handle:
            return json.load(handle, object_pairs_hook=OrderedDict)

    def load_all(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for slug in self.slugs():
            try:
                out[slug] = self.load(slug)
            except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover
                out[slug] = {"_error": str(exc)}
        return out

    def manifest(self) -> List[Dict[str, Any]]:
        """Slug, label, role and a handful of headline values for the picker."""
        entries = []
        for slug in self.slugs():
            try:
                data = self.load(slug)
            except (OSError, json.JSONDecodeError):
                continue
            meta = meta_of(data, slug)
            entries.append(
                {
                    "slug": slug,
                    "label": meta["label"],
                    "role": meta["role"],
                    "note": meta["note"],
                    "sections": sections_of(data),
                    "parameterCount": sum(
                        len(v) for k, v in data.items()
                        if not k.startswith("_") and isinstance(v, list)
                    ),
                    "headline": headline_values(data),
                    "modified": os.path.getmtime(self.path_for(slug)),
                }
            )
        entries.sort(key=lambda e: (ROLE_RANK.get(e["role"], 9), e["label"].lower()))
        return entries

    # ----------------------------------------------------------------- write

    def save(self, slug: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        validate(payload)
        path = self.path_for(slug)
        backup = self._backup(slug)
        ordered = order_sections(payload, slug)
        fd, tmp = tempfile.mkstemp(dir=self.directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(ordered, handle, indent=4, ensure_ascii=False)
                handle.write("\n")
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        self._prune_backups(slug)
        return {"slug": slug, "backup": os.path.basename(backup) if backup else None}

    def create(
        self,
        label: str,
        role: str = "functional",
        note: str = "",
        base: Optional[str] = None,
        slug: Optional[str] = None,
    ) -> str:
        """Create a card, either blank or copied from an existing one."""
        target = _safe_slug(slugify(slug or label))
        target = self._free_slug(target)
        if base:
            data = self.load(base)
        else:
            data = OrderedDict((k, json.loads(json.dumps(v))) for k, v in BLANK_SECTIONS.items())
        payload = OrderedDict()
        payload["_meta"] = {
            "label": str(label or target),
            "role": role if role in ROLE_RANK else "other",
            "note": str(note or ""),
        }
        for key, rows in data.items():
            if not key.startswith("_"):
                payload[key] = rows
        self.save(target, payload)
        return target

    def duplicate(self, slug: str, label: Optional[str] = None) -> str:
        data = self.load(slug)
        meta = meta_of(data, slug)
        return self.create(
            label=label or f"{meta['label']} (copy)",
            role=meta["role"],
            note=meta["note"],
            base=slug,
        )

    def rename(self, slug: str, label: str, new_slug: Optional[str] = None) -> str:
        """Change a card's label, and optionally its identifier with it."""
        data = self.load(slug)
        meta = meta_of(data, slug)
        meta["label"] = str(label or meta["label"])
        data["_meta"] = meta
        target = _safe_slug(slugify(new_slug)) if new_slug else slug
        if target != slug:
            if self.exists(target):
                raise ProtocolError(f"A card called {target} already exists.")
            self.save(target, data)
            self.delete(slug, backup=True)
            return target
        self.save(slug, data)
        return slug

    def set_meta(self, slug: str, **fields: Any) -> Dict[str, str]:
        data = self.load(slug)
        meta = meta_of(data, slug)
        for key in ("label", "role", "note"):
            if fields.get(key) is not None:
                meta[key] = str(fields[key])
        if meta["role"] not in ROLE_RANK:
            meta["role"] = "other"
        data["_meta"] = meta
        self.save(slug, data)
        return meta

    def delete(self, slug: str, backup: bool = True) -> None:
        path = self.path_for(slug)
        if not os.path.exists(path):
            raise FileNotFoundError(slug)
        if backup:
            self._backup(slug)
        os.unlink(path)

    # -------------------------------------------------------------- internal

    def _free_slug(self, slug: str) -> str:
        if not self.exists(slug):
            return slug
        for index in range(2, 500):
            candidate = f"{slug}-{index}"
            if not self.exists(candidate):
                return candidate
        raise ProtocolError("Could not find a free name for the new card.")

    def _backup(self, slug: str) -> Optional[str]:
        path = self.path_for(slug)
        if not os.path.exists(path):
            return None
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        backup = os.path.join(self.backup_dir, f"{slug}.{stamp}.json")
        shutil.copy2(path, backup)
        return backup

    def _prune_backups(self, slug: str, keep: int = 25) -> None:
        files = sorted(
            (f for f in os.listdir(self.backup_dir) if f.startswith(f"{slug}.")),
            reverse=True,
        )
        for stale in files[keep:]:
            try:
                os.unlink(os.path.join(self.backup_dir, stale))
            except OSError:  # pragma: no cover
                pass


# ------------------------------------------------------------------ helpers


def validate(payload: Any) -> None:
    if not isinstance(payload, dict) or not payload:
        raise ProtocolError("A card must be a non-empty object of pages.")
    pages = [k for k in payload if not str(k).startswith("_")]
    if not pages:
        raise ProtocolError("A card needs at least one page of parameters.")
    for section, rows in payload.items():
        if not isinstance(section, str):
            raise ProtocolError("Page names must be strings.")
        if section.startswith("_"):
            continue
        if not isinstance(rows, list):
            raise ProtocolError(f"Page {section!r} must contain a list of rows.")
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ProtocolError(f"{section}[{index}] must be an object.")
            if "parameter" not in row or "value" not in row:
                raise ProtocolError(
                    f"{section}[{index}] requires 'parameter' and 'value' keys."
                )
            if not isinstance(row["parameter"], str) or not row["parameter"].strip():
                raise ProtocolError(f"{section}[{index}].parameter must be a non-empty string.")
            # Repeated names are normal on a real console card: the indented
            # sub-rows of FOV, voxel size and slice geometry are all "AP (mm)".
            # Lookups take the first match, which is the console's own order.
            row.setdefault("indent", 0)
            if not isinstance(row["indent"], int):
                try:
                    row["indent"] = int(row["indent"])
                except (TypeError, ValueError):
                    row["indent"] = 0
            row["indent"] = max(0, min(4, row["indent"]))
            if not isinstance(row["value"], (str, int, float)):
                row["value"] = str(row["value"])
    meta = payload.get("_meta")
    if meta is not None and not isinstance(meta, dict):
        raise ProtocolError("_meta must be an object.")


def order_sections(payload: Dict[str, Any], slug: str = "") -> Dict[str, Any]:
    """Metadata first, then console pages in order, then anything else."""
    ordered: Dict[str, Any] = OrderedDict()
    ordered["_meta"] = meta_of(payload, slug)
    for section in sections_of(payload):
        ordered[section] = payload[section]
    for section, rows in payload.items():
        if section not in ordered and section != "_meta":
            ordered[section] = rows
    return ordered


def find_value(data: Dict[str, Any], parameter: str, default: str = "") -> str:
    """Case-insensitive lookup of a parameter value across every page."""
    target = parameter.strip().lower()
    for section, rows in data.items():
        if str(section).startswith("_") or not isinstance(rows, list):
            continue
        for row in rows:
            if str(row.get("parameter", "")).strip().lower() == target:
                return str(row.get("value", default))
    return default


def parse_tr_te(data: Dict[str, Any]) -> Dict[str, float]:
    """Return the actual TR/TE in milliseconds from 'Act. TR/TE (ms)'."""
    raw = find_value(data, "Act. TR/TE (ms)")
    numbers = re.findall(r"[-+]?\d*\.?\d+", raw)
    tr = float(numbers[0]) if numbers else 0.0
    te = float(numbers[1]) if len(numbers) > 1 else 0.0
    return {"tr_ms": tr, "te_ms": te}


def parse_duration_seconds(value: str) -> float:
    """Parse a 'MM:SS.s' or 'HH:MM:SS' console duration into seconds."""
    text = str(value).strip()
    if not text:
        return 0.0
    parts = text.split(":")
    try:
        numbers = [float(p) for p in parts]
    except ValueError:
        return 0.0
    seconds = 0.0
    for number in numbers:
        seconds = seconds * 60 + number
    return seconds


def format_duration(seconds: float) -> str:
    """Format seconds back into the console 'MM:SS.s' convention."""
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    if minutes >= 60:
        hours = minutes // 60
        minutes = minutes % 60
        return f"{hours:02d}:{minutes:02d}:{remainder:04.1f}"
    return f"{minutes:02d}:{remainder:04.1f}"


def headline_values(data: Dict[str, Any]) -> Dict[str, str]:
    tr_te = parse_tr_te(data)
    return {
        "duration": find_value(data, "Total scan duration"),
        "tr": f"{tr_te['tr_ms']:g}" if tr_te["tr_ms"] else "",
        "te": f"{tr_te['te_ms']:g}" if tr_te["te_ms"] else "",
        "voxel": find_value(data, "ACQ voxel MPS (mm)"),
        "slices": find_value(data, "slices"),
        "mbFactor": find_value(data, "MB Factor"),
        "senseP": find_value(data, "P reduction (AP)"),
        "flip": find_value(data, "Flip angle (deg)"),
        "dynScans": find_value(data, "dyn scans"),
        "dummyScans": find_value(data, "dummy scans"),
        "matrix": find_value(data, "Reconstruction matrix"),
        "technique": find_value(data, "technique"),
        "scanMode": find_value(data, "Scan mode"),
    }
