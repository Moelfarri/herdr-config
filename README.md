# herdr-config

My setup for [Herdr](https://herdr.dev), the desktop app for running coding
agents (Claude Code, Codex, ...) side by side in spaces, tabs and terminals.
Herdr's whole UI is files in `~/.config/herdr-app`: layouts, mods (small
JavaScript panels), themes and keys. This repo holds only my own files there;
Herdr's shipped files and its state are left out by a whitelist `.gitignore`.

## What is in it

### Layout

- `layouts/elias.json`: my window, cloned from Herdr's `main` layout. A
  sidebar with Spaces (`spaces-flat`) over Agents (`agents-spaces`), a tab bar
  (`tabs-drag`), the terminals with rounded pane frames, a side panel that
  stacks Files, Changes and History (`agent-history`), and a status bar. The
  terminals are 60 % opaque, so the theme's backdrop shows through them.

### Mods

Each one is a clone of a shipped mod that I changed, or a new one.

- `mods/agents-spaces` (from `agents`): the selected space's agents in three
  groups, "Needs your attention", "Working" and "Idle". Drag an agent to
  reorder, or drag it onto a space in the Spaces list to move it there.
  Right-click for priority, progress and "Move to". A theme can add decor
  (`themes/art/<theme>.decor`): a brush title card, a seal, calligraphy, a
  live sky and a landscape behind the terminals.
  - `astro.js`: where the sun and moon stand, and the moon's phase.
  - `sky.js`: the weather from MET Norway (`api.met.no`), at most every
    30 minutes, and the light washes on the agents panel.
  - `skysvg.js`: draws the live sky as an SVG (sun, moon, stars, clouds, rain,
    snow).
  - `backdrop.js`: points the layout's background at the sky picture of the
    moment, in `themes/art/sky/live/`.
- `mods/spaces-flat` (from `spaces`): a flat Spaces list with coloured
  avatars, each repo's branch and ahead/behind, machines as groups, drag to
  reorder. Each space keeps its own theme. A space (other than the one shown)
  with agents that need you is flagged: tinted in the most urgent status
  colour, a bar on its edge, and a pill such as "2 need you". It publishes
  where its rows are (shared `space.targets`) for `space-drag`.
- `mods/space-drag` (new): the drag layer. When an agent or a tab is dragged
  out of its list, a frameless window over the whole window draws its card
  under the pointer and lights up the space it would land on. Let go on a
  space and it moves there; anywhere else, or Esc, and nothing happens.
- `mods/space-menu` (from `menu`): the right-click menus for spaces, tabs and
  panes. Adds "Theme..." per space (Standard, Custom, Herdr) and "Move to",
  and "Clear PR" on a tab that carries a pull-request badge it should not have
  (a session that only read somebody else's).
- `mods/tabs-drag` (from `tabs`): the tab bar. Drag a tab to reorder, or out
  of the bar onto a space to move it. Scroll up or down to switch tabs. The
  side panel (Files, Changes, History) is remembered per space.
  Sessions that have opened a pull request carry its number (`#69`) in the
  colour of what became of it: accent for open, grey for a draft, green for
  merged. A button at the start of the bar shows how many there are and opens
  them as a menu (`pr-menu`). `PR_SPACES` in the mod says which spaces have the
  button ("Dagens arbeid"). It runs `bin/pr-tabs.py` every half minute.
- `mods/pr-menu` (new): the tab bar's pull-request menu. One row per tab with a
  pull request; click a row (or Enter) to go to that tab. It never closes a
  tab or ends a session: you do that yourself.
- `mods/agent-history` (new): closed Claude Code and Codex conversations,
  newest first, to resume one in a new tab. A popup (Cmd-Y) and a side panel.
  `history.py` reads `~/.claude/projects` and `~/.codex` on this computer
  only; it writes nothing but a cache file.

### Themes

Custom themes are named `custom-<name>`, so the space menu lists them apart
from Herdr's own.

- `themes/custom-bamboo-ink.json`: warm ink-black, with bamboo and sakura art
  behind the agents list (`themes/art/custom-bamboo-ink.svg`) and brush decor.
- `themes/custom-sakura-lofi.json`: night sakura in violet and peach. Its
  decor shows the live sky over Oslo and a lake-and-volcano landscape behind
  the terminals (`themes/art/backdrops/custom-sakura-lofi.svg`, drawn by
  `make_backdrop.py` in the same folder).

### Scripts

- `bin/move-to-space.py`: moves a tab, or one pane, to another space. Herdr
  has no command for this, so it edits Herdr's layout document in herdr-core
  (`hc connect`, version-checked) and relabels the terminals. `space-drag`
  and `space-menu` call it.
- `bin/pr-tabs.py`: the pull-request sweep the tab bar runs. It reads the
  screen of every agent whose turn has ended, takes the pull request URL it
  shows, and writes it on that Herdr terminal as the labels `pr`, `pr.url` and
  `pr.state` (asked of `gh` at most every three minutes). This is what covers
  Codex and any other agent without hooks. "Clear PR" in a tab's right-click
  menu takes the labels off and leaves that tab alone (`pr.off`).
- `bin/claude-pr.py`: a Claude Code `PostToolUse` hook (Bash). It writes the
  same labels the moment a session opens a pull request — the URL a command
  printed, unless the command only read pull requests (`gh pr list`, `gh pr
  view`, ...), so opening one through a script counts too.
- `bin/claude-progress.py`: a Claude Code `PostToolUse` hook. It writes the
  session's task-list progress as a label on its Herdr terminal, and
  `agents-spaces` draws it as a progress bar.

### Other

- `fonts/`: Yuji Boku, the brush font of the decor. SIL Open Font License 1.1
  (`fonts/YujiBoku-OFL.txt`), from the
  [Yuji project](https://github.com/Kinutafontfactory/Yuji).
- `keys.json`: my key bindings (macOS).
- `settings.json`: my settings.

## Use it

You need Herdr, `python3`, and Herdr's `hc` command on your `PATH`.

1. Put the files in `~/.config/herdr-app`. Before Herdr has run once:

   ```sh
   git clone https://github.com/Moelfarri/herdr-config.git ~/.config/herdr-app
   ```

   When the folder already exists (this replaces your `keys.json` and
   `settings.json`):

   ```sh
   cd ~/.config/herdr-app
   git init -b main
   git remote add origin https://github.com/Moelfarri/herdr-config.git
   git fetch origin
   git checkout -f -t origin/main
   ```

2. Switch to the layout: Cmd-Shift-L (in this `keys.json`) cycles through the
   layouts until `elias` shows. It uses the mods above
   and Herdr's own `workspace-chrome`, `pane`, `files`, `changes` and
   `workspace-status`.
3. Give a space a theme: right-click it, then Theme... > Custom.
4. For the progress bars, add the hook to `~/.claude/settings.json`:

   ```json
   "hooks": {
     "PostToolUse": [
       {
         "matcher": "TodoWrite|TaskCreate|TaskUpdate",
         "hooks": [
           { "type": "command", "command": "python3 -I ~/.config/herdr-app/bin/claude-progress.py", "timeout": 10 }
         ]
       }
     ]
   }
   ```

   And for the pull-request badges, in the same `"PostToolUse"` list:

   ```json
   {
     "matcher": "Bash",
     "hooks": [
       { "type": "command", "command": "python3 -I ~/.config/herdr-app/bin/claude-pr.py", "timeout": 10 }
     ]
   }
   ```

Notes:

- The layout's background points at a generated sky picture in
  `themes/art/sky/live/`, which is not in the repo. `agents-spaces` writes a
  new one when the sakura-lofi theme shows; until then the area has no
  picture. The mod changes that path in `layouts/elias.json` about every
  20 minutes, so git often shows that file as changed.
- The sky asks MET Norway's public forecast API for the place in
  `custom-sakura-lofi.decor`. Change `sky` there for your own place.
