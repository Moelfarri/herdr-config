// Sun and moon as seen from a place on Earth, for the sky behind the agents list:
// how high they stand, in which direction, and how much of the moon is lit.
// Low-precision formulas from the astronomical almanacs (sun to about 0.01°, moon to
// a few tenths of a degree): plenty for a picture. Angles in degrees, times in ms
// since the epoch. Pure functions, no Herdr imports.

const RAD = Math.PI / 180;
const wrap = (deg) => ((deg % 360) + 360) % 360;
const sin = (deg) => Math.sin(deg * RAD);
const cos = (deg) => Math.cos(deg * RAD);

// Days since J2000.0 (2000-01-01 12:00 UT).
const daysOf = (ms) => ms / 86400000 - 10957.5;

// The sun's ecliptic longitude (deg) and the obliquity of the ecliptic.
function sunEcliptic(d) {
  const g = 357.529 + 0.98560028 * d;
  const q = 280.459 + 0.98564736 * d;
  return { lon: wrap(q + 1.915 * sin(g) + 0.02 * sin(2 * g)), lat: 0, eps: 23.439 - 0.00000036 * d };
}

// The moon's ecliptic longitude and latitude (deg) and distance (km): the largest
// periodic terms only.
function moonEcliptic(d) {
  const L = 218.3165 + 13.17639648 * d; // mean longitude
  const D = 297.8502 + 12.19074912 * d; // mean elongation
  const M = 357.5291 + 0.98560028 * d; // the sun's mean anomaly
  const Mp = 134.9634 + 13.06499295 * d; // the moon's mean anomaly
  const F = 93.2721 + 13.22935024 * d; // argument of latitude
  const lon = L + 6.289 * sin(Mp) + 1.274 * sin(2 * D - Mp) + 0.658 * sin(2 * D)
    + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F);
  const lat = 5.128 * sin(F) + 0.281 * sin(Mp + F) + 0.278 * sin(Mp - F) + 0.173 * sin(2 * D - F);
  const km = 385001 - 20905 * cos(Mp) - 3699 * cos(2 * D - Mp) - 2956 * cos(2 * D);
  return { lon: wrap(lon), lat, km, eps: 23.439 - 0.00000036 * d };
}

// Ecliptic to altitude and azimuth (azimuth from north, clockwise: 90 east, 180
// south, 270 west) for a place at `lat`, `lon` (east positive).
function horizontal(d, e, lat, lon) {
  const ra = Math.atan2(sin(e.lon) * cos(e.eps) - Math.tan(e.lat * RAD) * sin(e.eps), cos(e.lon)) / RAD;
  const dec = Math.asin(sin(e.lat) * cos(e.eps) + cos(e.lat) * sin(e.eps) * sin(e.lon)) / RAD;
  const H = wrap(280.46061837 + 360.98564736629 * d + lon - ra);
  const alt = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H)) / RAD;
  const az = Math.atan2(-sin(H), Math.tan(dec * RAD) * cos(lat) - sin(lat) * cos(H)) / RAD;
  return { altitude: alt, azimuth: wrap(az) };
}

// What the air adds near the horizon (deg), so rise and set match the almanacs.
function refraction(alt) {
  if (alt < -2) return 0;
  const h = Math.max(alt, -1.9);
  return 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * RAD) / 60;
}

/** The sun's centre: { altitude (with refraction), azimuth }. */
export function sunAt(ms, lat, lon) {
  const d = daysOf(ms);
  const p = horizontal(d, sunEcliptic(d), lat, lon);
  return { altitude: p.altitude + refraction(p.altitude), azimuth: p.azimuth };
}

/** The moon's centre seen from the ground: { altitude (parallax and refraction),
 *  azimuth, phase: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter,
 *  lit: the share of the disc that is lit (0..1), waxing }. */
export function moonAt(ms, lat, lon) {
  const d = daysOf(ms);
  const m = moonEcliptic(d);
  const p = horizontal(d, m, lat, lon);
  const parallax = Math.asin(6378.14 / m.km) / RAD;
  const alt = p.altitude - parallax * cos(p.altitude);
  const elong = wrap(m.lon - sunEcliptic(d).lon);
  const lit = (1 - cos(m.lat) * cos(elong)) / 2;
  return { altitude: alt + refraction(alt), azimuth: p.azimuth, phase: elong / 360, lit, waxing: elong < 180 };
}
