#!/usr/bin/env python3
"""Claude Code PostToolUse hook: report the session's task-list progress to Herdr.

Writes the terminal label `progress=<done>/<total>` on the Herdr terminal the session
runs in ($HC_TERMINAL_ID), which the `agents-spaces` mod draws as a progress bar.
Outside Herdr, or on anything unexpected, it does nothing and never blocks Claude.

Handles both task-list tools:
- TodoWrite: the whole list arrives each time (todos[].status).
- TaskCreate / TaskUpdate: incremental, so a small tally per session is kept in $TMPDIR.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


def tally(event: dict, tool: str, tool_input: dict) -> tuple[int, int]:
    session = "".join(c for c in str(event.get("session_id") or "unknown") if c.isalnum() or c in "-_")
    state_dir = pathlib.Path(tempfile.gettempdir()) / "claude-progress"
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / f"{session}.json"
    try:
        state = json.loads(state_file.read_text())
    except (OSError, ValueError):
        state = {"created": 0, "status": {}}
    if tool == "TaskCreate":
        state["created"] += 1
    else:
        task_id = str(tool_input.get("taskId") or tool_input.get("id") or "")
        status = tool_input.get("status")
        if task_id and status:
            state["status"][task_id] = status
    state_file.write_text(json.dumps(state))
    statuses = state["status"].values()
    done = sum(1 for s in statuses if s == "completed")
    deleted = sum(1 for s in statuses if s == "deleted")
    return done, max(done, state["created"] - deleted)


def main() -> None:
    terminal = os.environ.get("HC_TERMINAL_ID")
    if not terminal:
        return
    event = json.load(sys.stdin)
    tool = event.get("tool_name")
    tool_input = event.get("tool_input") or {}
    if tool == "TodoWrite":
        todos = tool_input.get("todos") or []
        done, total = sum(1 for t in todos if t.get("status") == "completed"), len(todos)
    elif tool in ("TaskCreate", "TaskUpdate"):
        done, total = tally(event, tool, tool_input)
    else:
        return
    hc = shutil.which("hc") or str(pathlib.Path.home() / ".local/bin/hc")
    value = f"{done}/{total}" if total else ""
    subprocess.run([hc, "label", terminal, f"progress={value}"], capture_output=True, timeout=5, check=False)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # A progress bar is never worth failing a tool call over.
        pass
