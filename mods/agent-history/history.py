#!/usr/bin/env python3
"""List closed Claude Code and Codex conversations for the agent-history mod.

Prints JSON: {"sessions": [...]}, newest first. A conversation is "closed" when
no running process has it open:
- Claude Code: every running `claude` writes ~/.claude/sessions/<pid>.json with
  its sessionId; a live pid means that conversation is open.
- Codex: the process that owns a thread holds
  ~/.codex/thread-writer-locks/<thread id>.lock open; lsof shows which.

Claude titles sit near the end of large transcripts (ai-title records), so each
transcript is read once per change (size + mtime) and the result is cached.
Read-only towards Claude and Codex; the only write is the cache file.
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
import subprocess
import sys

HOME = os.path.expanduser("~")
CLAUDE_PROJECTS = os.path.join(HOME, ".claude", "projects")
CLAUDE_RUNNING = os.path.join(HOME, ".claude", "sessions")
CODEX_DB = os.path.join(HOME, ".codex", "state_5.sqlite")
CODEX_LOCKS = os.path.join(HOME, ".codex", "thread-writer-locks")
CACHE_DIR = os.path.join(HOME, "Library", "Caches")
if not os.path.isdir(CACHE_DIR):
    CACHE_DIR = os.path.join(HOME, ".cache")
CACHE_FILE = os.path.join(CACHE_DIR, "herdr-agent-history.json")
CACHE_VERSION = 1

HEAD_BYTES = 2 * 1024 * 1024
TAIL_BYTES = 1024 * 1024
LIMIT = 500


def clean(text: str, limit: int = 200) -> str:
    return " ".join(str(text).split())[:limit]


def prompt_text(content) -> str:
    """The person's words in a user record, or "" for tool results and meta text."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return ""
        text = " ".join(parts)
    else:
        return ""
    text = text.strip()
    if not text or text.startswith("<") or text.startswith("Caveat:") or text.startswith("[Request interrupted"):
        return ""
    return text


def records(chunk: bytes):
    for line in chunk.split(b"\n"):
        if not line.startswith(b"{"):
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def parse_claude(path: str, size: int) -> dict:
    info = {"cwd": None, "branch": None, "prompt": "", "title": "", "interactive": True}
    with open(path, "rb") as f:
        head = f.read(HEAD_BYTES)
        if size > HEAD_BYTES:
            f.seek(max(HEAD_BYTES, size - TAIL_BYTES))
            tail = f.read()
        else:
            tail = b""
    custom = ai = summary = ""
    for chunk in (head, tail):
        for r in records(chunk):
            kind = r.get("type")
            if r.get("cwd"):
                info["cwd"] = r["cwd"]
            if r.get("gitBranch"):
                info["branch"] = r["gitBranch"]
            if r.get("entrypoint") and r.get("entrypoint") != "cli":
                info["interactive"] = False
            if kind == "user" and not info["prompt"] and not r.get("isMeta") and not r.get("isSidechain"):
                info["prompt"] = clean(prompt_text((r.get("message") or {}).get("content")))
            elif kind == "custom-title" and r.get("customTitle"):
                custom = r["customTitle"]
            elif kind == "ai-title" and r.get("aiTitle"):
                ai = r["aiTitle"]
            elif kind == "summary" and r.get("summary"):
                summary = r["summary"]
    info["title"] = clean(custom or ai or summary or "", 120)
    return info


def open_claude() -> set:
    ids = set()
    for path in glob.glob(os.path.join(CLAUDE_RUNNING, "*.json")):
        try:
            with open(path) as f:
                d = json.load(f)
            os.kill(int(d["pid"]), 0)
            ids.add(d["sessionId"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return ids


def claude_sessions(cache: dict) -> list:
    running = open_claude()
    seen = {}
    out = []
    for path in glob.glob(os.path.join(CLAUDE_PROJECTS, "*", "*.jsonl")):
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = f"{st.st_size}:{int(st.st_mtime)}"
        hit = cache.get(path)
        if hit and hit.get("key") == key:
            info = hit["info"]
        else:
            try:
                info = parse_claude(path, st.st_size)
            except OSError:
                continue
        seen[path] = {"key": key, "info": info}
        sid = os.path.basename(path)[: -len(".jsonl")]
        if sid in running or not info["prompt"] or not info["interactive"]:
            continue
        cwd = info["cwd"] or HOME
        out.append({
            "agent": "claude",
            "id": sid,
            "title": info["title"] or info["prompt"][:120],
            "prompt": info["prompt"],
            "cwd": cwd,
            "exists": os.path.isdir(cwd),
            "branch": info["branch"],
            "updated": int(st.st_mtime * 1000),
        })
    cache.clear()
    cache.update(seen)
    return out


def open_codex() -> set:
    locks = glob.glob(os.path.join(CODEX_LOCKS, "*.lock"))
    if not locks:
        return set()
    try:
        r = subprocess.run(["lsof", "-Fn", *locks], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    ids = set()
    for line in r.stdout.splitlines():
        if line.startswith("n") and line.endswith(".lock"):
            name = os.path.basename(line[1:])[: -len(".lock")]
            if not name.startswith("."):
                ids.add(name)
    return ids


def codex_sessions() -> list:
    if not os.path.exists(CODEX_DB):
        return []
    running = open_codex()
    try:
        db = sqlite3.connect(f"file:{CODEX_DB}?mode=ro", uri=True, timeout=5)
        rows = db.execute(
            """
            select id, coalesce(nullif(name, ''), nullif(title, ''), first_user_message),
                   first_user_message, cwd, git_branch,
                   coalesce(updated_at_ms, updated_at * 1000)
            from threads
            where archived = 0 and source not like '%subagent%'
              and (first_user_message != '' or title != '')
            order by updated_at desc
            limit ?
            """,
            (LIMIT,),
        ).fetchall()
        db.close()
    except sqlite3.Error as e:
        print(f"codex: {e}", file=sys.stderr)
        return []
    out = []
    for tid, title, prompt, cwd, branch, updated in rows:
        if tid in running:
            continue
        cwd = cwd or HOME
        out.append({
            "agent": "codex",
            "id": tid,
            "title": clean(title or prompt or "", 120),
            "prompt": clean(prompt or ""),
            "cwd": cwd,
            "exists": os.path.isdir(cwd),
            "branch": branch,
            "updated": int(updated or 0),
        })
    return out


def load_cache() -> dict:
    try:
        with open(CACHE_FILE) as f:
            d = json.load(f)
        if d.get("version") == CACHE_VERSION:
            return d.get("claude", {})
    except (OSError, ValueError):
        pass
    return {}


def save_cache(claude: dict) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"version": CACHE_VERSION, "claude": claude}, f)
        os.replace(tmp, CACHE_FILE)
    except OSError:
        pass


def main() -> None:
    cache = load_cache()
    sessions = claude_sessions(cache) + codex_sessions()
    save_cache(cache)
    sessions.sort(key=lambda s: s["updated"], reverse=True)
    json.dump({"sessions": sessions[:LIMIT]}, sys.stdout)


if __name__ == "__main__":
    main()
