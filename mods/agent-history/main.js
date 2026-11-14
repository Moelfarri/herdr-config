// Closed Claude Code and Codex conversations, newest first, to pick one up again.
// Opens as a popup (cmd-y). `history.py` beside this file reads the agents' own
// stores (~/.claude/projects, ~/.codex/state_5.sqlite) and leaves out every
// conversation a running process still has open. Type to filter, ↑/↓ and Enter
// to resume it in a new tab of this space, in the conversation's folder; Esc to leave.
//
// Live while open: when a terminal or agent starts, ends or changes program in
// Herdr, the list is read again (and once more a moment later, as a pid file or
// Codex lock can lag the exit). Every 30 s it is read again anyway, for
// conversations closed outside Herdr (VS Code, another terminal app).
//
// Also a side panel (the "History" button beside Files and Changes in
// `tabs-drag`): a block in the layout's panel stack, drawn as a card like Files.
// A docked copy stays alive while hidden, so it reads nothing until it is shown.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, home, knownAgents, terminals, layout, run, notify, theme, settings, props, closeOverlay } from "herdr";

const AGENTS = {
  claude: { name: "Claude Code", run: ["claude"], resume: (id) => ["--resume", id], icon: "icons/claude.svg", tint: false },
  codex: { name: "Codex", run: ["codex", "--no-daemon"], resume: (id) => ["resume", id], icon: "icons/codex.svg", tint: true },
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const H = { head: 30, row: 46 };
const LIST_MAX = 460;
const SETTLE_MS = 2500;
const FALLBACK_MS = 30000;

const keyOf = (s) => `${s.agent}:${s.id}`;

// What runs in Herdr's terminals, without status: it changes when a terminal or
// agent starts or ends, not on every turn.
function liveSignature() {
  return terminals()
    .filter((x) => x.state === "live")
    .map((x) => `${x.address}:${x.agent ?? x.program?.key ?? ""}`)
    .sort()
    .join("|");
}

// Whether a block showing `mod` is on screen: no hidden node on the way, and the
// active child of every stack on the way.
function shownIn(node, mod) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === mod) return true;
  const kids = node.children ?? [];
  if (node.type === "stack") return shownIn(kids.find((c) => c.id === node.active) ?? kids[0], mod);
  return kids.some((c) => shownIn(c, mod));
}

const pad = (n) => String(n).padStart(2, "0");
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

function dayLabel(ms) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  const ago = Math.round((today - day) / 86400000);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  const d = new Date(ms);
  if (ago < 7) return DAYS[d.getDay()];
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function place(cwd) {
  const h = home();
  if (cwd === h) return "~";
  const rel = cwd.startsWith(h + "/") ? "~/" + cwd.slice(h.length + 1) : cwd;
  const parts = rel.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : rel;
}

export default class AgentHistory extends View {
  init(_props, cx) {
    this.filter = "";
    this.sessions = null;
    this.error = null;
    this.at = 0;
    this.scroll = 0;
    this.agents = {};
    this.input = InputState.new({ placeholder: "Search closed conversations…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; this.scroll = 0; cx.notify(); });
    this.input.on("submit", () => this.resume(this.rows().filter((r) => r.kind === "row")[this.at]?.s));
    // A popup takes the keyboard; a copy docked in a layout never does (it
    // starts with Herdr and on every reload, and would take it from the terminal).
    this.overlay = props()?.overlay ?? null;
    if (this.overlay) {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.handle = cx.focus_handle();
    this.loading = false;
    this.again = false;
    this.selKey = null;
    this.keepKey = null;
    this.live = liveSignature();
    this.closed = false;
    this.tasks = [];
    this.shown = this.isShown();
    this.load(cx);
    // Compares strings only; the helper runs when something changed.
    this.tasks.push(cx.timer.every(1000, (cx) => {
      if (this.closed) return;
      const shown = this.isShown();
      if (shown !== this.shown) {
        this.shown = shown;
        if (shown) { this.live = liveSignature(); this.load(cx); }
        return;
      }
      if (!shown) return;
      const live = liveSignature();
      if (live === this.live) return;
      this.live = live;
      this.load(cx);
      this.tasks = this.tasks.filter((t) => !t.is_done());
      this.tasks.push(cx.timer.after(SETTLE_MS, (cx) => this.load(cx)));
    }));
    this.tasks.push(cx.timer.every(FALLBACK_MS, (cx) => this.load(cx)));
    cx.spawn(async (cx) => {
      try {
        for (const a of await knownAgents()) {
          if (AGENTS[a.key] && a.run?.length) this.agents[a.key] = a;
        }
      } catch {}
      cx.notify();
    });
  }

  isShown() {
    return Boolean(this.overlay) || shownIn(layout(), "agent-history");
  }

  // One read at a time; a request during a read runs once after it. Nothing is
  // read while a docked copy is hidden.
  load(cx) {
    if (this.closed || !this.shown) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/agent-history/history.py`], { timeout: 60000 });
        if (this.closed) return;
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
        const sessions = JSON.parse(r.stdout).sessions ?? [];
        this.keepKey = this.selKey;
        this.sessions = sessions;
        this.error = null;
      } catch (e) {
        // A failed refresh keeps the list already shown.
        if (this.sessions === null || this.error) {
          this.error = String(e?.message ?? e);
          this.sessions = this.sessions ?? [];
        }
      }
      this.loading = false;
      cx.notify();
      if (this.again) { this.again = false; this.load(cx); }
    });
  }

  // Herdr calls this once when the popup goes: stop every timer, so a closed
  // panel never reads the history again.
  async close(_cx) {
    this.closed = true;
    for (const t of this.tasks ?? []) t.cancel();
    this.tasks = [];
  }

  dismiss() {
    if (this.overlay) closeOverlay(this.overlay);
  }

  agent(key) {
    const base = AGENTS[key];
    const known = this.agents[key];
    return {
      name: known?.name ?? base.name,
      run: known?.run ?? base.run,
      icon: known?.icon ?? base.icon,
      tint: known ? known.tint : base.tint,
      resume: base.resume,
    };
  }

  rows() {
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    let last = null;
    for (const s of this.sessions ?? []) {
      if (words.length) {
        const hay = [s.title, s.prompt, s.cwd, s.branch ?? "", this.agent(s.agent).name].join(" ").toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      const day = dayLabel(s.updated);
      if (day !== last) { out.push({ kind: "head", day }); last = day; }
      out.push({ kind: "row", s });
    }
    return out;
  }

  resume(s) {
    if (!s) return;
    const a = this.agent(s.agent);
    if (!s.exists) {
      notify({ title: "Folder is gone", body: `${place(s.cwd)} no longer exists, so ${a.name} can't resume there.`, level: "warning" });
      return;
    }
    this.dismiss();
    run("tab.new", { folder: s.cwd, argv: [...a.run, ...a.resume(s.id)] });
  }

  icon(key, t) {
    const a = this.agent(key);
    if (!a.icon) return div().w(16).flex_none();
    return a.tint ? svg(a.icon).size(16).flex_none().text_color(t.foreground) : image(a.icon).w(16).h(16).flex_none();
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind === "row");
    // After a refresh the same conversation stays selected, wherever it moved.
    if (this.keepKey !== null) {
      const i = pickable.findIndex((r) => keyOf(r.s) === this.keepKey);
      if (i >= 0) this.at = i;
      this.keepKey = null;
    }
    this.at = Math.max(0, Math.min(this.at, pickable.length - 1));
    const sel = pickable[this.at];
    this.selKey = sel ? keyOf(sel.s) : null;

    // One strip with each row at a fixed y; scrolling moves it only as far as
    // it takes to keep the selected row in view (as the picker does).
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += H[r.kind]; });
    const total = y;
    // A popup caps the list; a docked copy fills its block.
    const height = this.overlay ? Math.min(LIST_MAX, this.listHeight ?? LIST_MAX) : (this.listHeight ?? LIST_MAX);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      // Keep the day title above the first row of a day in view too.
      const top = si > 0 && rows[si - 1].kind === "head" ? tops[si - 1] : tops[si];
      if (top < this.scroll) this.scroll = top;
      if (tops[si] + H.row > this.scroll + height) this.scroll = tops[si] + H.row - height;
    }
    const at = (el, i) =>
      fixed ? el.absolute().left(0).right(0).top(tops[i] - this.scroll).h(H[rows[i].kind]) : el;
    const visible = (i) => !fixed || (tops[i] + H[rows[i].kind] > this.scroll && tops[i] < this.scroll + height);

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().h(H.head).px(10).pt(10).items_center().text_size(11).font_semibold().text_color(t.dim).child(r.day);
      }
      const s = r.s;
      const on = r === sel;
      const where = [place(s.cwd), s.branch && s.branch !== "HEAD" ? s.branch : null].filter(Boolean).join(" · ");
      return h_flex()
        .id(`ah-${s.agent}-${s.id}`)
        .h(H.row)
        .mx(4)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((st) => st.bg(t.hover))
        .on_click(() => this.resume(s))
        .child(this.icon(s.agent, t))
        .child(
          v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_color(s.exists ? t.foreground : t.muted).child(s.title || "(untitled)"))
            .child(div().truncate().text_size(11).text_color(t.dim).child(s.exists ? where : `${where} · folder gone`)),
        )
        .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(s.updated)));
    };

    let body;
    if (this.sessions === null) {
      body = div().px(10).py(14).text_color(t.dim).child("Reading conversations…");
    } else if (this.error) {
      body = div().px(10).py(14).text_color(t.blocked).child(`Couldn't read the history: ${this.error}`);
    } else if (!pickable.length) {
      body = div().px(10).py(14).text_color(t.dim).child(this.filter ? "No closed conversation matches." : "No closed conversations.");
    } else {
      body = v_flex()
        .id("ah-list")
        .on_size_change((size, cx) => { this.listHeight = size.height / settings().zoom; cx.notify(); })
        .when(!!this.overlay, (el) => el.h(Math.min(LIST_MAX, total)))
        .when(!this.overlay, (el) => el.flex_1())
        .min_h(0)
        .when(fixed, (el) =>
          el.overflow_hidden().on_scroll_wheel((e, cx) => {
            this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
            // The selection follows the wheel, so the next frame doesn't scroll back to it.
            while (this.at < pickable.length - 1 && tops[rows.indexOf(pickable[this.at])] < this.scroll) this.at++;
            while (this.at > 0 && tops[rows.indexOf(pickable[this.at])] + H.row > this.scroll + height) this.at--;
            cx.notify();
          }))
        .children(rows.map((r, i) => (visible(i) ? at(row(r), i) : null)).filter(Boolean));
    }

    const count = this.sessions?.length ? `${pickable.length}${this.filter ? ` of ${this.sessions.length}` : ""}` : "";
    const keys = (e, cx) => {
      const k = e.key;
      if (k === "escape" && this.overlay) return this.dismiss();
      if (!pickable.length) return;
      if (k === "down") this.at = (this.at + 1) % pickable.length;
      else if (k === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
      else if (k === "pagedown") this.at = Math.min(pickable.length - 1, this.at + 8);
      else if (k === "pageup") this.at = Math.max(0, this.at - 8);
      else return;
      cx.stop_propagation();
      cx.notify();
    };
    const search = (h) =>
      h_flex().h(h).flex_none().px(10).gap(8).items_center().rounded(this.overlay ? 9 : 7).border_1()
        .border_color(this.overlay ? t.accent : t.input ?? t.border).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground));

    // The side panel: a card like Files and Changes.
    if (!this.overlay) {
      return v_flex()
        .id("agent-history")
        .track_focus(this.handle)
        .on_key_down(keys)
        .size_full()
        .min_h(0)
        .rounded(10)
        .overflow_hidden()
        .bg(t.background)
        .border_1()
        .border_color(t.border)
        .text_color(t.foreground)
        .text_size(13)
        .child(
          h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
            .child(div().font_semibold().child("History"))
            .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(count)),
        )
        .child(div().flex_none().px(8).pt(8).child(search(30)))
        .child(v_flex().flex_1().min_h(0).p(4).child(body));
    }

    return v_flex()
      .id("agent-history")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down(keys)
      .child(
        h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Closed conversations"))
          .child(div().text_size(11).text_color(t.dim).child(count))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(search(36))
      .child(body)
      .child(div().text_size(11).text_color(t.dim).child("Enter resumes it in a new tab here, in its own folder"));
  }
}
