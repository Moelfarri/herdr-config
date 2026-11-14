#!/usr/bin/env python3
"""Move a tab, or one pane of a tab, to another Herdr space.

Herdr has no command for this, so it edits the layout document every Herdr
window shares (herdr-core's "herdr-app" document, read and written with
`hc connect`, version-checked so a change made at the same moment is never
lost), then labels the moved terminals with their new space.

    move-to-space.py --to <space id> --tab <tab id>    [--on <machine>]
    move-to-space.py --to <space id> --pane <pane id>  [--on <machine>]

--tab moves the whole tab (every pane in it). --pane moves one pane: alone in
its tab, the tab goes with it; split with others, it leaves the split and
becomes a new tab in the other space. Ids are as the machine knows them
(without a `machine/` prefix); --on names the machine for spaces elsewhere.
Both spaces must be on that one machine.

When the last tab leaves a space: a space someone named keeps going with a
fresh shell in its folder, so its name, color and theme stay; a space nobody
named closes, as when its last tab is closed.

Prints one JSON line: {"ok": true, "space", "tab", "terminals", "kept"} or
{"ok": false, "error"} (and exits 1).

Used by the mods spaces-flat (drop on a space), space-menu (Move to) and
agents-spaces (the agent menu's Move to). Elias, 14 Nov 2026.
"""

import argparse
import json
import secrets
import subprocess
import sys
import time

DOC = "herdr-app"


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


def hc(args):
    out = subprocess.run(["hc", *args], capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise Failed(f"hc {args[0]}: {out.stderr.strip() or out.stdout.strip()}")
    return out.stdout


def new_id(prefix):
    return prefix + secrets.token_hex(16)


def terminals_in(node):
    found = []
    content = node.get("content") or {}
    if content.get("terminal"):
        found.append(content["terminal"])
    for child in node.get("children") or []:
        found.extend(terminals_in(child))
    return found


def holds(node, pane):
    return node.get("id") == pane or any(holds(c, pane) for c in node.get("children") or [])


def blocks(node):
    if node.get("type") == "block":
        return 1
    return sum(blocks(c) for c in node.get("children") or [])


def cut(node, pane):
    """Removes the block `pane` under `node` (a row or column). Returns the block.
    A row or column left with one child is replaced by it (keeping the row's
    share); one left empty goes."""
    kids = node.get("children") or []
    for i, child in enumerate(kids):
        if child.get("id") == pane and child.get("type") == "block":
            del kids[i]
            return child
        if child.get("type") in ("row", "column") and holds(child, pane):
            block = cut(child, pane)
            rest = child.get("children") or []
            if not rest:
                del kids[i]
            elif len(rest) == 1:
                only = rest[0]
                if "size" in child:
                    only["size"] = child["size"]
                else:
                    only.pop("size", None)
                kids[i] = only
            return block
    return None


def plan(doc, args):
    """Applies the move to `doc` in place. Returns (moved tab, its terminals,
    whether the tab is new, the source space if the move empties it)."""
    spaces = doc.get("spaces") or []
    dst = next((s for s in spaces if s.get("id") == args.to), None)
    if not dst:
        raise Failed("That space isn't there any more.")
    for src in spaces:
        for tab in src.get("tabs") or []:
            if args.tab and tab.get("id") != args.tab:
                continue
            if args.pane and not holds(tab.get("root") or {}, args.pane):
                continue
            if src is dst:
                raise Failed(f"It is in {dst.get('name') or 'that space'} already.")
            root = tab.get("root") or {}
            if args.tab or blocks(root) <= 1:
                src["tabs"].remove(tab)
                dst.setdefault("tabs", []).append(tab)
                return tab, terminals_in(root), False, src if not src["tabs"] else None
            # One pane out of a split: it becomes a tab of its own over there.
            block = cut(root, args.pane)
            kids = root.get("children") or []
            if len(kids) == 1 and kids[0].get("type") in ("row", "column"):
                inner = kids[0]
                root["type"] = inner["type"]
                root["children"] = inner.get("children") or []
            block.pop("size", None)
            tab_id = new_id("tb")
            moved = {"id": tab_id, "name": "", "root": {"children": [block], "id": tab_id, "type": "row"}}
            dst.setdefault("tabs", []).append(moved)
            return moved, terminals_in(block), True, None
    raise Failed("That tab isn't there any more.")


def addressed(address, on):
    return f"{on}/{address}" if on else address


def main():
    parser = argparse.ArgumentParser(description="Move a Herdr tab or pane to another space.")
    parser.add_argument("--to", required=True, help="the space to move to")
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--tab", help="move this whole tab")
    which.add_argument("--pane", help="move this pane (its tab when it is alone)")
    parser.add_argument("--on", default=None, help="the machine both spaces live on")
    args = parser.parse_args()

    kept = None  # a shell started to keep a named space: {address, tab, pane}
    for _ in range(6):
        got, error = rpc("doc.get", {"name": DOC}, args.on)
        if error:
            raise Failed(f"Couldn't read the layout: {error.get('message')}")
        doc, version = got.get("value"), got.get("version")
        if not isinstance(doc, dict):
            raise Failed("The layout isn't readable.")
        tab, moved, new_tab, emptied = plan(doc, args)
        if emptied is not None:
            if emptied.get("name"):
                # A named space keeps going: a shell in its folder, as a new tab.
                if kept is None:
                    run = ["run", "--json", "--bg", "--keep", "--no-parent", "--outlive-parent", "--no-notify"]
                    if args.on:
                        run += ["--on", args.on]
                    if emptied.get("folder"):
                        run += ["--cwd", emptied["folder"]]
                    started = json.loads(hc(run))
                    address = started["address"].split("/")[-1]
                    kept = {"address": address, "tab": new_id("tb"), "pane": new_id("p")}
                shell = {"content": {"terminal": kept["address"]}, "id": kept["pane"], "type": "block"}
                emptied["tabs"] = [{"id": kept["tab"], "name": "", "root": {"children": [shell], "id": kept["tab"], "type": "row"}}]
            else:
                doc["spaces"] = [s for s in doc["spaces"] if s is not emptied]
        _, error = rpc("doc.set", {"name": DOC, "value": doc, "version": version}, args.on)
        if not error:
            break
        if (error.get("data") or {}).get("kind") != "conflict":
            raise Failed(f"Couldn't save the layout: {error.get('message')}")
        time.sleep(0.15)  # changed meanwhile: read it again
    else:
        if kept:
            hc(["kill", addressed(kept["address"], args.on)])
        raise Failed("The layout kept changing; nothing was moved.")
    # A shell started for a space that, on a later read, didn't need it.
    if kept and not (emptied is not None and emptied.get("name")):
        hc(["kill", addressed(kept["address"], args.on)])
        kept = None

    # The labels say where each terminal belongs (and bring it back there if lost).
    for address in moved:
        pairs = [f"herdr.space={args.to}"] + ([f"herdr.tab={tab['id']}"] if new_tab else [])
        hc(["label", addressed(address, args.on), *pairs])
    if kept:
        hc(["label", addressed(kept["address"], args.on), f"herdr.space={emptied['id']}", f"herdr.tab={kept['tab']}"])

    print(json.dumps({"ok": True, "space": args.to, "tab": tab["id"], "terminals": moved, "kept": kept and kept["address"]}))


if __name__ == "__main__":
    try:
        main()
    except Failed as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
    except Exception as e:  # never a traceback in a toast
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
