// The selected space's agents, by state. The title reads "Agents - <space>" in the
// space's own color (the Spaces list's avatar color); under it, three states:
//
// - Needs your attention: blocked agents (a question, a permission prompt) and agents
//   that finished while you weren't looking. A finished one you look at stays until
//   you move on, rather than drop away under you.
// - Working: agents working, or with a sub-agent working.
// - Idle: the rest.
//
// A parent is as urgent as its most urgent sub-agent. Pinned agents go first in
// Working and Idle. Switch space (the Spaces list, keys) to see another space's agents.
// agent.next / agent.prev go through this space's list first, then the other spaces'.
// A theme can bring more than colors, while it shows:
// - `themes/art/<theme name>.svg` (optional): art (full color, faint by its own
//   opacities) behind the list, at the bottom right.
// - `themes/art/<theme name>.decor`: JSON { font, title, titles: {<space name>: text},
//   calligraphy, seal, seal_color, seal_text, states: {attention, working, idle} }:
//   the title bar becomes a title card (brush title, the space's own else `title`, over
//   "Agents - <space>"), a seal on it, a brush character before each state, and faint
//   vertical brush text (`calligraphy`) at the bottom left where the list leaves room.
//   Fonts go in ~/.config/herdr-app/fonts.
//   `sheen` (#rrggbb): a glassy tint rising from the bottom of the panel.
//   `sky: { place, lat, lon, update_minutes? }`: the live sky for that place (skysvg.js):
//   the real sun and moon, stars at night, the light of the hour and the weather now
//   from MET Norway (sky.js; fetched at most every 30 minutes, kept for the next
//   start). The panel's glass follows its light. `sky.preview: { at, symbol, cloud,
//   wind }` freezes a time (ISO) and a MET weather symbol to try a look.
//   `backdrop` (a picture with a transparent sky) and `terminal_opacity`: a picture
//   behind the terminal area, the live sky behind it (backdrop.js edits the shown
//   layout for it, and puts the person's own values back for other themes).
// - Drag an agent within Working or Idle to reorder: it moves the agent's tab (tab.move).
// - Drag an agent out of the list onto a space in the Spaces list to move it there
//   (shared "space.drag", see spaces-flat): its tab goes, or only its pane when it shares
//   the tab with other panes. Or right-click it > Move to (space-menu's space list).
// - Right-click an agent for priority and progress. Both live on the terminal as labels:
//   `prio` (high | medium | low), `progress` (reported by the agent, "3/7" or "40%")
//   and `progress.manual` (set here, a percent; wins over the agent's).
// Cloned from the shipped `agents` mod.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, settings, shared, setShared, setAgentOrder, window, layout, props, openOverlay, closeOverlay, hc, notify, appHome, readTextFile, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { panelWashes, fetchWeather, weatherAt } from "./sky.js";
import { skyState } from "./skysvg.js";
import { Backdrop } from "./backdrop.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

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

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const STATUS_OF = { 4: "blocked", 3: "done", 2: "working", 1: "idle" };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

// The states the list is split into, top to bottom.
const STATES = [
  { id: "attention", label: "Needs your attention" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
];

// The same space marks as the spaces sidebar, so the title reads as its space.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space's color exactly as the Spaces list draws its avatar (ansi6 until it has one).
function markOf(t, id) {
  const c = (shared("space.colors") ?? {})[id] ?? "ansi6";
  return c.startsWith("#") ? c : MARK[c] ?? t[c] ?? t.foreground;
}

const PRIORITY = {
  high: { label: "High", color: "#e5484d", order: 3 },
  medium: { label: "Medium", color: "#e8a23a", order: 2 },
  low: { label: "Low", color: "#5b8def", order: 1 },
};

// "3/7" or "40" / "40%" to { p: 0..1, text }; anything else is no progress.
function parseProgress(v) {
  if (v == null || v === "") return null;
  let m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v);
  if (m) {
    const d = Number(m[2]);
    return d > 0 ? { p: Math.min(1, Number(m[1]) / d), text: `${m[1]}/${m[2]}` } : null;
  }
  m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(v);
  if (m) {
    const n = Math.max(0, Math.min(100, Number(m[1])));
    return { p: n / 100, text: `${Math.round(n)}%` };
  }
  return null;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

// Sets labels on a terminal; says so when it can't.
function label(address, ...pairs) {
  hc(["label", address, ...pairs])
    .then((r) => { if (r.code !== 0) notify({ title: "Couldn't update the agent", body: r.stderr.trim(), level: "error" }); })
    .catch((e) => notify({ title: "Couldn't update the agent", body: String(e), level: "error" }));
}

// A control inside a row keeps its press: the row neither drags nor focuses.
const own = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export default class AgentsBySpace extends View {
  init(_props, cx) {
    if (props()?.menu) return;
    // Folded agents (their sub-agent trees) for this run; folded states for good.
    this.folded = new Set();
    this.foldedGroups = new Set(readJson("folded-groups", []).filter((id) => STATES.some((s) => s.id === id)));
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = readJson("changed", {});
    this.pendingPins = readJson("pins", []);
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    // A drag: the agent pressed and the one under the pointer.
    this.pressed = null;
    this.over = null;
    // Where its card was grabbed, and once the pointer has moved a few px,
    // `dragging` with where the lifted card is (`lift`, in this list's coordinates).
    this.dragging = false;
    this.grab = null;
    this.lift = null;
    // Theme name -> { art, decor } (see the top); looked for once per run.
    this.looks = {};
    // The sky's weather: { place: "lat,lon", at: ms, hours } (see sky.js), kept across
    // restarts; not asked for again before `weatherRetry` after a failure.
    this.weather = readJson("weather", null);
    this.weatherBusy = false;
    this.weatherRetry = 0;
    // The picture behind the terminal area (backdrop.js), with the host calls it needs.
    this.backdrop = new Backdrop({
      home: () => appHome(),
      layoutName: () => shared("layout"),
      store: localStorage,
      readText: (path) => readTextFile(path),
      writeText: (path, text, expected) => writeTextFile(path, text, expected),
      exists: (path) => fs.exists(path),
      mkdir: (path) => fs.mkdir(path, { recursive: true }),
      write: (path, text) => fs.writeFile(path, text),
      list: (dir) => fs.readdir(dir),
      remove: (path) => fs.unlink(path),
    });
    // Also moves the sky on.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // The forecast hour now for the decor's `sky`, or null (not fetched yet, too old).
  // Fetches again when the kept forecast is 30 minutes old, or 10 after a failure.
  weatherFor(sky, cx) {
    const key = `${sky.lat.toFixed(2)},${sky.lon.toFixed(2)}`;
    const w = this.weather?.place === key ? this.weather : null;
    const now = Date.now();
    if ((!w || now - w.at > 30 * 60000) && !this.weatherBusy && now >= this.weatherRetry) {
      this.weatherBusy = true;
      cx.spawn(async (cx) => {
        try {
          const hours = await fetchWeather(sky.lat, sky.lon);
          this.weather = { place: key, at: Date.now(), hours };
          localStorage.setItem("weather", JSON.stringify(this.weather));
        } catch (e) {
          console.log(`sky: no weather (${e})`);
          this.weatherRetry = Date.now() + 10 * 60000;
        }
        this.weatherBusy = false;
        cx.notify();
      });
    }
    return w ? weatherAt(w.hours, now) : null;
  }

  // The decor's sky now (or as `sky.preview` freezes it), as skysvg.js's rounded state,
  // or null when the theme has no sky.
  skyFor(decor, cx) {
    const sky = decor?.sky;
    if (!sky || !Number.isFinite(sky.lat) || !Number.isFinite(sky.lon)) return null;
    const p = sky.preview ?? null;
    const at = p?.at ? Date.parse(p.at) : NaN;
    const weather = p?.symbol || p?.cloud != null
      ? { cloud: p.cloud ?? 0, wind: p.wind ?? 2, symbol: p.symbol ?? null }
      : this.weatherFor(sky, cx);
    return skyState(Number.isFinite(at) ? at : Date.now(), sky, weather);
  }

  // What the shown theme brings beyond colors: { art: path for image() | null,
  // decor: object | null }, or null while it's being looked for.
  lookFor(cx) {
    const s = settings() ?? {};
    const name = s.dark ? s.theme_dark : s.theme_light;
    if (!name || !/^[\w-]+$/.test(name)) return null;
    if (!(name in this.looks)) {
      this.looks[name] = null;
      cx.spawn(async (cx) => {
        const base = `${appHome()}/themes/art/${name}`;
        const art = await readTextFile(`${base}.svg`).catch(() => null);
        const text = await readTextFile(`${base}.decor`).catch(() => null);
        let decor = null;
        try { decor = text ? JSON.parse(text) : null; } catch { decor = null; }
        this.looks[name] = { art: art ? `themes/art/${name}.svg` : null, decor };
        if (art || decor) cx.notify();
      });
    }
    return this.looks[name];
  }

  // Where on a card it was grabbed (window coordinates, as Solitaire does), so the
  // lifted card keeps that spot under the pointer. `can`: whether it may lift at all.
  grabAt(e, can) {
    const b = e.bounds;
    this.dragging = false;
    this.lift = null;
    this.grab = { can, y: e.position.y, dy: b ? e.position.y - b.y : 15, x: b ? b.x : null, w: b ? b.width : null, h: b ? b.height : 30 };
  }

  endDrag() {
    this.pressed = null;
    this.over = null;
    this.dragging = false;
    this.grab = null;
    this.lift = null;
  }

  // The lifted card: `content` (no handlers, so it takes no hitbox and the rows under
  // it still get the pointer), following the pointer up and down in the list's column.
  lifted(t, content) {
    const { top, left, width } = this.lift;
    return h_flex().absolute().top(top).left(left)
      .when(width != null, (el) => el.w(width))
      .when(width == null, (el) => el.right(14))
      .h(this.grab.h).px(8).items_center()
      .rounded(8).bg(t.raised ?? t.selected).border_1().border_color(t.accent).shadow_lg()
      .child(content);
  }

  // Where a drop lands: a dot and a line on the target's edge, inside it so the next
  // row can't paint over it. Moving down lands after the target, moving up before it.
  marker(t, below) {
    return h_flex().absolute().left(0).right(4).h(6).items_center()
      .when(below, (l) => l.bottom(0))
      .when(!below, (l) => l.top(0))
      .child(div().size(6).flex_none().rounded(3).bg(t.accent))
      .child(div().flex_1().h(2).rounded(1).bg(t.accent));
  }

  toggleGroup(id) {
    this.foldedGroups.has(id) ? this.foldedGroups.delete(id) : this.foldedGroups.add(id);
    localStorage.setItem("folded-groups", JSON.stringify([...this.foldedGroups]));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays under Needs your attention until
  // you leave it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, true));
  }

  // compact: a ! for blocked where a header already says so.
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return this.pill(t, t.blocked, "Needs input");
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // Needs your attention says why each agent is there: it asks something, or it finished.
  pill(t, color, text) {
    return div().flex_none().px(6).h(18).rounded(5).bg(color + "26").text_size(10.5).font_semibold().text_color(color).flex().items_center().child(text);
  }

  // The right-click menu: priority and progress, written as labels on the terminal.
  menu(t) {
    const { menu: address, overlay } = props();
    const labels = terminals().find((x) => x.address === address)?.labels ?? {};
    const prio = PRIORITY[labels.prio] ? labels.prio : null;
    const manual = labels["progress.manual"] ?? null;
    const reported = parseProgress(labels.progress);
    const done = (fn) => () => {
      fn();
      closeOverlay(overlay);
    };
    const check = () => svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground);
    const section = (s) => div().px(8).pt(6).pb(4).text_size(11).text_color(t.dim).child(s);
    const item = (id, text, dot, on, act, hint) => h_flex()
      .id(id)
      .h(29)
      .px(8)
      .gap(9)
      .rounded(7)
      .items_center()
      .text_color(t.foreground)
      .hover((el) => el.bg(t.hover))
      .on_click(done(act))
      .child(dot)
      .child(div().flex_1().truncate().child(text))
      .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .when(on, (el) => el.child(check()));
    const swatch = (color) => color
      ? div().size(9).flex_none().rounded(5).bg(color)
      : div().size(9).flex_none().rounded(5).border(1.5).border_color(t.dim);
    // Move to: the spaces this agent can go to, in a submenu beside this menu (space-menu),
    // which stays open until a space is chosen.
    const agent = agents().find((x) => x.address === address);
    const moveTo = h_flex()
      .id("move-to")
      .h(29)
      .px(8)
      .gap(9)
      .rounded(7)
      .items_center()
      .text_color(agent ? t.foreground : t.dim)
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("left", (e) => { this.moveRow = e.bounds ?? null; })
      .on_click(() => {
        if (!agent) return;
        const row = this.moveRow;
        const all = spaces();
        const machine = all.find((x) => x.id === agent.space)?.machine ?? null;
        const n = all.filter((x) => (x.machine ?? null) === machine).length;
        openOverlay({ mod: "space-menu", kind: "popup", width: 230, height: Math.min(10 + 27 + n * 31, 460),
          ...(row ? { at: { x: row.x + row.width + 10, y: Math.max(8, row.y - 5 - 27) } } : {}),
          props: { tab: "move-to", target: { pane: agent.pane, space: agent.space, name: props().name }, parent: overlay } });
      })
      .child(svg("mods/workspace-chrome/layers.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().child("Move to"))
      .child(svg("mods/workspace-chrome/chevron-right.svg").size(13).flex_none().text_color(t.dim));
    const chip = (v) => div()
      .id(`pg-${v}`)
      .flex_1()
      .h(26)
      .rounded(6)
      .flex()
      .items_center()
      .justify_center()
      .text_size(11.5)
      .text_color(t.foreground)
      .bg(manual === String(v) ? t.selected : t.raised)
      .hover((el) => el.bg(t.hover))
      .on_click(done(() => label(address, `progress.manual=${v}`)))
      .child(`${v}%`);
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(moveTo)
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(section("Priority"))
      .children(Object.entries(PRIORITY).map(([k, p]) =>
        item(`prio-${k}`, p.label, swatch(p.color), prio === k, () => label(address, `prio=${k}`))))
      .child(item("prio-none", "None", swatch(null), !prio, () => label(address, "prio=")))
      .child(section("Progress"))
      .child(h_flex().px(4).pb(4).gap(4).children([0, 25, 50, 75, 100].map(chip)))
      .child(item("pg-auto", "From the agent", svg("mods/workspace-chrome/clock.svg").size(12).flex_none().text_color(t.dim), manual == null,
        () => label(address, "progress.manual="), reported?.text ?? "none"))
      .child(item("pg-clear", "Clear progress", svg("mods/workspace-chrome/x.svg").size(12).flex_none().text_color(t.dim), false,
        () => label(address, "progress.manual=", "progress=")));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.menu(t);
    const collapsed = narrow();
    // The shown theme's art and decor (none on the rail), its sky, and the picture
    // behind the terminal area (once the decor is read; kept up on the rail too).
    const look = this.lookFor(cx);
    const sky = look ? this.skyFor(look.decor, cx) : null;
    if (look) this.backdrop.update((job) => cx.spawn(async () => { await job(); }), look.decor, sky);
    const art = collapsed ? null : look?.art ?? null;
    const decor = collapsed ? null : look?.decor ?? null;
    const brushFont = decor?.font ?? null;
    const glass = decor ? panelWashes(sky, decor.sheen) : [];
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const labelsOf = new Map(all.map((x) => [x.address, x.labels ?? {}]));
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    // A parent is as urgent as its most urgent sub-agent.
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address) || RANK.idle;
    const prioOf = (a) => PRIORITY[labelsOf.get(a.address)?.prio] ?? null;
    const progressOf = (a) => {
      const l = labelsOf.get(a.address) ?? {};
      return parseProgress(l["progress.manual"]) ?? parseProgress(l.progress);
    };

    // The selected space: only its agents are listed.
    const allSpaces = spaces();
    const currentId = focused()?.space ?? allSpaces.find((s) => s.active)?.id ?? null;
    const current = allSpaces.find((s) => s.id === currentId) ?? null;

    // A space's agents by state. Needs your attention: needs input before done, then
    // higher priority, then newest first. Working and Idle: pinned first, then as
    // Herdr lists them (tab order). Ties keep agents()'s order.
    const order = new Map(list.map((a, i) => [a.address, i]));
    const stateOf = (a) => {
      const r = rankOf(a);
      return r >= RANK.done ? "attention" : r === RANK.working ? "working" : "idle";
    };
    const byState = (members) => STATES.map((s) => {
      const m = members.filter((a) => stateOf(a) === s.id);
      const listOrder = (x, y) => order.get(x.address) - order.get(y.address);
      m.sort(s.id === "attention"
        ? (x, y) => rankOf(y) - rankOf(x) || (prioOf(y)?.order ?? 0) - (prioOf(x)?.order ?? 0) || this.since(y) - this.since(x) || y.seq - x.seq || listOrder(x, y)
        : (x, y) => Number(Boolean(y.pinned)) - Number(Boolean(x.pinned)) || listOrder(x, y));
      return { ...s, members: m };
    });
    const groups = byState(current ? list.filter((a) => a.space === current.id) : []);
    // A new agent needing you opens Needs your attention, even when it was folded.
    const needing = new Set(groups[0].members.map((a) => a.address));
    if (this.needing && [...needing].some((x) => !this.needing.has(x)) && this.foldedGroups.has("attention")) this.toggleGroup("attention");
    this.needing = needing;

    // agent.next / agent.prev: this space's list, then the other spaces' in the Spaces
    // list's order, so the keys still reach an agent elsewhere (and switch space to it).
    const ordered = groups.flatMap((g) => g.members);
    const others = allSpaces.filter((s) => s.id !== current?.id)
      .flatMap((s) => byState(list.filter((a) => a.space === s.id)).flatMap((g) => g.members));
    const known = new Set([...ordered, ...others].map((a) => a.address));
    setAgentOrder([...ordered, ...others, ...list.filter((a) => !known.has(a.address))].map((a) => a.address));

    // Where each agent sits in its state, for drag-and-drop (Working and Idle only).
    const tabsById = new Map(allSpaces.flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const placeOf = new Map();
    for (const g of groups) if (g.id !== "attention") g.members.forEach((a, i) => placeOf.set(a.address, { state: g.id, i, tab: a.tab }));
    const dragging = this.dragging && Boolean(this.pressed) && Boolean(this.over) && this.pressed !== this.over;
    // The lifted card's content, built by the row being dragged.
    let ghost = null;
    const moveTo = (from, to) => {
      const f = placeOf.get(from), d = placeOf.get(to);
      const target = tabsById.get(d?.tab);
      if (!f || !d || f.state !== d.state || f.tab === d.tab || !target) return;
      run("tab.move", { id: f.tab, index: target.index });
    };

    // A row reads its detail: a tab someone named or the agent's own title, never an
    // automatic tab number unless two rows would otherwise read the same.
    const leads = leadPanes(panes());
    const labels = new Map(list.map(a => {
      const tab = tabsById.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const nameOf = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(nameOf(a)) ? null : nameOf(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, nameOf(a));
    }

    const openMenu = (a, name) => openOverlay({ mod: "agents-spaces", kind: "popup", width: 230, height: 316, props: { menu: a.address, name } });
    // What an agent dragged out of the list takes along to the Spaces list.
    this.dragInfo = new Map();

    const row = (a, i, subs, kind) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      const prio = prioOf(a);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(prio?.color ?? t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, { status: STATUS_OF[rankOf(a)] ?? a.status }, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = own(div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top"))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // The space goes without saying: the title names it.
      const name = more ?? (/^\d+$/.test(nameOf(a)) ? a.program?.name || nameOf(a) : nameOf(a));
      const state = kind === "attention"
        ? (rankOf(a) === RANK.blocked ? this.pill(t, t.blocked, "Needs input") : this.pill(t, t.done, "Done"))
        : this.status(t, { status: STATUS_OF[rankOf(a)] ?? a.status });
      const progress = progressOf(a);
      const nameColor = prio ? prio.color : idle && kind !== "attention" ? t.muted : t.foreground;
      this.dragInfo.set(a.address, { kind: "agent", terminal: a.address, pane: a.pane, tab: a.tab, space: a.space,
        machine: allSpaces.find((s) => s.id === a.space)?.machine ?? null, name, icon: a.program?.icon ?? null, tint: Boolean(a.program?.tint) });

      const line = h_flex()
        .h(30)
        .flex_none()
        .items_center()
        .gap(9)
        .when(Boolean(pic), el => el.child(own(div().id(`agent-fold-${a.address}`))
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(200).truncate().text_color(nameColor).when(Boolean(prio), (el) => el.font_medium()).child(name)))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(state);

      const bar = progress && h_flex()
        .pl(25)
        .pb(7)
        .mt(-3)
        .gap(7)
        .items_center()
        .child(div().flex_1().h(4).rounded(2).bg(t.border)
          .child(div().h_full().w(`${Math.round(progress.p * 100)}%`).rounded(2).bg(progress.p >= 1 ? t.done : prio?.color ?? t.accent)))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(progress.text));

      // Drag within Working or Idle: the row lifts out and follows the pointer, its place
      // fades, and the row it would land on is tinted with a line on the landing edge.
      const draggable = kind !== "attention";
      const here = placeOf.get(a.address);
      const from = this.pressed && placeOf.get(this.pressed);
      const landing = Boolean(dragging && this.over === a.address && from && here && from.state === here.state);
      const lifting = this.dragging && this.pressed === a.address;
      if (lifting) {
        const lpic = icon(a.program, 16, t.foreground);
        ghost = h_flex().flex_1().min_w(0).gap(9).items_center()
          .when(Boolean(lpic), (el) => el.child(lpic))
          .child(div().flex_1().min_w(0).truncate().text_color(prio ? prio.color : t.foreground).child(name))
          .child(this.status(t, a));
      }
      return v_flex()
        .id(`ag-${a.address}`)
        .relative()
        .px(8)
        .flex_none()
        .rounded(8)
        .when(Boolean(prio) && !a.focused, (el) => el.bg(prio.color + "14"))
        .when(a.focused, (el) => el.bg(t.selected))
        .when(!this.dragging, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(this.dragging, (el) => el.cursor_grabbing())
        .when(landing, (el) => el.bg(t.accent + "1f"))
        .when(lifting, (el) => el.opacity(0.25))
        .when(Boolean(prio), (el) => el.child(div().absolute().left(0).top(8).bottom(8).w(3).rounded(2).bg(prio.color)))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_mouse_down("left", (e) => {
          this.pressed = a.address;
          this.over = a.address;
          this.grabAt(e, true);
        })
        .on_mouse_move((_e, cx) => {
          if (!this.pressed || this.over === a.address) return;
          const f = placeOf.get(this.pressed);
          this.over = draggable && f && here && f.state === here.state ? a.address : this.pressed;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const pressedOn = this.pressed;
          if (!pressedOn) return;
          const over = this.over;
          const moved = this.dragging;
          this.endDrag();
          if (pressedOn === a.address) {
            if (!moved) run("pane.focus", { pane: a.pane });
          } else if (over === a.address) moveTo(pressedOn, a.address);
          cx.notify();
        })
        .on_mouse_down("right", () => openMenu(a, name))
        .child(line)
        .when(Boolean(bar), (el) => el.child(bar))
        .when(landing, (el) => el.child(this.marker(t, from.i < here.i)));
    };

    // The fold chevron on an agent with sub-agents; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return own(div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    let index = 0;
    const withKids = (a, kind) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, index++, subs, kind);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown))];
    };

    // A state's header folds it. Needs your attention, with agents in it, is flagged:
    // bold in the color of its most urgent agent (blocked, else done), a pulsing dot
    // and a filled count, on a tinted card (see `rows`).
    const toneOf = (g) => {
      const top = g.members.reduce((m, a) => Math.max(m, rankOf(a)), 0);
      return !g.members.length ? t.muted
        : g.id === "attention" ? (top === RANK.blocked ? t.blocked : t.done)
        : t.foreground;
    };
    const flaggedOf = (g) => g.id === "attention" && g.members.length > 0;
    const header = (g) => {
      const open = !this.foldedGroups.has(g.id);
      const tone = toneOf(g);
      const flagged = flaggedOf(g);
      return h_flex()
        .id(`grp-${g.id}`)
        .px(8)
        .when(!flagged, (el) => el.pt(10))
        .h(34)
        .flex_none()
        .gap(7)
        .items_center()
        .text_size(12.5)
        .font_semibold()
        .when(!this.dragging, (el) => el.cursor_pointer())
        .on_click((_e, cx) => {
          // Let go after a drag: that was a move (or nothing), not a fold.
          if (this.dragging) return;
          this.toggleGroup(g.id);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        // The theme's brush character for this state, in the state's tone.
        .when(Boolean(brushFont && decor?.states?.[g.id]), (el) => el.child(div().flex_none().font_family(brushFont).font_normal()
          .text_size(15).text_color(g.members.length ? tone : t.dim).child(decor.states[g.id])))
        .child(div().min_w(0).truncate().text_color(tone).when(flagged, (el) => el.font_bold()).child(g.label))
        .when(!flagged, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(flagged, (el) => el
          .child(div().size(7).flex_none().rounded(4).bg(tone).loop("opacity", { from: 0.3, to: 1, period: 1200 }))
          .child(div().flex_none().min_w(20).h(18).px(6).rounded(9).bg(tone)
            .text_size(11).font_bold().text_color(t.background).flex().items_center().justify_center()
            .child(String(g.members.length))));
    };

    const nothing = () => div().px(8).pl(27).h(24).flex_none().flex().items_center().text_size(12).text_color(t.dim).child("Nothing right now");

    const rows = collapsed
      ? groups.flatMap((g) => g.members.flatMap((a) => withKids(a, g.id)))
      : groups.map((g) => v_flex().id(`sec-${g.id}`).flex_none()
        // Flagged: a card tinted and bordered in its tone, so it can't be missed.
        .when(flaggedOf(g), (el) => el.mt(8).mb(2).rounded(10).border_1()
          .border_color(toneOf(g) + "80").bg(toneOf(g) + "17")
          .when(!this.foldedGroups.has(g.id), (c) => c.pb(4)))
        .child(header(g))
        .when(!this.foldedGroups.has(g.id) && !g.members.length, (el) => el.child(nothing()))
        .when(!this.foldedGroups.has(g.id), (el) => el.children(g.members.flatMap((a) => withKids(a, g.id)))));

    const mark = current ? markOf(t, current.id) : t.dim;
    // The title card's brush title: this space's own, else the theme's.
    const bannerText = brushFont && current ? (decor.titles?.[current.name] ?? decor.title ?? "") : "";
    const banner = Boolean(bannerText);
    // The title's height; a lifted card stays below it.
    this.titleH = banner ? 66 : 41;
    // The faint vertical brush text goes only in the free space under the list, never
    // behind a row: smaller as the list grows, gone when a character would be under
    // 20 px. `used`: the title and the list's rows.
    const brushText = brushFont && current ? [...(decor.calligraphy ?? "")] : [];
    let used = this.titleH + 8;
    for (const g of groups) {
      used += 34;
      // The flagged card's margins and padding.
      if (g.id === "attention" && g.members.length) used += this.foldedGroups.has(g.id) ? 10 : 14;
      if (this.foldedGroups.has(g.id)) continue;
      if (!g.members.length) used += 24;
      for (const a of g.members) {
        used += 30 + (progressOf(a) ? 8 : 0);
        if (!this.folded.has(a.address)) used += this.tree(all, a.address).length * 26;
      }
    }
    const brushStep = brushText.length ? Math.min(34, Math.floor(((this.height ?? 0) - used - 18 - 16) / brushText.length)) : 0;
    const brush = brushStep >= 20 ? brushText : [];

    return v_flex()
      .id("agents-root")
      .relative()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      // The theme's art, first so everything paints over it; clipped to the panel.
      // No handlers, so it takes no pointer.
      // The panel's height in layout px (zoom taken out), for the brush text's room.
      .on_size_change((size, cx) => {
        const h = size.height / (Number(settings()?.zoom) || 1);
        if (Math.abs(h - (this.height ?? 0)) < 1) return;
        this.height = h;
        cx.notify();
      })
      // The glass (light washes, sheen) goes behind the art.
      .when(Boolean(art) || brush.length > 0 || glass.length > 0, (el) => el.child(div().absolute().top(0).left(0).right(0).bottom(0).overflow_hidden()
        .children(glass)
        .when(Boolean(art), (l) => l.child(image(art).absolute().right(0).bottom(0).w(160).h(320)))
        .when(brush.length > 0, (l) => l.child(v_flex().absolute().left(22).bottom(18).items_center()
          .font_family(brushFont).font_normal().text_size(Math.round(brushStep * 0.88)).text_color(t.foreground + "30")
          .children(brush.map((c) => div().h(brushStep).flex().items_center().child(c)))))))
      .when(this.dragging, (el) => el.cursor_grabbing())
      // A drag starts once the pointer has moved a few px from the press (and only
      // where it can land: an agent under Working or Idle); from then on its card
      // follows the pointer, kept between the title and the bottom.
      .on_mouse_move((e, cx) => {
        if (!this.pressed || !this.grab?.can) return;
        if (!this.dragging && Math.abs(e.position.y - this.grab.y) < 4) return;
        this.dragging = true;
        const b = e.bounds;
        const top = e.position.y - (b?.y ?? 0) - this.grab.dy;
        this.lift = {
          top: Math.max(this.titleH ?? 41, Math.min(top, (b?.height ?? Infinity) - this.grab.h)),
          left: this.grab.x !== null && b ? this.grab.x - b.x : 8,
          width: this.grab.w,
        };
        cx.notify();
      })
      // Dragged out of the list: the drag goes on to the Spaces list, which moves the
      // agent to the space it is let go on (or nothing, let go anywhere else).
      .on_hover((on, cx) => {
        if (on || !this.pressed) return;
        const what = this.dragInfo?.get(this.pressed);
        if (what) setShared("space.drag", { ...what, source: "agents", at: Date.now() });
        this.endDrag();
        cx.notify();
      })
      // Brought back and let go here: not moved.
      .on_mouse_up("left", () => {
        if (shared("space.drag")?.source === "agents") setShared("space.drag", null);
      })
      // The title: whose agents these are, in a bar of that space's color.
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(8)
            .h(this.titleH)
            .pt(9)
            .flex_none()
            .items_center()
            .child(h_flex()
              .flex_1()
              .min_w(0)
              .h(banner ? 57 : 28)
              .px(banner ? 12 : 10)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(mark + "99")
              .bg(mark + "1f")
              .gap(8)
              .child(v_flex().flex_1().min_w(0).justify_center()
                // A title card: the brush title over the plain one, as a game names a place.
                .when(banner, (el) => el.child(div().h(30).min_w(0).flex().items_center().truncate()
                  .font_family(brushFont).font_normal().text_size(22).text_color(t.foreground).child(bannerText)))
                .child(div().min_w(0).truncate().text_size(banner ? 11.5 : 12.5).font_semibold().text_color(mark)
                  .child(current ? `Agents - ${current.name}` : "Agents")))
              // The theme's seal, stamped at the end of the title.
              .when(Boolean(brushFont && decor?.seal), (el) => el.child(div().size(banner ? 24 : 19).flex_none().rounded(3)
                .bg(decor.seal_color ?? t.blocked).flex().items_center().justify_center()
                .child(div().font_family(brushFont).font_normal().text_size(banner ? 17 : 14).text_color(decor.seal_text ?? "#ffffff").child(decor.seal))))),
        ),
      )
      // On the rail, a strip in the space's color says whose agents these are.
      .when(collapsed && Boolean(current), (el) => el.child(div().mx(10).mt(8).mb(4).h(3).flex_none().rounded(2).bg(mark)))
      .child(v_flex()
        .id("ag-list")
        .flex_1()
        .min_h(0)
        .px(collapsed ? 0 : 8)
        .pb(8)
        .overflow_y_scrollbar()
        .mode("always")
        // A drag let go anywhere but on an agent ends there.
        .on_mouse_up("left", (_e, cx) => {
          if (!this.pressed) return;
          this.endDrag();
          cx.notify();
        })
        .children(rows))
      .when(Boolean(ghost) && Boolean(this.lift) && !collapsed, (el) => el.child(this.lifted(t, ghost)))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
