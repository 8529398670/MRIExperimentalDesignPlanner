"""One zip with everything the planner can produce.

The client renders the figures (they only exist as SVG in the browser) and
generates the Markdown, methods narrative and PsychoPy configs, then posts the
lot here.  This module adds the XLSX workbook and the acquisition cards as
saved, and packs it all into a single archive with a README that says what
every file is.
"""

from __future__ import annotations

import base64
import io
import json
import posixpath
import re
import zipfile
from datetime import datetime
from typing import Any, Dict, List, Sequence

from .report import build_workbook

SAFE_PART = re.compile(r"[^A-Za-z0-9._ -]+")
MAX_FILES = 400


def safe_name(name: str, fallback: str = "file") -> str:
    """A single path component that cannot escape the archive."""
    clean = SAFE_PART.sub("-", str(name or "")).strip(" .-")
    clean = re.sub(r"-{2,}", "-", clean)
    return clean[:120] or fallback


def safe_path(path: str, fallback: str = "file") -> str:
    """A relative archive path: no absolutes, no traversal, no empty parts."""
    parts = [p for p in re.split(r"[\\/]+", str(path or "")) if p not in ("", ".", "..")]
    if not parts:
        return fallback
    cleaned = [safe_name(p, fallback) for p in parts]
    return posixpath.join(*cleaned)


def _entries(payload: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
    value = payload.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)][:MAX_FILES]


def _decode_data_url(blob: str) -> bytes:
    """Accept either a bare base64 string or a full ``data:...;base64,`` URL."""
    text = str(blob or "")
    if "," in text and text.lstrip().lower().startswith("data:"):
        text = text.split(",", 1)[1]
    padding = "=" * (-len(text) % 4)
    return base64.b64decode(text + padding, validate=False)


def build_bundle(payload: Dict[str, Any], protocols: Dict[str, Any]) -> Dict[str, Any]:
    """Pack the export set.  Returns ``{"blob": bytes, "filename": str,
    "manifest": [...]}``; anything that fails to build is reported in the
    manifest rather than sinking the whole archive."""
    report = payload.get("report") or {}
    design = payload.get("design") or {}
    meta = report.get("meta") or design.get("meta") or {}
    title = str(meta.get("studyTitle") or "MRI-Design")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = safe_name(title, "MRI-Design")[:60]

    manifest: List[Dict[str, Any]] = []
    buffer = io.BytesIO()

    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:

        def write(path: str, data: Any, note: str) -> None:
            if isinstance(data, str):
                data = data.encode("utf-8")
            zf.writestr(path, data)
            manifest.append({"path": path, "bytes": len(data), "note": note})

        # ---------------------------------------------------------- workbook
        try:
            workbook = build_workbook(dict(report), protocols)
            write(f"{stem}.xlsx", workbook, "Full XLSX workbook, one sheet per report section")
        except Exception as exc:  # pragma: no cover - defensive
            write("WORKBOOK-FAILED.txt", f"The XLSX workbook could not be built:\n{exc}\n",
                  "The workbook failed to build")

        # ------------------------------------------------------------- state
        write("design.json", json.dumps(design, indent=2, ensure_ascii=False),
              "The design state: trials, runs, sessions, experiments, budget and caps")
        write("report.json", json.dumps(report, indent=2, ensure_ascii=False),
              "The solved report the whole export is generated from")

        # -------------------------------------------------------------- text
        if payload.get("markdown"):
            write("report.md", str(payload["markdown"]),
                  "Every table in the planner as GitHub-flavoured Markdown")
        if payload.get("methods"):
            write("methods.txt", str(payload["methods"]),
                  "Paste-ready methods narrative for the solved design")

        for item in _entries(payload, "markdownTables"):
            name = safe_name(item.get("name"), "table")
            write(posixpath.join("markdown", f"{name}.md"), str(item.get("text", "")),
                  "One table as Markdown")

        # ---------------------------------------------------------- psychopy
        for item in _entries(payload, "psychopy"):
            name = safe_path(item.get("name") or "experiment.yaml", "experiment.yaml")
            write(posixpath.join("psychopy", name), str(item.get("text", "")),
                  "PsychoPy task config for one experiment")

        # ----------------------------------------------------------- figures
        for item in _entries(payload, "figures"):
            name = safe_name(item.get("name"), "figure")
            if item.get("svg"):
                write(posixpath.join("figures", f"{name}.svg"), str(item["svg"]),
                      "Vector figure, opens in Illustrator, Inkscape or a browser")
            if item.get("png"):
                try:
                    write(posixpath.join("figures", f"{name}.png"),
                          _decode_data_url(item["png"]), "Raster figure at 2x for slides")
                except (ValueError, TypeError):
                    pass

        # ------------------------------------------------- acquisition cards
        for slug, data in (protocols or {}).items():
            if not isinstance(data, dict) or "_error" in data:
                continue
            write(posixpath.join("scanner-parameters", f"{safe_name(slug, 'card')}.json"),
                  json.dumps(data, indent=4, ensure_ascii=False),
                  "Acquisition parameter card exactly as saved")

        # ------------------------------------------------------------ readme
        write("README.txt", _readme(title, meta, stamp, manifest),
              "This listing")

    return {
        "blob": buffer.getvalue(),
        "filename": f"{stem}-{stamp}.zip",
        "manifest": manifest,
    }


def _readme(title: str, meta: Dict[str, Any], stamp: str, manifest: Sequence[Dict[str, Any]]) -> str:
    lines = [
        "MRI Experimental Design Planner - full export",
        "=" * 46,
        "",
        f"Study        : {title}",
        f"Investigator : {meta.get('investigator') or '-'}",
        f"Institution  : {meta.get('institution') or '-'}",
        f"Design ID    : {meta.get('designId') or '-'}",
        f"Generated    : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ({stamp})",
        "",
        "Contents",
        "-" * 46,
    ]
    width = max((len(entry["path"]) for entry in manifest), default=10)
    for entry in manifest:
        size = entry["bytes"]
        human = f"{size / 1024:.1f} kB" if size >= 1024 else f"{size} B"
        lines.append(f"  {entry['path']:<{width}}  {human:>9}  {entry['note']}")
    lines += [
        "",
        "Reloading this design",
        "-" * 46,
        "  design.json goes back into the planner through",
        "  Report and export -> Saved designs -> Import JSON file.",
        "",
    ]
    return "\n".join(lines)
