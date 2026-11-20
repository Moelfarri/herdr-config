#!/usr/bin/env python3
"""Put the factory control room into a Herdr space, or take it out again.

    factory-room.py --space <space id> --on   [--on-machine <machine>]
    factory-room.py --space <space id> --off  [--on-machine <machine>]

--on: the space's first tab gets the `factory` mod's two panes, the floor above
what the tab already shows (its terminals stay, as the small prompt area) and the
feed beside both. Nothing happens when the space already has them.
--off: every `factory` pane in the space goes; the rest of each tab stays as it
was. A tab that held only factory panes gets a fresh shell in the space's folder.

Herdr has no command for this, so it edits the layout document every Herdr window
shares (herdr-core's "herdr-app" document, version-checked, as move-to-space.py).
Choosing the theme "custom-factory" for a space runs --on (space-menu, spaces-flat);
choosing another theme runs --off. Prints one JSON line {"ok": ..., ...}.
Elias, 20 Nov 2026.
"""

import argparse
import json
import secrets
import subprocess
import time

DOC = "herdr-app"
MOD = "factory"


class Failed(Exception):
    pass


def rpc(method, params, on):
    if on:
        params = {**params, "on": on}
    request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    try:
        out = subprocess.run(["hc", "connect"], input=request + "\n", capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Failed(f"hc connect: {e}")
    for line in out.stdout.splitlines():
        try:
            answer = json.loads(line)
        except ValueError:
            continue
        if answer.get("id") != 1:
            continue
        if "error" in answer:
            return None, answer["error"]
        return answer["result"], None
    raise Failed(f"hc connect gave no answer: {out.stderr.strip() or out.stdout.strip()[:200]}")


def new_id(prefix):
    return prefix + secrets.token_hex(16)


def is_factory(node):
    return (node.get("content") or {}).get("mod") == MOD


def has_factory(node):
    return is_factory(node) or any(has_factory(c) for c in node.get("children") or [])


def mod_block(section, space, weight):
    return {"id": new_id("p"), "type": "block", "size": {"weight": weight},
            "content": {"mod": MOD, "props": {"section": section, "space": space}}}


def room(tab, space):
    """The tab's tree with the floor above what it shows and the feed beside."""
    old = tab["root"]
    kids = old.get("children") or []
    # A lone pane goes in as itself; a split goes in whole, under a new id (the root
    # keeps the tab's id).
    if len(kids) == 1:
        prompt = dict(kids[0])
    else:
        prompt = {**old, "id": new_id("c")}
    prompt["size"] = {"weight": 3}
    return {"id": tab["id"], "type": "row", "children": [
        {"id": new_id("c"), "type": "column", "size": {"weight": 7},
         "children": [mod_block("floor", space, 7), prompt]},
        mod_block("feed", space, 3),
    ]}


def strip(node):
    """The node without factory panes; None when nothing is left."""
    if is_factory(node):
        return None
    if node.get("type") == "block":
        return node
    kids = [k for k in (strip(c) for c in node.get("children") or []) if k is not None]
    if not kids:
        return None
    if len(kids) == 1:
        only = dict(kids[0])
        if "size" in node:
            only["size"] = node["size"]
        else:
            only.pop("size", None)
        return only
    return {**node, "children": kids}


def unroom(tab):
    """The tab's tree without factory panes, its root a row or column with the tab's id.
    None when only factory panes were in it."""
    kept = strip(tab["root"])
    if kept is None:
        return None
    if kept.get("type") == "block":
        kept = dict(kept)
        kept.pop("size", None)
        return {"id": tab["id"], "type": "row", "children": [kept]}
    kids = [dict(k) for k in kept["children"]]
    return {"id": tab["id"], "type": kept["type"], "children": kids}


def main():
    ap = argparse.ArgumentParser(description="Put the factory control room into a Herdr space, or take it out.")
    ap.add_argument("--space", required=True)
    which = ap.add_mutually_exclusive_group(required=True)
    which.add_argument("--on", action="store_true")
    which.add_argument("--off", action="store_true")
    ap.add_argument("--on-machine", default=None)
    a = ap.parse_args()
    machine = a.on_machine
    space_id = a.space.split("/")[-1]
    shell = None  # a shell started for a tab that held only factory panes
    try:
        for _ in range(6):
            got, error = rpc("doc.get", {"name": DOC}, machine)
            if error:
                raise Failed(f"Couldn't read the layout: {error.get('message')}")
            doc, version = got.get("value"), got.get("version")
            space = next((s for s in doc.get("spaces") or [] if s.get("id") == space_id), None)
            if not space or not space.get("tabs"):
                raise Failed("That space isn't there.")
            changed = False
            if a.on:
                if any(has_factory(t["root"]) for t in space["tabs"]):
                    print(json.dumps({"ok": True, "space": space_id, "changed": False}))
                    return
                space["tabs"][0]["root"] = room(space["tabs"][0], a.space)
                changed = True
            else:
                tabs = []
                for t in space["tabs"]:
                    if not has_factory(t["root"]):
                        tabs.append(t)
                        continue
                    changed = True
                    root = unroom(t)
                    if root is not None:
                        tabs.append({**t, "root": root})
                if not tabs:
                    if shell is None:
                        run = ["hc", "run", "--json", "--bg", "--keep", "--no-parent", "--outlive-parent", "--no-notify"]
                        if machine:
                            run += ["--on", machine]
                        if space.get("folder"):
                            run += ["--cwd", space["folder"]]
                        started = subprocess.run(run, capture_output=True, text=True, timeout=20)
                        if started.returncode != 0:
                            raise Failed(f"hc run: {started.stderr.strip()}")
                        shell = {"address": json.loads(started.stdout)["address"].split("/")[-1],
                                 "tab": new_id("tb"), "pane": new_id("p")}
                    block = {"content": {"terminal": shell["address"]}, "id": shell["pane"], "type": "block"}
                    tabs = [{"id": shell["tab"], "name": "", "root": {"children": [block], "id": shell["tab"], "type": "row"}}]
                space["tabs"] = tabs
                if not changed:
                    print(json.dumps({"ok": True, "space": space_id, "changed": False}))
                    return
            _, error = rpc("doc.set", {"name": DOC, "value": doc, "version": version}, machine)
            if not error:
                break
            if (error.get("data") or {}).get("kind") != "conflict":
                raise Failed(f"Couldn't save the layout: {error.get('message')}")
            time.sleep(0.15)
        else:
            raise Failed("The layout kept changing; nothing changed.")
        if shell:
            address = f"{machine}/{shell['address']}" if machine else shell["address"]
            subprocess.run(["hc", "label", address, f"herdr.space={space_id}", f"herdr.tab={shell['tab']}"],
                           capture_output=True, text=True, timeout=20)
        print(json.dumps({"ok": True, "space": space_id, "changed": True}))
    except Failed as e:
        if shell:
            subprocess.run(["hc", "kill", shell["address"]], capture_output=True, text=True, timeout=20)
        print(json.dumps({"ok": False, "error": str(e)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
