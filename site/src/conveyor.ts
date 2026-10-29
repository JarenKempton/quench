export interface Part {
  short: string;
  detail: string;
  label: string;
  tokens: number;
  used: string;
  idle: boolean;
  color: string;
}

const NS = "http://www.w3.org/2000/svg";
const CYCLE = 2.2;
const SEQ = 7;
const MOVE = 0.3;
const START = 15.7;
const POSTER = { u: 12.8, phases: [0.95, 0.56, 0.8, 0.8] };
const POINTS = 72;
const PARTICLES = 14;
const VERBS = ["Pull in", "Smash", "Lock", "Spit out"];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const span = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const inOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const inCubic = (t: number) => t ** 3;
const outCubic = (t: number) => 1 - (1 - t) ** 3;
const outBack = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const bell = (v: number, a: number, b: number) => span(v, a, a + 0.05) * (1 - span(v, b - 0.12, b));
const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
const noise = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const f1 = (n: number) => n.toFixed(1);

type Attrs = Record<string, string | number>;

const node = <K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  set(el, attrs);
  parent.appendChild(el);
  return el;
};

const set = (el: Element, attrs: Attrs) => {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
};

const show = (el: SVGElement, on: boolean) => {
  el.style.display = on ? "" : "none";
};

function geometry(w: number, h: number) {
  const narrow = w < 720;
  const pitch = narrow ? (w - 12) / 4 : (w * 0.6) / 4;
  const slots = [0, 1, 2, 3].map((i) => (narrow ? 6 : 0) + pitch * (i + 0.5));
  const R = narrow ? Math.min(44, pitch * 0.33) : Math.min(70, pitch * 0.37);
  const hb = narrow ? 13 : 20;
  const head = narrow ? 18 : 26;
  const slab = narrow ? 20 : 30;
  const beltY = head + slab + 2.2 * R + (narrow ? 26 : 34);
  const beltR = narrow ? slots[3] + pitch * 0.42 : 4 * pitch + 6;
  const maxW = pitch * (narrow ? 0.8 : 0.76);
  const verb = narrow ? 19 : 36;
  const numY = beltY + (narrow ? 9 : 14) + (narrow ? 18 : 26);
  const verbY = numY + verb + 2;
  const floor = narrow ? Math.min(h - 16, verbY + 48 + 6 * 17) : h - 20;
  return {
    w,
    h,
    narrow,
    pitch,
    slots,
    R,
    hb,
    gap: narrow ? 4 : 5,
    head,
    slab,
    slabW: maxW + (narrow ? 10 : 22),
    hazard: narrow ? 4 : 6,
    beltY,
    beltL: -20,
    beltR,
    belt: narrow ? 9 : 14,
    ramRest: beltY - 2.2 * R - 10,
    hopY: beltY - 2.2 * R - 16,
    maxW,
    floor,
    edge: narrow ? w - 14 : beltR + 44,
    align: narrow ? -1 : 1,
    numY,
    verbY,
    labelFloor: narrow ? 170 : 0,
    type: {
      name: narrow ? 9.5 : 13,
      detail: narrow ? 0 : 11,
      note: narrow ? 10 : 12,
      stamp: narrow ? 8.5 : 10.5,
      verb,
      num: narrow ? 9 : 11,
      label: narrow ? 10 : 12,
      counter: narrow ? 46 : 92,
      caption: narrow ? 9 : 11,
      slab: narrow ? 9 : 13,
    },
  };
}

type Geo = ReturnType<typeof geometry>;

function rectPoint(s: number, hw: number, hh: number): [number, number] {
  if (s < hh) return [hw, s];
  if (s < hh + 2 * hw) return [hw - (s - hh), hh];
  if (s < 3 * hh + 2 * hw) return [-hw, hh - (s - hh - 2 * hw)];
  if (s < 3 * hh + 4 * hw) return [-hw + (s - 3 * hh - 2 * hw), -hh];
  return [hw, -hh + (s - 3 * hh - 4 * hw)];
}

function shape(R: number, bw: number, hb: number, k: number, t: number, seed: number) {
  const hw = bw / 2;
  const hh = hb / 2;
  if (k >= 1) return `M${f1(-hw)} ${-hb}H${f1(hw)}V0H${f1(-hw)}Z`;
  const perimeter = 4 * hw + 4 * hh;
  let d = "";
  for (let i = 0; i < POINTS; i++) {
    const u = i / POINTS;
    const th = u * Math.PI * 2;
    const calm = 1 - 0.85 * Math.max(0, Math.sin(th)) ** 3;
    const lump =
      0.08 * Math.sin(5 * th + seed + t * 1.9) +
      0.05 * Math.sin(8 * th + seed * 2 - t * 2.7) +
      0.035 * Math.sin(3 * th - t * 1.3);
    const r = R * (1 + lump * calm);
    const bx = Math.cos(th) * r;
    const by = Math.min(0, Math.sin(th) * r - R * 0.92);
    const [rx, ry] = rectPoint(u * perimeter, hw, hh);
    d += `${i ? "L" : "M"}${f1(lerp(bx, rx, k))} ${f1(lerp(by, ry - hh, k))}`;
  }
  return `${d}Z`;
}

function makeItem(parent: Element) {
  const g = node(parent, "g", { class: "qc-item" });
  const shadow = node(g, "path", { class: "qc-shadow", transform: "translate(5 6)" });
  const body = node(g, "path", { class: "qc-body" });
  const words = node(g, "g", { class: "qc-words" });
  const name = node(words, "text", { class: "qc-name", "text-anchor": "middle", "dominant-baseline": "central" });
  const detail = node(words, "text", { class: "qc-detail", "text-anchor": "middle", "dominant-baseline": "central" });
  const note = node(g, "g", { class: "qc-note" });
  const dim = node(note, "path", { class: "qc-dim" });
  const value = node(note, "text", { class: "qc-value", "text-anchor": "middle" });
  const stamp = node(note, "g", { class: "qc-stamp" });
  const stampBox = node(stamp, "rect");
  const stampText = node(stamp, "text", { "text-anchor": "middle", "dominant-baseline": "central" });
  return { g, shadow, body, words, name, detail, note, dim, value, stamp, stampBox, stampText };
}

type Item = ReturnType<typeof makeItem>;

function makeVerb(parent: Element, i: number) {
  const g = node(parent, "g", { class: "qc-station" });
  const num = node(g, "text", { class: "qc-num", "text-anchor": "middle" });
  num.textContent = `0${i + 1}`;
  const word = node(g, "g");
  const outline = node(word, "text", { class: "qc-verb qc-verb-line", "text-anchor": "middle" });
  const solid = node(word, "text", { class: "qc-verb", "text-anchor": "middle" });
  outline.textContent = solid.textContent = VERBS[i].toUpperCase();
  return { g, num, word, outline, solid };
}

function makeStackRow(parent: Element) {
  const bar = node(parent, "rect", { class: "qc-bar" });
  const label = node(parent, "text", { class: "qc-label", "dominant-baseline": "central" });
  const value = node(label, "tspan", { class: "qc-label-value" });
  const name = node(label, "tspan", { class: "qc-label-name" });
  const usage = node(label, "tspan", { class: "qc-label-usage" });
  return { bar, label, value, name, usage };
}

export function mountConveyor(figure: HTMLElement) {
  const svg = figure.querySelector("svg");
  if (!svg) return;
  const parts: Part[] = JSON.parse(figure.dataset.parts ?? "[]");
  const maxTokens = Math.max(...parts.map((p) => p.tokens));

  const defs = node(svg, "defs");
  parts.forEach((p, i) => {
    const pattern = node(defs, "pattern", {
      id: `qc-hatch-${i}`,
      width: 7,
      height: 7,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    node(pattern, "rect", { width: 2.5, height: 7 }).style.fill = p.color;
  });
  const hazard = node(defs, "pattern", {
    id: "qc-hazard",
    width: 12,
    height: 12,
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  });
  node(hazard, "rect", { width: 12, height: 12, class: "qc-hazard-a" });
  node(hazard, "rect", { width: 6, height: 12, class: "qc-hazard-b" });

  const scene = node(svg, "g");
  const stations = [0, 1, 2, 3].map((i) => makeVerb(scene, i));
  const rails = node(scene, "path", { class: "qc-rail" });
  const hopper = node(scene, "path", { class: "qc-hopper" });
  const beltBody = node(scene, "rect", { class: "qc-belt" });
  const treadTop = node(scene, "line", { class: "qc-tread" });
  const treadReturn = node(scene, "line", { class: "qc-tread qc-tread-return" });
  const roller = node(scene, "circle", { class: "qc-roller" });
  const spoke = node(scene, "path", { class: "qc-spoke" });

  const stack = node(scene, "g", { class: "qc-stack" });
  const pallet = node(stack, "rect", { class: "qc-pallet" });
  const caption = node(stack, "text", { class: "qc-caption" });
  const counterBlock = node(stack, "rect", { class: "qc-counter-block" });
  const counter = node(stack, "text", { class: "qc-counter" });
  const rows = parts.map(() => makeStackRow(stack));

  const itemLayer = node(scene, "g");
  const items = [0, 1, 2, 3].map(() => makeItem(itemLayer));

  const fx = node(scene, "g");
  const puffs = Array.from({ length: PARTICLES }, () => node(fx, "circle", { class: "qc-puff" }));
  const streaks = node(fx, "path", { class: "qc-streak" });
  const brackets = node(scene, "path", { class: "qc-bracket" });

  const ram = node(scene, "g", { class: "qc-ram" });
  const rod = node(ram, "rect", { class: "qc-rod" });
  const slab = node(ram, "rect", { class: "qc-slab" });
  const slabStripe = node(ram, "rect", { fill: "url(#qc-hazard)" });
  const slabText = node(ram, "text", { class: "qc-slab-text", "text-anchor": "middle", "dominant-baseline": "central" });
  slabText.textContent = "QUENCH";
  const headBlock = node(ram, "rect", { class: "qc-head" });

  let geo = geometry(1200, 380);

  const barWidth = (tokens: number) => Math.max(geo.narrow ? 5 : 8, (geo.maxW * tokens) / maxTokens);
  const slotX = (pos: number) => geo.slots[0] + pos * geo.pitch;
  const present = (n: number) => n >= 0 && n % SEQ !== SEQ - 1;
  const radius = (i: number) => geo.R * (0.86 + 0.14 * noise(i, 1));
  const stackX = (bw: number) => (geo.align === 1 ? geo.edge + bw / 2 : geo.edge - bw / 2);
  const stackBase = (i: number) => geo.floor - i * (geo.hb + geo.gap);

  const ramFace = (fs: number) => {
    const bottom = geo.beltY - geo.hb;
    if (fs < 0.4) return geo.ramRest;
    if (fs < 0.5) return lerp(geo.ramRest, bottom, inCubic(span(fs, 0.4, 0.5)));
    if (fs < 0.64) {
      const tau = (fs - 0.5) * CYCLE;
      return bottom - 4 * Math.exp(-tau * 22) * Math.abs(Math.sin(tau * 44));
    }
    return lerp(bottom, geo.ramRest, inOut(span(fs, 0.64, 0.88)));
  };

  function drawItem(it: Item, n: number, age: number, fs: number, moving: boolean, e: number, T: number) {
    const idx = n % SEQ;
    const pos = moving ? age - 1 + e : age;
    const hidden =
      !present(n) || pos < 0 || (age === 0 && fs < 0.3) || (age === 3 && !moving && fs >= 0.64);
    show(it.g, !hidden);
    if (hidden) return;

    const p = parts[idx];
    const R = radius(idx);
    const bw = barWidth(p.tokens);
    const { hb, beltY } = geo;
    let x = slotX(pos);
    let y = beltY;
    let rot = 0;
    let skew = 0;
    let sx = 1;
    let sy = 1;
    let k = age >= 2 ? 1 : 0;

    if (age === 0) {
      const q = span(fs, 0.3, 0.47);
      y = lerp(-2.4 * R - 12, beltY, q * q);
      if (q < 1) {
        sx = 0.8;
        sy = 1.22;
      } else {
        const s = Math.exp(-(fs - 0.47) * CYCLE * 6) * Math.cos((fs - 0.47) * CYCLE * 24);
        sx = 1 + 0.16 * s;
        sy = 1 - 0.2 * s;
      }
    }

    if (age === 1) {
      if (moving) {
        skew = 9 * Math.sin(2 * Math.PI * span(e, 0, 1)) * (1 - e * 0.3);
      } else {
        const tau = (fs - MOVE) * CYCLE;
        skew = -7 * Math.exp(-tau * 5) * Math.sin(tau * 16);
        const top = beltY - 1.95 * R;
        k = fs >= 0.5 ? 1 : span(ramFace(fs), top, beltY - hb);
        skew *= 1 - k;
      }
    }

    const locked = age === 3 || (age === 2 && !moving && fs >= 0.52);
    let noteAlpha = locked ? 1 : 0;

    if (age === 3 && !moving && fs >= 0.36) {
      const q = span(fs, 0.36, 0.64);
      x = lerp(x, stackX(bw), q);
      y = lerp(beltY, stackBase(idx), q * q) - (geo.narrow ? 6 : 10) * Math.sin(Math.PI * q);
      rot = 12 * Math.sin(Math.PI * q);
      noteAlpha = 1 - span(q, 0, 0.4);
    }

    set(it.g, {
      transform: `translate(${f1(x)} ${f1(y)}) rotate(${f1(rot)}) skewX(${f1(skew)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`,
    });
    const d = shape(R, bw, hb, k, T, idx * 1.7);
    it.body.setAttribute("d", d);
    it.shadow.setAttribute("d", d);

    const flash = age === 2 && !moving && fs >= 0.52 && fs < 0.56;
    const hatched = k >= 1 && !locked;
    it.body.style.fill = flash ? "var(--ink)" : hatched ? `url(#qc-hatch-${idx})` : p.color;
    it.body.style.stroke = hatched ? p.color : "none";
    it.shadow.style.display = hatched ? "none" : "";

    const wordsOn = k < 0.6;
    show(it.words, wordsOn);
    if (wordsOn) {
      set(it.words, {
        transform: `translate(0 ${f1(-R * 0.92)}) scale(${(1 + 0.5 * k).toFixed(3)} ${(1 - 0.9 * k).toFixed(3)})`,
        opacity: (1 - k / 0.6).toFixed(3),
      });
      it.name.textContent = p.short;
      const hasDetail = geo.type.detail > 0;
      set(it.name, { y: hasDetail ? -7 : 0, "font-size": geo.type.name });
      show(it.detail, hasDetail);
      if (hasDetail) {
        it.detail.textContent = p.detail;
        set(it.detail, { y: 9, "font-size": geo.type.detail });
      }
    }

    show(it.note, noteAlpha > 0);
    if (noteAlpha > 0) {
      const draw = age === 2 && !moving ? outCubic(span(fs, 0.52, 0.62)) : 1;
      const count = age === 2 && !moving ? outCubic(span(fs, 0.52, 0.72)) : 1;
      const dy = -hb - (geo.narrow ? 8 : 12);
      const a = (bw / 2) * draw;
      const tick = geo.narrow ? 3 : 4;
      set(it.note, { opacity: noteAlpha.toFixed(3) });
      set(it.dim, { d: `M${f1(-a)} ${dy - tick}V${dy + tick}M${f1(-a)} ${dy}H${f1(a)}M${f1(a)} ${dy - tick}V${dy + tick}` });
      it.value.textContent = kilo(p.tokens * count);
      set(it.value, { y: dy - (geo.narrow ? 6 : 9), "font-size": geo.type.note });

      const stampQ = age === 2 && !moving ? span(fs, 0.6, 0.68) : 1;
      show(it.stamp, !!p.used && stampQ > 0);
      if (p.used && stampQ > 0) {
        const size = geo.type.stamp;
        const text = p.used.toUpperCase();
        const sw = text.length * size * 0.6 + size * 1.4;
        const sh = size * 2;
        const s = lerp(1.9, 1, outBack(stampQ));
        const sy0 = dy - (geo.narrow ? 32 : 46);
        set(it.stamp, {
          transform: `translate(0 ${f1(sy0)}) rotate(-6) scale(${s.toFixed(3)})`,
          opacity: stampQ.toFixed(3),
          class: p.idle ? "qc-stamp qc-idle" : "qc-stamp",
        });
        set(it.stampBox, { x: f1(-sw / 2), y: f1(-sh / 2), width: f1(sw), height: f1(sh) });
        set(it.stampText, { "font-size": size });
        it.stampText.textContent = text;
      }
    }
  }

  function frame(u: number, still?: number[]) {
    const c = Math.floor(u);
    const f = u - c;
    const moving = !still && f < MOVE;
    const e = moving ? inOut(f / MOVE) : 1;
    const T = u * CYCLE;
    const phase = (age: number) => (still ? still[age] : f);
    const { w, h, beltY, hb, pitch, narrow } = geo;

    svg!.setAttribute("viewBox", `0 0 ${f1(w)} ${f1(h)}`);

    for (let age = 0; age < 4; age++) {
      const n = c - age;
      drawItem(items[((n % 4) + 4) % 4], n, age, phase(age), moving, e, T);
    }

    const pressN = c - 1;
    const pressing = present(pressN) && !moving;
    const fs1 = phase(1);
    const face = pressing ? ramFace(fs1) : geo.ramRest;
    const x1 = geo.slots[1];
    const impact = pressing && fs1 >= 0.5 ? (fs1 - 0.5) * CYCLE : -1;

    set(headBlock, { x: f1(x1 - pitch * 0.44), y: -1, width: f1(pitch * 0.88), height: geo.head + 1 });
    set(rod, { x: f1(x1 - (narrow ? 5 : 8)), y: geo.head, width: narrow ? 10 : 16, height: f1(Math.max(0, face - geo.slab - geo.head)) });
    set(slab, { x: f1(x1 - geo.slabW / 2), y: f1(face - geo.slab), width: f1(geo.slabW), height: geo.slab - geo.hazard });
    set(slabStripe, { x: f1(x1 - geo.slabW / 2), y: f1(face - geo.hazard), width: f1(geo.slabW), height: geo.hazard });
    set(slabText, { x: f1(x1), y: f1(face - geo.slab / 2 - geo.hazard / 2), "font-size": geo.type.slab });
    const railX = geo.slabW / 2 + (narrow ? 3 : 6);
    set(rails, { d: `M${f1(x1 - railX)} ${geo.head}V${f1(beltY)}M${f1(x1 + railX)} ${geo.head}V${f1(beltY)}` });

    const x0 = geo.slots[0];
    const mouth = geo.R * 0.72;
    const lip = pitch * 0.46;
    const plate = narrow ? 7 : 12;
    let hop = "";
    for (const side of [-1, 1]) {
      const top = x0 + side * lip;
      const low = x0 + side * mouth;
      hop += `M${f1(top)} -2L${f1(low)} ${f1(geo.hopY)}H${f1(low + side * plate)}L${f1(top + side * plate * 1.6)} -2Z`;
    }
    set(hopper, { d: hop });

    const travel = (c + e) * pitch;
    set(beltBody, { x: geo.beltL, y: f1(beltY), width: f1(geo.beltR - geo.beltL), height: geo.belt, rx: geo.belt / 2 });
    set(treadTop, { x1: geo.beltL, x2: f1(geo.beltR - geo.belt / 2), y1: f1(beltY + 3), y2: f1(beltY + 3), "stroke-dashoffset": f1(-travel) });
    set(treadReturn, {
      x1: geo.beltL,
      x2: f1(geo.beltR - geo.belt / 2),
      y1: f1(beltY + geo.belt - 3),
      y2: f1(beltY + geo.belt - 3),
      "stroke-dashoffset": f1(travel),
    });
    const rc = { x: geo.beltR - geo.belt / 2, y: beltY + geo.belt / 2, r: geo.belt / 2 - 2.5 };
    set(roller, { cx: f1(rc.x), cy: f1(rc.y), r: f1(rc.r) });
    const ang = travel / (geo.belt / 2);
    set(spoke, {
      d: `M${f1(rc.x - Math.cos(ang) * rc.r)} ${f1(rc.y - Math.sin(ang) * rc.r)}L${f1(rc.x + Math.cos(ang) * rc.r)} ${f1(rc.y + Math.sin(ang) * rc.r)}`,
    });

    const pressPart = parts[pressN % SEQ];
    const pressBw = pressPart ? barWidth(pressPart.tokens) : 0;
    const life = 0.5;
    const burst = impact >= 0 && impact < life;
    puffs.forEach((puff, j) => {
      show(puff, burst);
      if (!burst) return;
      const side = j % 2 ? 1 : -1;
      const vx = side * (90 + 260 * noise(pressN, j));
      const vy = -(120 + 240 * noise(j, pressN));
      const r = (narrow ? 2 : 3) + (narrow ? 4 : 7) * noise(pressN + j, 3);
      set(puff, {
        cx: f1(x1 + side * pressBw * 0.5 + vx * impact),
        cy: f1(beltY - hb / 2 + vy * impact + 700 * impact * impact),
        r: f1(r * (1 - impact / life) ** 0.7),
      });
      puff.style.fill = pressPart.color;
    });
    const streak = !still && impact >= 0 && impact < 0.28;
    show(streaks, streak);
    if (streak) {
      const reach = outCubic(impact / 0.28);
      const len = (narrow ? 18 : 34) * (1 - reach);
      let d = "";
      for (const side of [-1, 1]) {
        for (const off of [-1, 0, 1]) {
          const sx0 = x1 + side * (pressBw / 2 + 8 + reach * (narrow ? 18 : 40));
          const yy = beltY - hb / 2 + off * (narrow ? 5 : 8) - (off === 0 ? 0 : 0);
          d += `M${f1(sx0)} ${f1(yy)}h${f1(side * len * (off === 0 ? 1.4 : 1))}`;
        }
      }
      set(streaks, { d });
    }

    const lockN = c - 2;
    const fs2 = phase(2);
    const locking = present(lockN) && !moving && fs2 >= 0.4 && fs2 < 0.96;
    show(brackets, locking);
    if (locking) {
      const bw = barWidth(parts[lockN % SEQ].tokens);
      const far = narrow ? 18 : 30;
      const near = narrow ? 4 : 6;
      const pad =
        fs2 < 0.52 ? lerp(far, near, outBack(span(fs2, 0.4, 0.52))) : fs2 < 0.86 ? near : lerp(near, far, inCubic(span(fs2, 0.86, 0.96)));
      const L = narrow ? 6 : 10;
      const x2 = geo.slots[2];
      const l = x2 - bw / 2 - pad;
      const r = x2 + bw / 2 + pad;
      const t = beltY - hb - pad;
      const b = beltY + pad * 0.4;
      set(brackets, {
        d: `M${f1(l)} ${f1(t + L)}V${f1(t)}H${f1(l + L)}M${f1(r - L)} ${f1(t)}H${f1(r)}V${f1(t + L)}M${f1(r)} ${f1(b - L)}V${f1(b)}H${f1(r - L)}M${f1(l + L)} ${f1(b)}H${f1(l)}V${f1(b - L)}`,
        opacity: (span(fs2, 0.4, 0.46) * (1 - span(fs2, 0.88, 0.96))).toFixed(3),
      });
    }

    const shake = impact >= 0 && impact < 0.4 ? 3.5 * Math.exp(-impact * 16) * Math.cos(impact * 70) : 0;
    set(scene, { transform: still ? "" : `translate(0 ${f1(shake)})` });

    const acts: [number, number][] = [
      [present(c) ? bell(phase(0), 0.3, 0.66) : 0, c],
      [impact >= 0 ? 1 - span(impact, 0.3, 0.6) : 0, pressN],
      [present(lockN) && !moving ? bell(fs2, 0.5, 0.88) : 0, lockN],
      [present(c - 3) && !moving ? bell(phase(3), 0.36, 0.72) : 0, c - 3],
    ];
    stations.forEach((st, i) => {
      const [a, n] = acts[i];
      const x = geo.slots[i];
      set(st.num, { x: f1(x), y: f1(geo.numY), "font-size": geo.type.num });
      for (const t of [st.outline, st.solid]) set(t, { x: 0, y: 0, "font-size": geo.type.verb });
      st.solid.style.opacity = a.toFixed(3);
      if (a > 0) st.solid.style.fill = parts[n % SEQ].color;
      let tf = "";
      if (i === 0) tf = `translate(0 ${f1(-6 * (1 - outCubic(span(phase(0), 0.3, 0.42))) * (a > 0 ? 1 : 0))})`;
      if (i === 1 && impact >= 0) {
        const s = Math.exp(-impact * 9);
        tf = `scale(${(1 + 0.3 * s).toFixed(3)} ${(1 - 0.5 * s).toFixed(3)})`;
      }
      if (i === 2 && a > 0) tf = `scale(${(1 + 0.35 * (1 - outBack(span(fs2, 0.46, 0.56)))).toFixed(3)} 1)`;
      if (i === 3 && a > 0) tf = `translate(${f1(12 * Math.sin(Math.PI * span(phase(3), 0.36, 0.64)))} 0)`;
      set(st.word, { transform: `translate(${f1(x)} ${f1(geo.verbY)}) ${tf}` });
    });

    drawStack(u, !!still);
  }

  function drawStack(u: number, still: boolean) {
    const loop = Math.floor((u - 2.9) / SEQ);
    const base = SEQ * loop;
    const { floor, hb, align, edge, narrow, type } = geo;
    let sum = 0;
    let landed = 0;
    rows.forEach((row, i) => {
      const p = parts[i];
      const at = base + i + 3.64;
      const on = u >= at;
      show(row.bar, on);
      show(row.label, on);
      if (!on) return;
      landed++;
      const tau = still ? 9 : (u - at) * CYCLE;
      sum += p.tokens * outCubic(clamp(tau / 0.45));
      const bw = barWidth(p.tokens);
      const bx = align === 1 ? edge : edge - bw;
      const bottom = stackBase(i);
      const squash = 0.35 * Math.exp(-tau * 14) * Math.cos(tau * 36);
      set(row.bar, {
        x: f1(bx),
        y: f1(bottom - hb),
        width: f1(bw),
        height: hb,
        transform: `translate(${f1(bx + bw / 2)} ${f1(bottom)}) scale(${(1 + squash * 0.4).toFixed(3)} ${(1 - squash).toFixed(3)}) translate(${f1(-bx - bw / 2)} ${f1(-bottom)})`,
      });
      row.bar.style.fill = p.color;

      const value = kilo(p.tokens);
      const room = align === 1 ? geo.w - (edge + bw + 10) - 8 : edge - bw - 10 - geo.labelFloor;
      const width = (s: string) => s.length * type.label * 0.6;
      const full = `${value}  ${p.label}  ${p.used}`;
      const mid = `${value}  ${p.label}`;
      const pieces = p.used && width(full) <= room ? [value, p.label, p.used] : width(mid) <= room ? [value, p.label, ""] : [value, "", ""];
      let budget = Math.round(clamp((tau - 0.05) / 0.35) * pieces.join("  ").length);
      const spans = [row.value, row.name, row.usage];
      pieces.forEach((piece, j) => {
        const shown = piece.slice(0, Math.max(0, budget));
        budget -= piece.length + 2;
        spans[j].textContent = shown;
        set(spans[j], { dx: j && shown ? type.label * 1.2 : 0 });
      });
      row.usage.setAttribute("class", p.idle ? "qc-label-usage qc-idle" : "qc-label-usage");
      set(row.label, {
        x: f1(align === 1 ? edge + bw + 10 : edge - bw - 10),
        y: f1(bottom - hb / 2),
        "text-anchor": align === 1 ? "start" : "end",
        "font-size": type.label,
      });
    });

    const cx = narrow ? 14 : edge;
    const cy = narrow ? floor : 44 + type.counter * 0.74;
    set(counter, { x: f1(cx), y: f1(cy), "font-size": type.counter });
    counter.textContent = kilo(sum);
    set(caption, { x: f1(cx), y: f1(cy - type.counter * 0.74 - (narrow ? 10 : 14)), "font-size": type.caption });
    caption.textContent = "TOKENS BEFORE YOU TYPE";

    const done = landed === parts.length ? (u - (base + parts.length - 1 + 3.64)) * CYCLE : -1;
    const wipe = done >= 0.45 ? outCubic(clamp((done - 0.45) / 0.3)) : 0;
    show(counterBlock, wipe > 0);
    if (wipe > 0) {
      const bbox = counter.getBBox();
      const padX = narrow ? 6 : 10;
      set(counterBlock, {
        x: f1(bbox.x - padX),
        y: f1(bbox.y + bbox.height * 0.12),
        width: f1((bbox.width + padX * 2) * wipe),
        height: f1(bbox.height * 0.82),
      });
    }
    counter.classList.toggle("qc-counter-done", done >= 0.6);

    set(pallet, {
      x: f1(align === 1 ? edge - 6 : edge - geo.maxW - 6),
      y: f1(floor + 3),
      width: f1(geo.maxW + 12),
      height: narrow ? 3 : 4,
    });

    const arrive = span(u, base + 2.9, base + 3.25);
    const leave = span(u, base + 9.5, base + 9.88);
    set(stack, {
      transform: `translate(${f1(geo.w * inCubic(leave))} ${f1(36 * (1 - outCubic(arrive)))})`,
      opacity: (arrive * (1 - leave * 0.4)).toFixed(3),
    });
  }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let clock = START * CYCLE;
  let last = 0;
  let raf = 0;
  let visible = true;

  const draw = () => (reduce.matches ? frame(POSTER.u, POSTER.phases) : frame(clock / CYCLE));

  const tick = (now: number) => {
    clock += last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    frame(clock / CYCLE);
    raf = requestAnimationFrame(tick);
  };

  const sync = () => {
    cancelAnimationFrame(raf);
    last = 0;
    if (reduce.matches || !visible) draw();
    else raf = requestAnimationFrame(tick);
  };

  const resize = () => {
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return;
    geo = geometry(box.width, box.height);
    draw();
  };

  new ResizeObserver(resize).observe(svg);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(figure);
  reduce.addEventListener("change", sync);
  document.fonts?.ready.then(draw);
  resize();
  sync();
}
