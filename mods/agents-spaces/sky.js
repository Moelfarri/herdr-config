// The weather for the live sky (MET Norway: api.met.no, CC BY 4.0, asked for at most
// every 30 minutes), and the agents panel's glass: light washes that follow the hour
// (day, golden hour, night, overcast) and the theme's sheen rising from the bottom.
// The sky itself is drawn behind the terminal area (skysvg.js, backdrop.js).

import { div, PathBuilder, Background } from "gpui-kit";
import { lightOf } from "./skysvg.js";

const FADE = { duration: 4000, easing: "ease-in-out" };

/** The next hours' weather at `lat`, `lon` from MET Norway's forecast:
 *  [{ t (ms), cloud (%), wind (m/s), symbol }], or a rejection. */
export async function fetchWeather(lat, lon) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
  const r = await fetch(url, { headers: { "User-Agent": "herdr-sky/1.0" } });
  if (!r.ok) throw new Error(`MET Norway answered ${r.status}`);
  const body = await r.json();
  return (body?.properties?.timeseries ?? []).slice(0, 12).map((ts) => ({
    t: Date.parse(ts.time),
    cloud: ts.data?.instant?.details?.cloud_area_fraction ?? 0,
    wind: ts.data?.instant?.details?.wind_speed ?? 0,
    symbol: (ts.data?.next_1_hours ?? ts.data?.next_6_hours)?.summary?.symbol_code ?? null,
  }));
}

/** The forecast hour that holds `ms`, or null when the forecast is too old. */
export function weatherAt(hours, ms) {
  if (!hours?.length) return null;
  let now = hours[0];
  for (const h of hours) if (h.t <= ms) now = h;
  return ms - now.t > 3 * 3600000 ? null : now;
}

// A layer of the panel's width filled with a top-to-bottom gradient.
const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
const wash = (id, from, to) => div().id(`glass-${id}`).absolute().left(0).right(0)
  .child(window.paint_path(RECT(), Background.linear_gradient(180, from, to)).absolute().top(0).left(0).size_full());
const stop = (color, at) => Background.stop(color, at);

/** The panel's glass, behind everything: light washes for the sky `state` (skysvg.js;
 *  none when null), then a sheen of `sheen` (#rrggbb) rising from the bottom. */
export function panelWashes(state, sheen) {
  const out = [];
  if (state) {
    const L = lightOf(state);
    out.push(
      wash("day", "#cdd7f612", "#f8e3c805").top(0).bottom(0).opacity(L.day * (1 - 0.5 * L.cover)).transition("opacity", FADE),
      wash("night", stop("#4a4f9a1e", 0), stop("#3b3f7a00", 0.7)).top(0).bottom(0).opacity(L.night).transition("opacity", FADE),
      wash("grey", "#a39cb412", "#8e87a20e").top(0).bottom(0).opacity(Math.max(0, (L.cover - 0.6) / 0.4) * (0.5 + 0.5 * L.day)).transition("opacity", FADE),
      wash("golden", stop("#f2905e00", 0.35), stop("#f2905e24", 0.93)).bottom(0).h(320).opacity(L.golden).transition("opacity", FADE),
    );
  }
  if (/^#[0-9a-fA-F]{6}$/.test(sheen ?? "")) out.push(wash("sheen", stop(`${sheen}00`, 0), stop(`${sheen}14`, 1)).bottom(0).h(170));
  return out;
}
