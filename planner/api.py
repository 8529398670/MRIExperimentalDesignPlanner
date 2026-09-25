"""Version 1 of the planner's HTTP API: build and solve a design without a browser.

Everything a button in the interface does is an *action* - a JSON object such
as ``{"action": "run.update", "run": "Main run", "trialsPerBlock": 12}`` - and
``POST /api/v1/designs/<name>/actions`` runs a list of them in order against a
saved design, solves it, saves it and answers with the numbers that matter.

The actions themselves are ``static/js/api.js``, the same code the buttons
call, run here inside QuickJS (see ``planner/engine.py``).  The few that touch
files - acquisition cards, saved designs - are carried out below, after the
action layer has validated them against the design.

``GET /api/v1`` lists every action with its arguments; ``GET /api/v1/docs`` is
the same as Markdown, with a quick start.
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from flask import Blueprint, Response, jsonify, request

from planner.bundle import build_bundle
from planner.designs import DesignStore, clean_name, page_path
from planner.engine import ActionRefused, Engine, EngineUnavailable
from planner.protocols import ProtocolError, ProtocolStore, apply_values
from planner.report import build_workbook

MAX_ACTIONS = 500
REFERENCE_START = "<!-- action-reference:start -->"
REFERENCE_END = "<!-- action-reference:end -->"

ENDPOINTS = [
    ("GET", "/api/v1", "This index: endpoints, conventions and every action with its arguments"),
    ("GET", "/api/v1/docs", "The same as Markdown, with a quick start"),
    ("GET", "/api/v1/designs",
     "Saved designs, each with the `url` that opens it in the interface; `current` is the "
     "working design, at /"),
    ("POST", "/api/v1/designs", "Create a design: {name, from: default|blank|<design>, design?, overwrite?}"),
    ("GET", "/api/v1/designs/<name>", "The stored design, its revision, its `url` and a solved summary"),
    ("DELETE", "/api/v1/designs/<name>", "Delete a saved design (not `current`)"),
    ("POST", "/api/v1/designs/<name>/actions", "Run actions in order: {actions: [...], dryRun?, include?}"),
    ("GET", "/api/v1/designs/<name>/report", "Solve and report: ?view=summary|full|warnings"),
    ("GET", "/api/v1/designs/<name>/export/<format>",
     "markdown | methods | psychopy | json | figures | xlsx | bundle"),
]


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.extra = extra


def render_reference(catalogue: List[Dict[str, Any]]) -> str:
    """The action reference as Markdown, straight from the live catalogue:
    one heading per action and one line per argument."""
    lines: List[str] = []
    group = None
    for entry in catalogue:
        if entry["group"] != group:
            group = entry["group"]
            lines += ["", f"### {group}", ""]
        flags = []
        if not entry["changesDesign"]:
            flags.append("read-only")
        if entry["server"]:
            flags.append("server")
        tail = f" _({', '.join(flags)})_" if flags else ""
        lines.append(f"#### `{entry['name']}`{tail}")
        back = " Takes its item back as `design.get` returns it." if entry.get("roundTrip") else ""
        lines.append(f"{entry['summary']}.{back} Button: _{entry['ui']}_")
        if entry["args"]:
            lines.append("")
        for key, arg in entry["args"].items():
            name = f"**`{key}`**" if arg.get("required") else f"`{key}`"
            lines.append(f"- {name} {_arg_type(arg)}: {arg['doc']}")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _arg_type(arg: Dict[str, Any]) -> str:
    kind = arg["type"]
    if kind.startswith("ref:"):
        target = kind[4:]
        text = f"{target} slug or name" if target == "card" else f"{target} id or name"
    elif kind == "enum":
        text = " | ".join(f"`{value}`" for value in arg["values"])
    elif kind == "integer|string":
        text = "position or name"
    else:
        text = kind
    if arg.get("min") is not None and arg.get("max") is not None:
        text += f", {_literal(arg['min'])} to {_literal(arg['max'])}"
    elif arg.get("min") is not None:
        text += f", at least {_literal(arg['min'])}"
    elif arg.get("max") is not None:
        text += f", at most {_literal(arg['max'])}"
    if arg.get("nullable"):
        text += ", or null"
    if "default" in arg:
        text += f", default `{_literal(arg['default'])}`"
    if arg.get("aliases"):
        text += ", also " + " or ".join(f"`{alias}`" for alias in arg["aliases"])
    return f"({text})"


def _literal(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def render_docs(template: str, catalogue: List[Dict[str, Any]]) -> str:
    """API.md with its action reference regenerated from the catalogue."""
    reference = render_reference(catalogue)
    pattern = re.compile(
        re.escape(REFERENCE_START) + r".*?" + re.escape(REFERENCE_END), re.DOTALL
    )
    block = f"{REFERENCE_START}\n\n{reference}\n{REFERENCE_END}"
    if pattern.search(template):
        return pattern.sub(lambda _match: block, template)
    return template.rstrip() + "\n\n## Action reference\n\n" + block + "\n"


def create_blueprint(
    *,
    store: ProtocolStore,
    designs: DesignStore,
    engine: Engine,
    boot: Callable[[], Dict[str, Any]],
    export_dir: str,
    docs_path: str,
) -> Blueprint:
    bp = Blueprint("api_v1", __name__, url_prefix="/api/v1")

    # ------------------------------------------------------------- helpers

    def load(name: str) -> tuple:
        """``(design, rev)``; the working design starts from the defaults."""
        try:
            return designs.read(name)
        except FileNotFoundError:
            if clean_name(name) == "current":
                return None, None
            raise ApiError(
                404, f"No design named {clean_name(name)}.",
                hint="POST /api/v1/designs {\"name\": ...} creates one; "
                     "GET /api/v1/designs lists them.",
            )

    def body() -> Any:
        data = request.get_json(silent=True)
        if data is None:
            raise ApiError(400, "Send a JSON body with Content-Type: application/json.")
        return data

    def refresh(ctx) -> None:
        ctx.set_boot(boot())

    def link(name: str) -> str:
        """The address that opens a design in the interface, on the host and
        port this request came in on: something to hand a person."""
        return request.host_url.rstrip("/") + page_path(name)

    # ---------------------------------------------- server-hosted actions

    def save_as(ctx, args):
        target = clean_name(args["name"])
        done = ctx.finish()
        return {"saved": target, "rev": designs.write(target, done["state"]), "url": link(target)}

    def load_preset(ctx, args):
        try:
            design, _rev = designs.read(args["name"])
        except FileNotFoundError:
            raise ActionRefused(f"No saved design named {clean_name(args['name'])}.")
        ctx.replace(design)
        return {"loaded": clean_name(args["name"])}

    def card_create(ctx, args):
        slug = store.create(
            label=args["label"], role=args.get("role", "functional"),
            note=args.get("note", ""), base=args.get("base"), slug=args.get("slug"),
        )
        refresh(ctx)
        return {"card": slug}

    def card_duplicate(ctx, args):
        slug = store.duplicate(args["card"], args.get("label"))
        refresh(ctx)
        return {"card": slug, "from": args["card"]}

    def card_rename(ctx, args):
        old = args["card"]
        new = store.rename(old, args["label"], args["label"] if args.get("renameFile") else None)
        refresh(ctx)
        repointed = ctx.repoint_card(old, new) if new != old else 0
        return {"from": old, "to": new, "label": args["label"], "repointed": repointed}

    def card_set_meta(ctx, args):
        fields = {key: args[key] for key in ("label", "role", "note") if key in args}
        if not fields:
            raise ActionRefused("card.setMeta needs at least one of: label, role, note.")
        meta = store.set_meta(args["card"], **fields)
        refresh(ctx)
        return {"card": args["card"], "meta": meta}

    def card_set_parameters(ctx, args):
        values = args["values"]
        if not values:
            raise ActionRefused("card.setParameters needs at least one parameter in values.")
        for key, value in values.items():
            if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                raise ActionRefused(f"The value for {key!r} must be a string or a number.")
        data = store.load(args["card"])
        applied, missing = apply_values(data, values, first_only=True)
        if missing:
            raise ActionRefused(
                f"{args['card']} has no parameter named: {', '.join(missing)}. "
                "card.get lists every parameter; card.replace can add new ones."
            )
        store.save(args["card"], data)
        refresh(ctx)
        return {"card": args["card"], "applied": applied}

    def card_replace(ctx, args):
        result = store.save(args["card"], args["data"])
        refresh(ctx)
        return {"card": args["card"], "backup": result["backup"]}

    def card_delete(ctx, args):
        if len(store.slugs()) <= 1:
            raise ActionRefused("The last card cannot be deleted.")
        store.delete(args["card"])
        refresh(ctx)
        return {"deleted": args["card"]}

    def card_apply_solved(ctx, args):
        data = store.load(args["card"])
        applied, _missing = apply_values(data, args["updates"])
        store.save(args["card"], data)
        refresh(ctx)
        return {"card": args["card"], "run": args["run"], "applied": applied}

    def card_backups(ctx, args):
        return {"card": args["card"], "backups": store.backups(args["card"])}

    def card_restore(ctx, args):
        try:
            name = store.restore(args["card"], args["file"])
        except FileNotFoundError:
            raise ActionRefused(f"No backup {args['file']!r} for {args['card']}; card.backups lists them.")
        refresh(ctx)
        return {"card": args["card"], "restored": name}

    SERVER_ACTIONS = {
        "design.saveAs": save_as,
        "design.loadPreset": load_preset,
        "card.create": card_create,
        "card.duplicate": card_duplicate,
        "card.rename": card_rename,
        "card.setMeta": card_set_meta,
        "card.setParameters": card_set_parameters,
        "card.replace": card_replace,
        "card.delete": card_delete,
        "card.applySolvedTiming": card_apply_solved,
        "card.backups": card_backups,
        "card.restore": card_restore,
    }

    def wants_figures(actions: List[Any]) -> bool:
        return any(isinstance(a, dict) and a.get("action") == "export.figures" for a in actions)

    def run_actions(name: str, actions: List[Any], dry_run: bool, include: List[str]):
        with designs.lock(name):
            state, rev = load(name)
            ctx = engine.open(state, boot(), figures=wants_figures(actions))
            results: List[Dict[str, Any]] = []
            error: Optional[Dict[str, Any]] = None
            changed = False
            for index, raw in enumerate(actions):
                label = raw.get("action") if isinstance(raw, dict) else None
                try:
                    prepared = ctx.prepare(raw)
                    label = prepared["action"]
                    if prepared["host"] == "js":
                        value = ctx.run(prepared)
                    else:
                        if dry_run and not prepared["query"]:
                            raise ActionRefused(
                                f"{label} changes files on the server, so it cannot run in a dry run."
                            )
                        value = SERVER_ACTIONS[label](ctx, prepared["args"])
                except (ActionRefused, ProtocolError, FileNotFoundError) as exc:
                    message = str(exc) if not isinstance(exc, FileNotFoundError) \
                        else f"Not found: {exc}"
                    error = {"index": index, "action": label, "message": message}
                    break
                changed = changed or not prepared["query"]
                results.append({"action": label, "result": value})

            done = ctx.finish()
            saved = False
            if changed and not dry_run:
                rev = designs.write(name, done["state"])
                saved = True
            answer: Dict[str, Any] = {
                "ok": error is None,
                "name": clean_name(name),
                "rev": rev,
                "saved": saved,
                "dryRun": dry_run,
                "applied": len(results),
                "results": results,
            }
            if error:
                answer["error"] = error
                answer["hint"] = (
                    "Actions before the failed one were applied"
                    + (" and saved" if saved else "")
                    + "; the rest were not run. Fix it and send the remaining actions again."
                )
            answer["summary"] = done["summary"]
            answer["warnings"] = done["summary"]["warnings"]
            if "design" in include:
                answer["design"] = done["state"]
            if "report" in include:
                report = dict(done["report"])
                report.pop("state", None)
                answer["report"] = report
            return answer, (200 if error is None else 422)

    # -------------------------------------------------------------- routes

    @bp.errorhandler(ApiError)
    def api_error(exc: ApiError):
        return jsonify({"ok": False, "error": str(exc), **exc.extra}), exc.status

    @bp.errorhandler(EngineUnavailable)
    def engine_missing(exc: EngineUnavailable):
        return jsonify({"ok": False, "error": str(exc)}), 503

    @bp.errorhandler(ActionRefused)
    def refused(exc: ActionRefused):
        return jsonify({"ok": False, "error": str(exc)}), 422

    @bp.get("")
    @bp.get("/")
    def index() -> Response:
        return jsonify(
            {
                "api": "MRI Experimental Design Planner",
                "version": 1,
                "engine": engine.available,
                "docs": "/api/v1/docs",
                "quickStart": [
                    "GET /api/v1/designs/current - the working design (the page at /), with ids",
                    "POST /api/v1/designs/current/actions {\"actions\": [{\"action\": "
                    "\"budget.update\", \"totalScannerHours\": 80}]} - change it; the "
                    "answer carries the solved summary",
                    "Refer to trials, runs, sessions, experiments and cards by id or by name",
                ],
                "conventions": {
                    "action": "{\"action\": \"<name>\", ...arguments} - arguments inline, "
                              "or under \"args\"",
                    "order": "Actions run in order. The first refusal stops the batch; the "
                             "ones before it are kept.",
                    "positions": "Phases, blocks and plan rows are addressed by 0-based "
                                 "position (or by name / id where noted).",
                    "names": "Names are unique within a level; add and rename refuse a "
                             "name already taken.",
                    "solver": "Every batch ends with a solve. Repairs the solver makes "
                              "against the caps are saved, and reported in warnings.",
                    "liveUi": "Every design opens in the interface at its own url: / for "
                              "`current`, /designs/<name> for the rest. A page open on a "
                              "design shows changes made here within a few seconds.",
                },
                "endpoints": [
                    {"method": method, "path": path, "summary": summary}
                    for method, path, summary in ENDPOINTS
                ],
                "actions": engine.catalogue() if engine.available else [],
            }
        )

    @bp.get("/docs")
    def docs() -> Response:
        try:
            with open(docs_path, "r", encoding="utf-8") as handle:
                template = handle.read()
        except OSError:
            template = "# MRI Experimental Design Planner API\n"
        text = render_docs(template, engine.catalogue()) if engine.available else template
        return Response(text, mimetype="text/markdown")

    @bp.get("/designs")
    def list_designs() -> Response:
        entries = designs.list()
        for entry in entries:
            entry["rev"] = designs.rev(entry["name"])
            entry["url"] = link(entry["name"])
        return jsonify({"designs": entries})

    @bp.post("/designs")
    def create_design() -> Response:
        payload = body()
        if not isinstance(payload, dict) or not payload.get("name"):
            raise ApiError(400, "Name the new design: {\"name\": \"my-study\"}.")
        name = clean_name(payload["name"])
        source = payload.get("from", "default")
        if designs.exists(name) and not payload.get("overwrite"):
            raise ApiError(409, f"A design named {name} already exists.",
                           hint="Send \"overwrite\": true to replace it.")
        ctx = engine.open(None, boot())
        if isinstance(payload.get("design"), dict):
            ctx.execute({"action": "design.replace", "design": payload["design"]})
        elif source in ("default", "blank"):
            ctx.execute({"action": "design.reset", "blank": source == "blank"})
        else:
            original, _rev = load(str(source))
            ctx.replace(original)
        done = ctx.finish()
        with designs.lock(name):
            rev = designs.write(name, done["state"])
        return jsonify(
            {"ok": True, "name": name, "rev": rev, "url": link(name), "summary": done["summary"]}
        ), 201

    @bp.get("/designs/<name>")
    def get_design(name: str) -> Response:
        state, rev = load(name)
        ctx = engine.open(state, boot())
        return jsonify(
            {"name": clean_name(name), "rev": rev, "url": link(name), "design": ctx.state(),
             "summary": ctx.call("summary")}
        )

    @bp.delete("/designs/<name>")
    def delete_design(name: str) -> Response:
        if clean_name(name) == "current":
            raise ApiError(400, "The working design cannot be deleted; design.reset empties it.")
        if not designs.delete(name):
            raise ApiError(404, f"No design named {clean_name(name)}.")
        return jsonify({"ok": True, "deleted": clean_name(name)})

    @bp.post("/designs/<name>/actions")
    def post_actions(name: str) -> Response:
        payload = body()
        dry_run = False
        include: List[str] = []
        if isinstance(payload, list):
            actions = payload
        elif isinstance(payload, dict) and "actions" in payload:
            actions = payload["actions"]
            dry_run = bool(payload.get("dryRun"))
            include = payload.get("include") or []
            if isinstance(include, str):
                include = [include]
        elif isinstance(payload, dict) and "action" in payload:
            actions = [payload]
        else:
            raise ApiError(400, "Send {\"actions\": [{\"action\": ...}, ...]}, a list of "
                                "actions, or one action object.")
        if not isinstance(actions, list) or not actions:
            raise ApiError(400, "\"actions\" must be a non-empty list.")
        if len(actions) > MAX_ACTIONS:
            raise ApiError(400, f"At most {MAX_ACTIONS} actions per call.")
        answer, status = run_actions(name, actions, dry_run, include)
        return jsonify(answer), status

    @bp.get("/designs/<name>/report")
    def get_report(name: str) -> Response:
        view = request.args.get("view", "summary")
        state, rev = load(name)
        ctx = engine.open(state, boot())
        value = ctx.execute({"action": "report", "view": view})
        return jsonify({"name": clean_name(name), "rev": rev, "view": view, "report": value})

    @bp.get("/designs/<name>/export/<fmt>")
    def export(name: str, fmt: str) -> Response:
        state, _rev = load(name)
        stem = clean_name(name)
        if fmt in ("markdown", "methods", "psychopy", "figures"):
            ctx = engine.open(state, boot(), figures=fmt == "figures")
            call: Dict[str, Any] = {"action": f"export.{fmt}"}
            if fmt == "psychopy" and request.args.get("run"):
                call["run"] = request.args["run"]
            if fmt == "figures" and request.args.get("name"):
                call["name"] = request.args["name"]
            value = ctx.execute(call)
            if fmt == "markdown":
                return Response(value["markdown"], mimetype="text/markdown")
            if fmt == "methods":
                return Response(value["methods"], mimetype="text/plain")
            if fmt == "psychopy" and request.args.get("run"):
                if not value:
                    raise ApiError(404, "That run design has no PsychoPy config (is its card missing?).")
                return Response(
                    value[0]["yaml"], mimetype="text/yaml",
                    headers={"Content-Disposition": f'attachment; filename="{value[0]["file"]}"'},
                )
            return jsonify({"name": stem, fmt: value})
        if fmt == "json":
            ctx = engine.open(state, boot())
            done = ctx.finish()
            report = dict(done["report"])
            report.pop("state", None)
            return jsonify({"design": done["state"], "report": report})
        if fmt in ("xlsx", "bundle"):
            ctx = engine.open(state, boot(), figures=fmt == "bundle")
            payload = ctx.exports(figures=fmt == "bundle")
            protocols = store.load_all()
            payload["report"].setdefault("generated", datetime.now().strftime("%Y-%m-%d %H:%M"))
            if fmt == "xlsx":
                blob = build_workbook(payload["report"], protocols)
                title = (payload["report"].get("meta") or {}).get("studyTitle") or "MRI-Design"
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                filename = f"{clean_name(title)[:60]}-{stamp}.xlsx"
                mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                headers = {}
            else:
                result = build_bundle(payload, protocols)
                blob, filename = result["blob"], result["filename"]
                mimetype = "application/zip"
                headers = {"X-Planner-Files": str(len(result["manifest"]))}
            with open(os.path.join(export_dir, filename), "wb") as handle:
                handle.write(blob)
            headers.update({
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Planner-Archive": filename,
            })
            return Response(blob, mimetype=mimetype, headers=headers)
        raise ApiError(404, f"No export format {fmt!r}.",
                       formats=["markdown", "methods", "psychopy", "json", "figures",
                                "xlsx", "bundle"])

    return bp
