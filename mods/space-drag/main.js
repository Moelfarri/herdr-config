// The drag layer: while a tab (tabs-drag) or an agent (agents-spaces) is dragged out of
// its list, its card follows the pointer over the whole window, and the space it would
// land on in the Spaces list lights up. Let go on another space of the same machine and
// it moves there (bin/move-to-space.py: a tab whole, an agent's pane, or its tab when it
// is alone); anywhere else, nothing moves. Esc, or a press (the release was missed, let
// go outside the window), cancels.
//
// The source opens it as a window overlay over the whole window, without a frame, and
// sets shared "space.drag" to what is dragged (its row fades; the Spaces list says
// "Drop on a space"):
//   openOverlay({ mod: "space-drag", kind: "window", frame: "none", width: 1, height: 1,
//     at: { x: 0, y: 0 }, props: { what, grab: { dx, dy, w, h }, at, before } })
// what: { kind: "tab" | "agent", tab, pane, terminal, space, machine, name, icon, tint }.
// grab: where on its row it was grabbed and the row's size; at: the pointer (window
// coordinates); before: { terminal, pane } that had the keyboard, given back after.
// A layer over everything can't ask the rows under it, so the Spaces list publishes
// where they are: shared "space.targets" { viewport, rows: [{ id, name, machine, x, y,
// w, h }] } (window coordinates, see spaces-flat).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, run, exec, appHome, notify } from "herdr";

// Moves a tab ({ tab }) or an agent's pane ({ pane }) to space `to`, and says how it
// went in a toast (clicked: shows that space). Keep the same in space-menu.
async function moveToSpace(what, to) {
  const bare = (id) => String(id).split("/").pop();
  const args = [`${appHome()}/bin/move-to-space.py`, "--to", bare(to.id),
    what.tab ? "--tab" : "--pane", bare(what.tab ?? what.pane)];
  if (to.machine) args.push("--on", to.machine);
  let out = null;
  try {
    const r = await exec("python3", args, { timeout: 30000 });
    try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { out = { ok: false, error: (r.stderr || r.stdout).trim() || `exit ${r.code}` }; }
  } catch (e) {
    out = { ok: false, error: String(e) };
  }
  if (out.ok) notify({ title: `Moved to ${to.name}`, body: what.name || undefined, level: "success", timeout: 4000, action: { name: "space.select", args: { id: to.id } } });
  else notify({ title: `Couldn't move it to ${to.name}`, body: out.error, level: "error" });
  return out.ok;
}

export default class SpaceDrag extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.what = p.what ?? null;
    this.grab = { dx: 20, dy: 15, w: 220, h: 30, ...(p.grab ?? {}) };
    // The pointer and this layer's top left, in window coordinates.
    this.at = p.at ?? null;
    this.origin = { x: 0, y: 0 };
    // The space a move is going to, while it goes.
    this.moving = null;
    this.done = false;
    this.before = p.before ?? null;
    // The keyboard, so Esc cancels here and never reaches the agent in the terminal.
    // Not a drag layer (no `what`: docked somewhere by mistake): nothing at all.
    this.handle = cx.focus_handle();
    if (this.what) this.handle.focus();
    else this.done = true;
  }

  // Gives the keyboard back to the terminal (or pane) that had it.
  giveBackKeys() {
    const b = this.before;
    this.before = null;
    if (b?.terminal) run("pane.focus", { terminal: b.terminal });
    else if (b?.pane) run("pane.focus", { pane: b.pane });
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.giveBackKeys();
    if (shared("space.drag")) setShared("space.drag", null);
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  async close() {
    if (this.what && shared("space.drag")) setShared("space.drag", null);
  }

  // The space row under window point `at` (inside the list's visible part), or null.
  // `lands`: it is another space on the same machine.
  hit(at) {
    if (!at) return null;
    const targets = shared("space.targets") ?? {};
    const v = targets.viewport;
    if (v && (at.x < v.x || at.x > v.x + v.w || at.y < v.y || at.y > v.y + v.h)) return null;
    const r = (targets.rows ?? []).find((r) => at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h);
    if (!r) return null;
    const lands = (r.machine ?? null) === (this.what?.machine ?? null) && r.id !== this.what?.space;
    return { ...r, lands };
  }

  drop(cx) {
    if (this.done || this.moving) return;
    const r = this.hit(this.at);
    if (!r?.lands) return this.finish();
    // The card settles on the space while the move goes; the keys go back first, while
    // what had them is still in this space.
    this.moving = r;
    this.giveBackKeys();
    cx.notify();
    cx.spawn(async () => {
      await moveToSpace(this.what.kind === "tab" ? { tab: this.what.tab, name: this.what.name } : { pane: this.what.pane, name: this.what.name },
        { id: r.id, name: r.name, machine: r.machine ?? null });
      this.finish();
    });
  }

  // A row of the Spaces list, lit: where it lands, or where it is now.
  ring(t, r, o) {
    const v = (shared("space.targets") ?? {}).viewport;
    const top = v ? Math.max(r.y, v.y) : r.y;
    const bottom = v ? Math.min(r.y + r.h, v.y + v.h) : r.y + r.h;
    if (bottom - top < 6) return null;
    const label = r.lands ? "Move here" : "here now";
    return h_flex().absolute().left(r.x - o.x).top(top - o.y).w(r.w).h(bottom - top)
      .rounded(8).border_1().border_color(r.lands ? t.accent : t.border).bg(r.lands ? t.accent + "2e" : t.foreground + "0d")
      .items_center().justify_end().pr(6)
      .when(r.w >= 90, (el) => el.child(h_flex().h(18).px(7).gap(5).rounded(6).items_center().bg(r.lands ? t.accent : t.chrome)
        .text_size(11).font_semibold().text_color(r.lands ? (t.accent_foreground ?? t.background) : t.dim)
        .when(Boolean(this.moving), (p) => p.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().spin(900)))
        .child(label)));
  }

  card(t, r, o) {
    const w = Math.max(150, Math.min(this.grab.w ?? 220, 280));
    const h = this.grab.h ?? 30;
    // Kept where it was grabbed, under the pointer; on a space while moving there.
    const left = this.moving ? this.moving.x - o.x : this.at.x - o.x - Math.min(this.grab.dx ?? 20, w - 24);
    const top = this.moving ? this.moving.y - o.y : this.at.y - o.y - Math.min(this.grab.dy ?? 15, h - 6);
    const d = this.what;
    return h_flex().id("card").absolute().left(left).top(top).w(this.moving ? this.moving.w : w).h(h)
      .when(Boolean(this.moving), (el) => el.transition("left", { duration: 140, easing: "ease-out" }).transition("top", { duration: 140, easing: "ease-out" }).opacity(0.85))
      .px(8).gap(9).items_center().rounded(8)
      .bg(t.raised ?? t.selected).border_1().border_color(r?.lands ? t.accent : t.input ?? t.border).shadow_lg()
      .text_size(13).text_color(t.foreground)
      .when(Boolean(d.icon), (el) => el.child(d.tint ? svg(d.icon).size(16).flex_none().text_color(t.muted) : image(d.icon).size(16).flex_none()))
      .child(div().flex_1().min_w(0).truncate().child(d.name || (d.kind === "tab" ? "Tab" : "Agent")))
      .when(Boolean(r?.lands) && !this.moving, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(`→ ${r.name}`)));
  }

  render() {
    if (!this.what) return div();
    const t = theme();
    const o = this.origin;
    const r = this.moving ?? this.hit(this.at);
    const ring = r ? this.ring(t, r, o) : null;
    return div()
      .id("space-drag")
      .relative()
      .size_full()
      .track_focus(this.handle)
      .cursor_grabbing()
      .on_key_down((e) => { if (e.key === "escape" && !this.moving) this.finish(); })
      .on_mouse_move((e, cx) => {
        if (e.bounds) this.origin = { x: e.bounds.x, y: e.bounds.y };
        if (this.moving) return;
        this.at = e.position;
        cx.notify();
      })
      .on_mouse_up("left", (e, cx) => {
        if (!this.moving) this.at = e.position;
        this.drop(cx);
      })
      // A press while this is up: the release was missed (let go outside the window).
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!this.moving) this.finish(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (!this.moving) this.finish(); })
      .when(Boolean(ring), (el) => el.child(ring))
      .when(Boolean(this.what && this.at), (el) => el.child(this.card(t, r, o)));
  }
}
