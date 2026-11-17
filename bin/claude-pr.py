#!/usr/bin/env python3
"""Claude Code PostToolUse hook: tell Herdr when the session has opened a PR.

A session that has opened a pull request is finished, or nearly finished. This
writes the pull request on the Herdr terminal the session runs in
($HC_TERMINAL_ID) as the labels `pr`, `pr.url` and `pr.state`, which the tab bar
(`mods/tabs-drag`) draws as a badge and keeps in the sticky group at the start of
the bar. `bin/pr-tabs.py` keeps the state up to date and covers agents without
hooks; this hook is what catches the pull request the moment it is made.

It takes the pull request URL printed by a command that opens one — `gh pr
create`, `gh pr ready`, or a flow script's `pr` step (`patrol_flow.py pr`) — so
opening one through a script counts too. Only those: a session that merely
printed a pull request URL, its own or somebody else's, is not finished, and
`bin/pr-tabs.py` reads the screen of the ones this misses. Outside Herdr, or on
anything unexpected, it does nothing and never blocks Claude.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

PULL = re.compile(r"https?://[^\s<>\"'`]+/pull/(\d+)")
# Commands that open a pull request. Anything else that prints one is reading.
OPENS = re.compile(r"\bgh\s+pr\s+(create|ready)\b|\b[\w./-]+\.py\s+(pr|pr-\w+)\b")


def main() -> None:
    terminal = os.environ.get("HC_TERMINAL_ID")
    if not terminal:
        return
    event = json.load(sys.stdin)
    if event.get("tool_name") != "Bash":
        return
    command = str((event.get("tool_input") or {}).get("command") or "")
    if not OPENS.search(command):
        return
    response = event.get("tool_response")
    text = response if isinstance(response, str) else json.dumps(response)
    found = PULL.search(text)
    if not found:
        return
    url = found.group(0).rstrip(".,);:]")
    hc = shutil.which("hc") or str(pathlib.Path.home() / ".local/bin/hc")
    subprocess.run(
        [hc, "label", terminal, f"pr={found.group(1)}", f"pr.url={url}", "pr.state=OPEN", "pr.checked=0", "pr.off="],
        capture_output=True, timeout=5, check=False,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # A tab badge is never worth failing a tool call over.
        pass
