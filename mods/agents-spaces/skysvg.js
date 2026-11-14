// The live sky behind the terminal area, as an SVG picture (384x216, scaled up by
// Herdr: everything in it is soft on purpose). Pure: no Herdr imports, so it runs in
// tests too.
//
// Herdr keeps every background picture it has loaded until it restarts, so the sky is
// drawn from a rounded state (`skyState`): the same state gives the same picture and
// the same file name (`skyKey`), and Herdr loads it only once.
//
// Seen facing south: east at the left, west at the right, the horizon at the lake's far
// shore (where the backdrop's landscape puts it). The sun and the moon each cross the
// picture on an arc (`arcPlace`): up at the left edge when they really rise, highest
// when they really stand highest, down at the right edge when they really set. The
// real sky is too low for the picture much of the year (Oslo's winter sun stays under
// 10°, behind the volcano), so the arc keeps them in view and moving all through their
// time up; only its top follows the season (lower in winter). The light of the hour
// still follows the sun's real altitude.

import { sunAt, moonAt } from "./astro.js";

const W = 384;
const H = 216;
const HORIZON = 177;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const round = (v, step) => Math.round(v / step) * step;
const fixed = (v) => Number(v.toFixed(1));
// A steady pseudo-random number in [0, 1) for item `i`.
const rnd = (i, k) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// A body is drawn from this altitude (deg), just under the horizon line.
const UP = -1.5;
// The arc: from the left edge to the right one, inside what "cover" crops off the
// sides, and its top (y) for a pass that stands 55° high (summer sun) or low (winter
// sun; always above the volcano's summit at y 79).
const ARC_LEFT = 40;
const ARC_RIGHT = W - 40;
const ARC_HIGH = 30;
const ARC_LOW = 60;
const STEP = 5 * 60000;
const REACH = 26 * 3600000;

// Body name -> the last pass found, kept until that pass is over.
const passes = new Map();

/** The pass (time up) of a body that holds `ms`, for `at` (sunAt or moonAt):
 *  { rise, set (ms), peak (deg) }, or null when the body is down. Found in 5-minute
 *  steps, the edges where it crosses `UP`. */
export function passOf(body, at, ms, lat, lon) {
  const alt = (t) => at(t, lat, lon).altitude;
  const now = alt(ms);
  if (now <= UP) return null;
  const kept = passes.get(body);
  if (kept && kept.lat === lat && kept.lon === lon && ms >= kept.rise && ms <= kept.set) return kept;
  let peak = now;
  const edge = (dir) => {
    let t = ms;
    let a = now;
    for (let n = 0; n < REACH / STEP; n++) {
      const t2 = t + dir * STEP;
      const a2 = alt(t2);
      if (a2 <= UP) return t + dir * STEP * (a - UP) / (a - a2);
      peak = Math.max(peak, a2);
      t = t2;
      a = a2;
    }
    return t;
  };
  const pass = { lat, lon, rise: edge(-1), set: edge(1), peak };
  passes.set(body, pass);
  return pass;
}

/** Where a body at `altitude` (deg) at `ms` sits on the arc of its `pass`: across by
 *  the share of its time up, up by the share of its highest altitude on the pass. */
export function arcPlace(pass, ms, altitude) {
  const u = clamp((ms - pass.rise) / Math.max(1, pass.set - pass.rise));
  const x = ARC_LEFT + (ARC_RIGHT - ARC_LEFT) * u;
  const top = ARC_LOW + (ARC_HIGH - ARC_LOW) * clamp(pass.peak / 55);
  const y = altitude >= 0
    ? HORIZON - (HORIZON - top) * Math.pow(clamp(altitude / Math.max(pass.peak, 0.5)), 0.75)
    : HORIZON - altitude * 3;
  return { x, y };
}

// Where body `name` stands in the picture at `ms`, to 2 px: { x, y }, or nulls when down.
function spot(name, at, ms, sky) {
  const pass = passOf(name, at, ms, sky.lat, sky.lon);
  if (!pass) return { x: null, y: null };
  const p = arcPlace(pass, ms, at(ms, sky.lat, sky.lon).altitude);
  return { x: round(p.x, 2), y: round(p.y, 2) };
}

// MET Norway's weather symbol (e.g. "lightrainshowers_day", "heavysnow", "fog").
function readWeather(w) {
  if (!w) return { cloud: 0, wind: 2, precip: null, amount: 0, thunder: false, fog: false };
  const s = String(w.symbol ?? "").replace(/_(day|night|polartwilight)$/, "");
  const precip = /snow/.test(s) ? "snow" : /sleet/.test(s) ? "sleet" : /rain|drizzle/.test(s) ? "rain" : null;
  const amount = !precip ? 0 : s.startsWith("light") ? 1 : s.startsWith("heavy") ? 3 : 2;
  return { cloud: clamp(Number(w.cloud) / 100), wind: Number(w.wind) || 0, precip, amount, thunder: /thunder/.test(s), fog: s === "fog" };
}

/** The sky at `ms` for `sky` ({ lat, lon }) and the forecast hour `w` (or null),
 *  rounded so it changes in visible steps. */
export function skyState(ms, sky, w) {
  const sun = sunAt(ms, sky.lat, sky.lon);
  const moon = moonAt(ms, sky.lat, sky.lon);
  const wx = readWeather(w);
  const altStep = (a) => (Math.abs(a) < 12 ? 1.5 : 3);
  const cover = Math.max(wx.cloud, wx.precip ? 0.6 : 0, wx.fog ? 0.5 : 0);
  const sunSpot = spot("sun", sunAt, ms, sky);
  const moonSpot = spot("moon", moonAt, ms, sky);
  return {
    sunAlt: round(sun.altitude, altStep(sun.altitude)),
    sunX: sunSpot.x,
    sunY: sunSpot.y,
    moonAlt: round(moon.altitude, altStep(moon.altitude)),
    moonX: moonSpot.x,
    moonY: moonSpot.y,
    phase: Math.round(moon.phase * 24) % 24,
    clouds: Math.min(6, Math.floor(cover * 6 + 0.25)),
    precip: wx.precip,
    amount: wx.amount,
    thunder: wx.thunder,
    fog: wx.fog,
    windy: wx.wind > 8,
  };
}

/** A file name for the state: the same state, the same name. */
export function skyKey(s) {
  const n = (v) => String(v).replace("-", "m").replace(".", "p");
  const at = (x, y) => (x === null ? "d" : `x${x}y${y}`);
  return [`s${n(s.sunAlt)}${at(s.sunX, s.sunY)}`, `m${n(s.moonAlt)}${at(s.moonX, s.moonY)}p${s.phase}`,
    `c${s.clouds}${s.precip ?? "dry"}${s.amount}${s.thunder ? "t" : ""}${s.fog ? "f" : ""}${s.windy ? "w" : ""}`].join("-");
}

/** How light it is: { day, golden, night, dark, cover } (0..1), for the panel's washes too. */
export function lightOf(s) {
  const alt = s.sunAlt;
  return {
    day: clamp(alt / 15),
    golden: clamp(1 - Math.abs(alt - 1) / 9) * (1 - 0.6 * (s.clouds / 6)),
    night: clamp((-3 - alt) / 9),
    dark: clamp((-4 - alt) / 8),
    cover: s.clouds / 6,
  };
}

// The sky's colours (top, middle, horizon) by the sun's altitude.
const KEYS = [
  [-18, "#07070f", "#0b0b1a", "#15132a"],
  [-10, "#0b0c1e", "#131430", "#241f3f"],
  [-5, "#141838", "#2a2650", "#5a3f6e"],
  [-1, "#1f2350", "#5b4677", "#d9787c"],
  [2, "#2c3a72", "#8a6a9a", "#f2a072"],
  [7, "#3a5592", "#8c8fc0", "#f0c09a"],
  [15, "#4466a8", "#8ea5d8", "#d8d6ea"],
  [40, "#3d63b0", "#86a8e0", "#cfdcf2"],
];
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => "#" + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
function skyColours(alt) {
  if (alt <= KEYS[0][0]) return KEYS[0].slice(1);
  for (let i = 1; i < KEYS.length; i++) {
    if (alt <= KEYS[i][0]) {
      const t = (alt - KEYS[i - 1][0]) / (KEYS[i][0] - KEYS[i - 1][0]);
      return [1, 2, 3].map((k) => mix(KEYS[i - 1][k], KEYS[i][k], t));
    }
  }
  return KEYS[KEYS.length - 1].slice(1);
}

// The lit part of the moon (radius r at cx, cy) for phase index p of 24: lit on the
// right while waxing, on the left while waning.
function moonPath(cx, cy, r, p) {
  const f = p / 24;
  const rx = Math.abs(Math.cos(2 * Math.PI * f)) * r;
  const waxing = f < 0.5;
  const gibbous = f > 0.25 && f < 0.75;
  const limb = waxing ? 1 : 0;
  const term = waxing ? (gibbous ? 1 : 0) : (gibbous ? 0 : 1);
  return `M${cx} ${fixed(cy - r)} A${r} ${r} 0 0 ${limb} ${cx} ${fixed(cy + r)} A${fixed(rx)} ${r} 0 0 ${term} ${cx} ${fixed(cy - r)} Z`;
}

// Cloud slots, filled in this order as the cover grows: x, y, width.
const CLOUDS = [[70, 72, 92], [262, 54, 80], [160, 104, 112], [330, 112, 74], [24, 130, 84], [214, 142, 104]];

function cloud(x, y, w, fill, opacity) {
  const h = w * 0.3;
  const puffs = [[0.22, 0.62, 0.22, 0.38], [0.42, 0.42, 0.24, 0.5], [0.62, 0.5, 0.2, 0.42], [0.8, 0.66, 0.18, 0.32], [0.5, 0.72, 0.46, 0.28]];
  return `<g fill="${fill}" opacity="${opacity}">` + puffs.map(([px, py, rx, ry]) =>
    `<ellipse cx="${fixed(x + px * w)}" cy="${fixed(y + py * h)}" rx="${fixed(rx * w)}" ry="${fixed(ry * h * 1.4)}"/>`).join("") + "</g>";
}

/** The picture for state `s`. */
export function skySvg(s) {
  const L = lightOf(s);
  const alt = s.sunAlt;
  let [top, mid, hor] = skyColours(alt);
  // Clouds grey the sky: light grey by day, dark at night.
  const grey = mix("#1e1d2a", "#8d8ca0", L.day);
  const g = L.cover * 0.7;
  [top, mid, hor] = [mix(top, grey, g), mix(mid, grey, g), mix(hor, grey, g * 0.8)];

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  out.push(`<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${top}"/><stop offset="0.55" stop-color="${mid}"/>`
    + `<stop offset="${fixed(HORIZON / H)}" stop-color="${hor}"/><stop offset="1" stop-color="${hor}"/></linearGradient>`
    + `<radialGradient id="sunglow"><stop offset="0" stop-color="${mix("#ff9a5c", "#fff1d6", L.day)}" stop-opacity="0.7"/>`
    + `<stop offset="0.35" stop-color="${mix("#ff9a5c", "#fff1d6", L.day)}" stop-opacity="0.25"/>`
    + `<stop offset="1" stop-color="#ffd9b0" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="moonglow"><stop offset="0" stop-color="#f8e3c8" stop-opacity="0.5"/>`
    + `<stop offset="1" stop-color="#f8e3c8" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8d2e2" stop-opacity="0"/>`
    + `<stop offset="1" stop-color="#d8d2e2" stop-opacity="0.6"/></linearGradient></defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/>`);

  // Stars, hidden by clouds, paled by a bright moon.
  const moonLight = (1 - Math.abs(s.phase - 12) / 12) * clamp(s.moonAlt / 10);
  const seen = L.dark * Math.pow(1 - L.cover, 1.5) * (1 - 0.4 * moonLight);
  if (seen > 0.02) {
    for (let i = 0; i < 48; i++) {
      const x = fixed(rnd(i, 1) * W), y = fixed(rnd(i, 2) * (HORIZON - 20));
      out.push(`<circle cx="${x}" cy="${y}" r="${fixed(0.5 + rnd(i, 3) * 0.7)}" fill="#fff6e8" fill-opacity="${fixed((0.35 + rnd(i, 4) * 0.6) * seen * 10) / 10}"/>`);
    }
  }

  // The moon in its phase on its arc (the dark part faintly lit by the earth, so a thin
  // moon still reads as a disc), fainter by day and behind clouds.
  const op = (v) => fixed(v * 100) / 100;
  const moonUp = s.moonX !== null && s.moonAlt > UP;
  const moonO = moonUp ? clamp((s.moonAlt + 1.5) / 2) * (1 - 0.5 * L.day) : 0;
  const lit = (1 - Math.cos(2 * Math.PI * s.phase / 24)) / 2;
  if (moonUp) {
    const [x, y] = [fixed(s.moonX), fixed(s.moonY)];
    out.push(`<g opacity="${op(moonO * (1 - 0.45 * L.cover))}"><circle cx="${x}" cy="${y}" r="${fixed(26 + 20 * lit)}" fill="url(#moonglow)" fill-opacity="${op(0.35 + 0.65 * lit)}"/>`
      + `<circle cx="${x}" cy="${y}" r="9.5" fill="#f8e3c8" fill-opacity="0.2"/>`
      + (s.phase ? `<path d="${moonPath(x, y, 9.5, s.phase)}" fill="#fbeedd"/>` : "") + "</g>");
  }

  // The sun on its arc: pale and high, orange and low; dimmed by clouds.
  const sunUp = s.sunX !== null && alt > UP;
  const sunO = sunUp ? clamp((alt + 1.5) / 2) : 0;
  const sunCore = mix("#ff8a4c", "#ffefcf", L.day);
  if (sunUp) {
    const [x, y] = [fixed(s.sunX), fixed(s.sunY)];
    out.push(`<g opacity="${op(sunO * (1 - 0.45 * L.cover))}"><circle cx="${x}" cy="${y}" r="60" fill="url(#sunglow)"/>`
      + `<circle cx="${x}" cy="${y}" r="15" fill="${sunCore}" fill-opacity="0.3"/>`
      + `<circle cx="${x}" cy="${y}" r="10" fill="${sunCore}"/></g>`);
  }

  // Clouds: white by day, pink-lit at golden hour, dark and moonlit at night.
  const cloudFill = mix(mix("#3a3650", "#f6c3b4", clamp((alt + 6) / 8)), "#f4f1f8", L.day);
  CLOUDS.slice(0, s.clouds).forEach(([x, y, w], i) => out.push(cloud(x, y, w, cloudFill, fixed(0.55 + 0.25 * L.day + (i % 2) * 0.05))));
  if (s.clouds >= 6) out.push(`<rect width="${W}" height="${HORIZON}" fill="${cloudFill}" opacity="0.25"/>`);

  // Behind clouds, the sun and the moon still light them where they stand.
  if (sunUp && L.cover > 0.15) {
    out.push(`<circle cx="${fixed(s.sunX)}" cy="${fixed(s.sunY)}" r="40" fill="url(#sunglow)" opacity="${op(sunO * 0.7 * L.cover)}"/>`);
  }
  if (moonUp && L.cover > 0.15) {
    out.push(`<circle cx="${fixed(s.moonX)}" cy="${fixed(s.moonY)}" r="${fixed(22 + 14 * lit)}" fill="url(#moonglow)" opacity="${op(moonO * (0.3 + 0.5 * lit) * L.cover)}"/>`);
  }

  if (s.thunder) {
    out.push(`<rect width="${W}" height="${H}" fill="#e8e4ff" opacity="0.1"/>`
      + `<path d="M196 112 L186 134 L194 134 L186 158 L206 128 L198 128 L206 112 Z" fill="#fff4d6" opacity="0.9"/>`);
  }

  // Rain falls aslant in wind; snow is flakes. Sleet is both.
  const n = s.precip ? 22 * s.amount : 0;
  const slant = s.windy ? 5 : 2;
  for (let i = 0; i < n; i++) {
    const x = fixed(rnd(i, 5) * (W + 20) - 10), y = fixed(30 + rnd(i, 6) * (HORIZON - 34));
    const snow = s.precip === "snow" || (s.precip === "sleet" && i % 2 === 0);
    out.push(snow
      ? `<circle cx="${x}" cy="${y}" r="${fixed(0.8 + rnd(i, 7) * 0.8)}" fill="#ffffff" fill-opacity="0.8"/>`
      : `<line x1="${x}" y1="${y}" x2="${fixed(x - slant)}" y2="${fixed(y + 8)}" stroke="#c9d4ee" stroke-opacity="0.55" stroke-width="0.8" stroke-linecap="round"/>`);
  }
  if (s.fog) out.push(`<rect y="96" width="${W}" height="${H - 96}" fill="url(#fog)"/>`);
  out.push("</svg>\n");
  return out.join("");
}
