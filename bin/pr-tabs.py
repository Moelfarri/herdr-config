#!/usr/bin/env python3
"""Mark the Herdr terminals whose agent has opened a pull request.

A session that has opened a PR is finished, or nearly finished, so its tab can
usually be closed. This writes that on the terminal as labels, which the tab bar
(`mods/tabs-drag`) reads to keep those tabs in a sticky group at the start of the
bar:

- `pr`        the number, e.g. `69`
- `pr.url`    the pull request
- `pr.state`  OPEN, DRAFT, MERGED, CLOSED or UNKNOWN (what `gh` says)
- `pr.checked` unix seconds of the last `gh` look

Two things write `pr`: `bin/claude-pr.py`, a Claude Code hook that labels the
terminal the moment the session runs `gh pr create`, and this sweep, which reads
the screen of every agent that is done or idle and takes a pull request URL it
shows. The sweep is what covers Codex and anything else without hooks. Labels
stay until the tab closes, or until "Clear PR" in the tab's right-click menu.

Run by `mods/tabs-drag` every half minute, and safe to run by hand:

    python3 -I ~/.config/herdr-app/bin/pr-tabs.py [--verbose]
"""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import sys
import time

# How long a PR's state is trusted before `gh` is asked again (seconds).
STATE_MAX_AGE = 180
# Only a finished turn is read: an agent at work may be looking at someone
# else's pull request, and that is not its own.
READ_STATES = ("done", "idle")
PULL = re.compile(r"https?://[^\s<>\"'`]+/pull/(\d+)")


def tool(name: str) -> str:
    return shutil.which(name) or str(pathlib.Path.home() / ".local/bin" / name)


def run(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def terminals(hc: str) -> list[dict]:
    """Every live terminal, each as `hc get` describes it: `hc ls` leaves labels out."""
    r = run([hc, "ls", "--json"])
    if r.returncode != 0:
        return []
    try:
        listed = json.loads(r.stdout).get("terminals") or []
    except ValueError:
        return []
    out = []
    for term in listed:
        if term.get("state") != "live":
            continue
        one = run([hc, "get", str(term.get("address")), "--json"], timeout=10)
        if one.returncode != 0:
            continue
        try:
            out.append(json.loads(one.stdout))
        except ValueError:
            pass
    return out


def pull_url(text: str) -> str | None:
    """The first pull request URL on the screen, also when the line wrapped."""
    for candidate in (text, text.replace("\n", "")):
        found = PULL.search(candidate)
        if found:
            return found.group(0).rstrip(".,);:]")
    return None


def label(hc: str, address: str, values: dict[str, str]) -> None:
    run([hc, "label", address, *(f"{k}={v}" for k, v in values.items())])


def state_of(gh: str, url: str) -> str | None:
    r = run([gh, "pr", "view", url, "--json", "state,isDraft"], timeout=30)
    if r.returncode != 0:
        return None
    try:
        pr = json.loads(r.stdout)
    except ValueError:
        return None
    state = str(pr.get("state") or "UNKNOWN").upper()
    return "DRAFT" if state == "OPEN" and pr.get("isDraft") else state


def main() -> None:
    verbose = "--verbose" in sys.argv
    hc, gh = tool("hc"), tool("gh")
    now = int(time.time())
    found, checked = [], []
    for term in terminals(hc):
        address = term.get("address")
        labels = term.get("labels") or {}
        if labels.get("pr.off"):  # "Clear PR" in the tab's menu: leave this one alone.
            continue
        url = labels.get("pr.url")
        # A screen that shows a pull request, from an agent whose turn has ended.
        status = term.get("status")
        # `hc ls` says "done", `hc get` says { "state": "done" }.
        if isinstance(status, dict):
            status = status.get("state")
        if not url and status in READ_STATES:
            r = run([hc, "read", address], timeout=15)
            url = pull_url(r.stdout) if r.returncode == 0 else None
            if url:
                label(hc, address, {"pr": url.rsplit("/", 1)[-1], "pr.url": url, "pr.state": "UNKNOWN"})
                labels = {**labels, "pr.url": url, "pr.state": "UNKNOWN"}
                found.append((address, url))
        if not url:
            continue
        # What became of it, now and then: merged means the tab is certainly done.
        try:
            age = now - int(labels.get("pr.checked") or 0)
        except ValueError:
            age = STATE_MAX_AGE + 1
        if age <= STATE_MAX_AGE:
            continue
        state = state_of(gh, url)
        label(hc, address, {"pr.checked": str(now), **({"pr.state": state} if state else {})})
        checked.append((address, state or "unreachable"))
    if verbose:
        print(json.dumps({"found": found, "checked": checked}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # A tab badge is never worth an error dialog.
        if "--verbose" in sys.argv:
            print(f"pr-tabs: {e}", file=sys.stderr)
