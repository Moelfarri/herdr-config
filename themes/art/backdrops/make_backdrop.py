"""Writes the landscape behind the terminal area for the custom-sakura-lofi theme.

A 1280x720 SVG whose sky is transparent (the live sky shows through it): a Fuji-like
volcano with a snowcap, a far shore, a calm lake with the mountain's reflection and
mist, sakura branches from the top corners and falling petals. Original art.
Usage: make_backdrop.py <output.svg>
"""

import math
import random
import sys
from pathlib import Path

W, H, HORIZON = 1280, 720, 590
OUT = Path(sys.argv[1])


def bezier(p0, p1, p2, p3, n=60):
    pts = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


def x_at(curve, y):
    """x on a monotonic slope curve at height y."""
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        if (y0 - y) * (y1 - y) <= 0 and y0 != y1:
            return x0 + (x1 - x0) * (y - y0) / (y1 - y0)
    return curve[-1][0]


def poly(points):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in points)


# The volcano: concave slopes (steep near the top, flat at the foot), a short summit
# with small notches.
PEAK_X, TOP = 800, 262
left = bezier((330, HORIZON), (540, 578), (712, 400), (PEAK_X - 34, TOP))
right = bezier((PEAK_X + 34, TOP), (888, 400), (1062, 578), (1300, HORIZON))
summit = [(PEAK_X - 34, TOP), (PEAK_X - 20, TOP - 7), (PEAK_X - 9, TOP - 1), (PEAK_X + 2, TOP - 8),
          (PEAK_X + 14, TOP - 2), (PEAK_X + 24, TOP - 6), (PEAK_X + 34, TOP)]
mountain = left + summit[1:-1] + right

# The snowcap: down to about y 370, with fingers running down the gullies.
rng = random.Random(7)
snow_l = [p for p in left if p[1] <= 372]
snow_r = [p for p in right if p[1] <= 372]
edge = []
xl, xr = x_at(left, 372), x_at(right, 372)
fingers = 11
for i in range(fingers * 2 + 1):
    t = i / (fingers * 2)
    x = xr + (xl - xr) * t
    dip = (70 + rng.uniform(-18, 26)) * (1 - abs(t - 0.5) * 1.1) if i % 2 else rng.uniform(-6, 8)
    edge.append((x, 372 + max(dip, -4)))
snowcap = snow_l + summit[1:-1] + snow_r + edge

# Ridges: faint lines from the snow down the slopes.
ridges = []
for k, (sx, length, lean) in enumerate([(-150, 150, -60), (-80, 190, -25), (-20, 210, -6), (40, 200, 14),
                                        (110, 180, 40), (175, 140, 70)]):
    x0 = PEAK_X + sx * 0.45
    y0 = 372 + 30 + abs(sx) * 0.12
    ridges.append(f"M{x0:.1f} {y0:.1f} q {lean * 0.4:.1f} {length * 0.5:.1f} {lean:.1f} {length:.1f}")

# Far shore: low hills along the horizon, in front of the volcano's foot.
shore = [(-10, HORIZON + 4)]
for x in range(-10, W + 40, 40):
    shore.append((x, HORIZON - 8 - 10 * math.sin(x / 95) - 6 * math.sin(x / 37 + 1.3)))
shore += [(W + 40, HORIZON + 4)]


def blossom(cx, cy, r, rot, fill, opacity):
    petals = "".join(
        f'<ellipse cx="0" cy="{-r * 0.62:.1f}" rx="{r * 0.42:.1f}" ry="{r * 0.6:.1f}" transform="rotate({a})"/>'
        for a in range(0, 360, 72))
    return (f'<g transform="translate({cx:.1f} {cy:.1f}) rotate({rot:.0f})" fill="{fill}" fill-opacity="{opacity:.2f}">'
            f'{petals}<circle r="{r * 0.2:.1f}" fill="#e2667a" fill-opacity="0.9"/></g>')


def branch(path_d, width):
    return (f'<path d="{path_d}" fill="none" stroke="#3b2733" stroke-width="{width}" stroke-linecap="round" '
            f'stroke-opacity="0.95"/>')


def cluster(points, rng, scale=1.0):
    out = []
    for (x, y, n) in points:
        for _ in range(n):
            dx, dy = rng.uniform(-26, 26) * scale, rng.uniform(-18, 18) * scale
            r = rng.uniform(9, 15) * scale
            fill = rng.choice(["#f4b6cb", "#f7c6d6", "#f2a7c3", "#fbdbe5"])
            out.append(blossom(x + dx, y + dy, r, rng.uniform(0, 72), fill, rng.uniform(0.78, 0.98)))
        for _ in range(max(1, n // 3)):
            out.append(f'<circle cx="{x + rng.uniform(-30, 30) * scale:.1f}" cy="{y + rng.uniform(-22, 22) * scale:.1f}" '
                       f'r="{rng.uniform(2.5, 4) * scale:.1f}" fill="#e88aa6"/>')
    return "".join(out)


rng = random.Random(21)
# Top-right branch, reaching in from the corner.
br_right = (branch("M1300 40 C1200 70 1120 92 1010 150 C960 176 930 200 900 238", 13)
            + branch("M1135 86 C1110 120 1092 140 1060 160", 7)
            + branch("M1028 140 C1000 118 978 110 950 108", 6)
            + branch("M1240 52 C1225 90 1230 120 1210 150", 6))
bl_right = cluster([(1010, 150, 7), (900, 238, 6), (1060, 160, 5), (950, 108, 5), (1210, 150, 5), (1130, 86, 4),
                    (1265, 46, 4), (965, 196, 4)], rng)
# Top-left branch, smaller and higher, so the start of lines stays clear.
br_left = (branch("M-20 18 C60 30 120 22 190 46 C230 60 262 80 290 104", 10)
           + branch("M120 26 C140 0 160 -6 190 -10", 5)
           + branch("M210 54 C214 80 206 100 196 118", 5))
bl_left = cluster([(290, 104, 5), (196, 118, 4), (190, 46, 5), (150, 0, 3), (60, 28, 3)], rng, 0.85)

# Petals drifting down across the whole picture, fainter lower down.
petals = []
for i in range(34):
    x = rng.uniform(40, W - 20)
    y = rng.uniform(140, 680)
    o = 0.85 - (y / H) * 0.45
    petals.append(f'<ellipse rx="{rng.uniform(4, 6.5):.1f}" ry="{rng.uniform(6.5, 9.5):.1f}" '
                  f'transform="translate({x:.0f} {y:.0f}) rotate({rng.uniform(0, 180):.0f})" '
                  f'fill="{rng.choice(["#f4b6cb", "#f7c6d6", "#f2a7c3"])}" fill-opacity="{o:.2f}"/>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">
  <!-- The landscape behind the terminal area for the custom-sakura-lofi theme (the decor's
       `backdrop`). The sky is left transparent: the live sky (agents-spaces, sky.js) shows
       through it. Made by themes/art/backdrops/make_backdrop.py; original art. -->
  <defs>
    <linearGradient id="fuji" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9184c6"/><stop offset="0.55" stop-color="#6c5f9e"/><stop offset="1" stop-color="#463c6c"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0.5" stop-color="#241d3d" stop-opacity="0"/><stop offset="1" stop-color="#241d3d" stop-opacity="0.45"/>
    </linearGradient>
    <linearGradient id="snow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbf7f4"/><stop offset="0.7" stop-color="#ece4ef"/><stop offset="1" stop-color="#d6cbe4"/>
    </linearGradient>
    <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3160"/><stop offset="1" stop-color="#1d1930"/>
    </linearGradient>
    <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f1e6f0" stop-opacity="0"/><stop offset="0.6" stop-color="#f1e6f0" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#f1e6f0" stop-opacity="0.08"/>
    </linearGradient>
    <clipPath id="water"><rect x="0" y="{HORIZON}" width="{W}" height="{H - HORIZON}"/></clipPath>
  </defs>

  <!-- The volcano, lit from the left, its snowcap and ridges. -->
  <polygon points="{poly(mountain)}" fill="url(#fuji)" fill-opacity="0.74"/>
  <polygon points="{poly(mountain)}" fill="url(#shade)"/>
  <polygon points="{poly(snowcap)}" fill="url(#snow)" fill-opacity="0.86"/>
  <g fill="none" stroke="#3c3462" stroke-opacity="0.35" stroke-width="3" stroke-linecap="round">
    {"".join(f'<path d="{d}"/>' for d in ridges)}
  </g>

  <!-- Mist at its foot, the far shore, the lake and the reflection. -->
  <rect x="0" y="{HORIZON - 70}" width="{W}" height="80" fill="url(#mist)"/>
  <polygon points="{poly(shore)}" fill="#2d2648" fill-opacity="0.9"/>
  <rect x="0" y="{HORIZON}" width="{W}" height="{H - HORIZON}" fill="url(#lake)" fill-opacity="0.86"/>
  <g clip-path="url(#water)" opacity="0.22">
    <polygon points="{poly([(x, 2 * HORIZON - y) for x, y in mountain])}" fill="#8c7fc0"/>
    <polygon points="{poly([(x, 2 * HORIZON - y) for x, y in snowcap])}" fill="#efe8f2"/>
  </g>
  <g stroke="#f4dbe6" stroke-linecap="round" stroke-opacity="0.22" stroke-width="2">
    {"".join(f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{x + w:.0f}" y2="{y:.0f}"/>' for x, y, w in
             [(560, 612, 90), (700, 628, 140), (860, 618, 70), (420, 650, 110), (760, 664, 160), (980, 646, 90),
              (300, 690, 120), (640, 700, 100), (1080, 684, 130)])}
  </g>

  <!-- Sakura branches from the top corners, and petals. -->
  {br_right}{bl_right}
  {br_left}{bl_left}
  {"".join(petals)}
</svg>
'''
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(svg)
print(f"wrote {OUT} ({len(svg) // 1024} KB)")
