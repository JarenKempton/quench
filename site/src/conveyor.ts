import { inputTokens, kilo, layers, requests, startTokens } from "./context.ts";

type Point = [number, number];
type Attrs = Record<string, string>;

export const W = 960;
export const H = 460;
export const BELT = 250;
export const FLOOR = 440;
export const CYCLE = 2.1;
export const MOVE = 0.75;
export const PITCH = 225;
export const SLAB_W = 124;
export const RAM_UP = 124;
export const LEFT_END = 450;
export const RIGHT_START = 636;
export const BELT_END = 700;
export const ROLLERS = [10, 100, 190, 280, 370];
export const TANK_L = 470;
export const TANK_R = 620;
export const WATER = 284;
export const CART_X = 840;
export const CART_TOP = 402;
export const WHEELS = [-52, 52];
export const STEAM = 5;

const STACK_H = 140;
const DIP = 122;
const IMPACT = 0.42;
const SUBMERGED = 0.45;

export const station = (p: number) => 95 + p * PITCH;
export const PRESS_X = station(1);
export const TANK_X = station(2);

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
  [0, 1].map((i) => {
    const side = i === 1 ? 1 : -1;
    const x0 = side * w * (0.2 + 0.1 * rand(seed + i));
    const y0 = -h * 0.8;
    const x1 = x0 + side * w * 0.12;
    const y1 = y0 + h * 0.2;
    return `M${f(x0)} ${f(y0)}Q${f(x0 + side * w * 0.1)} ${f(y0 + h * 0.02)} ${f(x1)} ${f(y1)}`;
  });

export const items = [...layers]
  .sort((a, b) => b.share - a.share)
  .map((l, i) => {
    const w = 116 + l.share * 100;
    const h = 64 + l.share * 120;
    return {
      name: l.kind === "skills" ? "Skills" : l.name,
      tokens: l.share * startTokens,
      w,
      h,
      slab: Math.max(6, l.share * STACK_H),
      outline: sackOutline(w, h, i + 1),
      creases: creases(w, h, i + 1),
    };
  });

export const resentShare = (startTokens * requests) / inputTokens;

let floorY = CART_TOP;
export const stack = items.map((it) => {
  const bottom = floorY;
  floorY -= it.slab;
  return { bottom, top: floorY };
});

export const END = (items.length + 2) * CYCLE + MOVE + 0.5;

const ramBottom = (j: number, dwell: number) => {
  if (j < 0 || j >= items.length) return RAM_UP;
  const stop = BELT - items[j].slab;
  const lift = 10 * Math.sin(Math.PI * span(dwell, 0, 0.18));
  const down = easeIn(span(dwell, 0.18, IMPACT));
  const up = inOut(span(dwell, 0.8, 1.25));
  return RAM_UP - lift + (stop - RAM_UP) * down * (1 - up);
};

const platDepth = (j: number, dwell: number) =>
  j >= 0 && j < items.length ? DIP * inOut(span(dwell, 0.08, SUBMERGED)) * (1 - inOut(span(dwell, 0.9, 1.3))) : 0;

const wave = (y: number, amp: number, t: number) => {
  let d = `M${TANK_L + 2} ${f(y)}`;
  for (let x = TANK_L + 2; x < TANK_R - 2; x += 12) {
    d += `L${Math.min(x + 12, TANK_R - 2)} ${f(y + amp * Math.sin(x * 0.12 - t * 9))}`;
  }
  return d;
};

export function scene(time: number) {
  const t = Math.min(time, END);
  const n = items.length;
  const c = Math.floor(t / CYCLE);
  const tau = t - c * CYCLE;
  const e = inOut(clamp01(tau / MOVE));
  const dwell = tau - MOVE;
  const offset = (c + e) * PITCH;
  const attrs: Record<string, Attrs> = {};
  const texts: Record<string, string> = {};

  attrs["tread-l"] = { "stroke-dashoffset": f(-offset) };
  attrs["tread-r"] = { "stroke-dashoffset": f(-offset) };
  const spin = (x: number, r: number) => ({ transform: `rotate(${f(((offset / r) * 180) / Math.PI)} ${x} ${BELT + 12})` });
  ROLLERS.forEach((x, i) => (attrs[`r${i}`] = spin(x, 8)));
  attrs.rl = spin(LEFT_END, 12);
  attrs.rs = spin(RIGHT_START, 12);
  attrs.re = spin(BELT_END, 12);

  const pj = c - 1;
  const ram = ramBottom(pj, dwell);
  const since = dwell - IMPACT;
  attrs.ram = { transform: `translate(0 ${f(ram - RAM_UP)})` };
  attrs.rod = { height: f(Math.max(0, ram - 22 - 84)) };

  const tj = c - 2;
  const dipping = tj >= 0 && tj < n;
  const depth = platDepth(tj, dwell);
  const plat = BELT + depth;
  attrs.plat = { transform: `translate(0 ${f(depth)})` };
  const level = WATER - (dipping ? 7 * (depth / DIP) * (items[tj].slab / 66) : 0);
  attrs.water = { y: f(level), height: f(FLOOR - 4 - level) };
  const ripple = dipping ? 4 * Math.exp(-Math.max(0, dwell - 0.3) * 3) * span(depth, 0, 20) : 0;
  attrs.surface = { d: wave(level, ripple, t) };

  const life = dwell - (SUBMERGED - 0.05);
  for (let i = 0; i < STEAM; i++) {
    const l = dipping ? span(life, i * 0.08, i * 0.08 + 0.8) : 0;
    const seed = tj * 17 + i;
    const x = TANK_X + (rand(seed) - 0.5) * 100 + (rand(seed + 1) - 0.5) * 40 * l;
    const y = level - 6 - 110 * easeOut(l);
    attrs[`st${i}`] = {
      opacity: f(l > 0 && l < 1 ? (1 - l) * Math.min(1, l * 6) : 0),
      transform: `translate(${f(x)} ${f(y)}) scale(${f(0.6 + 1.2 * l)})`,
    };
  }

  items.forEach((it, j) => {
    const p = c - j;
    const key = `b${j}`;
    let px = station(p - 1) + e * PITCH;
    let y = BELT;
    let rot = 0;
    let visible = p >= 0 && p <= 3;
    let sx = 1;
    let sy = 1;
    let slab = p >= 2;
    const heat = p === 2 ? 1 - span(dwell, SUBMERGED, 1.0) : p >= 3 ? 0 : 1;
    let springX = 1;

    if (p === 1) {
      if (since < 0) {
        sy = Math.min(it.h, BELT - ram) / it.h;
        sx = Math.min(1 + 0.55 * (1 - sy), 214 / it.w);
      } else {
        slab = true;
        springX = 1 + 0.3 * (1 - outBack(span(since, 0, 0.3)));
      }
    }
    if (p === 2 && dwell >= 0) y = plat;
    if (p === 3) {
      px = TANK_X + e * (CART_X - TANK_X);
      if (px > BELT_END) {
        const fall = (px - BELT_END) / (CART_X - BELT_END);
        y = BELT + (stack[j].bottom - BELT) * fall * fall;
        rot = 14 * Math.sin(Math.PI * fall);
      }
      visible = tau < MOVE;
    }

    attrs[key] = { transform: `translate(${f(px)} ${f(y)}) rotate(${f(rot)})`, opacity: visible ? "1" : "0" };
    attrs[`${key}s`] = { transform: `scale(${f(sx)} ${f(sy)})`, opacity: slab ? "0" : "1" };
    attrs[`${key}m`] = { transform: `scale(${f(springX)} 1)`, opacity: slab ? "1" : "0" };
    attrs[`${key}h`] = { opacity: f(heat) };
    attrs[`${key}t`] = { opacity: f(1 - span(heat, 0, 0.5)) };
  });

  const landed = Math.max(0, Math.min(n, c - 3 + (tau >= MOVE ? 1 : 0)));
  items.forEach((_, j) => (attrs[`s${j}`] = { opacity: j < landed ? "1" : "0" }));

  const fresh = c - 3 >= 0 && c - 3 < n && tau >= MOVE ? c - 3 : -1;
  const count =
    items.slice(0, landed).reduce((sum, it) => sum + it.tokens, 0) -
    (fresh >= 0 ? items[fresh].tokens * (1 - easeOut(span(dwell, 0, 0.5))) : 0);
  texts.count = kilo(count);

  return { attrs, texts };
}
