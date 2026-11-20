// The Spaces list's menus (cloned from the shipped `menu`). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "space-theme" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args, look?];
// a command "worktree" opens the worktree dialog instead.
//
// A space's menu has "Theme...", which opens its theme list (tab "space-theme"):
// - Standard: the theme every space starts with (shared "space.themes".default).
//   Choosing it drops the space's own theme, so it is always one click back.
// - Custom: the themes made for spaces, `themes/custom-<name>.json`, kept apart from
//   Herdr's own so Standard is never changed by them.
// - Herdr: Herdr's themes (the presets and other themes/ files).
// Only themes for the appearance shown now (light or dark) are listed. The choice goes to
// shared "space.themes".spaces[<space id>]; the Spaces list shows it when that space is.
//
// A tab whose agent opened a pull request carries it as labels on its terminals (the tab
// bar draws the badge, bin/pr-tabs.py writes them): its menu then has "Clear PR", which
// takes the labels off, for a tab that only read somebody else's pull request. The sweep
// leaves that tab alone from then on (`pr.off`); a pull request the session opens itself
// brings the badge back.
//
// A tab's menu has "Move to", and so has an agent's (the agents-spaces menu opens this
// one): a submenu beside it (tab "move-to", target { tab | pane, space, name }, parent:
// the menu's overlay) lists the spaces on the same machine; choosing one moves the tab,
// or the agent's pane, there (bin/move-to-space.py; the Spaces list's drop does the
// same). The view stays where it is; the toast goes there when clicked.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, themes, settings, layouts, shared, setShared, keys, terminals, spaces, panes, exec, appHome, notify } from "herdr";

// Themes made for spaces carry this prefix: that's their category.
const CUSTOM = "custom-";

// The theme that brings the factory control room (the `factory` mod's panes) into a
// space: choosing it puts them in, choosing another takes them out (bin/factory-room.py).
const FACTORY_THEME = "custom-factory";
const isFactory = (th) => th?.light === FACTORY_THEME || th?.dark === FACTORY_THEME;
function factoryRoom(spaceId, on) {
  const s = spaces().find((x) => x.id === spaceId);
  const args = ["-I", `${appHome()}/bin/factory-room.py`, "--space", String(spaceId).split("/").pop(), on ? "--on" : "--off",
    ...(s?.machine ? ["--on-machine", s.machine] : [])];
  const fail = (body) => notify({ title: on ? "Couldn't build the factory room" : "Couldn't take the factory room out", body, level: "error" });
  exec("python3", args)
    .then((r) => { if (r.code !== 0) fail((r.stdout || r.stderr).trim().slice(0, 200)); })
    .catch((e) => fail(String(e)));
}

// "custom-warm-sand" reads "Warm sand"; "atom-one-dark" reads "Atom one dark".
function pretty(name) {
  const s = (name.startsWith(CUSTOM) ? name.slice(CUSTOM.length) : name).replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A space's avatar color, as the Spaces list draws it (spaces-flat's MARK).
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function avatarColor(t, id) {
  const c = (shared("space.colors") ?? {})[id] ?? "ansi6";
  return c.startsWith("#") ? c : (MARK[c] ?? t[c] ?? t.accent);
}

// Moves a tab ({ tab }) or an agent's pane ({ pane }) to space `to`, and says how it
// went in a toast (clicked: shows that space). Keep the same in spaces-flat.
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

// The spaces a tab or an agent can move to: every space on its machine, the one it is
// in marked (and not a choice).
function moveItems(tg) {
  const all = spaces();
  const from = all.find((s) => s.id === tg.space);
  const machine = from?.machine ?? null;
  return all.filter((s) => (s.machine ?? null) === machine)
    .map((s) => [s.name, "space.move-to", { to: s.id }, { space: s, on: s.id === tg.space }]);
}

// The theme every space starts with, both halves.
function standardTheme() {
  const s = settings() ?? {};
  return (shared("space.themes") ?? {}).default ?? { light: s.theme_light ?? null, dark: s.theme_dark ?? null };
}
const sameTheme = (a, b) => a?.light === b?.light && a?.dark === b?.dark;

// A space's theme list: Standard, then Custom, then Herdr's, for the shown appearance.
function themeItems(spaceId) {
  const half = settings()?.dark ? "dark" : "light";
  const std = standardTheme();
  const own = (shared("space.themes") ?? {}).spaces?.[spaceId] ?? null;
  const standard = !own || sameTheme(own, std);
  const current = (own ?? std)[half];
  const all = themes().filter((x) => Boolean(x.light) === (half === "light") && !layouts().includes(x.name));
  const custom = all.filter((x) => x.name.startsWith(CUSTOM));
  const herdr = all.filter((x) => !x.name.startsWith(CUSTOM) && x.name !== std[half]);
  const swatch = (name) => all.find((x) => x.name === name)?.colors ?? null;
  const item = (x, i, section) => [pretty(x.name), "space.theme", { space: spaceId, name: x.name },
    { on: !standard && current === x.name, colors: x.colors, section: i === 0 ? section : null }];
  return [
    ["Standard", "space.theme", { space: spaceId, name: null }, { on: standard, colors: swatch(std[half]), section: "Theme" }],
    ...custom.map((x, i) => item(x, i, "Custom")),
    ...herdr.map((x, i) => item(x, i, "Herdr")),
  ];
}

// Gives a space a theme (null: Standard again). Only the half for that theme's
// lightness changes; the other stays as the space had it.
function setSpaceTheme(spaceId, name) {
  const stored = shared("space.themes") ?? {};
  const std = standardTheme();
  const own = { ...(stored.spaces ?? {}) };
  const before = own[spaceId] ?? std;
  if (name == null) delete own[spaceId];
  else {
    const light = Boolean(themes().find((x) => x.name === name)?.light);
    const next = { ...(own[spaceId] ?? std), [light ? "light" : "dark"]: name };
    if (sameTheme(next, std)) delete own[spaceId];
    else own[spaceId] = next;
  }
  setShared("space.themes", { ...stored, default: std, spaces: own });
  const after = own[spaceId] ?? std;
  if (isFactory(after) !== isFactory(before)) factoryRoom(spaceId, isFactory(after));
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// The terminals in a tab that carry a pull request (the tab bar's badge).
function prTerminals(tab) {
  const bare = (id) => String(id ?? "").split("/").pop();
  return terminals().filter((t) => t.labels?.pr && bare(t.labels["herdr.tab"]) === bare(tab));
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Move to", "space.move-to.menu", { tab: tg.id, space: tg.space }],
        ...(prTerminals(tg.id).length ? [["Clear PR", "tab.pr.clear", { id: tg.id }]] : []),
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "move-to":
      return moveItems(tg);
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Theme...", "space.theme.menu", { space: tg.id }],
        ["Close", "space.close", { id: tg.id }],
      ];
    case "space-theme":
      return themeItems(tg.id);
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command === "tab.pr.clear" ? "minus" : command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" || command === "space.theme.menu" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : command === "space.move-to.menu" ? "layers" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    // Where each row is (window coordinates, from its press), so a submenu opens beside it.
    this.rows = {};
    // The space a move is going to, while it goes.
    this.moving = null;
    const first = props();
    // The move list starts on the first space it can move to.
    if (first?.tab === "move-to") this.at = Math.max(0, moveItems(first.target ?? {}).findIndex((it) => !it[3]?.on));
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  // "Move to": the space list, opened beside this menu (which stays until a space is
  // chosen). `row`: the row's bounds; from the keyboard, at the pointer.
  openMoveTo(what, row) {
    const n = moveItems({ space: what.space }).length;
    const height = 10 + 27 + n * 31;
    openOverlay({ mod: "space-menu", kind: "popup", width: 230, height: Math.min(height, 460),
      ...(row ? { at: { x: row.x + row.width + 10, y: Math.max(8, row.y - 5 - 27) } } : {}),
      props: { tab: "move-to", target: what, parent: props()?.overlay } });
  }

  choose(i, cx) {
    const p = props();
    const it = items(p, this.git)[i];
    if (!it) return;
    if (it[1] === "space.move-to.menu") {
      this.openMoveTo({ ...it[2], name: p?.target?.name }, this.rows[i]);
      return;
    }
    if (it[1] === "space.move-to") {
      const to = it[3]?.space;
      if (!to || it[3].on || this.moving) return;
      this.moving = to.id;
      cx.notify();
      cx.spawn(async () => {
        await moveToSpace(p.target ?? {}, to);
        if (p.parent) closeOverlay(p.parent);
        closeOverlay(p.overlay);
      });
      return;
    }
    closeOverlay(props()?.overlay);
    // Not Herdr's command, but labels on the tab's terminals.
    if (it[1] === "tab.pr.clear") {
      for (const term of prTerminals(it[2].id)) {
        exec("hc", ["label", term.address, "pr=", "pr.url=", "pr.state=", "pr.checked=", "pr.off=1"]).catch((e) => console.log(`clear pr: ${e}`));
      }
      return;
    }
    if (it[1] === "space.theme") setSpaceTheme(it[2].space, it[2].name);
    else if (it[1] === "space.theme.menu") {
      // As tall as its rows and section titles; height is only the most.
      const rows = themeItems(it[2].space);
      const height = 10 + rows.length * 31 + rows.filter((r) => r[3]?.section).length * 30;
      openOverlay({ mod: "space-menu", kind: "popup", width: 220, height: Math.min(height, 520), props: { tab: "space-theme", target: { id: it[2].space } } });
    } else if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "right" && list[this.at]?.[1] === "space.move-to.menu") this.choose(this.at, cx);
        else if (e.key === "escape" || (e.key === "left" && props()?.tab === "move-to")) closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      // The move list says what it is; with nowhere to go, says so.
      .when(props()?.tab === "move-to", (el) => el.child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Move to")))
      .when(props()?.tab === "move-to" && !list.some((it) => !it[3]?.on), (el) => el.child(div().px(8).h(31).flex().items_center().text_color(t.dim).child("No other space on this machine")))
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme") || Boolean(it[3]?.section)), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            // A theme list's category title (Theme, Custom, Herdr).
            .when(Boolean(it[3]?.section), el => el.child(div().px(8).pt(4).pb(4).text_size(11).text_color(t.dim).child(it[3].section)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .when(!it[3]?.space || !it[3].on, (el) => el.hover((s) => s.bg(t.hover)))
            .when(Boolean(it[3]?.space?.id) && it[3].on, (el) => el.text_color(t.dim))
            .on_mouse_down("left", (e) => { if (e.bounds) this.rows[i] = e.bounds; })
            .on_click((_e, cx) => this.choose(i, cx))
            // A theme shows a swatch of itself (its background and accent), and a check when chosen.
            .when(!it[3], el => el.child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted)))
            // A space to move to: its avatar, as the Spaces list draws it.
            .when(Boolean(it[3]?.space), el => el.child(h_flex().size(16).flex_none().rounded(4).bg(avatarColor(t, it[3].space.id))
              .when(it[3].on, (a) => a.opacity(0.5)).items_center().justify_center().text_size(9.5).font_bold().text_color("#ffffff")
              .child([...it[3].space.name][0]?.toUpperCase() ?? "?")))
            .when(Boolean(it[3]) && !it[3].space, el => el.child(div().size(14).flex_none().rounded(4).border_1().border_color(t.border)
              .bg(it[3].colors?.background ?? t.surface).flex().items_center().justify_center()
              .child(div().size(6).rounded(3).bg(it[3].colors?.accent ?? t.accent))))
            .child(div().flex_1().min_w(0).truncate().child(it[0]))
            .when(!it[3] && it[1] !== "space.move-to.menu", el => el.child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))))
            .when(it[1] === "space.move-to.menu", el => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(13).flex_none().text_color(t.dim)))
            .when(Boolean(it[3]?.space) && it[3].on, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("here now")))
            .when(Boolean(it[3]?.space) && this.moving === it[3].space.id, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900)))
            .when(Boolean(it[3]?.on) && !it[3].space, el => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))),
        ),
      );
  }
}
