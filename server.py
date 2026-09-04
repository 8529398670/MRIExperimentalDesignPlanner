"""MRI Experimental Design Planner - production HTTP server.

Serves the planner UI and a small JSON API over the acquisition parameter
cards, saved designs, the XLSX report generator and the full-export zip.
Run with::

    ./run.sh                      # waitress, 0.0.0.0:8760
    python server.py --port 9000  # explicit port
    python server.py --debug      # Flask reloader, development only
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from typing import Any, Dict

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

from planner.bundle import build_bundle
from planner.protocols import (
    ROLE_LABELS,
    ROLES,
    ProtocolError,
    ProtocolStore,
    find_value,
    headline_values,
    meta_of,
    parse_duration_seconds,
    parse_tr_te,
    sections_of,
)
from planner.report import build_workbook

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
PROTOCOL_DIR = os.environ.get(
    "PLANNER_PROTOCOL_DIR", os.path.join(BASE_DIR, "scanner-parameters")
)
PRESET_DIR = os.environ.get("PLANNER_PRESET_DIR", os.path.join(BASE_DIR, "presets"))
EXPORT_DIR = os.environ.get("PLANNER_EXPORT_DIR", os.path.join(BASE_DIR, "exports"))
MAX_PAYLOAD_BYTES = 96 * 1024 * 1024  # the export bundle carries rendered figures

os.makedirs(PRESET_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_PAYLOAD_BYTES
app.json.sort_keys = False  # card pages must keep console order

store = ProtocolStore(PROTOCOL_DIR)

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

STATIC_DIR = os.path.join(BASE_DIR, "static")
COMPRESSIBLE_TYPES = {
    "application/javascript",
    "application/json",
    "application/xml",
    "image/svg+xml",
    "text/javascript",
}
GZIP_FLOOR_BYTES = 1024


def asset_url(path: str) -> str:
    """Static URL stamped with the file's own mtime and size.

    A rebuilt image or an edited file changes the stamp, so the browser asks
    for a URL it has never seen and cannot answer from its cache.  Nothing the
    user has to know about: no hard refresh, no cleared cache.
    """
    try:
        stat = os.stat(os.path.join(STATIC_DIR, path))
        stamp = f"{int(stat.st_mtime)}-{stat.st_size}"
    except OSError:
        stamp = "0"
    return f"/static/{path}?v={stamp}"


app.jinja_env.globals["asset"] = asset_url


def _page(name: str) -> Response:
    return Response(render_template(name), mimetype="text/html; charset=utf-8")


def _preset_path(name: str) -> str:
    clean = SAFE_NAME.sub("-", (name or "").strip())[:80] or "untitled"
    return os.path.join(PRESET_DIR, f"{clean}.json")


def _write_json(path: str, payload: Any) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _body() -> Dict[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ProtocolError("Request body must be a JSON object.")
    return data


def _acquisition_summary(protocols: Dict[str, Any]) -> Dict[str, Any]:
    summary = {}
    for slug, data in protocols.items():
        if not isinstance(data, dict) or "_error" in data:
            continue
        tr_te = parse_tr_te(data)
        summary[slug] = {
            "trMs": tr_te["tr_ms"],
            "teMs": tr_te["te_ms"],
            "durationSeconds": parse_duration_seconds(find_value(data, "Total scan duration")),
        }
    return summary


# ------------------------------------------------------------------- pages


@app.route("/")
def index() -> Response:
    return _page("index.html")


@app.route("/favicon.ico")
def favicon() -> Response:
    return send_from_directory(app.static_folder, "wsu-mark.svg", mimetype="image/svg+xml")


# --------------------------------------------------------------------- api


@app.get("/api/health")
def health() -> Response:
    return jsonify(
        {
            "status": "ok",
            "protocolDir": PROTOCOL_DIR,
            "protocols": len(store.slugs()),
            "time": datetime.now().isoformat(timespec="seconds"),
        }
    )


@app.get("/api/bootstrap")
def bootstrap() -> Response:
    """Everything the client needs on first paint, in one round trip."""
    protocols = store.load_all()
    current = None
    current_path = _preset_path("current")
    if os.path.exists(current_path):
        try:
            with open(current_path, "r", encoding="utf-8") as handle:
                current = json.load(handle)
        except (OSError, json.JSONDecodeError):
            current = None
    return jsonify(
        {
            "manifest": store.manifest(),
            "protocols": protocols,
            "acquisition": _acquisition_summary(protocols),
            "roles": ROLES,
            "roleLabels": ROLE_LABELS,
            "design": current,
            "presets": _preset_list(),
            "generated": datetime.now().isoformat(timespec="seconds"),
        }
    )


# -------------------------------------------------------- acquisition cards


@app.get("/api/protocols")
def list_protocols() -> Response:
    return jsonify({"manifest": store.manifest()})


def _card_response(slug: str, extra: Dict[str, Any] | None = None) -> Response:
    data = store.load(slug)
    body = {
        "slug": slug,
        "data": data,
        "meta": meta_of(data, slug),
        "sections": sections_of(data),
        "headline": headline_values(data),
        "manifest": store.manifest(),
        "acquisition": _acquisition_summary({slug: data}),
    }
    if extra:
        body.update(extra)
    return jsonify(body)


@app.get("/api/protocols/<slug>")
def get_protocol(slug: str) -> Response:
    try:
        return _card_response(slug)
    except (FileNotFoundError, ProtocolError):
        return jsonify({"error": f"Unknown card {slug}"}), 404


@app.put("/api/protocols/<slug>")
def put_protocol(slug: str) -> Response:
    payload = _body()
    data = payload.get("data", payload)
    result = store.save(slug, data)
    return _card_response(
        slug, {"backup": result["backup"], "savedAt": datetime.now().isoformat(timespec="seconds")}
    )


@app.post("/api/protocols")
def create_protocol() -> Response:
    """New card, blank or copied from ``base``."""
    payload = _body()
    label = str(payload.get("label") or "New card").strip()
    base = payload.get("base") or None
    if base and not store.exists(base):
        return jsonify({"error": f"Unknown base card {base}"}), 404
    slug = store.create(
        label=label,
        role=str(payload.get("role") or "functional"),
        note=str(payload.get("note") or ""),
        base=base,
        slug=payload.get("slug"),
    )
    return _card_response(slug, {"created": slug})


@app.post("/api/protocols/<slug>/duplicate")
def duplicate_protocol(slug: str) -> Response:
    payload = request.get_json(silent=True) or {}
    if not store.exists(slug):
        return jsonify({"error": f"Unknown card {slug}"}), 404
    created = store.duplicate(slug, payload.get("label"))
    return _card_response(created, {"created": created, "from": slug})


@app.post("/api/protocols/<slug>/rename")
def rename_protocol(slug: str) -> Response:
    payload = _body()
    if not store.exists(slug):
        return jsonify({"error": f"Unknown card {slug}"}), 404
    label = str(payload.get("label") or "").strip()
    if not label:
        return jsonify({"error": "A card needs a name."}), 400
    new_slug = payload.get("slug")
    if new_slug is True:  # "rename the file too", identifier follows the label
        new_slug = label
    target = store.rename(slug, label, new_slug or None)
    return _card_response(target, {"renamed": {"from": slug, "to": target}})


@app.post("/api/protocols/<slug>/meta")
def protocol_meta(slug: str) -> Response:
    payload = _body()
    if not store.exists(slug):
        return jsonify({"error": f"Unknown card {slug}"}), 404
    store.set_meta(
        slug, label=payload.get("label"), role=payload.get("role"), note=payload.get("note")
    )
    return _card_response(slug)


@app.delete("/api/protocols/<slug>")
def delete_protocol(slug: str) -> Response:
    if not store.exists(slug):
        return jsonify({"error": f"Unknown card {slug}"}), 404
    if len(store.slugs()) <= 1:
        return jsonify({"error": "The last card cannot be deleted."}), 400
    store.delete(slug)
    protocols = store.load_all()
    return jsonify(
        {
            "deleted": slug,
            "manifest": store.manifest(),
            "protocols": protocols,
            "acquisition": _acquisition_summary(protocols),
        }
    )


@app.get("/api/protocols/<slug>/backups")
def list_backups(slug: str) -> Response:
    prefix = f"{slug}."
    entries = []
    for name in sorted(os.listdir(store.backup_dir), reverse=True):
        if name.startswith(prefix):
            path = os.path.join(store.backup_dir, name)
            entries.append(
                {
                    "file": name,
                    "size": os.path.getsize(path),
                    "modified": os.path.getmtime(path),
                }
            )
    return jsonify({"slug": slug, "backups": entries})


@app.post("/api/protocols/<slug>/restore")
def restore_backup(slug: str) -> Response:
    payload = _body()
    name = SAFE_NAME.sub("-", str(payload.get("file", "")))
    source = os.path.join(store.backup_dir, name)
    if not name.startswith(f"{slug}.") or not os.path.exists(source):
        return jsonify({"error": "Backup not found."}), 404
    with open(source, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    store.save(slug, data)
    return _card_response(slug, {"restored": name})


@app.post("/api/apply-derived")
def apply_derived() -> Response:
    """Write solver-derived acquisition values back into a card.

    Accepts ``{"slug": ..., "updates": {"dyn scans": 1900, ...}}`` and rewrites
    only those parameters, leaving every other row untouched.
    """
    payload = _body()
    slug = payload.get("slug", "")
    updates = payload.get("updates", {})
    if not isinstance(updates, dict) or not updates:
        return jsonify({"error": "updates must be a non-empty object."}), 400
    try:
        data = store.load(slug)
    except (FileNotFoundError, ProtocolError):
        return jsonify({"error": f"Unknown card {slug}"}), 404

    lowered = {str(k).strip().lower(): v for k, v in updates.items()}
    applied = {}
    for section, rows in data.items():
        if str(section).startswith("_") or not isinstance(rows, list):
            continue
        for row in rows:
            key = str(row.get("parameter", "")).strip().lower()
            if key in lowered:
                row["value"] = str(lowered[key])
                applied[row["parameter"]] = row["value"]
    store.save(slug, data)
    return _card_response(slug, {"applied": applied})


# ------------------------------------------------------------------ design


def _preset_list():
    entries = []
    for name in sorted(os.listdir(PRESET_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(PRESET_DIR, name)
        label = os.path.splitext(name)[0]
        title = label
        try:
            with open(path, "r", encoding="utf-8") as handle:
                blob = json.load(handle)
            title = (blob.get("meta") or {}).get("studyTitle") or label
        except (OSError, json.JSONDecodeError):
            pass
        entries.append(
            {
                "name": label,
                "title": title,
                "modified": os.path.getmtime(path),
            }
        )
    return entries


@app.get("/api/design")
def get_design() -> Response:
    name = request.args.get("name", "current")
    path = _preset_path(name)
    if not os.path.exists(path):
        return jsonify({"error": f"No saved design named {name}."}), 404
    with open(path, "r", encoding="utf-8") as handle:
        return jsonify({"name": name, "design": json.load(handle)})


@app.post("/api/design")
def post_design() -> Response:
    payload = _body()
    name = payload.get("name", "current")
    design = payload.get("design")
    if not isinstance(design, dict):
        return jsonify({"error": "design must be an object."}), 400
    _write_json(_preset_path(name), design)
    return jsonify(
        {
            "name": name,
            "savedAt": datetime.now().isoformat(timespec="seconds"),
            "presets": _preset_list(),
        }
    )


@app.delete("/api/design/<name>")
def delete_design(name: str) -> Response:
    path = _preset_path(name)
    if name == "current":
        return jsonify({"error": "The working design cannot be deleted."}), 400
    if os.path.exists(path):
        os.unlink(path)
    return jsonify({"deleted": name, "presets": _preset_list()})


# ------------------------------------------------------------------ export


@app.post("/api/export/xlsx")
def export_xlsx() -> Response:
    payload = _body()
    report = payload.get("report", payload)
    protocols = payload.get("protocols")
    if not isinstance(protocols, dict) or not protocols:
        protocols = store.load_all()
    report.setdefault("generated", datetime.now().strftime("%Y-%m-%d %H:%M"))
    blob = build_workbook(report, protocols)

    title = (report.get("meta") or {}).get("studyTitle") or "MRI-Design"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{SAFE_NAME.sub('-', title)[:60]}-{stamp}.xlsx"
    archive = os.path.join(EXPORT_DIR, filename)
    with open(archive, "wb") as handle:
        handle.write(blob)

    return Response(
        blob,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Planner-Archive": filename,
        },
    )


@app.post("/api/export/bundle")
def export_bundle() -> Response:
    """Everything at once: workbook, JSON, Markdown, methods, PsychoPy
    configs, every rendered figure and every acquisition card, in one zip."""
    payload = _body()
    protocols = payload.get("protocols")
    if not isinstance(protocols, dict) or not protocols:
        protocols = store.load_all()
    report = payload.get("report") or {}
    if isinstance(report, dict):
        report.setdefault("generated", datetime.now().strftime("%Y-%m-%d %H:%M"))

    result = build_bundle(payload, protocols)
    archive = os.path.join(EXPORT_DIR, result["filename"])
    with open(archive, "wb") as handle:
        handle.write(result["blob"])

    return Response(
        result["blob"],
        mimetype="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{result["filename"]}"',
            "X-Planner-Archive": result["filename"],
            "X-Planner-Files": str(len(result["manifest"])),
        },
    )


@app.post("/api/export/json")
def export_json() -> Response:
    payload = _body()
    blob = json.dumps(payload, indent=2).encode("utf-8")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Response(
        blob,
        mimetype="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="mri-design-{stamp}.json"'
        },
    )


@app.errorhandler(ProtocolError)
def handle_protocol_error(exc: ProtocolError) -> Response:
    return jsonify({"error": str(exc)}), 400


@app.errorhandler(404)
def handle_404(_exc) -> Response:
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found", "path": request.path}), 404
    return _page("index.html")


@app.after_request
def freshness(response: Response) -> Response:
    """Never serve yesterday's application code.

    API answers and the page shell are never stored; static assets carry an
    ETag and must be revalidated on every request, so a refresh always picks
    up a rebuilt file while an unchanged one still costs only a 304.
    """
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    else:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.after_request
def compress(response: Response) -> Response:
    """gzip the text payloads: the UI bundle is most of what crosses the wire."""
    if "gzip" not in request.headers.get("Accept-Encoding", "").lower():
        return response
    if not 200 <= response.status_code < 300 or response.status_code == 204:
        return response
    if "Content-Encoding" in response.headers:
        return response

    content_type = (response.content_type or "").split(";")[0].strip().lower()
    if not (content_type.startswith("text/") or content_type in COMPRESSIBLE_TYPES):
        return response

    response.vary.add("Accept-Encoding")
    if response.direct_passthrough:
        response.direct_passthrough = False
    body = response.get_data()
    if len(body) < GZIP_FLOOR_BYTES:
        return response

    packed = gzip.compress(body, 6)
    if len(packed) >= len(body):
        return response
    response.set_data(packed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(packed))
    return response


# -------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="MRI Experimental Design Planner")
    parser.add_argument("--host", default=os.environ.get("PLANNER_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PLANNER_PORT", "8760"))
    )
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--debug", action="store_true", help="Flask reloader (development)")
    args = parser.parse_args()

    banner = (
        f"\n  MRI Experimental Design Planner\n"
        f"  Wright State University\n"
        f"  ---------------------------------------------\n"
        f"  acquisition cards : {PROTOCOL_DIR} ({len(store.slugs())} files)\n"
        f"  presets           : {PRESET_DIR}\n"
        f"  exports           : {EXPORT_DIR}\n"
        f"  listening on      : http://{args.host}:{args.port}\n"
    )
    print(banner, flush=True)

    if args.debug:
        app.run(host=args.host, port=args.port, debug=True)
        return 0

    try:
        from waitress import serve
    except ImportError:
        print(
            "  waitress not installed; falling back to the Flask server.\n"
            "  Install production dependencies with: pip install -r requirements.txt\n",
            file=sys.stderr,
            flush=True,
        )
        app.run(host=args.host, port=args.port, threaded=True)
        return 0

    serve(app, host=args.host, port=args.port, threads=args.threads, ident="MRI-Planner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
