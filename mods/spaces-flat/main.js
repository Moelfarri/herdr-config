// Workspace spaces, flat (cloned from `spaces`): stable colored avatars, no worktree nesting,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.
//
// Agents that need you elsewhere: a space other than the shown one with agents asking
// something (blocked) or finished while you weren't looking (done) is flagged: tinted in
// the most urgent one's color (blocked, else done), a bar on its edge, its name in bold
// and a pill with how many ("2 need you", a pulsing dot). On the rail: tinted, with the
// count. The shown space's agents say so in the agents list.
//
// Drops: a tab or an agent dragged out of the tab bar or the agents list is drawn and
// dropped by the drag layer (space-drag), a window over everything, which can't ask these
// rows where they are. So they say it: every press anywhere (on_mouse_down_out tells each
// row its bounds) and every pointer move here update shared "space.targets" { viewport,
// rows: [{ id, name, machine, x, y, w, h }] } (window coordinates), published when it
// changes. While something is dragged (shared "space.drag") the title reads "Drop on a space".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, themes, settings, shared, setShared, watchFolder, window, layout, agents } from "herdr";

// The theme shown now, both halves (Herdr shows the one for the light or dark appearance).
function shownTheme() {
  const s = settings() ?? {};
  return { light: s.theme_light ?? null, dark: s.theme_dark ?? null };
}
const sameTheme = (a, b) => a?.light === b?.light && a?.dark === b?.dark;
// How long a space switch waits for its theme to show before a change counts as a pick.
const THEME_SETTLE_MS = 2000;

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

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    // A drag: the space pressed, the one under the pointer, where its card was
    // grabbed, and once the pointer has moved a few px, `dragging` with where the
    // lifted card is (`lift`, in the list's own coordinates).
    this.pressed = null;
    this.over = null;
    this.dragging = false;
    this.grab = null;
    this.lift = null;
    localStorage.removeItem("drag-trace"); // left by a debugging run, 11 Nov 2026
    // Where each space row is, and the list's visible part (see the top): key -> rect.
    this.rects = {};
    this.published = null;
    // A drag left from before a restart (the drag layer clears its own).
    if (shared("space.drag")) setShared("space.drag", null);
    // Per-space themes (see followTheme): the space whose theme is shown, the theme
    // last seen, and a switch's theme on its way ({ target, at }).
    this.themeSpace = undefined;
    this.themeWant = undefined;
    this.themeSeen = null;
    this.applying = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // Each space's own theme. On a space switch (and on the first look) the new space's
  // theme is shown: its own, else Standard (the default). So is a theme set for the
  // shown space elsewhere (the space menu's "Theme..."). A theme change while the space
  // and its setting stay the same is a pick (Settings, the palette, a menu) and becomes
  // this space's; picking Standard's theme drops the space's own.
  followTheme() {
    const now = shownTheme();
    if (!now.light && !now.dark) return;
    const stored = shared("space.themes") ?? {};
    const own = stored.spaces ?? {};
    if (!stored.default) setShared("space.themes", { ...stored, default: now, spaces: own });
    const standard = stored.default ?? now;
    const sp = spaces();
    const active = sp.find((s) => s.active)?.id ?? null;
    const want = active ? own[active] ?? standard : null;

    if (active !== this.themeSpace || !sameTheme(want, this.themeWant)) {
      this.themeSpace = active;
      this.themeWant = want;
      this.themeSeen = now;
      this.applying = null;
      if (!want) return;
      // A theme that's gone (a deleted themes/ file) leaves that half as it is.
      const names = new Set(themes().map((x) => x.name));
      const target = {
        light: want.light && names.has(want.light) ? want.light : now.light,
        dark: want.dark && names.has(want.dark) ? want.dark : now.dark,
      };
      if (sameTheme(target, now)) return;
      this.applying = { target, at: Date.now() };
      for (const half of ["light", "dark"]) if (target[half] !== now[half]) run("app.theme", { name: target[half] });
      return;
    }
    if (this.applying) {
      // The switch's own theme on its way is not a pick.
      if (!sameTheme(now, this.applying.target) && Date.now() - this.applying.at < THEME_SETTLE_MS) return;
      this.applying = null;
      this.themeSeen = now;
      return;
    }
    if (sameTheme(now, this.themeSeen)) return;
    this.themeSeen = now;
    if (!active) return;
    // Spaces that are gone lose their theme, once every machine has listed its spaces.
    const ready = machines().every((m) => m.layout === "ready");
    const ids = new Set(sp.map((s) => s.id));
    const kept = Object.fromEntries(Object.entries(own).filter(([id]) => id !== active && (!ready || ids.has(id))));
    // Standard's theme picked: the space goes back to Standard (no theme of its own).
    if (!sameTheme(now, standard)) kept[active] = now;
    setShared("space.themes", { default: standard, spaces: kept });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    // `space-menu`: Herdr's space menu plus "Theme..." (a theme for this space).
    openOverlay({ mod: "space-menu", kind: "popup", width: 200, height: 300, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    // Flat: every space is its own category, even a worktree of another space's repo.
    const nested = (_r) => false;
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      return [cell(head), ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  endDrag() {
    this.pressed = null;
    this.over = null;
    this.dragging = false;
    this.grab = null;
    this.lift = null;
  }

  // Keeps where a row (or the list, key "viewport") is, from an event's bounds; a change
  // redraws, and the redraw publishes it (see targets).
  noteRect(key, b, cx) {
    if (!b) return;
    const r = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    const old = this.rects[key];
    if (old && old.x === r.x && old.y === r.y && old.w === r.w && old.h === r.h) return;
    this.rects[key] = r;
    cx.notify();
  }

  // shared "space.targets" for the drag layer, when it changed.
  publishTargets(sp) {
    const rows = sp.filter((s) => this.rects[s.id]).map((s) => ({ id: s.id, name: s.name, machine: s.machine ?? null, ...this.rects[s.id] }));
    const value = { viewport: this.rects.viewport ?? null, rows };
    const text = JSON.stringify(value);
    if (text === this.published) return;
    this.published = text;
    setShared("space.targets", value);
  }

  // A pill saying how many agents in a space need you, in the most urgent one's color.
  needPill(t, need) {
    return h_flex().flex_none().h(18).px(7).gap(5).rounded(9).items_center().bg(need.tone)
      .child(div().size(5).flex_none().rounded(3).bg(t.background).loop("opacity", { from: 0.35, to: 1, period: 1200 }))
      .child(div().text_size(10.5).font_bold().text_color(t.background).child(`${need.n} need${need.n === 1 ? "s" : ""} you`));
  }

  avatar(w, t) {
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?");
  }

  // The card of the space being dragged, lifted out of the list and following the
  // pointer up and down (kept in the list's column). It has no handlers, so it takes
  // no hitbox: the rows under it still get the pointer.
  ghost(w, t) {
    const { top, left, width } = this.lift;
    return h_flex().absolute().top(top).left(left)
      .when(width != null, (el) => el.w(width))
      .when(width == null, (el) => el.right(14))
      .h(this.grab.h).px(8).gap(9).items_center()
      .rounded(8).bg(t.raised ?? t.selected).border_1().border_color(t.accent).shadow_lg()
      .child(this.avatar(w, t))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(w.name));
  }

  // Where the dragged space will land: a dot and a line on the target's edge, inside
  // the row (its free 6 px) so the next row can't paint over it. Moving down lands
  // after the target, moving up before it (space.move).
  landing(t, below) {
    return h_flex().absolute().left(-2).right(0).h(6).items_center()
      .when(below, (l) => l.bottom(0))
      .when(!below, (l) => l.top(0))
      .child(div().size(6).flex_none().rounded(3).bg(t.accent))
      .child(div().flex_1().h(2).rounded(1).bg(t.accent));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const lifted = this.dragging && this.pressed === w.id;
    const target = this.dragging && this.pressed !== null && this.over === w.id && this.pressed !== w.id;
    // Agents that need you here, unless this is the space shown.
    const need = on ? null : this.needs?.get(w.id) ?? null;
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(Boolean(need), (el) => el.bg(need.tone + "24"))
      .when(!on && !this.dragging, (el) => el.hover((s) => s.bg(need ? need.tone + "38" : t.hover)))
      .when(target, (el) => el.bg(t.accent + "1f"))
      .when(lifted, (el) => el.opacity(0.25))
      .when(this.dragging, (el) => el.cursor_grabbing())
      .on_mouse_down_out((e, cx) => this.noteRect(w.id, e.bounds, cx))
      .on_mouse_down("left", (e) => {
        this.pressed = w.id;
        this.over = w.id;
        this.dragging = false;
        // Where on the card it was grabbed (window coordinates, as Solitaire does),
        // so the lifted card keeps that spot under the pointer.
        const b = e.bounds;
        this.grab = {
          y: e.position.y,
          dy: b ? e.position.y - b.y : 15,
          x: b ? b.x : null,
          w: b ? b.width : null,
          h: b ? b.height : rowHeight({ tree }),
        };
      })
      .on_mouse_move((e, cx) => {
        this.noteRect(w.id, e.bounds, cx);
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        const moved = this.dragging;
        this.endDrag();
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id && !moved) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(this.avatar(w, t)))
          .child(div().flex_shrink(0).max_w(need ? 112 : 150).truncate().text_color(t.foreground).when(Boolean(need), (n) => n.font_bold()).child(w.name))
          // Agents need you here: how many, instead of the repo.
          .when(Boolean(need), el => el.child(div().flex_1()).child(this.needPill(t, need)))
          .when(!need, el => el.child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())),
      )
      // The flag's bar on the edge (no handlers, so no hitbox).
      .when(Boolean(need), (el) => el.child(div().absolute().left(0).top(6).bottom(6).w(3).rounded(2).bg(need.tone)))
      .when(target, (el) => el.child(this.landing(t, fromIndex < i)));
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .when(!w.active && Boolean(this.needs?.get(w.id)), (el) => el.bg(this.needs.get(w.id).tone + "33"))
      .on_mouse_down_out((e, cx) => this.noteRect(w.id, e.bounds, cx))
      .on_mouse_move((e, cx) => this.noteRect(w.id, e.bounds, cx))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      // Agents that need you here: how many; else the space's state.
      .when(!w.active && Boolean(this.needs?.get(w.id)), (el) => el.child(div().absolute().right(3).top(1).text_size(10).font_bold()
        .text_color(this.needs.get(w.id).tone).child(String(this.needs.get(w.id).n))))
      .when(w.active || !this.needs?.get(w.id), (el) => el.child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status)))));
  }

  render() {
    this.followTheme();
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const ghost = this.dragging && this.lift && !collapsed ? sp.find((s) => s.id === this.pressed) : null;
    // Agents that need you, by space: how many, in the most urgent one's color.
    const needs = new Map();
    for (const a of agents()) {
      if (a.status !== "blocked" && a.status !== "done") continue;
      const n = needs.get(a.space) ?? { n: 0, blocked: false };
      n.n += 1;
      n.blocked ||= a.status === "blocked";
      needs.set(a.space, n);
    }
    this.needs = new Map([...needs].map(([id, n]) => [id, { n: n.n, tone: n.blocked ? t.blocked : t.done }]));
    this.publishTargets(sp);
    const drag = shared("space.drag");
    return v_flex().id("spaces-root").relative().size_full().min_h(0).bg(t.chrome).text_size(13)
      .when(this.dragging, (el) => el.cursor_grabbing())
      // A drag starts once the pointer has moved a few px from the press; from then on
      // the card follows it. Positions are the pointer minus this list's bounds (both
      // window coordinates), as Solitaire does; kept between the header and the bottom.
      .on_mouse_move((e, cx) => {
        if (this.pressed === null || !this.grab) return;
        if (!this.dragging && Math.abs(e.position.y - this.grab.y) < 4) return;
        this.dragging = true;
        const b = e.bounds;
        const top = e.position.y - (b?.y ?? 0) - this.grab.dy;
        this.lift = {
          top: Math.max(31, Math.min(top, (b?.height ?? Infinity) - this.grab.h)),
          left: this.grab.x !== null && b ? this.grab.x - b.x : 8,
          width: this.grab.w,
        };
        cx.notify();
      })
      // Dragged out of the list: the drag is off, as in Solitaire.
      .on_hover((on, cx) => {
        if (on || this.pressed === null) return;
        this.endDrag();
        cx.notify();
      })
      // Let go anywhere here but on a space: nothing moves.
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        this.endDrag();
        cx.notify();
      })
      // Let go outside the list never reaches it; the next press anywhere clears it.
      .on_mouse_down_out((_e, cx) => {
        if (this.pressed === null) return;
        this.endDrag();
        cx.notify();
      })
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(drag ? div().text_color(t.accent).child("Drop on a space") : div().child("Spaces")))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().id("spaces-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        // The list's visible part, for the drag layer (see the top).
        .on_mouse_down_out((e, cx) => this.noteRect("viewport", e.bounds, cx))
        .on_mouse_move((e, cx) => this.noteRect("viewport", e.bounds, cx))
        .children(this.grouped(t, collapsed)))
      .when(Boolean(ghost), (el) => el.child(this.ghost(ghost, t)));
  }
}
