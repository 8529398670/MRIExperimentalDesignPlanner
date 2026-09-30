"""Who is asking, and what they may do: the planner's side of sign-in.

Everybody may look.  Every page, every saved design and every read of the
API answers anyone who can reach the port, so a design can be shown to
whoever needs to see it.  Changing anything - any request that is not a GET
- and the export endpoints need a session: the cookie a login link set, or
``Authorization: Bearer <API key>`` for a script or an agent.  Without one the
answer is 401, and the page, told the same thing at bootstrap, runs view-only.

An API key may do all of that, but none of /api/auth: it cannot add or
remove people, or make links or keys.  A key that got out is then ended by
revoking it, and only a person signed in with a login link can do that.

The accounts themselves - people, sessions, links, keys - are
``planner/auth.py``.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from flask import Blueprint, Flask, Response, g, jsonify, render_template, request

from planner.auth import COOKIE, COOKIE_AGE, KEY_PREFIX, Accounts, Throttle, log

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# The two ways in, open to anyone, since getting in is what they are for.
OPEN_POSTS = frozenset({"/api/auth/redeem", "/api/auth/resume"})

# Reads that are exports all the same: files to take away, and archived in
# exports/ on the way out.  The PsychoPy addresses are exports too, even
# though they sit under the design rather than under /api/v1: the index is a
# list of files to fetch and each one is a file to take away, so both want the
# same sign-in.
#
# So is the demo: it plays a run rather than handing over a file, but what it
# sends the page is the config itself, which is exactly what the download is.
# Gating one and not the other would only mean the config left by the quieter
# door.  A figure is different - that is a view of the design, and open.
EXPORT_READS = (
    re.compile(r"^/api/v1/designs/[^/]+/export(/|$)"),
    re.compile(r"^/designs/[^/]+/psychopy(/|$)"),
    re.compile(r"^/designs/[^/]+/demo(/|$)"),
)


def an_export(path: str) -> bool:
    return any(pattern.match(path) for pattern in EXPORT_READS)

# The page shell.  Opening the planner sets the cookie again: a browser drops
# a cookie 400 days after it was last set, so this is what makes a sign-in
# for good.
PAGE_ENDPOINTS = frozenset({"index", "design_page"})

VIEW_ONLY = "View only: sign in with a login link to make changes."

# Said to a script whose Bearer token matched nothing, rather than VIEW_ONLY,
# which is for a browser.
UNKNOWN_TOKEN = ("That token is not recognised: the API key was revoked or the person who "
                 "made it was removed, or the session ended. Make a new key in People.")

# What an API key may ask of /api/auth: who it is, and nothing else.
KEY_AUTH_ROUTES = frozenset({("GET", "/api/auth/me")})
KEY_REFUSED = ("An API key cannot manage people, login links or keys: that takes a person "
               "signed in with a login link.")


def _fail(status: int, message: str, **extra: Any) -> Tuple[Response, int]:
    return jsonify({"ok": False, "error": message, **extra}), status


def install(app: Flask, accounts: Accounts, throttle: Throttle, public_url: str = "") -> None:
    """Put the guard in front of every request and add /login and /api/auth."""

    # ------------------------------------------------------------ requests

    def presented() -> Tuple[str, bool]:
        """The token this request carries, and whether it came as the cookie."""
        header = request.headers.get("Authorization") or ""
        if header[:7].lower() == "bearer ":
            return header[7:].strip(), False
        return request.cookies.get(COOKIE) or "", True

    def https() -> bool:
        """Came in over https - through a proxy or a tunnel, which says so."""
        proto = (request.headers.get("X-Forwarded-Proto") or "").lower()
        return proto == "https" or '"https"' in (request.headers.get("CF-Visitor") or "")

    def set_session(response: Response, token: str) -> None:
        # Lax, not Strict: a Strict cookie is left off a link followed from
        # another site, so opening a design link from an email would show it
        # view-only.  Secure only over https - a browser on the LAN address
        # would otherwise refuse to keep it at all.
        response.set_cookie(COOKIE, token, max_age=COOKIE_AGE, path="/", httponly=True,
                            samesite="Lax", secure=https())

    def client() -> str:
        """Who is knocking, for the throttle.  Behind a proxy every request
        comes from the same address, and the proxy names the real one."""
        forwarded = (request.headers.get("CF-Connecting-IP")
                     or (request.headers.get("X-Forwarded-For") or "").split(",")[0]).strip()
        return forwarded or request.remote_addr or "?"

    def same_origin() -> bool:
        """Whether a write came from the planner's own pages.

        SameSite keeps the cookie off a cross-site POST, but not off one from
        another port on the same host - and on the LAN, every app on this box
        is the same host.  The browser says where a request came from;
        anything that says somewhere else is refused.
        """
        site = request.headers.get("Sec-Fetch-Site")
        if site:
            return site in ("same-origin", "none")
        origin = request.headers.get("Origin")
        if not origin:
            return True                 # not a browser: nothing ambient to abuse
        hosts = {request.headers.get("Host") or "", request.headers.get("X-Forwarded-Host") or ""}
        return urlsplit(origin).netloc in hosts - {""}

    @app.before_request
    def guard() -> Optional[Tuple[Response, int]]:
        # One worker thread serves many requests, so who is asking is worked
        # out afresh every time.
        g.user = None
        g.token, g.via_cookie = "", False
        if request.path.startswith("/static/"):
            return None
        token, via_cookie = presented()
        if token:
            g.token, g.via_cookie = token, via_cookie
            # A key only ever comes in the header: the cookie is a browser's,
            # and nothing turns a key into one.
            if token.startswith(KEY_PREFIX):
                g.user = None if via_cookie else accounts.key_for(token)
            else:
                g.user = accounts.user_for(token)
        if (g.user and g.user.get("key") and request.path.startswith("/api/auth/")
                and (request.method, request.path) not in KEY_AUTH_ROUTES):
            return _fail(403, KEY_REFUSED)
        # A browser with a dead cookie is simply signed out; a script is told why.
        unknown = UNKNOWN_TOKEN if token and not via_cookie and g.user is None else ""
        if request.method not in SAFE_METHODS:
            if not same_origin():
                return _fail(403, "Refused: that came from another site.")
            if request.path in OPEN_POSTS:
                return None
            if g.user is None:
                return _fail(401, unknown or VIEW_ONLY, viewOnly=True, signIn="/login")
        elif g.user is None and an_export(request.path):
            return _fail(401, unknown or "Exports need a sign-in with a login link.",
                         viewOnly=True, signIn="/login")
        return None

    @app.after_request
    def renew(response: Response) -> Response:
        if (g.get("user") and g.get("via_cookie") and response.status_code == 200
                and request.endpoint in PAGE_ENDPOINTS):
            set_session(response, g.token)
        return response

    # -------------------------------------------------------------- routes

    bp = Blueprint("auth", __name__)

    def given() -> str:
        payload = request.get_json(silent=True)
        token = payload.get("token") if isinstance(payload, dict) else ""
        return str(token or "")[:200]

    def link_out(made: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """A link as the page shows it, on the address it will be opened from."""
        if not made:
            return None
        base = public_url or request.host_url.rstrip("/")
        return {"id": made["id"], "path": made["path"], "expiresAt": made["expiresAt"],
                "url": base + made["path"]}

    @bp.get("/login")
    def login_page() -> Response:
        """A login link's page, the same whoever opens it: the token is after
        the #, which the browser never sends, and the page's script spends it.
        A chat app fetching the link for a preview gets nothing to spend."""
        response = Response(render_template("login.html"), mimetype="text/html; charset=utf-8")
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        return response

    @bp.post("/api/auth/redeem")
    def redeem():
        """A login link, opened.  It is spent whether or not this goes well."""
        who = client()
        if throttle.blocked(who):
            return _fail(429, "Slow down.")
        got = accounts.redeem(given(), request.headers.get("User-Agent") or "")
        if not got:
            throttle.fail(who)
            return _fail(401, "That link has been used, or has lapsed.")
        session, user = got
        # The browser was signed in already: that session is over, not left
        # behind as a device nobody is using.
        if g.user and g.via_cookie:
            accounts.end(g.token)
        log(f"{user['name']} signed in with a login link")
        # The token goes back in the body as well as the cookie, for the page
        # to keep in localStorage - the one copy that outlives a lost cookie -
        # and for a script to send as a Bearer token.
        response = jsonify({"ok": True, "token": session, "id": user["id"], "name": user["name"]})
        set_session(response, session)
        return response

    @bp.post("/api/auth/resume")
    def resume():
        """Put back a session this browser kept, or confirm the one it has."""
        who = client()
        if throttle.blocked(who):
            return _fail(429, "Slow down.")
        token = given()
        user = accounts.user_for(token) if token else None
        if user:
            response = jsonify({"ok": True, "name": user["name"]})
            set_session(response, token)
            return response
        if g.user:
            return jsonify({"ok": True, "name": g.user["name"]})
        throttle.fail(who)
        return _fail(401, "Not signed in.")

    @bp.get("/api/auth/me")
    def me():
        if g.user is None:
            return _fail(401, "Not signed in.")
        return jsonify(g.user)

    @bp.post("/api/auth/logout")
    def logout():
        accounts.end(g.token)
        log(f"{g.user['name']} signed out of a browser")
        response = jsonify({"ok": True})
        response.delete_cookie(COOKIE, path="/", httponly=True, samesite="Lax", secure=https())
        return response

    # Everyone signed in may do all of this - there are no roles, only names.

    @bp.get("/api/auth/users")
    def list_users():
        if g.user is None:
            return _fail(401, "Not signed in.")
        return jsonify({"me": g.user["id"], "users": accounts.users(), "keys": accounts.keys()})

    @bp.post("/api/auth/users")
    def add_user():
        payload = request.get_json(silent=True)
        name = payload.get("name") if isinstance(payload, dict) else None
        user, why = accounts.add(name, g.user["id"])
        if not user:
            return _fail(400, why)
        log(f"{g.user['name']} added {user['name']}")
        # Somebody is added to be let in, so their first link comes with them.
        made = accounts.link(user["id"], g.user["id"])
        return jsonify({"ok": True, "user": user, "link": link_out(made)}), 201

    @bp.post("/api/auth/users/<uid>/link")
    def new_link(uid: str):
        made = accounts.link(uid[:32], g.user["id"])
        if not made:
            return _fail(404, "Nobody by that id.")
        log(f"{g.user['name']} made a login link for {made['name']}")
        return jsonify(link_out(made)), 201

    @bp.delete("/api/auth/users/<uid>")
    def remove_user(uid: str):
        # You cannot take yourself out: somebody else has to, which is also
        # what stops the last person in from locking everybody out by accident.
        if uid == g.user["id"]:
            return _fail(400, "You cannot remove yourself; somebody else can.")
        name = accounts.remove(uid[:32])
        if name is None:
            return _fail(404, "Nobody by that id.")
        log(f"{g.user['name']} removed {name}")
        return jsonify({"ok": True, "removed": name})

    @bp.delete("/api/auth/links/<link_id>")
    def cancel_link(link_id: str):
        if not accounts.revoke(link_id):
            return _fail(404, "No unused link with that id.")
        log(f"{g.user['name']} cancelled an unused login link")
        return jsonify({"ok": True})

    @bp.post("/api/auth/keys")
    def make_key():
        payload = request.get_json(silent=True)
        name = payload.get("name") if isinstance(payload, dict) else None
        made, why = accounts.make_key(g.user["id"], name)
        if not made:
            return _fail(400, why)
        log(f"{g.user['name']} made an API key: {made['name']}")
        return jsonify({"ok": True, "key": made}), 201

    @bp.delete("/api/auth/keys/<key_id>")
    def revoke_key(key_id: str):
        name = accounts.revoke_key(key_id)
        if name is None:
            return _fail(404, "No API key with that id.")
        log(f"{g.user['name']} revoked the API key {name}")
        return jsonify({"ok": True})

    app.register_blueprint(bp)
