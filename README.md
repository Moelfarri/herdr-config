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
  reorder. It takes tabs and agents dropped on a space. Each space keeps its
  own theme.
- `mods/space-menu` (from `menu`): the right-click menus for spaces, tabs and
  panes. Adds "Theme..." per space (Standard, Custom, Herdr) and "Move to".
- `mods/tabs-drag` (from `tabs`): the tab bar. Drag a tab to reorder, or out
  of the bar onto a space to move it. Scroll up or down to switch tabs. The
  side panel (Files, Changes, History) is remembered per space.
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
  has no command for this. `spaces-flat`, `space-menu` and `agents-spaces` call
  it.
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

Notes:

- The layout's background points at a generated sky picture in
  `themes/art/sky/live/`, which is not in the repo. `agents-spaces` writes a
  new one when the sakura-lofi theme shows; until then the area has no
  picture. The mod changes that path in `layouts/elias.json` about every
  20 minutes, so git often shows that file as changed.
- The sky asks MET Norway's public forecast API for the place in
  `custom-sakura-lofi.decor`. Change `sky` there for your own place.
