// The tab bar (cloned from `tabs`), with drag-to-reorder that shows itself: the tab
// lifts out and follows the pointer left and right, its place fades, and the tab it
// would land on is tinted with a line on the landing edge (right of it when moving
// right, left of it when moving left: tab.move). Dragged out of the bar, it goes on
// to the Spaces list (shared "space.drag", see spaces-flat): let go on a space and the
// tab moves there. Right-click a tab for its menu (space-menu: with "Move to").

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A tab's title, the same rule as the agents sidebar (mods/agents-spaces): a tab nobody
// named shows its agent's own title (what the program set), not its place number. Keep
// clean/leadPanes/title the same in both mods, so the bar and the sidebar agree.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

export default class Tabs extends View {
  init() {
    // A drag: the tab pressed, the one under the pointer, where it was grabbed, and
    // once the pointer has moved a few px, `dragging` with where the lifted tab is.
    this.pressed = null;
    this.over = null;
    this.dragging = false;
    this.grab = null;
    this.lift = null;
    // The trackpad swipe in progress: its vertical distance, whether it already switched
    // a tab, and when its last event came.
    this.swipe = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // Where on the tab it was grabbed (window coordinates, as Solitaire does), so the
  // lifted tab keeps that spot under the pointer.
  grabAt(e) {
    const b = e.bounds;
    this.dragging = false;
    this.lift = null;
    this.grab = { x: e.position.x, dx: b ? e.position.x - b.x : 20, y: b ? b.y : null, w: b ? b.width : null, h: b ? b.height : 29 };
  }

  endDrag() {
    this.pressed = null;
    this.over = null;
    this.dragging = false;
    this.grab = null;
    this.lift = null;
  }

  // The lifted tab: `content` (no handlers, so it takes no hitbox and the tabs under
  // it still get the pointer), following the pointer along the bar.
  lifted(t, content) {
    return h_flex().absolute().left(this.lift.left).top(this.lift.top)
      .when(this.grab.w != null, (el) => el.w(this.grab.w))
      .h(this.grab.h).px(10).items_center()
      .rounded(7).bg(t.raised ?? t.selected).border_1().border_color(t.accent).shadow_lg()
      .child(content);
  }

  // Where a drop lands: a dot and a line on the target tab's edge, inside its padding
  // so the next tab can't paint over it.
  marker(t, after) {
    return v_flex().absolute().top(3).bottom(3).w(6).items_center()
      .when(after, (l) => l.right(2))
      .when(!after, (l) => l.left(2))
      .child(div().size(6).flex_none().rounded(3).bg(t.accent))
      .child(div().flex_1().w(2).rounded(1).bg(t.accent));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const fromIndex = shown.findIndex(x => x.id === this.pressed);
    // The lifted tab's content, built by the tab being dragged.
    let ghost = null;
    const leads = leadPanes(panes());
    // What a tab dragged out of the bar takes along to the Spaces list.
    this.dragInfo = new Map();
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const auto = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const name = title({ ...c, name: auto }, leads.get(c.id));
      const lifting = this.dragging && this.pressed === c.id;
      const landing = this.dragging && this.pressed !== null && this.over === c.id && this.pressed !== c.id;
      // What a tab shows: its program's icon, its name and its state. No controls, so
      // the lifted copy built from it takes no hitbox.
      const face = (el) => el
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])));
      if (lifting) ghost = face(h_flex().gap(7).items_center().text_size(12.8).text_color(t.foreground));
      this.dragInfo.set(c.id, { kind: "tab", tab: c.id, space: space.id, machine: space.machine ?? null, name, icon: program?.icon ?? null, tint: Boolean(program?.tint) });
      return face(h_flex().id(`tab-${c.id}`).relative().h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .when(!this.dragging, el => el.hover(s => s.bg(t.hover)))
        .when(this.dragging, el => el.cursor_grabbing())
        .when(landing, el => el.bg(t.accent + "1f"))
        .when(lifting, el => el.opacity(0.25))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = c.id;
          this.over = c.id;
          this.grabAt(e);
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .on_mouse_move((_e, cx) => {
          if (this.pressed === null || this.over === c.id) return;
          this.over = c.id;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed, moved = this.dragging;
          this.endDrag();
          if (from !== null && from !== c.id) run("tab.move", { id: from, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else if (!moved) run("tab.select", { id: c.id });
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "space-menu", kind: "popup", width: 200, height: 170, props: { tab: "tab", target: { id: c.id, space: space.id, name } } }); }))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))))
        .when(landing, el => el.child(this.marker(t, fromIndex < i)));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // History (mod agent-history) is not one of the welcome screen's panels: it
    // shows when this layout's panel stack has a "history" block.
    const hasHistory = (body?.children ?? []).some(c => c.id === "history");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), ...(hasHistory ? ["history"] : [])];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const tabs = shown.map(item);
    return h_flex().id("tabs-root").relative().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(this.dragging, el => el.cursor_grabbing())
      // A drag starts once the pointer has moved a few px from the press; from then on
      // the tab follows it along the bar, kept inside the bar.
      .on_mouse_move((e, cx) => {
        if (this.pressed === null || !this.grab) return;
        if (!this.dragging && Math.abs(e.position.x - this.grab.x) < 4) return;
        this.dragging = true;
        const b = e.bounds;
        const left = e.position.x - (b?.x ?? 0) - this.grab.dx;
        this.lift = {
          left: Math.max(0, Math.min(left, (b?.width ?? Infinity) - (this.grab.w ?? 0))),
          top: this.grab.y !== null && b ? this.grab.y - b.y : 6,
        };
        cx.notify();
      })
      // Dragged out of the bar: the drag goes on to the Spaces list, which moves the tab
      // to the space it is let go on (or nothing, let go anywhere else).
      .on_hover((on, cx) => {
        if (on || this.pressed === null) return;
        const what = this.dragInfo?.get(this.pressed);
        if (what) setShared("space.drag", { ...what, source: "tabs", at: Date.now() });
        this.endDrag();
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        // Brought back and let go here: not moved.
        if (shared("space.drag")?.source === "tabs") setShared("space.drag", null);
        if (this.pressed === null) return;
        this.endDrag();
        cx.notify();
      })
      // Sideways scrolling only scrolls the tab strip. Up and down switch tabs: one tab per
      // mouse wheel notch, one per trackpad swipe. A swipe sends many small events (and
      // momentum after it), so switching on each one jumped through the tabs.
      .on_scroll_wheel(e => {
        const now = Date.now();
        if (e.touch_phase === "started" || !this.swipe || now - this.swipe.at > 300) this.swipe = { y: 0, done: false, at: now };
        this.swipe.at = now;
        if (Math.abs(e.delta.y) <= Math.abs(e.delta.x)) return;
        const notch = Math.sign(e.delta_lines?.y ?? 0);
        if (notch !== 0) { run(notch > 0 ? "tab.prev" : "tab.next"); return; }
        if (this.swipe.done) return;
        this.swipe.y += e.delta.y;
        if (Math.abs(this.swipe.y) < 40) return;
        this.swipe.done = true;
        run(this.swipe.y > 0 ? "tab.prev" : "tab.next");
      })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(tabs))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("history"), el => el.child(panelButton("history", "History", "mods/agent-history/history.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-drag/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-drag/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-drag/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))))
      .when(Boolean(ghost) && Boolean(this.lift), el => el.child(this.lifted(t, ghost)));
  }
}
