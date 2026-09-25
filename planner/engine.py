"""Run the planner's own JavaScript on the server.

The solver, the optimisers and the action layer live in ``static/js`` and run
in the browser.  So that an agent can build a study over HTTP without one, the
server loads those same files into QuickJS (the ``quickjs`` package) and calls
them directly: there is no second implementation to drift out of step.

Every request gets a fresh interpreter.  Loading the scripts costs a few tens
of milliseconds, far less than a solve, and a fresh context means no state can
leak between requests or threads.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, Optional

try:
    import quickjs
except ImportError:  # pragma: no cover - reported through Engine.available
    quickjs = None

CORE_SCRIPTS = ("efficiency.js", "model.js", "api.js")
# The figure markup lives in ui.js alongside the DOM code; nothing DOM-bound
# runs at load time, so it loads fine without a document.
FIGURE_SCRIPTS = ("ui.js",)

# Glue between Python and the action layer: every call crosses as JSON text,
# and every error comes back as data rather than as an exception whose message
# has been mangled on the way through.
GLUE = r"""
var __work = null;
function __call(method, payload) {
  try {
    var args = JSON.parse(payload);
    var value;
    if (method === 'open') {
      __work = PlannerActions.session(args.state, args.boot);
      value = null;
    } else if (method === 'catalogue') {
      value = PlannerActions.catalogue();
    } else if (method === 'exports') {
      value = __exports(args);
    } else {
      value = __work[method].apply(null, args);
    }
    return JSON.stringify({ ok: true, value: value === undefined ? null : value });
  } catch (error) {
    var planner = !!(error && error.planner);
    return JSON.stringify({
      ok: false, planner: planner,
      error: String((error && error.message) || error),
      stack: planner ? '' : String((error && error.stack) || '')
    });
  }
}

/* Everything the browser posts for a workbook or a zip, built here instead. */
function __exports(options) {
  var M = PlannerModel;
  var done = __work.finish();
  var report = done.report;
  var out = {
    report: report,
    design: done.state,
    markdown: M.allMarkdown(report),
    methods: report.methodsText,
    markdownTables: Object.keys(report.markdownTables).map(function (key) {
      return { name: key, text: report.markdownTables[key] };
    }),
    psychopy: report.runs.filter(function (run) { return !run.missing; }).map(function (run) {
      return { name: M.psychopyFileName(run), text: M.psychopyYaml(report, run) };
    })
  };
  if (options && options.figures) out.figures = __work.execute({ action: 'export.figures' });
  return out;
}
"""


class EngineUnavailable(RuntimeError):
    """QuickJS is not installed, so nothing can be solved on the server."""


class ActionRefused(Exception):
    """The action layer turned a call down; the message says why."""


class Engine:
    def __init__(self, static_dir: str, time_limit: float = 120.0, memory_mb: int = 384) -> None:
        self.script_dir = os.path.join(static_dir, "js")
        self.time_limit = time_limit
        self.memory_bytes = memory_mb * 1024 * 1024
        self._sources: Dict[str, Any] = {}
        self._lock = threading.Lock()
        self._catalogue: Optional[Any] = None
        self._catalogue_stamp: Optional[tuple] = None

    @property
    def available(self) -> bool:
        return quickjs is not None

    def _source(self, name: str) -> str:
        """Script text, re-read whenever the file changes on disk."""
        path = os.path.join(self.script_dir, name)
        stat = os.stat(path)
        stamp = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._sources.get(name)
            if cached and cached[0] == stamp:
                return cached[1]
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
        # ui.js carries two raw control bytes as separators inside a string
        # literal; QuickJS's Python binding cannot take a NUL, so hand them
        # over as the escapes they stand for.
        text = text.replace("\x00", "\\u0000").replace("\x01", "\\u0001")
        with self._lock:
            self._sources[name] = (stamp, text)
        return text

    def _stamp(self) -> tuple:
        return tuple(
            os.stat(os.path.join(self.script_dir, name)).st_mtime_ns for name in CORE_SCRIPTS
        )

    def context(self, figures: bool = False) -> "Context":
        if quickjs is None:
            raise EngineUnavailable(
                "The server cannot run the planner's solver: the Python package 'quickjs' "
                "is not installed. Install it with: pip install -r requirements.txt"
            )
        ctx = quickjs.Context()
        ctx.set_memory_limit(self.memory_bytes)
        ctx.set_time_limit(self.time_limit)
        ctx.eval("var window = globalThis;")
        for name in CORE_SCRIPTS + (FIGURE_SCRIPTS if figures else ()):
            ctx.eval(self._source(name))
        ctx.eval(GLUE)
        return Context(ctx)

    def open(self, state: Dict[str, Any], boot: Dict[str, Any], figures: bool = False) -> "Context":
        context = self.context(figures=figures)
        context.call("open", {"state": state, "boot": boot})
        return context

    def catalogue(self) -> Any:
        stamp = self._stamp()
        if self._catalogue is None or self._catalogue_stamp != stamp:
            self._catalogue = self.context().call("catalogue", {})
            self._catalogue_stamp = stamp
        return self._catalogue


class Context:
    """One interpreter with one design open in it."""

    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx
        self._call = ctx.get("__call")

    def call(self, method: str, *args: Any) -> Any:
        payload = args[0] if method in ("open", "catalogue", "exports") else list(args)
        try:
            raw = self._call(method, json.dumps(payload))
        except quickjs.JSException as exc:  # time limit, memory limit
            message = str(exc)
            if "interrupted" in message.lower():
                message = "The solver ran out of time on the server."
            raise RuntimeError(message) from exc
        answer = json.loads(raw)
        if answer.get("ok"):
            return answer.get("value")
        if answer.get("planner"):
            raise ActionRefused(answer.get("error"))
        raise RuntimeError(f"{answer.get('error')}\n{answer.get('stack', '')}".strip())

    # Thin names for what the API does with an open design.
    def prepare(self, action: Any) -> Dict[str, Any]:
        return self.call("prepare", action)

    def run(self, prepared: Dict[str, Any]) -> Any:
        return self.call("run", prepared)

    def execute(self, action: Any) -> Any:
        return self.call("execute", action)

    def state(self) -> Dict[str, Any]:
        return self.call("state")

    def replace(self, design: Dict[str, Any]) -> None:
        self.call("replace", design)

    def set_boot(self, boot: Dict[str, Any]) -> None:
        self.call("setBoot", boot)

    def repoint_card(self, old: str, new: str) -> int:
        return self.call("repointCard", old, new)

    def finish(self) -> Dict[str, Any]:
        return self.call("finish")

    def exports(self, figures: bool = False) -> Dict[str, Any]:
        return self.call("exports", {"figures": figures})
