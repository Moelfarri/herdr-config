// The picture behind the terminal area, for a theme whose decor has `backdrop`: the
// live sky (skysvg.js) on the tab block, the theme's landscape (`backdrop`, a picture
// with a transparent sky) on the pane frames, and `terminal_opacity` (default 0.6) so
// both show faintly through the terminals.
//
// Herdr can't redraw a background picture whose file changes, so this edits the shown
// layout's file directly: it points the tab block at the sky picture for the current
// state (themes/art/sky/live/<key>.svg). Never `layout.set`, which clears the person's
// clicks (sizes, theme picks). Only these three fields are touched, and only on a
// personal layout. When the shown theme has no backdrop, the person's own values come
// back (kept in localStorage the first time they were replaced).
//
// Herdr keeps every picture it has loaded until it restarts (about 2 MB for a sky), so
// the sky changes at most every `sky.update_minutes` (default 20), and at most hourly
// once this run has loaded 48 skies. Sky files not used for 7 days are deleted.
//
// No Herdr imports: main.js passes the host calls in, so the logic runs in tests too.

import { skySvg, skyKey } from "./skysvg.js";

const SHIPPED = new Set(["main", "terminals", "win98"]);
const LIVE = "themes/art/sky/live";
const CAP = 48;
const KEEP_DAYS = 7;

const isOurs = (bg) => typeof bg?.image === "string" && bg.image.startsWith("themes/art/");
const copy = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// The block that shows the active tab.
export function tabBlock(node) {
  if (node?.type === "block" && node.content?.tab === "active") return node;
  for (const c of node?.children ?? []) {
    const b = tabBlock(c);
    if (b) return b;
  }
  return null;
}

/** The person's own values of the three fields, or null when they are ours already. */
export function originalsOf(tree) {
  const block = tabBlock(tree);
  if (!block) return null;
  const pane = block.content.pane ?? {};
  if (isOurs(block.background) || isOurs(pane.background)) return null;
  return { block: copy(block.background), pane: copy(pane.background), opacity: copy(tree.terminal_opacity) };
}

/** `tree` with the backdrop `want` ({ sky: path | null, land: path, opacity }) applied,
 *  or, when `want` is null, with `originals` back. Changes `tree` in place. */
export function applyTo(tree, want, originals) {
  const block = tabBlock(tree);
  if (!block) return tree;
  const set = (o, k, v) => { if (v === null || v === undefined) delete o[k]; else o[k] = v; };
  if (want) {
    block.content.pane ??= {};
    set(block, "background", want.sky ? { image: want.sky, fit: "cover" } : "background");
    block.content.pane.background = { image: want.land, fit: "cover" };
    tree.terminal_opacity = want.opacity;
  } else {
    const o = originals ?? { block: null, pane: "background", opacity: null };
    if (!isOurs(block.background) && !isOurs(block.content.pane?.background) && !originals) return tree;
    set(block, "background", o.block);
    if (block.content.pane) set(block.content.pane, "background", o.pane);
    set(tree, "terminal_opacity", o.opacity);
  }
  return tree;
}

export class Backdrop {
  // io: { home(): string, layoutName(): string | null, readText(path), writeText(path, text, expected),
  //       exists(path), mkdir(path), write(path, text), list(dir): string[], remove(path), store: Storage }
  constructor(io) {
    this.io = io;
    this.sig = null; // what the layout holds now (as last written or checked)
    this.skyKey = null;
    this.skyAt = 0;
    this.loaded = new Set(); // sky pictures Herdr has loaded in this run
    this.busy = false;
    this.pausedUntil = 0;
    this.pruned = false;
  }

  /** Brings the layout in line with the shown theme's decor (null: a theme without one)
   *  and the sky `state`. Cheap when nothing changed; the work runs in `spawn`. */
  update(spawn, decor, state) {
    const name = this.io.layoutName();
    if (typeof name !== "string" || SHIPPED.has(name) || this.busy || Date.now() < this.pausedUntil) return;
    const land = typeof decor?.backdrop === "string" ? decor.backdrop : null;
    let key = land && decor.sky && state ? skyKey(state) : null;
    // Hold the sky picture until its time is up, so Herdr loads fewer of them.
    if (key && this.skyKey && key !== this.skyKey && this.sig?.includes(land)) {
      const minutes = this.loaded.size >= CAP ? 60 : Math.max(5, Number(decor.sky.update_minutes) || 20);
      if (Date.now() - this.skyAt < minutes * 60000) key = this.skyKey;
    }
    const want = land
      ? { sky: key ? `${LIVE}/${key}.svg` : null, land, opacity: Number(decor.terminal_opacity) || 0.6 }
      : null;
    const sig = JSON.stringify([name, want]);
    if (sig === this.sig) return;
    this.busy = true;
    spawn(async () => {
      try {
        if (key) await this.ensureSky(key, state);
        await this.write(name, want);
        this.sig = sig;
        if (key && key !== this.skyKey) {
          this.skyKey = key;
          this.skyAt = Date.now();
          this.loaded.add(key);
        }
      } catch (e) {
        console.log(`backdrop: ${e}`);
        this.pausedUntil = Date.now() + 60000;
      }
      this.busy = false;
    });
  }

  // Writes the sky picture for `key` unless it is there; notes its use; prunes old ones.
  async ensureSky(key, state) {
    const dir = `${this.io.home()}/${LIVE}`;
    const file = `${dir}/${key}.svg`;
    if (!(await this.io.exists(file))) {
      if (skyKey(state) !== key) throw new Error(`no picture for ${key}`);
      await this.io.mkdir(dir);
      await this.io.write(file, skySvg(state));
    }
    let used = {};
    try { used = JSON.parse(this.io.store.getItem("sky-used") ?? "{}") ?? {}; } catch { used = {}; }
    used[key] = Date.now();
    if (!this.pruned) {
      this.pruned = true;
      const old = Date.now() - KEEP_DAYS * 86400000;
      for (const f of await this.io.list(dir)) {
        const k = f.replace(/\.svg$/, "");
        if (f.endsWith(".svg") && !(used[k] > old)) {
          await this.io.remove(`${dir}/${f}`).catch(() => {});
          delete used[k];
        }
      }
    }
    this.io.store.setItem("sky-used", JSON.stringify(used));
  }

  // Applies `want` to the layout file `name`, keeping the person's own values first.
  async write(name, want) {
    const path = `${this.io.home()}/layouts/${name}.json`;
    const text = await this.io.readText(path);
    if (!text) return;
    const tree = JSON.parse(text);
    let all = {};
    try { all = JSON.parse(this.io.store.getItem("backdrop-originals") ?? "{}") ?? {}; } catch { all = {}; }
    const own = originalsOf(tree);
    if (own && want) {
      all[name] = own;
      this.io.store.setItem("backdrop-originals", JSON.stringify(all));
    }
    applyTo(tree, want, all[name] ?? null);
    const next = JSON.stringify(tree, null, 2) + "\n";
    if (next !== text) await this.io.writeText(path, next, text);
  }
}
