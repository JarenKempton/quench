import { inputTokens, kilo, layers, requests, servers, skillUse, startTokens } from "./context.ts";

type Point = [number, number];
type Attrs = Record<string, string>;

export const W = 960;
export const H = 460;
export const BELT = 250;
export const FLOOR = 440;
export const CYCLE = 2.4;
export const MOVE = 0.85;
export const PITCH = 225;
export const SLOTS = 8;
export const SLAB_W = 124;
export const RAM_UP = 106;
export const LEFT_END = 450;
export const RIGHT_START = 636;
export const BELT_END = 700;
export const ROLLERS = [10, 100, 190, 280, 370];
export const TANK_L = 470;
export const TANK_R = 620;
export const BEAM = 118;
export const WATER = 284;
export const CART_X = 840;
export const CART_TOP = 402;
export const WHEELS = [-52, 52];
export const STEAM = 9;

const STACK_H = 140;
const DIP = 122;
const IMPACT = 0.35;
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
  [0, 1, 2].map((i) => {
    const side = i === 1 ? 1 : -1;
    const x0 = side * w * (0.18 + 0.12 * rand(seed + i));
    const y0 = -h * (0.82 - 0.12 * i);
    const x1 = x0 + side * w * 0.14;
    const y1 = y0 + h * 0.2;
    return `M${f(x0)} ${f(y0)}Q${f(x0 + side * w * 0.12)} ${f(y0 + h * 0.02)} ${f(x1)} ${f(y1)}`;
  });

const used = (l: (typeof layers)[number]) => {
  if (l.kind === "skills") return { used: skillUse.used, of: skillUse.listed };
  const server = servers.find((s) => l.name === `MCP: ${s.server}`);
  return server ? { used: server.called, of: server.tools } : null;
};

export const items = [...layers]
  .sort((a, b) => b.share - a.share)
  .map((l, i) => {
    const w = 116 + l.share * 100;
    const h = 64 + l.share * 120;
    return {
      name: l.name,
      tokens: l.share * startTokens,
      use: used(l),
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
export const stackTop = floorY;

const ramBottom = (j: number, dwell: number) => {
  if (j >= items.length) return RAM_UP;
  const stop = BELT - items[j].slab;
  const down = easeIn(span(dwell, 0.05, IMPACT));
  const up = inOut(span(dwell, 0.85, 1.35));
  return RAM_UP + (stop - RAM_UP) * down * (1 - up);
};

const platDepth = (j: number, dwell: number) =>
  j < items.length ? DIP * inOut(span(dwell, 0.08, SUBMERGED)) * (1 - inOut(span(dwell, 0.95, 1.4))) : 0;

const wave = (y: number, amp: number, t: number) => {
  let d = `M${TANK_L + 2} ${f(y)}`;
  for (let x = TANK_L + 2; x < TANK_R - 2; x += 12) {
    const dy = amp * Math.sin(x * 0.12 - t * 9) + 1.5 * Math.sin(x * 0.05 + t * 2);
    d += `L${Math.min(x + 12, TANK_R - 2)} ${f(y + dy)}`;
  }
  return d;
};

export const STILL = SLOTS * CYCLE + MOVE + 1.3;

export function scene(t: number) {
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

  const pj = mod(c - 1, SLOTS);
  const pressing = pj < items.length;
  const ram = ramBottom(pj, dwell);
  const since = dwell - IMPACT;
  const shake = pressing && since > 0 ? 3 * Math.exp(-since * 14) * Math.cos(since * 60) : 0;
  attrs.press = { transform: `translate(0 ${f(shake)})` };
  attrs.ram = { transform: `translate(0 ${f(ram - RAM_UP)})` };
  attrs.rod = { height: f(ram - 20 - 84) };
  attrs.impact = { opacity: f(pressing ? (since >= 0 ? 1 - span(since, 0, 0.22) : 0) : 0) };

  const tj = mod(c - 2, SLOTS);
  const dipping = tj < items.length;
  const depth = platDepth(tj, dwell);
  const plat = BELT + depth;
  attrs.plat = { transform: `translate(0 ${f(depth)})` };
  attrs.cable0 = { y2: f(plat) };
  attrs.cable1 = { y2: f(plat) };
  const level = WATER - (dipping ? 7 * (depth / DIP) * (items[tj].slab / 66) : 0);
  attrs.water = { y: f(level), height: f(FLOOR - 4 - level) };
  const ripple = dipping ? 5 * Math.exp(-Math.max(0, dwell - 0.3) * 3) * span(depth, 0, 20) : 0;
  attrs.surface = { d: wave(level, ripple, t) };

  const life = dwell - (SUBMERGED - 0.05);
  for (let i = 0; i < STEAM; i++) {
    const l = dipping ? span(life, i * 0.06, i * 0.06 + 0.7) : 0;
    const seed = tj * 17 + i;
    const x = TANK_X + (rand(seed) - 0.5) * 110 + (rand(seed + 1) - 0.5) * 50 * l;
    const y = level - 4 - 120 * easeOut(l);
    attrs[`st${i}`] = {
      opacity: f(l > 0 && l < 1 ? (1 - l) * Math.min(1, l * 6) : 0),
      transform: `translate(${f(x)} ${f(y)}) scale(${f(0.5 + 1.3 * l)})`,
    };
  }

  items.forEach((it, j) => {
    const p = mod(c - j, SLOTS);
    const key = `b${j}`;
    let px = station(p - 1) + e * PITCH;
    let y = BELT;
    let rot = 0;
    let visible = p <= 3;
    let sx = 1;
    let sy = 1;
    let slab = p >= 2;
    let heat = p === 2 ? 1 - span(dwell, SUBMERGED, 1.0) : p >= 3 ? 0 : 1;
    let springX = 1;

    if (p === 1 && pressing && pj === j) {
      if (since < 0) {
        sy = Math.min(it.h, BELT - ram) / it.h;
        sx = Math.min(1 + 0.55 * (1 - sy), 214 / it.w);
      } else {
        slab = true;
        springX = 1 + 0.35 * (1 - outBack(span(since, 0, 0.3)));
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

  const k = mod(c - 3, SLOTS);
  const landed = k < items.length ? k + (tau >= MOVE ? 1 : 0) : k === items.length ? items.length : 0;
  let cartDx = 0;
  if (k === items.length) cartDx = 320 * easeIn(span(tau, 0.15, 1.9));
  if (k === items.length + 1) cartDx = 240 * (1 - easeOut(span(tau, 0.1, 1.5)));
  attrs.cart = { transform: `translate(${f(cartDx)} 0)` };
  WHEELS.forEach((x, i) => (attrs[`w${i}`] = { transform: `rotate(${f((cartDx / 12) * (180 / Math.PI))} ${CART_X + x} 427)` }));
  items.forEach((_, j) => (attrs[`s${j}`] = { opacity: j < landed ? "1" : "0" }));
  const strap = k === items.length - 1 ? inOut(span(dwell, 0.15, 0.6)) : k === items.length ? 1 : 0;
  attrs.straps = { opacity: f(Math.min(1, strap * 3)), transform: `translate(0 ${f(-30 * (1 - strap))})` };
  attrs.lamp = { "data-on": strap >= 1 ? "1" : "0" };

  const fresh = k < items.length && tau >= MOVE ? k : -1;
  const count =
    items.slice(0, landed).reduce((n, it) => n + it.tokens, 0) -
    (fresh >= 0 ? items[fresh].tokens * (1 - easeOut(span(dwell, 0, 0.5))) : 0);
  texts.count = kilo(count);

  return { attrs, texts, rows: items.map((_, j) => (j === fresh && dwell < 1.2 ? "now" : j < landed ? "on" : "off")) };
}
