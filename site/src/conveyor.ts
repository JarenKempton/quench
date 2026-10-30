import { layers, servers, skillUse, startTokens } from "./context.ts";

type Attrs = Record<string, string>;

export const W = 960;
export const H = 460;
export const FLOOR = 440;
export const BELT = 250;
export const PULLEY = 12;
export const LEFT_END = 450;
export const RIGHT_START = 636;
export const BELT_END = 700;
export const IDLERS = [15, 95, 175, 255, 335, 415];

export const LOAD_X = 95;
export const PRESS_X = 320;
export const TANK_X = 545;
export const CART_X = 840;

export const CROWN = 92;
export const RAM_REST = 142;
export const RAM_H = 30;
export const BAR_H = 22;
export const DIM_Y = 210;

export const TANK_L = 470;
export const TANK_R = 620;
export const TANK_TOP = 264;
export const TANK_FLOOR = 424;
export const WATER = 292;
export const SLEEVE = 380;
export const DECK = 394;

export const BAG = { w: 136, h: 104 };
export const STEAM = 12;
export const DROPS = 10;

const PER_K = 8;
const DIP = 96;
const TIP_X = 708;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const span = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const lerp = (a: number, b: number, v: number) => a + (b - a) * v;
const inOut = (v: number) => (v < 0.5 ? 4 * v ** 3 : 1 - (-2 * v + 2) ** 3 / 2);
const easeIn = (v: number) => v ** 3;
const easeOut = (v: number) => 1 - (1 - v) ** 3;
const outBack = (v: number) => 1 + 2.70158 * (v - 1) ** 3 + 1.70158 * (v - 1) ** 2;
const f = (n: number) => (Math.abs(n) < 1e-3 ? "0" : n.toFixed(2));
const rand = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const unused = new Set(servers.filter((s) => s.called === 0).map((s) => `MCP: ${s.server}`));

type Band = { x: number; w: number; cut: boolean; tokens: number };

const pieces = [...layers]
  .sort((a, b) => b.share - a.share)
  .flatMap((l) => {
    const tokens = l.share * startTokens;
    if (l.kind !== "skills") return [{ tokens, cut: unused.has(l.name), min: 2 }];
    const used = skillUse.used / skillUse.listed;
    return [
      { tokens: tokens * used, cut: false, min: 2 },
      { tokens: tokens * (1 - used), cut: true, min: 3 },
    ];
  })
  .sort((a, b) => Number(b.cut) - Number(a.cut));

let edge = PRESS_X;
export const bands: Band[] = pieces.map(({ tokens, cut, min }) => {
  const w = Math.max(min, (tokens / 1000) * PER_K);
  edge += w;
  return { x: edge - w, w, cut, tokens };
});
export const BAR_W = edge - PRESS_X;
for (const b of bands) b.x -= BAR_W / 2;
export const BAR_L = PRESS_X - BAR_W / 2;

const kept = bands.filter((b) => !b.cut);
export const KEEP_L = kept[0].x;
export const KEEP_R = kept[kept.length - 1].x + kept[kept.length - 1].w;
export const KEEP_C = (KEEP_L + KEEP_R) / 2;
export const firstCut = bands.find((b) => b.cut)!;

const T = {
  in: [0.2, 1.7],
  go: [2.3, 3.5],
  lift: [3.6, 3.95],
  hit: 4.12,
  recoil: [4.24, 4.42, 5.0],
  dim: [4.45, 5.0],
  mark: [5.4, 5.75],
  note: [5.6, 6.0],
  take: [6.3, 6.9],
  tank: [7.2, 8.3],
  dip: [8.4, 8.95],
  rise: [10.0, 10.55],
  out: [10.65, 11.3],
  land: 11.72,
};
export const END = 12.6;
export const FRAMES = { load: 2.0, quench: 0, end: END };

const depthAt = (t: number) =>
  DIP * inOut(span(t, T.dip[0], T.dip[1])) * (1 - inOut(span(t, T.rise[0], T.rise[1])));
const contact = (() => {
  let t = T.dip[0];
  while (BELT + depthAt(t) < WATER && t < T.dip[1]) t += 0.002;
  return t;
})();
FRAMES.quench = contact + 0.4;

const ramBottom = (t: number) => {
  const lift = 14 * easeOut(span(t, T.lift[0], T.lift[1]));
  const strike = easeIn(span(t, T.lift[1], T.hit));
  const low = BELT - BAR_H;
  const up = RAM_REST - lift;
  if (t < T.recoil[0]) return lerp(up, low, strike);
  const kick = low - 34 * easeOut(span(t, T.recoil[0], T.recoil[1]));
  return lerp(kick, RAM_REST, inOut(span(t, T.recoil[1], T.recoil[2])));
};

const bagX = (t: number) =>
  t < T.go[0] ? lerp(-110, LOAD_X, inOut(span(t, T.in[0], T.in[1]))) : lerp(LOAD_X, PRESS_X, inOut(span(t, T.go[0], T.go[1])));

const sway = (t: number, [a, b]: number[], amp: number) => {
  if (t < a) return 0;
  if (t < b) return -amp * Math.sin(2 * Math.PI * span(t, a, b));
  const s = t - b;
  return amp * 0.8 * Math.exp(-5 * s) * Math.sin(13 * s);
};

const wave = (y: number, amp: number, t: number) => {
  let d = `M${TANK_L + 4} ${f(y)}`;
  for (let x = TANK_L + 4; x < TANK_R - 4; x += 6) {
    const nx = Math.min(x + 6, TANK_R - 4);
    d += `L${nx} ${f(y + amp * Math.sin(nx * 0.11 - t * 10) * Math.sin(((nx - TANK_L) / (TANK_R - TANK_L)) * Math.PI))}`;
  }
  return d;
};

export function scene(time: number) {
  const t = Math.min(Math.max(time, 0), END);
  const a: Record<string, Attrs> = {};
  const show = (v: number) => ({ opacity: f(clamp01(v)) });

  const bx = bagX(t);
  const toTank = TANK_X - KEEP_C;
  const keepShift = toTank * inOut(span(t, T.tank[0], T.tank[1]));
  const leftRun = bx + 110 + keepShift;
  const outV = span(t, T.out[0], T.out[1]);
  const outX = lerp(TANK_X, TIP_X, outV * outV);
  const rightRun = outX - TANK_X;
  a["tread-l"] = { "stroke-dashoffset": f(-leftRun) };
  a["tread-r"] = { "stroke-dashoffset": f(-rightRun) };
  const spin = (run: number, x: number, r: number) => ({
    transform: `rotate(${f(((run / r) * 180) / Math.PI)} ${x} ${BELT + PULLEY})`,
  });
  IDLERS.forEach((x, i) => (a[`i${i}`] = spin(leftRun, x, 7)));
  a.pl = spin(leftRun, LEFT_END, PULLEY);
  a.pr0 = spin(rightRun, RIGHT_START, PULLEY);
  a.pr1 = spin(rightRun, BELT_END, PULLEY);

  const ram = ramBottom(t);
  a.ram = { transform: `translate(0 ${f(ram - RAM_REST)})` };
  a.rod = { height: f(ram - RAM_H - CROWN) };

  const struck = t >= T.hit;
  const bagTop = BELT - BAG.h;
  const sy = struck ? BAR_H / BAG.h : Math.min(1, (BELT - Math.max(ram, bagTop)) / BAG.h);
  const sx = 1 + (BAR_W / BAG.w - 1) * ((1 - sy) / (1 - BAR_H / BAG.h));
  const tilt = t < T.go[0] ? sway(t, T.in, 3) : sway(t, T.go, 4);
  a.bag = { transform: `translate(${f(bx)} ${BELT}) rotate(${f(tilt)})`, opacity: struck ? "0" : "1" };
  a["bag-s"] = { transform: `scale(${f(sx)} ${f(sy)})` };

  const spring = 1 + 0.06 * (1 - outBack(span(t, T.hit, T.hit + 0.32)));
  a.bar = {
    transform: `translate(${PRESS_X} 0) scale(${f(spring)} 1) translate(${-PRESS_X} 0)`,
    opacity: struck ? "1" : "0",
  };
  const flash = struck ? 1 - span(t, T.hit, T.hit + 0.28) : 0;
  const burst = easeOut(span(t, T.hit, T.hit + 0.28));
  a["spark-l"] = { opacity: f(flash), transform: `translate(${f(BAR_L - 4 - 10 * burst)} ${BELT - BAR_H / 2})` };
  a["spark-r"] = { opacity: f(flash), transform: `translate(${f(BAR_L + BAR_W + 4 + 10 * burst)} ${BELT - BAR_H / 2})` };

  const drawn = easeOut(span(t, T.dim[0], T.dim[1]));
  const markV = span(t, T.mark[0], T.mark[1]);
  a["dim-all"] = {
    opacity: f(span(t, T.dim[0], T.dim[0] + 0.15) * (1 - markV)),
    transform: `translate(${PRESS_X} 0) scale(${f(Math.max(0.001, drawn))} 1) translate(${-PRESS_X} 0)`,
  };
  a["dim-all-t"] = show(span(t, T.dim[0] + 0.3, T.dim[1]) * (1 - markV));
  a["dim-cut"] = show(markV);
  a.mark = show(markV);
  a.ghost = show(span(t, T.take[0], T.take[0] + 0.3));
  const take = span(t, T.take[0], T.take[1]);
  a.cut = { transform: `translate(0 ${f(-46 * easeIn(take))})`, opacity: f(1 - easeIn(take)) };

  const depth = depthAt(t);
  a.plat = { transform: `translate(0 ${f(depth)})` };
  a.prod = { y: f(BELT + 6 + depth), height: f(SLEEVE - BELT - 6 - depth + 4) };
  const sub = clamp01((BELT + depth - WATER) / BAR_H);
  const level = WATER - 5 * sub;
  a.water = { y: f(level), height: f(TANK_FLOOR - level) };
  const since = t - contact;
  const ripple = since > 0 ? 3.2 * Math.exp(-2.4 * since) : 0;
  a.surface = { d: wave(level, ripple, t) };

  for (let i = 0; i < DROPS; i++) {
    const side = i % 2 ? 1 : -1;
    const s = since - (i >> 1) * 0.02;
    const vx = side * (30 + 50 * rand(i + 3));
    const vy = -(150 + 120 * rand(i + 11));
    const x0 = TANK_X + side * (KEEP_R - KEEP_L) * (0.15 + 0.35 * rand(i + 7));
    const live = s > 0 && s < 0.55;
    const x = x0 + vx * s;
    const y = WATER + vy * s + 0.5 * 900 * s * s;
    const tvx = vx * 0.035;
    const tvy = (vy + 900 * s) * 0.035;
    a[`dr${i}`] = {
      d: `M${f(x)} ${f(y)}L${f(x - tvx)} ${f(y - tvy)}`,
      opacity: live && y < WATER + 2 ? f(1 - s / 0.55) : "0",
    };
  }

  const heat = struck ? 1 - span(t, contact + 0.2, contact + 1.25) : 0;
  a.hot = show(heat);

  for (let i = 0; i < STEAM; i++) {
    const round = Math.floor(i / 6);
    const start = contact + 0.05 + (i % 6) * 0.09 + round * 0.7;
    const s = span(t, start, start + 1.4);
    const x = TANK_X + ((i % 6) / 5 - 0.5) * 104 + (rand(i + 21) - 0.5) * 14;
    const strength = round ? 0.6 : 1;
    a[`st${i}`] = {
      transform: `translate(${f(x)} ${f(level - 2 - 34 * easeOut(s))}) scale(${i % 2 ? -1 : 1} ${f(0.8 + 0.35 * rand(i + 5) + 0.25 * s)})`,
      "stroke-dashoffset": f(lerp(58, -124, easeOut(s))),
      opacity: f(s > 0 && s < 1 ? 0.85 * strength * Math.sin(Math.PI * s) * (1 - 0.6 * s) : 0),
    };
  }

  const landed = Math.max(0, t - T.land);
  const settle = landed > 0 ? 2.6 * Math.exp(-7 * landed) * Math.sin(22 * landed) : 0;
  a.deck = { transform: `translate(0 ${f(settle)})` };

  let kx = KEEP_C + keepShift;
  let ky = BELT + depth;
  let rot = 0;
  if (t >= T.out[0]) {
    kx = outX;
    ky = BELT;
  }
  if (t >= T.out[1]) {
    const u = span(t, T.out[1], T.land);
    kx = lerp(TIP_X, CART_X, u);
    ky = lerp(BELT, DECK, u * u);
    rot = 15 * Math.sin(Math.PI * u) * (1 - u * 0.4);
    if (t >= T.land) {
      kx = CART_X;
      ky = DECK + settle;
      rot = 0;
    }
  }
  a.keep = { transform: `translate(${f(kx - KEEP_C)} ${f(ky - BELT)}) rotate(${f(rot)} ${f(KEEP_C)} ${BELT})` };

  a["note-cut"] = { style: `opacity:${f(span(t, T.note[0], T.note[1]))}` };

  return a;
}
