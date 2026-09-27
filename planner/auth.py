"""Who may change things, and the links that let someone in.

Anybody who can reach the planner can look at it: every panel, every saved
design, live as it changes.  Changing anything - a design, an acquisition
card, a saved design - and taking anything away as an export needs a
session.  A browser without one gets the planner in view-only mode, nothing
more.

Everybody who has a session can do everything.  There are no roles, only
names: each person is somebody, and every one of them can add people, remove
them, and make the links that let them in.

The only way in for a person is one of those links.  It works once: the
first browser to open it is signed in as that person for good, and the link
is spent.  There is no password to forget and none to guess - a token is 256
random bits.

A script or an agent gets an API key instead: made by someone signed in,
named for what will use it, sent as ``Authorization: Bearer <key>``.  It can
change and export anything a person can, but it cannot add or remove people
or make links or keys - so revoking a key that got out is the end of it.  A
key is its maker's: when they are removed, their keys stop working too.

What is kept, in ``<PLANNER_AUTH_DIR>/users.json``:

    users     id -> name, and who added them
    sessions  sha256(token) -> whose, since when, last seen
    links     sha256(token) -> whose, until when
    keys      sha256(key) -> whose, what it is called, since when, last used

Only hashes are written down.  A copy of the file - a backup, a paste into a
bug report - lets nobody in; the tokens themselves exist only in the browsers
holding them and in the one link that was sent.

The file has a second writer: ``python -m planner.auth link <name>``, which
``./dockerRun.sh --link <name>`` runs inside the container.  That is how the
first person gets in, and how anyone gets back in if everyone else has been
removed.  So every change takes an flock and re-reads the file before
touching it, and the server notices a file changed under it by its stat.

Standard library only, so the server can import it and so can a shell.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parent.parent

# Kept apart from presets/: every *.json there is listed as a saved design.
AUTH_DIR = Path(os.environ.get("PLANNER_AUTH_DIR") or BASE_DIR / "accounts")

# How long a login link nobody has opened keeps working.  The sign-in it
# makes does not expire at all.
try:
    LINK_DAYS = min(3650.0, max(0.01, float(os.environ.get("PLANNER_LINK_DAYS") or 7)))
except ValueError:
    LINK_DAYS = 7.0

# Where the planner is reached from outside, if it is - a tunnel or a reverse
# proxy.  Login links are built on it so they work for whoever they are sent
# to; empty, they are built on the address the person making one is using.
PUBLIC_URL = (os.environ.get("PLANNER_PUBLIC_URL") or "").strip().rstrip("/")
if not re.fullmatch(r"https?://[^/\s]+", PUBLIC_URL):
    PUBLIC_URL = ""

# The cookie that carries a session.  Not MediaTracker's name: cookies are
# kept per host, not per port, and both run on the same machine.  A browser
# keeps a cookie at most 400 days whatever it is told, so it is set again
# every time the planner is opened, and the page keeps the token in
# localStorage too, to put the cookie back if it ever goes.
COOKIE = "mrip_session"
COOKIE_AGE = 400 * 86400

# How stale a session's "last seen" may get before it is written down.  The
# page polls every few seconds; each poll would otherwise be a disk write.
SEEN_EVERY = 3600

# Ceilings, so that nothing can grow the file without end.  Every session
# costs someone a link and every link costs someone a click, so the real
# numbers are a handful.
MAX_USERS = 200
MAX_SESSIONS = 2000
MAX_LINKS = 500
MAX_KEYS = 200
NAME_MAX = 32

TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_-]{20,128}")

# What an API key starts with, so that one is recognisable wherever it turns
# up, and so that the server knows which list to look it up in.
KEY_PREFIX = "mrip_"
KINDS = ("sessions", "links", "keys")


def log(message: str) -> None:
    print(f"  auth: {message}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def well_formed(token: object) -> bool:
    return isinstance(token, str) and bool(TOKEN_SHAPE.fullmatch(token))


def _later(days: float) -> str:
    moment = datetime.now(timezone.utc) + timedelta(days=days)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _age(stamp: Optional[str]) -> float:
    """Seconds since an ISO stamp; forever for one that cannot be read."""
    try:
        then = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return (datetime.now(timezone.utc) - then).total_seconds()


def clean_person(raw: object) -> str:
    """A name as it will be shown: one line, no control characters, not long.

    Anything printable is allowed, accents and all - it is only ever drawn as
    text, never used as a path or a key.  (Not ``designs.clean_name``, which
    makes file names.)
    """
    text = unicodedata.normalize("NFKC", str(raw or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    text = " ".join(text.split())[:NAME_MAX].strip()
    return text if any(ch.isalnum() for ch in text) else ""


def _blank() -> dict:
    return {"schema": 1, "users": {}, "sessions": {}, "links": {}, "keys": {}}


def _clean(raw: object) -> dict:
    """The file as read, with anything malformed dropped rather than trusted."""
    data = _blank()
    if not isinstance(raw, dict):
        return data
    for uid, user in (raw.get("users") or {}).items():
        if isinstance(uid, str) and isinstance(user, dict) and clean_person(user.get("name")):
            data["users"][uid] = {
                "name": clean_person(user.get("name")),
                "createdAt": str(user.get("createdAt") or ""),
                "createdBy": str(user.get("createdBy") or ""),
            }
    for kind in KINDS:
        for key, entry in (raw.get(kind) or {}).items():
            if (isinstance(key, str) and len(key) == 64 and isinstance(entry, dict)
                    and entry.get("user") in data["users"]):
                kept = {k: str(v) for k, v in entry.items() if isinstance(v, str)}
                if kind == "keys":
                    kept["name"] = clean_person(kept.get("name"))
                    if not kept["name"]:
                        continue
                data[kind][key] = kept
    return data


def _cap(entries: dict, limit: int, field: str) -> None:
    """Drop the oldest by `field` until there are `limit` left."""
    if len(entries) <= limit:
        return
    for key in sorted(entries, key=lambda k: entries[k].get(field) or "")[:len(entries) - limit]:
        del entries[key]


class Accounts:
    """The users file, shared between the server's threads and a shell.

    Reads come from memory, refreshed whenever the file's stat changes.  Every
    change is made under an flock to the file as it is on disk at that
    moment, then written atomically - so a link made from the shell while the
    server is running is in the server a request later, and neither writer
    ever puts back what the other just took out.
    """

    def __init__(self, directory) -> None:
        self.directory = Path(directory)
        self.path = self.directory / "users.json"
        self.lock_path = self.directory / "users.lock"
        self.lock = threading.RLock()
        self.data = _blank()
        self.stamp: Optional[tuple] = None
        self.seen: Dict[str, str] = {}      # session -> last seen, not yet written

    # ---------------------------------------------------------------- disk

    def _stat(self) -> Optional[tuple]:
        try:
            st = os.stat(self.path)
        except OSError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    def _fresh(self) -> None:
        """Read the file again if anything has written it since last time."""
        stamp = self._stat()
        if stamp is not None and stamp == self.stamp:
            return
        self.stamp = stamp
        if stamp is None:
            self.data = _blank()
            return
        try:
            self.data = _clean(json.loads(self.path.read_text("utf-8")))
        except (OSError, ValueError) as exc:
            # Keep what was there for whoever looks, and start again.  Only a
            # disk fault gets here: every write is a whole file, renamed in.
            broken = self.path.with_name(f"users.corrupt-{int(time.time())}.json")
            log(f"!! {self.path.name} is unreadable ({exc}); moved to {broken.name}")
            try:
                self.path.replace(broken)
            except OSError:
                pass
            self.data = _blank()
            self.stamp = None

    def _write(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        payload = json.dumps(self.data, ensure_ascii=False, indent=1)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self.path)
        self.stamp = self._stat()

    def _tidy(self) -> bool:
        """Fold in who has been seen, and drop links that have lapsed."""
        changed = False
        sessions, keys = self.data["sessions"], self.data["keys"]
        for key, when in self.seen.items():
            entry = sessions.get(key) or keys.get(key)
            if entry and (entry.get("seenAt") or "") < when:
                entry["seenAt"] = when
                changed = True
        self.seen.clear()
        now = now_iso()
        for key in [k for k, link in self.data["links"].items()
                    if (link.get("expiresAt") or "") <= now]:
            del self.data["links"][key]
            changed = True
        return changed

    def _change(self, fn: Callable[[dict], Tuple[object, bool]]):
        """Run `fn(data) -> (result, changed)` against the file as it is now."""
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            with open(self.lock_path, "a", encoding="utf-8") as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                try:
                    self.stamp = None
                    self._fresh()
                    tidied = self._tidy()
                    result, changed = fn(self.data)
                    if changed or tidied:
                        self._write()
                    return result
                finally:
                    fcntl.flock(held, fcntl.LOCK_UN)

    # ------------------------------------------------------------ sessions

    def _lookup(self, kind: str, token: str, found: Callable[[str, dict, dict], dict]):
        """The session or key this token is, as `found(key, entry, user)` puts
        it, or None.  Notes it as seen, and writes that down now and then."""
        if not well_formed(token):
            return None
        key = _hash(token)
        with self.lock:
            self._fresh()
            entry = self.data[kind].get(key)
            user = self.data["users"].get(entry["user"]) if entry else None
            if not user:
                return None
            now = now_iso()
            self.seen[key] = now
            stale = _age(entry.get("seenAt")) > SEEN_EVERY
            if stale:
                # A page load is a dozen requests at once; one write is enough.
                entry["seenAt"] = now
            answer = found(key, entry, user)
        if stale:
            try:
                self._change(lambda data: (None, False))
            except OSError as exc:
                log(f"!! could not note a {kind[:-1]} as seen: {exc}")
        return answer

    def user_for(self, token: str) -> Optional[dict]:
        """Whose session this is, or None.  Asked on every request."""
        return self._lookup("sessions", token, lambda key, session, user: {
            "id": session["user"], "name": user["name"]})

    def key_for(self, token: str) -> Optional[dict]:
        """The API key this is, as who is asking, or None.  It is named for
        itself, not its maker: what it changes is the agent's doing."""
        if not str(token or "").startswith(KEY_PREFIX):
            return None
        return self._lookup("keys", token, lambda key, entry, user: {
            "id": "key:" + key[:12], "name": entry["name"], "key": key[:12],
            "by": user["name"]})

    def redeem(self, token: str, agent: str = "") -> Optional[Tuple[str, dict]]:
        """Spend a link.  A new session for whoever it was made for, or None."""
        if not well_formed(token):
            return None
        key = _hash(token)
        with self.lock:
            self._fresh()
            if key not in self.data["links"]:
                return None             # nothing to change, so nothing to lock

        def spend(data):
            # Asked again under the lock: two tabs, or two processes, may have
            # opened the same link at once, and only one of them gets it.
            link = data["links"].pop(key, None)
            # A lapsed link is already gone: _tidy drops them before this runs.
            if not link or link["user"] not in data["users"]:
                return None, link is not None
            session = secrets.token_urlsafe(32)
            now = now_iso()
            data["sessions"][_hash(session)] = {
                "user": link["user"], "createdAt": now, "seenAt": now,
                "agent": str(agent or "")[:200],
            }
            _cap(data["sessions"], MAX_SESSIONS, "seenAt")
            user = data["users"][link["user"]]
            return (session, {"id": link["user"], "name": user["name"]}), True

        return self._change(spend)

    def end(self, token: str) -> bool:
        """Sign one browser out."""
        if not well_formed(token):
            return False
        key = _hash(token)

        def drop(data):
            gone = data["sessions"].pop(key, None) is not None
            return gone, gone

        return self._change(drop)

    # --------------------------------------------------------------- people

    def users(self) -> List[dict]:
        """Everyone, with how many browsers each is signed in on and when last
        seen, and the links made for them that nobody has opened yet."""
        with self.lock:
            self._fresh()
            now = now_iso()
            people = {uid: {"id": uid, "name": user["name"],
                            "createdAt": user.get("createdAt") or "",
                            "createdBy": (self.data["users"].get(user.get("createdBy") or "")
                                          or {}).get("name", ""),
                            "devices": 0, "seenAt": "", "links": []}
                      for uid, user in self.data["users"].items()}
            for key, session in self.data["sessions"].items():
                person = people.get(session["user"])
                if not person:
                    continue
                person["devices"] += 1
                seen = max(session.get("seenAt") or "", self.seen.get(key) or "")
                person["seenAt"] = max(person["seenAt"], seen)
            for key, link in self.data["links"].items():
                person = people.get(link["user"])
                if person and (link.get("expiresAt") or "") > now:
                    person["links"].append({"id": key[:12], "createdAt": link.get("createdAt") or "",
                                            "expiresAt": link.get("expiresAt") or ""})
        for person in people.values():
            person["links"].sort(key=lambda link: link["createdAt"])
        return sorted(people.values(), key=lambda p: p["name"].casefold())

    def count(self) -> int:
        with self.lock:
            self._fresh()
            return len(self.data["users"])

    def find(self, name: str) -> Optional[str]:
        """The id of whoever goes by this name, ignoring case."""
        wanted = clean_person(name).casefold()
        with self.lock:
            self._fresh()
            for uid, user in self.data["users"].items():
                if user["name"].casefold() == wanted:
                    return uid
        return None

    def add(self, name: object, by: str = "") -> Tuple[Optional[dict], str]:
        """Someone new.  Their record, or None and why not."""
        clean = clean_person(name)
        if not clean:
            return None, "a name needs a letter or a number in it"

        def make(data):
            if any(u["name"].casefold() == clean.casefold() for u in data["users"].values()):
                return (None, f"there is already someone called {clean}"), False
            if len(data["users"]) >= MAX_USERS:
                return (None, "that is as many people as this will hold"), False
            uid = secrets.token_hex(6)
            data["users"][uid] = {"name": clean, "createdAt": now_iso(), "createdBy": by or ""}
            return ({"id": uid, "name": clean}, ""), True

        return self._change(make)

    def remove(self, uid: str) -> Optional[str]:
        """Take someone out, and every browser they are signed in on and every
        key they made with them.  Their name, or None if there was nobody by
        that id."""
        def drop(data):
            user = data["users"].pop(uid, None)
            if not user:
                return None, False
            for kind in KINDS:
                data[kind] = {k: v for k, v in data[kind].items() if v["user"] != uid}
            return user["name"], True

        return self._change(drop)

    def _drop_by_id(self, kind: str, short: str) -> Optional[dict]:
        """Take out a link or a key by the id the listings gave it: the first
        12 hex of its hash, which names one and gives nothing away.  What was
        taken out, or None."""
        short = str(short or "").lower()
        if not re.fullmatch(r"[0-9a-f]{12}", short):
            return None

        def drop(data):
            hits = [key for key in data[kind] if key.startswith(short)]
            if len(hits) != 1:
                return None, False
            return data[kind].pop(hits[0]), True

        return self._change(drop)

    # ---------------------------------------------------------------- links

    def link(self, uid: str, by: str = "") -> Optional[dict]:
        """A new one-time link for this person.  The token is in the answer and
        nowhere else - it cannot be looked up again, only made again."""
        def make(data):
            if uid not in data["users"]:
                return None, False
            token = secrets.token_urlsafe(32)
            key = _hash(token)
            expires = _later(LINK_DAYS)
            data["links"][key] = {"user": uid, "createdAt": now_iso(),
                                  "createdBy": by or "", "expiresAt": expires}
            _cap(data["links"], MAX_LINKS, "createdAt")
            return {"token": token, "id": key[:12], "path": f"/login#{token}",
                    "name": data["users"][uid]["name"], "expiresAt": expires}, True

        return self._change(make)

    def revoke(self, link_id: str) -> bool:
        """Cancel a link nobody has opened yet, by the id `users()` gave it."""
        return self._drop_by_id("links", link_id) is not None

    # ----------------------------------------------------------------- keys

    def keys(self) -> List[dict]:
        """Every API key, oldest first: what it is called, who made it, and
        when it was last used.  Never the key itself - that is not kept."""
        with self.lock:
            self._fresh()
            users = self.data["users"]
            found = [{"id": key[:12], "name": entry["name"], "user": entry["user"],
                      "madeBy": (users.get(entry["user"]) or {}).get("name", ""),
                      "createdAt": entry.get("createdAt") or "",
                      "seenAt": max(entry.get("seenAt") or "", self.seen.get(key) or "")}
                     for key, entry in self.data["keys"].items()]
        return sorted(found, key=lambda made: made["createdAt"])

    def make_key(self, uid: str, name: object) -> Tuple[Optional[dict], str]:
        """A new API key, made by this person and named for what will use it.
        The key is in the answer and nowhere else - it cannot be looked up
        again, only made again.  None and why not, if it cannot be made."""
        clean = clean_person(name)
        if not clean:
            return None, "a key's name needs a letter or a number in it"

        def make(data):
            if uid not in data["users"]:
                return (None, "nobody by that id"), False
            # Full is a refusal, not the oldest dropped: some agent depends on it.
            if len(data["keys"]) >= MAX_KEYS:
                return (None, "that is as many API keys as this will hold; revoke one "
                              "first"), False
            token = KEY_PREFIX + secrets.token_urlsafe(32)
            key = _hash(token)
            now = now_iso()
            data["keys"][key] = {"user": uid, "name": clean, "createdAt": now, "seenAt": ""}
            return ({"token": token, "id": key[:12], "name": clean, "createdAt": now}, ""), True

        return self._change(make)

    def revoke_key(self, key_id: str) -> Optional[str]:
        """Stop an API key working, by the id `keys()` gave it.  Its name, or
        None if there was no such key."""
        dropped = self._drop_by_id("keys", key_id)
        return dropped["name"] if dropped else None


class Throttle:
    """A cap on failed attempts to get in, per address.

    A token cannot be guessed, so this is not what keeps anyone out.  It keeps
    somebody hammering the door from costing the machine anything.
    """

    def __init__(self, allowance: int = 30, window: float = 600.0) -> None:
        self.allowance = allowance
        self.window = window
        self.fails: Dict[str, List[float]] = {}
        self.lock = threading.Lock()

    def _recent(self, key: str, now: float) -> List[float]:
        kept = [t for t in self.fails.get(key, ()) if now - t < self.window]
        if kept:
            self.fails[key] = kept
        else:
            self.fails.pop(key, None)
        return kept

    def blocked(self, key: str) -> bool:
        with self.lock:
            return len(self._recent(key, time.monotonic())) >= self.allowance

    def fail(self, key: str) -> None:
        now = time.monotonic()
        with self.lock:
            if len(self.fails) > 4096:
                self.fails.clear()
            self.fails[key] = self._recent(key, now) + [now]


# --------------------------------------------------------------------------
# the shell: python -m planner.auth link <name>   (./dockerRun.sh --link <name>)
# --------------------------------------------------------------------------


def main(argv: List[str]) -> int:
    """Make a login link from outside the planner - the first one, or the one
    that gets somebody back in when nobody left inside can make it for them."""
    accounts = Accounts(AUTH_DIR)
    if len(argv) >= 2 and argv[0] == "link":
        name = " ".join(argv[1:])
        uid = accounts.find(name)
        if uid is None:
            user, why = accounts.add(name)
            if not user:
                print(why, file=sys.stderr)
                return 1
            uid = user["id"]
        made = accounts.link(uid)
        if not made:
            print("could not make a link", file=sys.stderr)
            return 1
        print(made["path"])
        return 0
    if argv[:1] == ["users"]:
        people = accounts.users()
        for person in people:
            seen = person["seenAt"] or "never"
            print(f"{person['name']:<{NAME_MAX}}  {person['devices']} signed in"
                  f"  last seen {seen}  {len(person['links'])} unused link(s)")
        if not people:
            print("nobody yet - python -m planner.auth link <name>")
        return 0
    print("usage: python -m planner.auth link <name>  |  python -m planner.auth users",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
