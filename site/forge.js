const W = 1200;
const H = 400;
const BELT = 260;
const BH = 44;
const BW = 400;
const SEG = { base: [0, 150], instr: [150, 205], mcp: [205, 265], skills: [265, 400] };
const CHIPS = 23;
const DEAD = 7;
const CHIP = (SEG.skills[1] - SEG.skills[0]) / CHIPS;
const KEPT = SEG.skills[0] + (CHIPS - DEAD) * CHIP;
const SCAN_X = 60;
const SPOT_X = 180;
const PRESS_X = 300;
const TANK_X = 790;
const TANK = [770, 1150];
const WATER = 280;
const DIP = 80;
const BIN = [648, 742];
const G = 2400;

const IMPACT = 7.05;
const SPLASH = 10.2;
const END = 14.6;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, x) => a + (b - a) * x;
const lin = (x) => x;
const out = (x) => 1 - (1 - x) ** 3;
const cubicIn = (x) => x * x * x;
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const back = (s) => (x) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const track = (t, keys) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, curve = inOut] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) return lerp(v0, v1, curve(span(t, t0, t1)));
  }
  return keys[keys.length - 1][1];
};
const decay = (t, from, k, w) =>
  t < from ? 0 : Math.exp(-(t - from) * k) * Math.sin((t - from) * w);
const rand = (i, k) => {
  const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, x) => [lerp(a[0], b[0], x), lerp(a[1], b[1], x), lerp(a[2], b[2], x)];
const css = (c, a = 1) => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0} / ${a.toFixed(3)})`;
const ramp = (stops, x) => {
  const n = stops.length - 1;
  const v = clamp(x) * n;
  const i = Math.min(n - 1, Math.floor(v));
  return mix(stops[i], stops[i + 1], v - i);
};

const HEAT = ["#3a3d42", "#7a2e1c", "#c94a1c", "#e0843a", "#ffb24a"].map(hex);
const COOL = ["#ffb24a", "#c94a1c", "#6b2a1e", "#2f3237"].map(hex);

const barX = (t) =>
  track(t, [
    [0, -BW - 40],
    [1.0, SCAN_X, out],
    [3.5, SCAN_X],
    [4.4, SPOT_X],
    [5.6, SPOT_X],
    [6.4, PRESS_X],
    [8.0, PRESS_X],
    [9.3, TANK_X],
  ]);
const pressY = (t) =>
  track(t, [
    [6.5, 0],
    [6.85, -14, out],
    [6.92, -14],
    [IMPACT, 66, cubicIn],
    [7.18, 58, out],
    [7.3, 62],
    [7.75, 62],
    [8.3, 0],
  ]);
const liftY = (t) =>
  track(t, [
    [9.6, 0],
    [SPLASH, DIP, cubicIn],
    [12.4, DIP],
    [13.0, 0, out],
  ]);
const heat = (t) => {
  const up = inOut(span(t, 8.3, 9.4));
  if (t < SPLASH) return { T: up, q: 0 };
  return { T: up * Math.exp(-(t - SPLASH) * 2.4), q: span(t, SPLASH + 0.3, SPLASH + 1.6) };
};

export function mountForge(root) {
  const canvas = root.querySelector("canvas");
  const c = canvas.getContext("2d");
  const narrow = matchMedia("(max-width: 600px)");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();
  const mono = v("--mono") || "monospace";
  const P = {
    bg: v("--bg"),
    panel: v("--panel"),
    panel2: v("--panel-2"),
    line: v("--line"),
    line2: v("--line-2"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    ink3: v("--ink-3"),
    accent: v("--accent"),
    accentDim: v("--accent-dim"),
    warm: v("--warm"),
    red: v("--red"),
    green: v("--green"),
  };
  const STEEL = hex("#3a3d42");
  const STEEL_DARK = hex("#2f3237");
  const TEAL_DIM = hex(P.accentDim);

  const chips = Array.from({ length: DEAD }, (_, i) => {
    const v0 = 40 + rand(i, 1) * 90;
    const d = 376 - BELT;
    return {
      i,
      v0,
      land: (-v0 + Math.sqrt(v0 * v0 + 2 * G * d)) / G,
      dx: -10 + rand(i, 2) * 20,
      spin: (rand(i, 3) - 0.5) * 3.2,
      rest: (rand(i, 4) - 0.5) * 0.5,
    };
  });
  const puffs = Array.from({ length: 44 }, (_, i) => ({
    t0: SPLASH + 0.05 + 2.1 * (i / 44) ** 1.6,
    x: TANK_X + 10 + rand(i, 5) * (KEPT - 20),
    life: 1.5 + rand(i, 6) * 1.0,
    v: 60 + rand(i, 7) * 70,
    drift: 10 + rand(i, 8) * 30,
    r0: 7 + rand(i, 9) * 6,
    r1: 30 + rand(i, 10) * 30,
    a: 0.22 + rand(i, 11) * 0.16,
  }));
  const drops = Array.from({ length: 12 }, (_, i) => ({
    x: TANK_X + rand(i, 12) * KEPT,
    vx: (rand(i, 13) - 0.5) * 160,
    vy: -(180 + rand(i, 14) * 160),
    r: 1.4 + rand(i, 15) * 1.2,
  }));

  let k = 1;
  let vw = W;
  let shown = 0;
  let raf = 0;

  function rect(x, y, w, h, fill, stroke) {
    c.fillStyle = fill;
    c.fillRect(x, y, w, h);
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
  }
  function label(text, x, y, color, a = 1, align = "center", size = 15) {
    if (a <= 0.01) return;
    c.font = `500 ${narrow.matches ? size + 5 : size}px ${mono}`;
    c.textAlign = align;
    c.textBaseline = "alphabetic";
    c.globalAlpha = a;
    c.fillStyle = color;
    c.fillText(text, x, y);
    c.globalAlpha = 1;
  }
  function twoTone(parts, x, y, a, align = "center") {
    if (a <= 0.01) return;
    const size = narrow.matches ? 20 : 15;
    c.font = `500 ${size}px ${mono}`;
    const widths = parts.map((p) => c.measureText(p[0]).width);
    const total = widths.reduce((n, w) => n + w, 0);
    let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
    c.textAlign = "left";
    c.globalAlpha = a;
    parts.forEach(([text, color], i) => {
      c.fillStyle = color;
      c.fillText(text, cx, y);
      cx += widths[i];
    });
    c.globalAlpha = 1;
  }
  function leader(x, y0, y1, a) {
    if (a <= 0.01) return;
    c.globalAlpha = a;
    c.fillStyle = P.ink3;
    c.fillRect(x - 0.5, Math.min(y0, y1), 1, Math.abs(y1 - y0));
    c.globalAlpha = 1;
  }
  function puff(x, y, r, a, color) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, css(color, a));
    g.addColorStop(0.55, css(color, a * 0.45));
    g.addColorStop(1, css(color, 0));
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function segmentColor(base, T, q) {
    let col = T > 0.02 ? mix(base, ramp(HEAT, T), clamp(T * 1.15)) : base;
    if (q > 0) col = mix(ramp(COOL, q), mix(base, STEEL_DARK, 0.5), q * q);
    return col;
  }

  function drawBar(x, y, t, whole, dead, T, q) {
    const w = whole ? BW : KEPT;
    const base = segmentColor(STEEL, T, q);
    const tint = segmentColor(TEAL_DIM, T, q);
    rect(x, y, w, BH, css(base));
    const seg = (a, b, col) => {
      c.fillStyle = col;
      c.fillRect(x + a, y + 6, b - a, BH - 12);
    };
    seg(SEG.instr[0] + 2, SEG.instr[1] - 2, css(tint));
    seg(SEG.mcp[0] + 2, SEG.mcp[1] - 2, css(tint));
    const n = whole ? CHIPS : CHIPS - DEAD;
    for (let i = 0; i < n; i++) {
      const a = SEG.skills[0] + i * CHIP + 1;
      const b = a + CHIP - 2;
      const isDead = i >= CHIPS - DEAD;
      if (isDead && dead > 0) {
        const d = clamp(dead * DEAD - (i - (CHIPS - DEAD)));
        c.fillStyle = css(mix(tint, hex(P.panel2), d));
        c.fillRect(x + a, y + 6, b - a, BH - 12);
        if (d > 0.5) {
          c.strokeStyle = P.red;
          c.lineWidth = 1;
          c.strokeRect(x + a + 0.5, y + 6.5, b - a - 1, BH - 13);
        }
      } else seg(a, b, css(tint));
    }
    c.fillStyle = `rgb(255 255 255 / ${0.14 + 0.1 * T})`;
    c.fillRect(x, y, w, 1);
    c.fillStyle = "rgb(0 0 0 / 0.35)";
    c.fillRect(x, y + BH - 1, w, 1);
    [SEG.instr[0], SEG.mcp[0], SEG.skills[0]].forEach((d) => {
      c.fillStyle = "rgb(0 0 0 / 0.45)";
      c.fillRect(x + d - 0.5, y, 1, BH);
    });
    if (whole) {
      c.fillStyle = "rgb(0 0 0 / 0.45)";
      c.fillRect(x + KEPT - 0.5, y, 1, BH);
    }
  }

  function render(t) {
    const cw = canvas.width;
    const ch = canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = P.panel;
    c.fillRect(0, 0, cw, ch);

    const bx = barX(t);
    const focus = bx + (t < IMPACT ? BW : KEPT) / 2;
    const camX = narrow.matches ? clamp(focus - vw / 2, 0, W - vw) : 0;
    const jolt = 3 * decay(t, IMPACT, 8, 34);
    c.setTransform(k, 0, 0, k, -camX * k, jolt * k);

    const stations = [
      ["scan", 260, 0],
      ["spot", 380, 3.5],
      ["smash", 680, 5.6],
      ["quench", 960, 8.0],
    ];
    stations.forEach(([name, x, at], i) => {
      const next = stations[i + 1]?.[2] ?? END;
      const active = t >= at && t < next;
      label(name, x, 34, active ? P.ink : t >= next ? P.ink2 : P.ink3, 1, "center", 13);
    });

    c.fillStyle = P.line;
    c.fillRect(0, BELT, TANK[0] - 12, 2);
    c.fillStyle = P.line2;
    for (let x = 30; x < TANK[0] - 20; x += 40) {
      c.beginPath();
      c.arc(x, BELT + 12, 7, 0, Math.PI * 2);
      c.fillStyle = P.panel2;
      c.fill();
      c.strokeStyle = P.line2;
      c.lineWidth = 1;
      c.stroke();
      const a = bx / 7;
      c.fillStyle = P.line2;
      c.fillRect(x + Math.cos(a) * 3 - 1, BELT + 12 + Math.sin(a) * 3 - 1, 2, 2);
    }
    c.fillStyle = P.line;
    c.fillRect(0, BELT + 22, TANK[0] - 12, 1);

    c.fillStyle = P.line;
    c.fillRect(0, 376, W, 1);
    rect(40, 80, 440, 16, P.panel2, P.line2);
    rect(60, 0, 6, 80, P.panel2, P.line2);
    rect(454, 0, 6, 80, P.panel2, P.line2);
    const scanX = track(t, [
      [1.1, SCAN_X],
      [3.1, SCAN_X + BW, lin],
    ]);
    const scanning = span(t, 1.0, 1.15) * (1 - span(t, 3.1, 3.3));
    rect(scanX - 14, 96, 28, 10, P.panel2, P.line2);
    if (scanning > 0) {
      c.globalAlpha = scanning;
      c.fillStyle = P.accent;
      c.fillRect(scanX - 0.5, 106, 1, BELT - BH - 106);
      c.globalAlpha = 0.12 * scanning;
      c.fillRect(scanX - 6, 106, 12, BELT - BH - 106);
      c.globalAlpha = 1;
    }
    const p = span(t, 1.1, 3.1);
    const counted = t > 1.0 && t < 3.6;
    if (counted)
      label(
        t >= 3.1
          ? "starting load 21.0k · 61% of tokens processed"
          : `starting load ${((21000 * p) / 1000).toFixed(1)}k`,
        260,
        70,
        t >= 3.1 ? P.ink : P.ink2,
        1 - span(t, 3.4, 3.6),
      );

    const scanLabels = [
      ["instructions 6.1 KB", SEG.instr, 128],
      ["mcp docs · 14 calls", SEG.mcp, 154],
      ["23 skills · 14.6k chars", SEG.skills, 180],
    ];
    scanLabels.forEach(([text, [a, b], y]) => {
      const cx = SCAN_X + (a + b) / 2;
      const seen = span(scanX, cx - 10, cx + 10) * span(t, 1.1, 1.2);
      const alpha = seen * (1 - span(t, 3.4, 3.6));
      leader(cx, y + 8, BELT - BH - 6, alpha);
      label(text, cx, y, P.ink2, alpha);
    });

    const spotting = span(t, 4.5, 5.3);
    const spotLabelA = span(t, 5.0, 5.3) * (1 - span(t, 5.6, 5.8));
    const usedA = span(t, 4.7, 5.0) * (1 - span(t, 5.6, 5.8));
    rect(SPOT_X + KEPT + 2, 150, 4, 30, P.panel2, P.line2);
    const stampY = track(t, [
      [4.4, 150],
      [4.6, BELT - BH - 18, out],
      [5.3, BELT - BH - 18],
      [5.6, 150],
    ]);
    rect(SPOT_X + KEPT - 2, stampY, BW - KEPT + 4, 8, P.line2);
    twoTone([["7 never used", P.red]], SPOT_X + KEPT + (BW - KEPT) / 2, 136, spotLabelA);
    leader(SPOT_X + KEPT + (BW - KEPT) / 2, 144, stampY - 2, spotLabelA);
    twoTone([["used", P.accent]], SPOT_X + (SEG.mcp[0] + SEG.mcp[1]) / 2, 136, usedA);
    leader(SPOT_X + (SEG.mcp[0] + SEG.mcp[1]) / 2, 144, BELT - BH - 6, usedA);

    rect(BIN[0], BELT + 30, BIN[1] - BIN[0], 376 - BELT - 30, P.bg, P.line2);
    if (t >= IMPACT) {
      const u = t - IMPACT;
      chips.forEach((ch) => {
        const fall = Math.min(u, ch.land);
        const y = BELT - BH + ch.v0 * fall + 0.5 * G * fall * fall;
        const settled = span(u, ch.land, ch.land + 0.25);
        const x = PRESS_X + KEPT + ch.i * CHIP + CHIP / 2 + ch.dx * clamp(u / ch.land);
        c.save();
        c.translate(x, Math.min(y, 376 - 2) - (BH - 12) / 2);
        c.rotate(lerp(ch.spin * clamp(u / ch.land), ch.rest, settled));
        c.fillStyle = P.panel2;
        c.fillRect(-CHIP / 2 + 1, -(BH - 12) / 2, CHIP - 2, BH - 12);
        c.strokeStyle = P.red;
        c.lineWidth = 1;
        c.strokeRect(-CHIP / 2 + 1.5, -(BH - 12) / 2 + 0.5, CHIP - 3, BH - 13);
        c.restore();
      });
    }
    const noteA = span(t, 7.4, 7.8) * (1 - span(t, 9.2, 9.6));
    label("you remove them", (BIN[0] + BIN[1]) / 2, 395, P.ink2, noteA, "center", 13);

    const py = pressY(t);
    rect(PRESS_X + KEPT - 32, 40, BW - KEPT + 64, 14, P.panel2, P.line2);
    rect(PRESS_X + KEPT + (BW - KEPT) / 2 - 8, 54, 16, 60 + py, P.panel2, P.line2);
    rect(PRESS_X + KEPT - 14, 114 + py, BW - KEPT + 28, 36, P.line2, P.ink3);

    const heaterOn = span(t, 8.2, 8.6) * (1 - span(t, 9.6, 10.2));
    rect(TANK_X - 10, 110, 4, 110, P.panel2, P.line2);
    rect(TANK_X + 96, 110, 4, 110, P.panel2, P.line2);
    rect(TANK_X - 10, 110, 110, 6, P.panel2, P.line2);
    for (let i = 0; i < 4; i++) {
      const col = mix(hex(P.line2), hex(P.warm), heaterOn);
      c.fillStyle = css(col);
      c.fillRect(TANK_X - 6, 130 + i * 20, 102, 4);
    }

    rect(TANK[0], BELT + 2, TANK[1] - TANK[0], 376 - BELT - 2, P.panel2, P.line2);
    const ly = liftY(t);
    const by = BELT - BH + ly;
    const { T, q } = heat(t);

    const sub = span(t, SPLASH - 0.15, SPLASH + 0.2) * (1 - span(t, 12.4, 13.0));
    const level = WATER - 6 * sub;
    const inWater = by + BH > level;

    const water = (y0, y1) => {
      c.save();
      c.beginPath();
      c.rect(TANK[0] + 1, y0, TANK[1] - TANK[0] - 2, y1 - y0);
      c.clip();
      c.fillStyle = "rgb(32 52 64 / 0.78)";
      c.fillRect(TANK[0], level, TANK[1] - TANK[0], 376 - level);
      c.fillStyle = "rgb(90 130 150 / 0.8)";
      c.fillRect(TANK[0], level, TANK[1] - TANK[0], 1);
      [SPLASH, 13.0].forEach((s0) => {
        for (let r = 0; r < 3; r++) {
          const u = t - s0 - r * 0.2;
          if (u <= 0 || u > 1.5) continue;
          const grow = 4 + u * 110;
          c.strokeStyle = `rgb(160 200 220 / ${0.5 * Math.exp(-u * 2.4)})`;
          c.lineWidth = 1;
          c.strokeRect(TANK_X - grow, level - 2 - grow * 0.1, KEPT + grow * 2, 4 + grow * 0.2);
        }
      });
      c.restore();
    };
    water(BELT, level + 0.5);

    if (t < 13.0 || t >= 13.0) {
      rect(TANK_X - 10, by + BH, KEPT + 20, 6, P.panel2, P.line2);
      rect(TANK_X + 10, by + BH + 6, 4, 376 - (by + BH + 6), P.panel2);
      rect(TANK_X + KEPT - 14, by + BH + 6, 4, 376 - (by + BH + 6), P.panel2);
    }

    if (t < 8.0 || t >= 8.0) {
      const whole = t < IMPACT;
      const x = t >= 9.3 ? TANK_X : bx;
      const y = t >= 9.3 ? by : BELT - BH;
      drawBar(x, y, t, whole, whole ? spotting : 0, T, q);
      if (T > 0.08 && !inWater) {
        puff(x + KEPT / 2, y + BH / 2, KEPT * 0.5, 0.1 * T, hex(P.warm));
      }
    }

    if (inWater) water(level, 376);

    drops.forEach((d) => {
      const u = t - SPLASH;
      if (u <= 0) return;
      const y = level + d.vy * u + 0.5 * 1500 * u * u;
      if (y > level + 2) return;
      c.fillStyle = "rgb(160 200 220 / 0.8)";
      c.beginPath();
      c.arc(d.x + d.vx * u, y, d.r, 0, Math.PI * 2);
      c.fill();
    });
    puffs.forEach((pf) => {
      const a = t - pf.t0;
      if (a <= 0 || a >= pf.life) return;
      const f = a / pf.life;
      const rise = (pf.v * (1 - Math.exp(-a * 1.5))) / 1.5 + 24 * a;
      const x = pf.x + pf.drift * a;
      const y = level - 4 - rise;
      const r = lerp(pf.r0, pf.r1, 1 - Math.exp(-a * 1.4));
      const alpha = pf.a * Math.min(1, f * 6) * (1 - f) ** 1.5;
      puff(x, y, r, alpha, hex("#b7bfc6"));
    });

    const clampIn = back(1.4)(span(t, 13.1, 13.5));
    [-1, 1].forEach((side) => {
      const edge = side < 0 ? TANK_X : TANK_X + KEPT;
      const from = side < 0 ? TANK[0] - 60 : TANK[1] + 60;
      const cx = lerp(from, edge, clampIn);
      const w = 10;
      const x0 = side < 0 ? cx - w : cx;
      rect(x0, BELT - BH - 10, w, BH + 10, P.ink3, P.line2);
      rect(side < 0 ? cx : cx - 16, BELT - BH - 10, 16, 6, P.ink3, P.line2);
    });

    const keptLabels = [
      [[["instructions · "], ["kept", P.accent]], SEG.instr, 128],
      [[["mcp docs · 14 calls · "], ["kept", P.accent]], SEG.mcp, 154],
      [[["16 skills · "], ["kept", P.accent]], [SEG.skills[0], KEPT], 180],
    ];
    keptLabels.forEach(([parts, [a, b], y], i) => {
      const alpha = span(t, 13.4 + i * 0.25, 13.8 + i * 0.25);
      const cx = TANK_X + (a + b) / 2;
      leader(cx, y + 8, BELT - BH - 14, alpha);
      twoTone(
        parts.map(([s, col]) => [s, col ?? P.ink2]),
        cx,
        y,
        alpha,
      );
    });

    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  function size() {
    vw = narrow.matches ? 560 : W;
    const cssW = root.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    k = (cssW / vw) * dpr;
    canvas.style.height = `${(cssW * H) / vw}px`;
    canvas.width = Math.round(vw * k);
    canvas.height = Math.round(H * k);
  }

  function play() {
    cancelAnimationFrame(raf);
    const began = performance.now();
    const frame = (now) => {
      shown = Math.min(END, (now - began) / 1000);
      render(shown);
      if (shown < END) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  size();
  let width = root.clientWidth;
  new ResizeObserver(() => {
    if (root.clientWidth === width) return;
    width = root.clientWidth;
    size();
    render(shown);
  }).observe(root);
  narrow.addEventListener("change", () => {
    size();
    render(shown);
  });
  void document.fonts?.ready.then(() => render(shown));

  if (still.matches) {
    shown = END;
    render(END);
    return;
  }
  render(0);
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      play();
    },
    { threshold: 0.3 },
  );
  seen.observe(root);
}
