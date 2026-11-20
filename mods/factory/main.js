// The factory floor: a control room for an agent factory that works the GitHub issues
// of one repository (config.local.json). One mod, two sections (props.section):
//
// - "floor": a title band (line state, last sync, demo switch), gauges (queue, on the
//   line, needs you, shipped, PRs merged per day, open PRs and their checks) and the
//   assembly line: five stations (intake > build > verify > review > shipped) with a
//   card per issue on a moving belt. A card opens its issue or pull request.
// - "feed": the crew (every agent in the factory space; click one to go to it), the
//   intake queue (open an issue, or Dispatch it to a new Claude Code worker tab) and
//   signals (what moved, newest first).
//
// The terminal you prompt sits beside them as an ordinary pane of the same tab.
// With nothing on the line, the floor shows sample work, clearly marked DEMO.
// How a factory reports to the floor: README.md here. Elias, 20 Nov 2026.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, shared, setShared, run, exec, notify } from "herdr";
import { STAGES, FLOW_DAYS, cfg, store, refresh, snapshot, pushEvent } from "./store.js";

const MONO = "JetBrains Mono";
const ICON = (name) => `mods/factory/${name}.svg`;
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;

const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + a : c);

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

function tone(t, name) {
  return { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[name] ?? t.dim;
}

function stageTone(t, id, brand) {
  return { intake: brand, build: t.working, verify: t.ansi3, review: t.blocked, shipped: t.done }[id] ?? t.dim;
}

function lamp(color, { size = 8, pulse = false } = {}) {
  return div().size(size).flex_none().rounded(size / 2).bg(color)
    .when(pulse, (el) => el.loop("opacity", { from: 0.25, to: 1, period: 1100 }));
}

function programIcon(p, size, color) {
  if (!p?.icon) return svg(CHROME("terminal")).size(size).flex_none().text_color(color);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color ?? color) : image(p.icon).w(size).h(size).flex_none();
}

function caps(t, text) {
  return div().text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
}

function open(url) {
  if (url) exec("open", [url]).catch(() => {});
}

// The belt under the stations: chevrons that step forward while the line runs.
function belt(chars) {
  const unit = "›   ";
  const base = unit.repeat(Math.ceil(chars / unit.length) + 2);
  return [0, 1, 2, 3].map((k) => base.slice(unit.length - k, unit.length - k + chars));
}

// What a dispatched worker is told: config's `worker` ({n}, {repo}, {host} filled in),
// else a plain task that asks before anything leaves the machine.
function workerTask(n) {
  const fill = (text) => text.replaceAll("{n}", String(n)).replaceAll("{repo}", cfg.slug).replaceAll("{host}", cfg.host);
  if (cfg.worker) return fill(cfg.worker);
  return fill([
    "You are a worker on the factory floor. I ask you to start on GitHub issue #{n} in {repo} now.",
    "Read it with `gh issue view {n} -R {host}/{repo} --comments`, and work in your own git worktree on a new branch.",
    "Ask me before you push, open a pull request, or write on or change the issue.",
  ].join(" "));
}

export default class Factory extends View {
  init(_props, cx) {
    this.section = props()?.section === "feed" ? "feed" : "floor";
    this.w = 0;
    this.armed = null; // { n, at }: Dispatch was pressed once
    cx.timer.every(20_000, (cx) => this.pull(cx, false));
    this.pull(cx, false);
  }

  pull(cx, force) {
    cx.spawn(async (cx) => {
      const changed = await refresh(force);
      if (changed || force) cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const snap = snapshot(props()?.space);
    const brand = t[shared("space.colors")?.[snap.space?.id]] ?? t.accent;
    const body = this.section === "feed" ? this.feed(t, snap, brand) : this.floor(t, snap, brand);
    return v_flex()
      .id("factory-root")
      .size_full()
      .min_h(0)
      .bg(alpha(t.background, "f2"))
      .text_color(t.foreground)
      .text_size(12)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.w) < 8) return;
        this.w = size.width;
        cx.notify();
      })
      .children(body);
  }

  // --- floor ------------------------------------------------------------------

  floor(t, snap, brand) {
    return [this.band(t, snap, brand), this.gauges(t, snap, brand), this.line(t, snap, brand)];
  }

  band(t, snap, brand) {
    const needs = snap.stats.needs;
    const state = needs > 0
      ? { color: t.blocked, text: `NEEDS YOU · ${needs}`, pulse: true }
      : snap.running ? { color: t.working, text: "LINE RUNNING", pulse: false } : { color: t.idle, text: "LINE IDLE", pulse: false };
    const sync = snap.error
      ? div().text_color(t.blocked).truncate().max_w(260).child(`gh: ${snap.error}`)
      : div().text_color(t.dim).font_family(MONO).text_size(11).child(snap.gh ? `synced ${clock(snap.gh.at)}` : "reading GitHub…");
    const button = (id, label, onClick, active = false) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(5)
      .border(1).border_color(active ? alpha(t.ansi3, "aa") : t.border).bg(active ? alpha(t.ansi3, "22") : t.surface)
      .text_size(11).text_color(active ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click(onClick).child(label);
    return h_flex()
      .flex_none().h(38).px(12).gap(10).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(svg(ICON("hazard")).w(28).h(10).flex_none().text_color(t.ansi3))
      .child(div().font_family(MONO).font_bold().text_size(12.5).text_color(t.foreground).child(cfg.title.toUpperCase()))
      .child(div().text_size(11).text_color(t.dim).truncate().child(cfg.slug ?? "no repository set"))
      .when(snap.demo, (el) => el.child(h_flex().h(20).px(7).gap(5).items_center().rounded(4).bg(alpha(t.ansi3, "26"))
        .border(1).border_color(alpha(t.ansi3, "88"))
        .child(svg(ICON("hazard")).w(16).h(6).text_color(t.ansi3))
        .child(div().font_family(MONO).font_bold().text_size(10).text_color(t.ansi3).child("DEMO DATA"))))
      .child(div().flex_1())
      .child(h_flex().gap(6).items_center()
        .child(snap.running && needs === 0
          ? svg(ICON("gear")).size(14).flex_none().text_color(state.color).spin(2400)
          : lamp(state.color, { pulse: state.pulse }))
        .child(div().font_family(MONO).font_bold().text_size(11).text_color(state.color).child(state.text)))
      .child(sync)
      .child(button("fx-demo", snap.demo ? "Hide demo" : "Demo", () => setShared("factory.demo", !snap.demo), snap.demo))
      .child(h_flex().id("fx-refresh").size(22).items_center().justify_center().rounded(5).border(1).border_color(t.border)
        .bg(t.surface).hover((s) => s.bg(t.hover)).cursor_pointer().tooltip("Ask GitHub now")
        .on_click((_e, cx) => this.pull(cx, true))
        .child(svg(ICON("refresh")).size(12).text_color(t.muted).when(snap.fetching, (el) => el.spin(900))));
  }

  gauges(t, snap, brand) {
    const s = snap.stats;
    const tile = (label, value, color, sub, { pulse = false } = {}) => v_flex()
      .flex_grow(1).flex_basis(0).min_w(0).px(11).py(8).gap(1).rounded(8)
      .bg(value > 0 && pulse ? alpha(color, "1c") : t.surface)
      .border(1).border_color(value > 0 && pulse ? alpha(color, "99") : t.border)
      .child(h_flex().gap(6).items_center()
        .child(lamp(value > 0 ? color : t.border, { size: 6, pulse: pulse && value > 0 }))
        .child(caps(t, label)))
      .child(div().font_family(MONO).font_bold().text_size(22).text_color(value > 0 ? color : t.muted).child(String(value)))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(sub));
    const days = s.flow;
    const max = Math.max(1, ...days.map((d) => d.n));
    const total = days.reduce((n, d) => n + d.n, 0);
    const flow = v_flex().flex_grow(1.6).flex_basis(0).min_w(0).px(11).py(8).gap(4).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().child(lamp(brand, { size: 6 })).child(caps(t, `PRs merged · ${FLOW_DAYS} d`))
        .child(div().flex_1()).child(div().font_family(MONO).font_bold().text_size(13).text_color(brand).child(String(total))))
      .child(h_flex().h(30).gap(3).items_end().children(days.map((d, i) => div().id(`fx-day-${i}`).flex_1().min_w(3)
        .h(Math.max(2, Math.round((d.n / max) * 30))).rounded(2)
        .bg(i === days.length - 1 ? brand : alpha(brand, d.n ? "88" : "33"))
        .tooltip(`${new Date(d.start).toDateString().slice(0, 10)}: ${d.n}`))))
      .child(div().text_size(10.5).text_color(t.dim).child(`${(total / FLOW_DAYS).toFixed(1)} a day, today ${days[days.length - 1].n}`));
    const pr = s.prs;
    const prs = tile("Open PRs", pr.open, t.foreground, `${pr.green} green · ${pr.red} red · ${pr.running} running`);
    const wide = this.w === 0 || this.w > 820;
    const mid = this.w === 0 || this.w > 640;
    return h_flex().flex_none().gap(8).px(12).pt(10).pb(8)
      .child(tile("Queue", s.queue, brand, "waiting for a worker"))
      .child(tile("On the line", s.line, t.working, "build and verify"))
      .child(tile("Needs you", s.needs, t.blocked, "review, questions", { pulse: true }))
      .child(tile("Shipped · 7 d", s.shipped, t.done, "issues closed"))
      .when(mid, (el) => el.child(flow))
      .when(wide, (el) => el.child(prs));
  }

  line(t, snap, brand) {
    const chars = Math.max(40, Math.ceil((this.w || 1400) / 6.4));
    const frames = belt(chars);
    const header = h_flex().flex_none().children(STAGES.map((s, i) => {
      const n = snap.stages[s.id].length;
      const color = stageTone(t, s.id, brand);
      return h_flex().flex_1().min_w(0).px(10).py(8).gap(6).items_center()
        .when(i > 0, (el) => el.border_l(1).border_color(t.border))
        .child(lamp(n ? color : t.border, { size: 7, pulse: s.id === "review" && n > 0 }))
        .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(s.no))
        .child(div().text_size(11).font_bold().text_color(n ? t.foreground : t.muted).truncate().child(s.label.toUpperCase()))
        .child(div().flex_1())
        .child(div().font_family(MONO).text_size(11).font_bold().px(6).rounded(4)
          .when(n > 0, (el) => el.bg(alpha(color, "26"))).text_color(n ? color : t.dim).child(String(n)));
    }));
    const beltRow = div().flex_none().h(14).overflow_hidden().whitespace_nowrap()
      .bg(t.chrome).border_t(1).border_b(1).border_color(t.border)
      .font_family(MONO).text_size(10).text_color(snap.running ? alpha(t.ansi3, "cc") : alpha(t.dim, "66"))
      .when(snap.running, (el) => el.frames(frames, 170))
      .when(!snap.running, (el) => el.child(frames[0]));
    const loading = !snap.gh && !snap.demo;
    const cols = h_flex().flex_1().min_h(0).items_stretch().children(STAGES.map((s, i) => {
      const cards = snap.stages[s.id];
      return v_flex().id(`fx-col-${s.id}`).flex_1().min_w(0).min_h(0).p(6).gap(6)
        .when(i > 0, (el) => el.border_l(1).border_color(t.border))
        .overflow_y_scrollbar()
        .children(cards.length
          ? cards.map((c) => this.card(t, c, stageTone(t, s.id, brand)))
          : [div().pt(10).px(4).text_size(11).text_color(t.dim).child(loading ? "…" : s.empty)]);
    }));
    return v_flex().flex_1().min_h(0).mx(12).mb(12).rounded(8).overflow_hidden()
      .bg(t.surface).border(1).border_color(t.border)
      .child(header).child(beltRow).child(cols);
  }

  card(t, c, color) {
    const ch = c.pr?.checks;
    const worker = c.worker;
    const meta = [];
    if (worker) {
      meta.push(h_flex().gap(4).items_center()
        .child(lamp(tone(t, worker.status), { size: 6, pulse: worker.status === "blocked" }))
        .child(div().text_size(10.5).text_color(worker.status === "blocked" ? t.blocked : t.muted)
          .child(worker.status === "blocked" ? "needs you" : worker.status)));
    }
    if (c.pr) {
      meta.push(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(`PR #${c.pr.number}${c.pr.draft ? " draft" : ""}`));
    }
    if (ch) {
      const part = (icon, n, col) => h_flex().gap(2).items_center()
        .child(svg(icon).size(10).text_color(col)).child(div().font_family(MONO).text_size(10.5).text_color(col).child(String(n)));
      meta.push(h_flex().gap(5).items_center()
        .when(ch.pass > 0, (el) => el.child(part(CHROME("check"), ch.pass, t.done)))
        .when(ch.fail > 0, (el) => el.child(part(CHROME("x"), ch.fail, t.blocked)))
        .when(ch.pending > 0, (el) => el.child(part(CHROME("clock"), ch.pending, t.ansi3))));
    }
    const edge = c.red ? t.blocked : color;
    return h_flex().id(`fx-card-${c.key}`).flex_none().items_stretch().rounded(6).overflow_hidden()
      .bg(t.background).border(1).border_color(alpha(edge, "55"))
      .hover((s) => s.bg(t.hover)).when(Boolean(c.url), (el) => el.cursor_pointer())
      .tooltip(c.url ? `Open ${c.pr ? `PR #${c.pr.number}` : `#${c.number}`} in the browser` : "Sample work (demo)")
      .on_click(() => open(c.url))
      .child(div().w(3).flex_none().bg(edge))
      .child(v_flex().flex_1().min_w(0).px(7).py(6).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(svg(ICON("crate")).size(11).flex_none().text_color(edge))
          .child(div().font_family(MONO).font_bold().text_size(11).text_color(edge).child(`#${c.number}`))
          .child(div().flex_1())
          .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(ago(c.since))))
        .child(div().text_size(11.5).max_h(35).overflow_hidden().text_color(t.foreground).child(c.title))
        .when(meta.length > 0, (el) => el.child(h_flex().gap(8).items_center().flex_wrap().children(meta))));
  }

  // --- feed ---------------------------------------------------------------------

  feed(t, snap, brand) {
    return [this.crewSection(t, snap, brand), this.intakeSection(t, snap, brand), this.signalSection(t, snap)];
  }

  head(t, label, count, extra = null) {
    return h_flex().flex_none().h(30).px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_t(1).border_color(t.border)
      .child(caps(t, label))
      .when(count != null, (el) => el.child(div().font_family(MONO).text_size(10.5).px(5).rounded(4).bg(t.raised).text_color(t.muted).child(String(count))))
      .child(div().flex_1())
      .when(Boolean(extra), (el) => el.child(extra));
  }

  crewSection(t, snap, brand) {
    const rows = snap.crew.map((w) => {
      const status = w.status === "blocked" ? "needs you" : w.status;
      const time = w.status === "working" && w.since ? ` ${ago(w.since)}` : "";
      const role = w.controller
        ? div().font_family(MONO).font_bold().text_size(9.5).px(5).rounded(3).bg(alpha(brand, "2a")).text_color(brand).child("CONTROL")
        : w.issue ? div().font_family(MONO).font_bold().text_size(10).text_color(t.muted).child(`#${w.issue}`) : null;
      return h_flex().id(`fx-crew-${w.address}`).flex_none().gap(9).px(10).py(6).mx(4).rounded(6).items_center()
        .when(w.status === "blocked", (el) => el.bg(alpha(t.blocked, "18")))
        .when(!w.demo, (el) => el.hover((s) => s.bg(t.hover)).cursor_pointer().on_click(() => run("pane.focus", { pane: w.pane })))
        .child(programIcon(w.program, 16, t.muted))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center().min_w(0)
            .when(Boolean(role), (el) => el.child(role))
            .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(w.controller ? "You prompt here" : w.issue ? w.name.replace(/^#\d+\s*/, "") : w.name)))
          .child(div().truncate().text_size(11).text_color(t.dim).child(w.note || "…")))
        .child(h_flex().flex_none().gap(5).items_center()
          .child(w.status === "working"
            ? svg(ICON("gear")).size(11).text_color(t.working).spin(1800)
            : lamp(tone(t, w.status), { size: 7, pulse: w.status === "blocked" }))
          .child(div().font_family(MONO).text_size(10.5).text_color(tone(t, w.status)).child(status + time)));
    });
    const empty = div().px(14).py(8).text_size(11).text_color(t.dim).child("No agents in this space yet.");
    // A scroll list needs a definite height in a column that sizes to its content.
    const listH = Math.min(Math.max(rows.length, 1) * 46 + 8, 196);
    return v_flex().flex_none()
      .child(this.head(t, "Crew", snap.crew.length).border_t(0))
      .child(v_flex().id("fx-crew").h(listH).py(4).gap(2).overflow_y_scrollbar().children(rows.length ? rows : [empty]));
  }

  intakeSection(t, snap, brand) {
    const queue = snap.stages.intake;
    const now = Date.now();
    const newIssue = h_flex().id("fx-new").h(20).px(7).gap(4).items_center().rounded(5).border(1).border_color(t.border)
      .bg(t.surface).hover((s) => s.bg(t.hover)).cursor_pointer().tooltip("Open a new issue on GitHub")
      .on_click(() => open(cfg.url && `${cfg.url}/issues/new`))
      .child(svg(CHROME("plus")).size(10).text_color(t.muted)).child(div().text_size(10.5).text_color(t.muted).child("New issue"));
    const rows = queue.map((c) => {
      const armed = this.armed && this.armed.n === c.number && now - this.armed.at < 6000;
      const dispatch = h_flex().id(`fx-go-${c.key}`).flex_none().h(20).px(7).gap(4).items_center().rounded(5)
        .border(1).border_color(armed ? t.ansi3 : alpha(brand, "77")).bg(armed ? alpha(t.ansi3, "2a") : alpha(brand, "14"))
        .when(!c.demo, (el) => el.hover((s) => s.bg(alpha(brand, "30"))).cursor_pointer())
        .tooltip(c.demo ? "Sample work (demo)" : "Start a Claude Code worker on this issue in a new tab")
        .on_click((_e, cx) => {
          if (c.demo) return;
          if (armed) {
            this.armed = null;
            this.dispatch(c, snap);
          } else this.armed = { n: c.number, at: Date.now() };
          cx.notify();
        })
        .child(svg(ICON("bolt")).size(10).text_color(armed ? t.ansi3 : brand))
        .child(div().text_size(10.5).font_semibold().text_color(armed ? t.ansi3 : brand).child(armed ? "Sure?" : "Dispatch"));
      return v_flex().flex_none().gap(3).px(12).py(7).border_b(1).border_color(alpha(t.border, "88"))
        .child(h_flex().gap(7).items_center()
          .child(div().id(`fx-in-${c.key}`).font_family(MONO).font_bold().text_size(11).text_color(brand)
            .when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => open(c.issueUrl)))
            .child(`#${c.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(c.title))
          .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(ago(c.since))))
        .child(h_flex().gap(5).items_center()
          .children(c.labels.slice(0, 3).map((l) => div().px(5).rounded(3).text_size(10)
            .bg(alpha(`#${l.color}`, "30")).text_color(t.muted).child(l.name)))
          .child(div().flex_1())
          .child(dispatch));
    });
    const empty = v_flex().px(14).py(10).gap(4)
      .child(div().text_size(11.5).text_color(t.muted).child(WATCH_EMPTY))
      .child(div().text_size(10.5).text_color(t.dim).child("New issues land here first, oldest at the top."));
    return v_flex().flex_1().min_h(0)
      .child(this.head(t, "Intake", queue.length, newIssue))
      .child(v_flex().id("fx-intake").flex_1().min_h(0).overflow_y_scrollbar().children(rows.length ? rows : [empty]));
  }

  signalSection(t, snap) {
    const rows = snap.events.slice(0, 60).map((e, i) => h_flex().id(`fx-sig-${i}`).flex_none().gap(8).px(12).py(3).items_start()
      .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(clock(e.at)))
      .child(div().flex_none().pt(4).child(lamp(tone(t, e.tone), { size: 6 })))
      .child(div().flex_1().min_w(0).text_size(11).text_color(i === 0 ? t.foreground : t.muted).child(e.text)));
    return v_flex().flex_1().min_h(0)
      .child(this.head(t, "Signals", null))
      .child(v_flex().id("fx-signals").flex_1().min_h(0).py(4).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().px(14).py(8).text_size(11).text_color(t.dim).child("Quiet so far.")]));
  }

  dispatch(c, snap) {
    const s = snap.space;
    if (!s) {
      notify({ title: "No factory space", body: "Could not find the space to start the worker in.", level: "warning" });
      return;
    }
    const title = c.title.length > 34 ? `${c.title.slice(0, 33)}…` : c.title;
    run("tab.new", { space: s.id, name: `#${c.number} ${title}`, folder: s.folder || null, argv: ["claude"], task: workerTask(c.number) });
    pushEvent("working", `#${c.number} dispatched to a new worker`);
  }
}

const WATCH_EMPTY = "No open issues waiting.";
