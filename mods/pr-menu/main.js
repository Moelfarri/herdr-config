// The pull-request menu (new): the tabs in a space whose agent has opened a pull request,
// which the tab bar's button at the start of the bar opens (mods/tabs-drag). Those
// sessions are finished, or nearly, so this is the list of tabs to look over and close.
//
// Each row is one tab: its number (`#69`, tinted by what became of the pull request), its
// name and what became of it. Click a row, or Enter, to go to that tab; Esc closes the
// menu. ↑/↓ move. The menu never closes a tab or ends a session: the person does that
// themselves, in the tab bar.
//
// What a tab knows comes from the labels on its terminals (`pr`, `pr.state`), written by
// `bin/claude-pr.py` and `bin/pr-tabs.py`. Props: { space, names: { <tab id>: name } } —
// the tab bar passes the names it draws, so the two always say the same thing.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, terminals, run, theme, props, closeOverlay } from "herdr";

// What became of a pull request: the badge's color and the word on the right.
const STATES = {
  OPEN: { color: "accent", word: "open" },
  DRAFT: { color: "muted", word: "draft" },
  MERGED: { color: "done", word: "merged" },
  CLOSED: { color: "dim", word: "closed" },
  UNKNOWN: { color: "accent", word: "" },
};

// Remote ids carry a machine prefix; a label on that machine omits it.
const bare = (id) => String(id ?? "").split("/").pop();

// The tabs of this space that carry a pull request, in the space's own order.
function rows() {
  const p = props() ?? {};
  const space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
  if (!space) return [];
  const pulls = new Map();
  for (const term of terminals()) {
    const labels = term.labels ?? {};
    if (!labels.pr || !labels["herdr.tab"]) continue;
    pulls.set(bare(labels["herdr.tab"]), { number: labels.pr, state: (labels["pr.state"] ?? "UNKNOWN").toUpperCase() });
  }
  return (space.tabs ?? [])
    .filter((c) => pulls.has(bare(c.id)))
    .map((c) => ({ id: c.id, active: c.active, name: (p.names ?? {})[bare(c.id)] ?? c.name, pr: pulls.get(bare(c.id)) }));
}

export default class PrMenu extends View {
  init(_props, cx) {
    this.at = Math.max(0, rows().findIndex((r) => r.active));
    this.handle = cx.focus_handle();
    if (typeof props()?.overlay === "string") this.handle.focus();
  }

  // Goes to the tab, then closes this menu. Only an id it was given is ever closed: this
  // copy may not be an overlay at all.
  choose(row) {
    if (!row) return;
    run("tab.select", { id: row.id });
    this.dismiss();
  }

  dismiss() {
    const overlay = props()?.overlay;
    if (typeof overlay === "string" && overlay) closeOverlay(overlay);
  }

  render(cx) {
    const t = theme();
    const list = rows();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const badge = (pr) => {
      const color = t[STATES[pr.state]?.color ?? "accent"] ?? t.accent;
      return div().flex_none().px(5).h(16).rounded(5).bg(color + "26").text_size(10.5).font_semibold()
        .text_color(color).flex().items_center().child(`#${pr.number}`);
    };
    return v_flex()
      .id("pr-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (!list.length && e.key !== "escape") return;
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(list[this.at]);
        else if (e.key === "escape") this.dismiss();
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Pull requests"))
      .when(!list.length, (el) => el.child(div().px(8).h(31).flex().items_center().text_color(t.dim).child("No tab has one")))
      .children(
        list.map((row, i) =>
          h_flex()
            .id(`pr-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_mouse_move((_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
            .on_click(() => this.choose(row))
            .child(badge(row.pr))
            .child(div().flex_1().min_w(0).truncate().child(row.name))
            .when(row.active, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("here now")))
            .when(Boolean(STATES[row.pr.state]?.word), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(STATES[row.pr.state].word))),
        ),
      );
  }
}
