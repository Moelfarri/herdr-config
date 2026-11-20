// The factory floor's data: GitHub (issues, pull requests, checks) and Herdr (the
// agents in the factory space), turned into one picture of the line. Every copy of
// the mod (floor, feed) shares this module, so GitHub is asked once per refresh.
//
// Stages of an issue, left to right:
//   intake  - open, nobody on it yet
//   build   - a worker agent has it (tab "#12 ...", or label factory.issue=12),
//             or its pull request is still a draft
//   verify  - a pull request that closes it is open and its checks run or fail
//   review  - that pull request is green and waits for a person
//   shipped - closed as completed in the last SHIPPED_DAYS days
// A worker can say where it is itself: label factory.stage=<stage> on its terminal.

import { exec, agents, terminals, spaces, panes, shared, readTextFile, appHome } from "herdr";

// Which repository the floor watches, and what a dispatched worker is told: the file
// config.local.json next to this one, kept out of Git (config.example.json shows the
// keys). Without it the floor shows demo work and says what is missing.
const CONFIG = "mods/factory/config.local.json";
export const cfg = { ready: false, missing: null, host: null, slug: null, url: null, title: "FACTORY", label: null, worker: null };

async function loadConfig() {
  if (cfg.ready) return;
  const raw = await readTextFile(`${appHome()}/${CONFIG}`).catch(() => null);
  if (!raw) {
    cfg.missing = `no repository: copy config.example.json to ${CONFIG}`;
    return;
  }
  try {
    const c = JSON.parse(raw);
    if (!c.owner || !c.repo) throw new Error("owner and repo are needed");
    cfg.host = c.host || "github.com";
    cfg.slug = `${c.owner}/${c.repo}`;
    cfg.url = `https://${cfg.host}/${cfg.slug}`;
    cfg.title = String(c.title || "FACTORY");
    cfg.label = c.watch_label || null; // only issues with this label enter the line
    cfg.worker = Array.isArray(c.worker) ? c.worker.join(" ") : c.worker || null;
    cfg.ready = true;
    cfg.missing = null;
  } catch (e) {
    cfg.missing = `${CONFIG}: ${e?.message ?? e}`;
  }
}
const REFRESH_MS = 90_000;
const RETRY_MS = 30_000;
const SHIPPED_DAYS = 7;
export const FLOW_DAYS = 14;
const MAX_EVENTS = 80;

export const STAGES = [
  { id: "intake", no: "01", label: "Intake", empty: "No open issues" },
  { id: "build", no: "02", label: "Build", empty: "No worker busy" },
  { id: "verify", no: "03", label: "Verify", empty: "Nothing in CI" },
  { id: "review", no: "04", label: "Review", empty: "Nothing waits for you" },
  { id: "shipped", no: "05", label: "Shipped", empty: `Nothing in ${SHIPPED_DAYS} days` },
];
const STAGE_IDS = new Set(STAGES.map((s) => s.id));

export const store = {
  gh: null, // { open, closed, prs, merged, at }
  error: null,
  fetching: null,
  lastAttempt: 0,
  events: [], // newest first: { at, tone, text }
  stages: null, // issue number -> stage, from the last real snapshot
  failing: new Set(), // pull requests whose checks failed last time
  agentStatus: new Map(), // address -> status
  started: false,
};

const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function gh(args) {
  const r = await exec("gh", [...args, "-R", `${cfg.host}/${cfg.slug}`], { timeout: 45_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `gh exited ${r.code}`).trim());
  return JSON.parse(r.stdout || "[]");
}

/** Asks GitHub again when the data is older than REFRESH_MS (or `force`). Resolves true
 *  when there is new data. Copies share one request. */
export function refresh(force = false) {
  if (store.fetching) return store.fetching;
  const now = Date.now();
  if (!force && store.gh && now - store.gh.at < REFRESH_MS - 2000) return Promise.resolve(false);
  if (!force && store.error && now - store.lastAttempt < RETRY_MS) return Promise.resolve(false);
  store.lastAttempt = now;
  const issueFields = "number,title,state,stateReason,labels,assignees,author,createdAt,updatedAt,closedAt,url";
  store.fetching = (async () => {
    try {
      await loadConfig();
      if (!cfg.ready) throw new Error(cfg.missing);
      const label = cfg.label ? ["--label", cfg.label] : [];
      const [open, closed, prs, merged] = await Promise.all([
        gh(["issue", "list", "--state", "open", "--limit", "100", ...label, "--json", issueFields]),
        gh(["issue", "list", "--state", "closed", "--limit", "50", ...label,
          "--search", `closed:>=${isoDay(now - SHIPPED_DAYS * DAY)}`, "--json", issueFields]),
        gh(["pr", "list", "--state", "open", "--limit", "60", "--json",
          "number,title,url,headRefName,isDraft,reviewDecision,statusCheckRollup,closingIssuesReferences,author,createdAt,updatedAt"]),
        gh(["pr", "list", "--state", "merged", "--limit", "300", "--search", `merged:>=${isoDay(now - FLOW_DAYS * DAY)}`,
          "--json", "number,title,url,mergedAt,closingIssuesReferences"]),
      ]);
      store.gh = { open, closed, prs, merged, at: Date.now() };
      store.error = null;
      return true;
    } catch (e) {
      store.error = String(e?.message ?? e).split("\n")[0].slice(0, 140);
      return true;
    } finally {
      store.fetching = null;
    }
  })();
  return store.fetching;
}

export function pushEvent(tone, text, at = Date.now()) {
  store.events.unshift({ at, tone, text });
  if (store.events.length > MAX_EVENTS) store.events.length = MAX_EVENTS;
}

// --- Herdr side ---------------------------------------------------------------

/** The factory space: the one given in props, else the space holding a factory pane,
 *  else one whose name says factory. */
export function factorySpace(spaceId) {
  const all = spaces();
  if (spaceId) {
    const s = all.find((x) => x.id === spaceId);
    if (s) return s;
  }
  const pane = panes().find((p) => p.mod === "factory");
  if (pane) {
    const s = all.find((x) => x.tabs.some((t) => t.id === pane.tab));
    if (s) return s;
  }
  return all.find((x) => /factory/i.test(x.name)) ?? null;
}

/** The tabs of a space that show the floor: their agents are controllers (the one you prompt). */
function floorTabs(space) {
  const mine = new Set(space.tabs.map((t) => t.id));
  return new Set(panes().filter((p) => p.mod === "factory" && mine.has(p.tab)).map((p) => p.tab));
}

/** The crew: every agent in the factory space, the controller first. */
export function crew(space) {
  if (!space) return [];
  const labels = new Map(terminals().map((t) => [t.address, t.labels ?? {}]));
  const tabs = new Map(space.tabs.map((t) => [t.id, t]));
  const control = floorTabs(space);
  const list = agents()
    .filter((a) => a.space === space.id)
    .map((a) => {
      const l = labels.get(a.address) ?? {};
      const issue = Number(l["factory.issue"] ?? (a.tab_name.match(/#(\d+)/) ?? [])[1]) || null;
      const stage = STAGE_IDS.has(l["factory.stage"]) ? l["factory.stage"] : null;
      const tab = tabs.get(a.tab);
      return {
        address: a.address,
        pane: a.pane,
        status: a.status,
        program: a.program,
        name: a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : `Tab ${a.tab_index}`,
        note: l["factory.note"] || a.title || "",
        issue,
        stage,
        controller: control.has(a.tab),
        since: tab?.working_since ?? null,
        demo: false,
      };
    });
  list.sort((x, y) => Number(y.controller) - Number(x.controller));
  return list;
}

/** Records agent state changes as signals. Cheap; safe to call on every render. */
export function watchCrew(list) {
  for (const w of list) {
    if (w.demo) continue;
    const before = store.agentStatus.get(w.address);
    store.agentStatus.set(w.address, w.status);
    if (before === undefined || before === w.status) continue;
    const who = w.controller ? "Controller" : w.issue ? `Worker on #${w.issue}` : w.name;
    if (w.status === "blocked") pushEvent("blocked", `${who} needs you`);
    else if (w.status === "done") pushEvent("done", `${who} finished`);
    else if (w.status === "working" && before !== "working") pushEvent("working", `${who} started working`);
  }
}

// --- The line -----------------------------------------------------------------

export function checks(rollup) {
  const c = { pass: 0, fail: 0, pending: 0 };
  for (const r of rollup ?? []) {
    const v = String(r.conclusion || r.state || r.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) c.pass++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) c.fail++;
    else c.pending++;
  }
  return c;
}

function closes(pr, n) {
  if ((pr.closingIssuesReferences ?? []).some((r) => r.number === n)) return true;
  return new RegExp(`(^|[/_-])issue-?${n}($|[/_-])`, "i").test(pr.headRefName ?? "");
}

/** Cards per stage from GitHub data and the crew. */
function line(gh, workers) {
  const stages = Object.fromEntries(STAGES.map((s) => [s.id, []]));
  if (!gh) return stages;
  const now = Date.now();
  const byIssue = new Map();
  for (const w of workers) if (w.issue && !byIssue.has(w.issue)) byIssue.set(w.issue, w);
  for (const i of gh.open) {
    const prs = gh.prs.filter((p) => closes(p, i.number));
    const pr = prs.find((p) => !p.isDraft) ?? prs[0] ?? null;
    const worker = byIssue.get(i.number) ?? null;
    const c = pr ? checks(pr.statusCheckRollup) : null;
    let stage = "intake";
    if (pr && !pr.isDraft) stage = c.fail || c.pending ? "verify" : "review";
    else if (pr || worker) stage = "build";
    if (worker?.stage) stage = worker.stage;
    stages[stage].push({
      key: `i${i.number}`, number: i.number, title: i.title, url: pr?.url ?? i.url, issueUrl: i.url,
      labels: i.labels ?? [], since: Date.parse(i.createdAt), stage,
      pr: pr ? { number: pr.number, url: pr.url, draft: pr.isDraft, checks: c } : null,
      worker, red: Boolean(c?.fail),
    });
  }
  for (const i of gh.closed) {
    if (String(i.stateReason).toUpperCase() !== "COMPLETED") continue;
    const at = Date.parse(i.closedAt);
    if (!(now - at < SHIPPED_DAYS * DAY)) continue;
    const pr = gh.merged.find((p) => closes(p, i.number));
    stages.shipped.push({
      key: `i${i.number}`, number: i.number, title: i.title, url: i.url, issueUrl: i.url,
      labels: i.labels ?? [], since: at, stage: "shipped",
      pr: pr ? { number: pr.number, url: pr.url, draft: false, checks: null } : null, worker: null, red: false,
    });
  }
  stages.intake.sort((a, b) => a.since - b.since); // oldest first: first in, first out
  stages.shipped.sort((a, b) => b.since - a.since);
  return stages;
}

/** Signals for what moved since the last real snapshot. */
function watchLine(gh, stages) {
  if (!gh) return;
  const next = new Map();
  for (const s of STAGES) for (const c of stages[s.id]) next.set(c.number, c);
  if (store.stages) {
    for (const [n, c] of next) {
      const was = store.stages.get(n);
      if (was === c.stage) continue;
      if (!was && c.stage === "intake") pushEvent("idle", `#${n} entered intake: ${c.title}`);
      else if (c.stage === "shipped") pushEvent("done", `#${n} shipped`);
      else if (c.stage === "review") pushEvent("blocked", `#${n} is green and waits for your review`);
      else pushEvent("working", `#${n} moved to ${c.stage}`);
    }
  }
  store.stages = new Map([...next].map(([n, c]) => [n, c.stage]));
  const failing = new Set(gh.prs.filter((p) => checks(p.statusCheckRollup).fail).map((p) => p.number));
  if (store.started) {
    for (const n of failing) if (!store.failing.has(n)) pushEvent("blocked", `PR #${n}: checks failing`);
    for (const n of store.failing) if (!failing.has(n)) pushEvent("done", `PR #${n}: checks green again`);
  }
  store.failing = failing;
  if (!store.started) {
    store.started = true;
    pushEvent("idle", `Floor online, watching ${cfg.slug}`);
  }
}

/** Pull requests merged per day, oldest day first. */
function flow(gh) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = FLOW_DAYS - 1; i >= 0; i--) days.push({ start: today.getTime() - i * DAY, n: 0 });
  for (const p of gh?.merged ?? []) {
    const at = Date.parse(p.mergedAt);
    for (let i = days.length - 1; i >= 0; i--) {
      if (at >= days[i].start) {
        days[i].n++;
        break;
      }
    }
  }
  return days;
}

let lastGh = null;
/** Everything a view draws. `demo`: show sample work in place of the real line. */
export function snapshot(spaceId) {
  const space = factorySpace(spaceId);
  const real = crew(space);
  watchCrew(real);
  const gh = store.gh;
  const realStages = line(gh, real);
  if (gh && gh !== lastGh) {
    lastGh = gh;
    watchLine(gh, realStages);
  }
  const realCount = STAGES.reduce((n, s) => n + realStages[s.id].length, 0);
  const choice = shared("factory.demo");
  const demo = choice === true || (choice == null && (gh != null || Boolean(cfg.missing)) && realCount === 0 && real.filter((w) => !w.controller).length === 0);
  const workers = demo ? [...real.filter((w) => w.controller), ...demoCrew()] : real;
  const stages = demo ? demoLine(workers) : realStages;
  const openPrs = gh?.prs ?? [];
  const prChecks = openPrs.map((p) => checks(p.statusCheckRollup));
  const blockedCrew = workers.filter((w) => w.status === "blocked").length;
  return {
    space, demo, demoChoice: choice ?? null, gh, error: store.error, fetching: Boolean(store.fetching),
    stages, crew: workers,
    events: demo ? demoEvents() : store.events,
    stats: {
      queue: stages.intake.length,
      line: stages.build.length + stages.verify.length,
      needs: stages.review.length + blockedCrew,
      shipped: stages.shipped.length,
      flow: flow(gh),
      prs: { open: openPrs.length, green: prChecks.filter((c) => !c.fail && !c.pending).length,
        red: prChecks.filter((c) => c.fail).length, running: prChecks.filter((c) => !c.fail && c.pending).length },
    },
    running: workers.some((w) => w.status === "working" && !w.controller) || stages.build.length + stages.verify.length > 0,
  };
}

// --- Demo: sample work, so the floor can be seen before the factory runs -------

const MIN = 60_000;
function demoCrew() {
  const now = Date.now();
  const program = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false };
  return [
    { address: "demo-1", status: "working", program, name: "#121 Sheet row spacing", note: "Running the golden tests", issue: 121, stage: null, controller: false, since: now - 14 * MIN, demo: true },
    { address: "demo-2", status: "blocked", program, name: "#119 Offline banner on Home", note: "Asks: keep the iOS text?", issue: 119, stage: null, controller: false, since: null, demo: true },
    { address: "demo-3", status: "working", program, name: "#124 Share sheet safe area", note: "Writing the widget test", issue: 124, stage: null, controller: false, since: now - 3 * MIN, demo: true },
  ];
}

function demoLine(workers) {
  const now = Date.now();
  const w = (n) => workers.find((x) => x.issue === n) ?? null;
  const card = (number, title, stage, ageMin, extra = {}) => ({
    key: `d${number}`, number, title, url: null, issueUrl: null, labels: [], since: now - ageMin * MIN, stage,
    pr: null, worker: w(number), red: false, demo: true, ...extra,
  });
  const lab = (name, color) => ({ name, color });
  return {
    intake: [
      card(126, "Balance flickers after pull to refresh", "intake", 50, { labels: [lab("bug", "d73a4a")] }),
      card(127, "Dark mode: chips lose contrast", "intake", 22, { labels: [lab("bug", "d73a4a")] }),
      card(128, "Add «Share list» to the list menu", "intake", 6, { labels: [lab("enhancement", "a2eeef")] }),
    ],
    build: [
      card(121, "Sheet rows are 4 px too tall", "build", 95),
      card(124, "Share sheet ignores the safe area", "build", 40, { pr: { number: 131, draft: true, checks: null } }),
      card(119, "Offline banner shows twice on Home", "build", 180),
    ],
    verify: [
      card(117, "Close button misses its semantics label", "verify", 260, { pr: { number: 129, draft: false, checks: { pass: 6, fail: 0, pending: 3 } } }),
      card(116, "Brochure zoom resets on rotate", "verify", 400, { pr: { number: 127, draft: false, checks: { pass: 7, fail: 1, pending: 0 } }, red: true }),
    ],
    review: [
      card(114, "Price tag cut off at 200 % text", "review", 600, { pr: { number: 125, draft: false, checks: { pass: 9, fail: 0, pending: 0 } } }),
    ],
    shipped: [
      card(112, "Settings switch label typo", "shipped", 1500, { pr: { number: 122, draft: false, checks: null } }),
      card(110, "QR timer starts late", "shipped", 3100, { pr: { number: 118, draft: false, checks: null } }),
    ],
  };
}

function demoEvents() {
  const now = Date.now();
  const e = (min, tone, text) => ({ at: now - min * MIN, tone, text });
  return [
    e(1, "working", "Worker on #124 started working"),
    e(3, "blocked", "Worker on #119 needs you"),
    e(9, "working", "#117 moved to verify"),
    e(12, "blocked", "PR #127: checks failing"),
    e(18, "blocked", "#114 is green and waits for your review"),
    e(26, "idle", "#127 entered intake: Dark mode: chips lose contrast"),
    e(41, "done", "#112 shipped"),
    e(55, "idle", "Floor online, watching the repository"),
  ];
}
