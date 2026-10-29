import { layers, percent } from "./context.ts";

type Point = [number, number];
type Attrs = Record<string, string>;

export const W = 1320;
export const H = 560;
export const BELT = 340;
export const FLOOR = 520;
export const CYCLE = 2.6;
export const MOVE = 0.9;
export const PITCH = 260;
export const SLOTS = 7;
export const SLAB_W = 120;
export const STACK_X = 1066;
export const PALLET_TOP = 504;
export const RAM_UP = 170;
export const HEAD_UP = 256;
export const PIVOT_Y = 186;
export const STRIP = 148;
export const CURTAIN = [62, 70, 78];
export const ROLLERS = [-30, 100, 160, 230, 360, 490, 620, 750, 880];
export const END_ROLLER = 980;
export const PARTICLES = 14;
export const JAW_OPEN = 16;

const STACK_H = 150;
const EDGE = 992;
const IMPACT = 0.35;
const LOCKED = 0.5;

export const station = (p: number) => 150 + p * PITCH;
export const PRESS_X = station(1);
export const LOCK_X = station(2);
const OUT_X = station(3);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const span = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const inOut = (v: number) => (v < 0.5 ? 4 * v ** 3 : 1 - (-2 * v + 2) ** 3 / 2);
const easeIn = (v: number) => v ** 3;
const easeOut = (v: number) => 1 - (1 - v) ** 3;
const outBack = (v: number) => 1 + 2.70158 * (v - 1) ** 3 + 1.70158 * (v - 1) ** 2;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const f = (n: number) => (Math.abs(n) < 1e-4 ? "0" : n.toFixed(2));
const rand = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const smooth = (p: Point[]) => {
  const at = (i: number) => p[mod(i, p.length)];
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < p.length; i++) {
    const [a, b, c, e] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(b[0] + (c[0] - a[0]) / 6)} ${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)} ${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])} ${f(c[1])}`;
  }
  return `${d}Z`;
};

const superSign = (v: number, p: number) => Math.sign(v) * Math.abs(v) ** p;

const sackOutline = (w: number, h: number, seed: number) => {
  const points: Point[] = [];
  const n = 30;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const lump = 1 + 0.045 * Math.sin(5 * a + seed * 1.7) + 0.03 * Math.sin(9 * a + seed * 2.9);
    let x = (w / 2) * superSign(c, 0.55) * lump;
    let y = -h / 2 + (h / 2) * superSign(s, 0.55) * lump;
    if (s < -0.9) {
      x *= 0.22;
      y -= 4;
    }
    points.push([x, Math.min(0, y)]);
  }
  return smooth(points);
};

const creases = (w: number, h: number, seed: number) =>
  [0, 1, 2].map((i) => {
    const side = i === 1 ? 1 : -1;
    const x0 = side * w * (0.18 + 0.12 * rand(seed + i));
    const y0 = -h * (0.82 - 0.12 * i);
    const x1 = x0 + side * w * 0.14;
    const y1 = y0 + h * 0.2;
    return `M${f(x0)} ${f(y0)}Q${f(x0 + side * w * 0.12)} ${f(y0 + h * 0.02)} ${f(x1)} ${f(y1)}`;
  });

export const gear = (r: number, teeth: number) => {
  const points: string[] = [];
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2;
    const rr = i % 4 < 2 ? r : r * 0.78;
    points.push(`${f(Math.cos(a) * rr)},${f(Math.sin(a) * rr)}`);
  }
  return points.join(" ");
};

export const items = [...layers]
  .sort((a, b) => b.share - a.share)
  .map((l, i) => {
    const w = 120 + l.share * 140;
    const h = 72 + l.share * 168;
    return {
      name: l.name,
      pct: percent(l.share),
      share: l.share,
      w,
      h,
      slab: Math.max(6, l.share * STACK_H),
      outline: sackOutline(w, h, i + 1),
      creases: creases(w, h, i + 1),
    };
  });

let floorY = PALLET_TOP;
let labelY = Infinity;
export const stack = items.map((it) => {
  const bottom = floorY;
  floorY -= it.slab;
  labelY = Math.min((bottom + floorY) / 2, labelY - 16);
  return { bottom, top: floorY, label: labelY };
});
export const stackTop = floorY;

const pressed = (c: number) => mod(c - 1, SLOTS);
const locking = (c: number) => mod(c - 2, SLOTS);

const ramBottom = (j: number, dwell: number) => {
  if (j >= items.length) return RAM_UP;
  const stop = BELT - items[j].slab;
  const down = easeIn(span(dwell, 0.05, IMPACT));
  const up = inOut(span(dwell, 0.9, 1.5));
  return RAM_UP + (stop - RAM_UP) * down * (1 - up);
};

const beltX = (j: number, c: number, e: number) => {
  const p = mod(c - j, SLOTS);
  return { p, x: station(p - 1) + e * PITCH };
};

export const STILL = 9 * CYCLE + MOVE + 0.62;

export function scene(t: number) {
  const c = Math.floor(t / CYCLE);
  const tau = t - c * CYCLE;
  const e = inOut(clamp01(tau / MOVE));
  const dwell = tau - MOVE;
  const offset = (c + e) * PITCH;
  const attrs: Record<string, Attrs> = {};
  const texts: Record<string, string> = {};

  attrs["tread-top"] = { "stroke-dashoffset": f(-offset) };
  attrs["tread-bot"] = { "stroke-dashoffset": f(offset) };
  attrs.chain = { "stroke-dashoffset": f(-offset * 0.4) };
  ROLLERS.forEach((x, i) => (attrs[`r${i}`] = { transform: `rotate(${f(((offset / 11) * 180) / Math.PI)} ${x} 356)` }));
  attrs.rend = { transform: `rotate(${f(((offset / 13) * 180) / Math.PI)} ${END_ROLLER} 356)` };
  attrs.gear = { transform: `translate(160 470) rotate(${f(((offset * 0.4) / 18) * (180 / Math.PI))})` };

  const pj = pressed(c);
  const pressing = pj < items.length;
  const ram = ramBottom(pj, dwell);
  const since = dwell - IMPACT;
  const shake = pressing && since > 0 ? 3.5 * Math.exp(-since * 14) * Math.cos(since * 60) : 0;
  attrs.press = { transform: `translate(0 ${f(shake)})` };
  attrs.ram = { transform: `translate(0 ${f(ram - RAM_UP)})` };
  attrs.rod = { height: f(18 + ram - RAM_UP) };
  attrs.impact = { opacity: f(pressing ? (since >= 0 ? 1 - span(since, 0, 0.22) : 0) : 0) };

  const reading = pressing ? outBack(span(since, 0, 0.4)) * (1 - inOut(span(dwell, 1.0, 1.5))) : 0;
  const angle = pressing ? -120 + 240 * Math.min(1, items[pj].share / 0.5) : -120;
  attrs.needle = { transform: `rotate(${f(-120 + (angle + 120) * reading)} 318 95)` };
  let shown = pressing && since >= 0.05 ? c : c - 1;
  while (pressed(shown) >= items.length) shown--;
  texts.pct = items[pressed(shown)].pct;
  texts.pname = items[pressed(shown)].name;

  const lj = locking(c);
  const lockingNow = lj < items.length;
  const jaw = lockingNow ? easeOut(span(dwell, 0.1, 0.32)) * (1 - inOut(span(dwell, 1.1, 1.4))) : 0;
  const jawGap = JAW_OPEN * (1 - jaw);
  attrs.jl = { transform: `translate(${f(-jawGap)} 0)` };
  attrs.jr = { transform: `translate(${f(jawGap)} 0)` };
  attrs.jlr = { width: f(LOCK_X - SLAB_W / 2 - 14 - 578 - jawGap) };
  attrs.jrr = { x: f(LOCK_X + SLAB_W / 2 + 14 + jawGap), width: f(762 - (LOCK_X + SLAB_W / 2 + 14) - jawGap) };
  const headDown = lockingNow ? inOut(span(dwell, 0.26, 0.48)) * (1 - inOut(span(dwell, 0.9, 1.2))) : 0;
  const headDy = lockingNow ? (BELT - items[lj].slab - HEAD_UP) * headDown : 0;
  attrs.head = { transform: `translate(0 ${f(headDy)})` };
  attrs.headrod = { height: f(6 + headDy) };
  attrs.lamp = { "data-on": lockingNow && dwell >= LOCKED && dwell < 1.55 ? "1" : "0" };

  const curtain = CURTAIN.map(() => 0);

  items.forEach((it, j) => {
    const { p, x } = beltX(j, c, e);
    const key = `b${j}`;
    let y = BELT;
    let rot = 0;
    let visible = p <= 4;
    let sx = 1;
    let sy = 1;
    let slab = p >= 2;
    let locked = p >= 3 ? 1 : 0;
    let springX = 1;
    let px = x;

    if (p === 1 && pressing && pj === j) {
      if (since < 0) {
        sy = Math.min(it.h, BELT - ram) / it.h;
        sx = Math.min(1 + 0.55 * (1 - sy), 210 / it.w);
      } else {
        slab = true;
        springX = 1 + 0.4 * (1 - outBack(span(since, 0, 0.3)));
      }
    }
    if (p === 2) locked = span(dwell, LOCKED, LOCKED + 0.12);
    if (p === 4) {
      px = OUT_X + e * (STACK_X - OUT_X);
      if (px > EDGE) {
        const fall = (px - EDGE) / (STACK_X - EDGE);
        y = BELT + (stack[j].bottom - BELT) * fall * fall;
        rot = 16 * Math.sin(Math.PI * fall);
      }
      visible = tau < MOVE;
    }

    if (!slab && p <= 1) {
      const half = (it.w * sx) / 2;
      const top = BELT - it.h * sy;
      CURTAIN.forEach((cx, i) => {
        const head = (px + half - cx) / (it.w * 0.3);
        const tail = (cx - (px - half)) / (it.w * 0.22);
        const push = clamp01(Math.min(head, tail));
        const rest = Math.acos(Math.min(1, Math.max(-1, (top - PIVOT_Y) / STRIP)));
        curtain[i] = Math.max(curtain[i], ((rest * 180) / Math.PI) * inOut(push) * (1 - i * 0.06));
      });
    }

    attrs[key] = {
      transform: `translate(${f(px)} ${f(y)}) rotate(${f(rot)})`,
      opacity: visible ? "1" : "0",
    };
    attrs[`${key}s`] = { transform: `scale(${f(sx)} ${f(sy)})`, opacity: slab ? "0" : "1" };
    attrs[`${key}m`] = { transform: `scale(${f(springX)} 1)`, opacity: slab ? "1" : "0" };
    attrs[`${key}l`] = { opacity: f(locked) };
  });

  CURTAIN.forEach((cx, i) => (attrs[`c${i}`] = { transform: `rotate(${f(-curtain[i])} ${cx} ${PIVOT_Y})` }));

  for (let i = 0; i < PARTICLES; i++) {
    const key = `p${i}`;
    const life = since;
    if (!pressing || life < 0 || life > 1.1) {
      attrs[key] = { opacity: "0", transform: "translate(0 0)" };
      continue;
    }
    const seed = pj * 31 + i;
    const side = i % 2 ? 1 : -1;
    const ox = PRESS_X + side * (SLAB_W / 2 + 6);
    const oy = BELT - Math.min(items[pj].slab, 40) * rand(seed + 4);
    const vx = side * (90 + 170 * rand(seed));
    const vy = -(60 + 260 * rand(seed + 1));
    const px = ox + vx * life;
    const py = Math.min(FLOOR - 5, oy + vy * life + 450 * life * life);
    const spin = (rand(seed + 2) * 900 - 450) * Math.min(life, 0.7);
    attrs[key] = {
      opacity: f(1 - span(life, 0.6, 1.1)),
      transform: `translate(${f(px)} ${f(py)}) rotate(${f(spin)}) scale(${f(0.6 + rand(seed + 3) * 0.7)})`,
    };
  }

  const k = mod(c - 4, SLOTS);
  const ship = k === 6 ? span(dwell, 0.15, 0.95) : 0;
  const shipDx = 300 * easeIn(ship);
  const shipFade = k === 6 ? 1 - span(dwell, 0.5, 0.95) : 1;
  items.forEach((_, j) => {
    const landed = k === 6 || j < k || (j === k && tau >= MOVE);
    attrs[`s${j}`] = { opacity: landed ? f(shipFade) : "0", transform: `translate(${f(shipDx)} 0)` };
  });
  const fresh = span(dwell, 1.1, 1.5);
  attrs.pallet =
    k === 6 && dwell >= 1.0
      ? { opacity: f(fresh), transform: `translate(0 ${f(14 * (1 - fresh))})` }
      : { opacity: f(shipFade), transform: `translate(${f(shipDx)} 0)` };
  const tag = k === 5 ? span(dwell, 0.2, 0.5) : k === 6 ? shipFade : 0;
  attrs.tag = { opacity: f(tag), transform: `translate(${f(shipDx)} ${f(6 * (1 - Math.min(1, tag * 2)))})` };

  return { attrs, texts };
}
