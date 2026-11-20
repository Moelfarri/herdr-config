# factory

A control room for an agent factory that works the GitHub issues of one
repository, set in `config.local.json` (kept out of Git; copy
`config.example.json` and fill in the host, owner and repo, and what
Dispatch tells a worker). Without it the floor shows demo work. It comes with the theme
**Factory** (`themes/custom-factory.json`): right-click a space > Theme... >
Custom > Factory, and the space's first tab gets the room; what the tab showed
stays, below the floor, as the small prompt area. Choose another theme and the
room goes, the tab as it was. `bin/factory-room.py` does it (space-menu and
spaces-flat run it); no layout file changes, so other spaces look as before.

```
┌──────────────────────────────────────────────┬────────────────┐
│ floor: title band, gauges, assembly line     │ feed: crew     │
│ 01 Intake > 02 Build > 03 Verify > 04 Review │       intake   │
│ > 05 Shipped, a card per issue               │       signals  │
├──────────────────────────────────────────────┤                │
│ the terminal you prompt (small)              │                │
└──────────────────────────────────────────────┴────────────────┘
```

One mod, two sections: `props.section` is `floor` or `feed`, and `props.space`
is the factory space's id. The tab tree is in herdr-core's `herdr-app`
document; drag the dividers to resize, and close a pane to remove it.

## What it reads

- GitHub, every 90 seconds (the refresh button asks now), with `gh`: open
  issues, issues closed in the last 7 days, open pull requests with their
  checks, and pull requests merged in the last 14 days.
- Herdr, live: the agents in the factory space and their terminal labels.

`watch_label` in `config.local.json` limits the line to issues with one
label (for example `factory`); `null` takes every open issue.

## How an issue moves

| Stage | When |
|---|---|
| Intake | open, nobody on it |
| Build | a worker has it, or its pull request is a draft |
| Verify | a pull request that closes it is open, checks run or fail |
| Review | that pull request is green: it waits for a person |
| Shipped | closed as completed in the last 7 days |

A pull request belongs to an issue when GitHub lists the issue in its
closing references (`Closes #12` in the body), or when its branch has
`issue-12` in the name.

## How a factory reports to the floor

A worker is any agent in the factory space. The floor links it to an issue
by its tab name (`#12 Fix login`) or by labels on its terminal, which any
controller can set with `hc label <terminal> key=value`:

| Label | Meaning |
|---|---|
| `factory.issue=12` | this worker has issue #12 |
| `factory.stage=verify` | where the worker says the issue is (`intake`, `build`, `verify`, `review`, `shipped`); wins over what GitHub implies |
| `factory.note=Running tests` | one line shown under the worker in Crew (else the terminal title) |

An agent in the same tab as the floor is the controller (CONTROL in Crew).

## Buttons

- A card opens its pull request, or its issue, in the browser.
- Crew: click an agent to go to it.
- Intake: `#12` opens the issue; Dispatch, then Sure?, starts Claude Code
  in a new tab of the factory space, named `#12 <title>`, with the task in
  config's `worker` (else a plain one: its own worktree and branch, and ask
  before it pushes, opens a pull request or writes on the issue).
- Demo / Hide demo: sample work on the floor. With nothing on the line and
  no workers it shows by itself, marked DEMO DATA. The choice is shared
  state `factory.demo`.

Signals (what moved, newest first) are kept in memory: a restart or a save
of the mod starts them over.
