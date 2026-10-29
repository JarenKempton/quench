export interface Part {
  name: string;
  tokens: number;
  used: string;
}

export interface Copy {
  caption: string;
  total: string;
  unit: string;
  rows: string[];
}

const NS = "http://www.w3.org/2000/svg";
const CYCLE = 2.2;
const MOVE = 0.2;
const LAND = 0.36;
const POINTS = 64;
const NOZZLES = 5;
const WISPS = 3;
const HOT = [255, 173, 102];
const COOL = [159, 220, 250];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const span = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const inOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const inCubic = (t: number) => t ** 3;
const outCubic = (t: number) => 1 - (1 - t) ** 3;
const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
const f1 = (n: number) => n.toFixed(1);
const mix = (t: number) => `rgb(${HOT.map((h, i) => Math.round(lerp(h, COOL[i], t))).join(" ")})`;
const settle = (tau: number, rate: number, freq: number) => Math.exp(-tau * rate) * Math.cos(tau * freq);

type Attrs = Record<string, string | number>;

const set = (el: Element, attrs: Attrs) => {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
};

const node = <K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  set(el, attrs);
  parent.appendChild(el);
  return el;
};

const show = (el: SVGElement, on: boolean) => {
  el.style.display = on ? "" : "none";
};

const rect = (x: number, y: number, w: number, h: number) => `M${f1(x)} ${f1(y)}h${f1(w)}v${f1(h)}h${f1(-w)}Z`;

function geometry(w: number, h: number) {
  const narrow = w < 900;
  const pitch = narrow ? (w - 40) / 3.3 : (w * 0.5) / 3.3;
  const R = narrow ? Math.min(38, pitch * 0.33) : Math.min(56, pitch * 0.31);
  const maxW = narrow ? Math.min(pitch * 0.72, 2.6 * R) : pitch * 0.72;
  const hb = narrow ? 11 : 16;
  const crownTop = narrow ? 8 : 14;
  const crownH = narrow ? 16 : 24;
  const cylH = narrow ? 18 : 30;
  const platen = narrow ? 10 : 16;
  const gap = narrow ? 10 : 14;
  const beltY = crownTop + crownH + cylH + (narrow ? 14 : 22) + platen + 2 * R + gap;
  const belt = narrow ? 10 : 14;
  const beltR = 3.3 * pitch;
  const bin = hb + (narrow ? 8 : 10);
  const binW = maxW + (narrow ? 12 : 18);
  const postX = narrow ? w - 18 : beltR + 0.28 * pitch + binW + 10;
  const binL = postX - (narrow ? 8 : 10) - binW;
  const floor = narrow ? beltY + belt + 40 : h - 18;
  const wide = w >= 1100;
  return {
    w,
    h,
    narrow,
    pitch,
    slots: [0.6, 1.6, 2.6].map((s) => s * pitch),
    R,
    maxW,
    hb,
    slabW: maxW + (narrow ? 12 : 20),
    crownTop,
    crownH,
    cylH,
    platen,
    stroke: 1.5,
    beltY,
    belt,
    beltR,
    tankY: beltY + belt + (narrow ? 4 : 6),
    tank: narrow ? 16 : 24,
    ramRest: beltY - 2 * R - gap,
    hopY: beltY - 2 * R - (narrow ? 12 : 16),
    hoodBottom: beltY - (narrow ? 52 : 84),
    hoodH: narrow ? 18 : 28,
    floor,
    bin,
    binGap: 4,
    binW,
    binL,
    postX,
    inset: narrow ? 6 : 9,
    platform: narrow ? h - 30 : h - 40,
    wheel: narrow ? 6 : 8,
    labelX: narrow ? Math.max(16, binL - 250) : postX + 22,
    panelX: narrow ? 16 : postX + 22,
    panelY: narrow ? floor + 30 : 36,
    lift: narrow ? 16 : 40,
    type: {
      value: narrow ? 10 : 13,
      label: narrow ? 10 : wide ? 12 : 11,
      caption: narrow ? 13 : 15,
      counter: narrow ? 48 : wide ? 84 : 72,
      unit: narrow ? 16 : 24,
      row: narrow ? 13 : 16,
    },
  };
}

function rectPoint(s: number, hw: number, hh: number): [number, number] {
  if (s < hh) return [hw, s];
  if (s < hh + 2 * hw) return [hw - (s - hh), hh];
  if (s < 3 * hh + 2 * hw) return [-hw, hh - (s - hh - 2 * hw)];
  if (s < 3 * hh + 4 * hw) return [-hw + (s - 3 * hh - 2 * hw), -hh];
  return [hw, -hh + (s - 3 * hh - 4 * hw)];
}

function shape(R: number, bw: number, hb: number, k: number, seed: number) {
  const hw = bw / 2;
  const hh = hb / 2;
  if (k >= 1) return rect(-hw, -hb, bw, hb);
  const perimeter = 4 * hw + 4 * hh;
  let d = "";
  for (let i = 0; i < POINTS; i++) {
    const u = i / POINTS;
    const th = u * Math.PI * 2;
    const calm = 1 - 0.9 * Math.max(0, Math.sin(th)) ** 3;
    const lump = 0.09 * Math.sin(3 * th + seed) + 0.05 * Math.sin(5 * th + seed * 2.3);
    const r = R * (1 + lump * calm);
    const bx = Math.cos(th) * r;
    const by = Math.min(0, Math.sin(th) * r - R * 0.92);
    const [rx, ry] = rectPoint(u * perimeter, hw, hh);
    d += `${i ? "L" : "M"}${f1(lerp(bx, rx, k))} ${f1(lerp(by, ry - hh, k))}`;
  }
  return `${d}Z`;
}

function makeItem(parent: Element) {
  const g = node(parent, "g");
  const body = node(g, "path", { class: "qc-piece" });
  const value = node(g, "text", { class: "qc-value", "text-anchor": "middle" });
  return { g, body, value };
}

type Item = ReturnType<typeof makeItem>;

function makeRow(parent: Element) {
  const tray = node(parent, "path", { class: "qc-tray" });
  const slab = node(parent, "rect", { class: "qc-cool" });
  const label = node(parent, "text", { class: "qc-label", "dominant-baseline": "central" });
  const value = node(label, "tspan", { class: "qc-label-value" });
  const name = node(label, "tspan");
  const used = node(label, "tspan", { class: "qc-label-used" });
  return { tray, slab, label, value, name, used };
}

export function mountConveyor(figure: HTMLElement) {
  const svg = figure.querySelector("svg");
  if (!svg) return;
  const parts: Part[] = JSON.parse(figure.dataset.parts ?? "[]");
  const copy: Copy = JSON.parse(figure.dataset.copy ?? "{}");
  const maxTokens = Math.max(...parts.map((p) => p.tokens));
  const count = parts.length;
  const landAt = (i: number) => i + 3 + LAND;
  const BEGIN = 0.2;
  const END = landAt(count - 1) + 0.5;

  const scene = node(svg, "g");
  const machine = { class: "qc-machine" };
  const legs = node(scene, "path", machine);
  const tankWater = node(scene, "path", { class: "qc-tank-water" });
  const tankSurface = node(scene, "path", { class: "qc-water" });
  const tank = node(scene, "path", { class: "qc-machine qc-open" });
  const bed = node(scene, "path", machine);
  const columns = node(scene, "path", machine);
  const beltBody = node(scene, "rect", machine);
  const tread = node(scene, "line", { class: "qc-tread" });
  const roller = node(scene, "circle", { class: "qc-machine" });
  const axle = node(scene, "path", { class: "qc-line" });

  const cart = node(scene, "g");
  const post = node(cart, "path", machine);
  const platform = node(cart, "path", machine);
  const wheels = [0, 1].map(() => node(cart, "circle", machine));
  const hubs = [0, 1].map(() => node(cart, "circle", { class: "qc-hub" }));
  const rows = parts.map(() => makeRow(cart));

  const panel = node(scene, "g");
  const caption = node(panel, "text", { class: "qc-caption" });
  caption.textContent = copy.caption;
  const counter = node(panel, "text", { class: "qc-counter" });
  const counterValue = node(counter, "tspan");
  const counterUnit = node(counter, "tspan", { class: "qc-unit" });
  counterUnit.textContent = copy.unit;
  const panelRows = copy.rows.map(() => node(panel, "text", { class: "qc-row" }));
  panelRows.forEach((r, i) => (r.textContent = copy.rows[i]));

  const itemLayer = node(scene, "g");
  const items = [0, 1, 2, 3].map(() => makeItem(itemLayer));

  const hopper = node(scene, "path", machine);
  const water = node(scene, "path", { class: "qc-water qc-spray" });
  const wisps = Array.from({ length: WISPS }, () => node(scene, "path", { class: "qc-steam" }));
  const hood = node(scene, "path", machine);
  const nozzles = node(scene, "path", machine);
  const crown = node(scene, "path", machine);
  const rod = node(scene, "path", machine);
  const platen = node(scene, "path", machine);

  let geo = geometry(1200, 420);

  const barWidth = (tokens: number) => Math.max(geo.narrow ? 4 : 6, (geo.maxW * tokens) / maxTokens);
  const present = (n: number) => n >= 0 && n < count;
  const radius = (i: number) => geo.R * (0.5 + 0.5 * Math.sqrt(parts[i].tokens / maxTokens));
  const binBottom = (i: number) => geo.platform - i * (geo.bin + geo.binGap);
  const slabX = (bw: number) => geo.binL + geo.inset + bw / 2;
  const endX = () => geo.beltR - geo.belt / 2;

  const ramFace = (f: number, active: boolean) => {
    const contact = geo.beltY - geo.hb;
    if (!active || f < 0.48 || f >= 0.84) return geo.ramRest;
    if (f < 0.54) return geo.ramRest - (geo.narrow ? 6 : 10) * outCubic(span(f, 0.48, 0.54));
    if (f < 0.6) return lerp(geo.ramRest - (geo.narrow ? 6 : 10), contact, inCubic(span(f, 0.54, 0.6)));
    if (f < 0.7) {
      const tau = (f - 0.6) * CYCLE;
      return contact - 2 * Math.exp(-tau * 20) * Math.abs(Math.sin(tau * 40));
    }
    return lerp(contact, geo.ramRest, inOut(span(f, 0.7, 0.84)));
  };

  function drawItem(it: Item, n: number, age: number, f: number, moving: boolean, e: number) {
    const hidden = !present(n) || (age === 0 && f < 0.24) || (age === 3 && f >= LAND);
    show(it.g, !hidden);
    if (hidden) return;

    const R = radius(n);
    const bw = barWidth(parts[n].tokens);
    const { hb, beltY, slots } = geo;
    const at = (pos: number) => (pos < 2 ? lerp(slots[Math.floor(pos)], slots[Math.ceil(pos)], pos % 1) : lerp(slots[2], endX(), pos - 2));
    let x = at(moving ? age - 1 + e : Math.min(age, 3));
    let y = beltY;
    let sx = 1;
    let sy = 1;
    let rot = 0;
    let k = age >= 2 ? 1 : 0;
    let fill = "";
    let raw = age < 2;
    let valueAlpha = 0;

    if (age === 0) {
      if (f < 0.36) y = lerp(geo.hopY - 30, geo.hopY - 6, outCubic(span(f, 0.24, 0.34)));
      else if (f < 0.46) {
        y = lerp(geo.hopY - 6, beltY, span(f, 0.36, 0.46) ** 2);
        sx = 0.94;
        sy = 1.06;
      } else {
        const s = settle((f - 0.46) * CYCLE, 7, 22);
        sx = 1 + 0.12 * s;
        sy = 1 - 0.16 * s;
      }
    }

    if (age === 1 && !moving) {
      const face = ramFace(f, true);
      k = f >= 0.6 ? 1 : span(face, beltY - 1.92 * R, beltY - hb);
      if (f >= 0.6) {
        raw = false;
        fill = mix(0);
      }
      valueAlpha = span(f, 0.8, 0.88);
    }

    if (age === 2) {
      fill = mix(moving ? 0 : span(f, 0.72, 0.86));
      valueAlpha = moving ? 1 - span(e, 0, 0.6) : 0;
    }

    if (age === 3) {
      fill = mix(1);
      if (!moving) {
        const q = span(f, MOVE, LAND);
        const x1 = slabX(bw);
        const y1 = binBottom(n) - 3;
        const peak = Math.min(beltY, y1) - geo.lift;
        x = lerp(endX(), x1, inOut(q));
        y = (1 - q) ** 2 * beltY + 2 * (1 - q) * q * (2 * peak - (beltY + y1) / 2) + q * q * y1;
        rot = 6 * Math.sin(Math.PI * q);
      }
    }

    set(it.g, { transform: `translate(${f1(x)} ${f1(y)}) rotate(${f1(rot)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})` });
    it.body.setAttribute("d", shape(R, bw, hb, k, n * 1.9));
    it.body.classList.toggle("qc-raw", raw);
    it.body.style.fill = raw ? "" : fill;

    show(it.value, valueAlpha > 0);
    if (valueAlpha > 0) {
      it.value.textContent = kilo(parts[n].tokens);
      set(it.value, { y: -hb - (geo.narrow ? 7 : 10), "font-size": geo.type.value, opacity: valueAlpha.toFixed(3) });
    }
  }

  function drawPress(f: number, active: boolean) {
    const { slots, slabW, beltY, belt, crownTop, crownH, cylH, floor, narrow, stroke } = geo;
    const x = slots[1];
    const face = ramFace(f, active);
    const col = narrow ? 7 : 10;
    const gw = slabW / 2 + (narrow ? 4 : 6);
    const reach = gw + col + (narrow ? 4 : 6);
    const foot = narrow ? 5 : 8;
    set(crown, {
      d: rect(x - reach, crownTop, 2 * reach, crownH) + rect(x - (narrow ? 13 : 20), crownTop + crownH, narrow ? 26 : 40, cylH),
    });
    set(columns, {
      d:
        rect(x - gw - col, crownTop + crownH, col, floor - crownTop - crownH) +
        rect(x + gw, crownTop + crownH, col, floor - crownTop - crownH) +
        rect(x - gw - col - foot, floor - 4, col + 2 * foot, 4) +
        rect(x + gw - foot, floor - 4, col + 2 * foot, 4),
    });
    const rodW = narrow ? 8 : 12;
    const rodTop = crownTop + crownH + cylH;
    set(rod, { d: rect(x - rodW / 2, rodTop - stroke, rodW, face - geo.platen - rodTop + stroke) });
    set(platen, { d: rect(x - slabW / 2, face - geo.platen, slabW, geo.platen) });
    const bedH = narrow ? 8 : 12;
    set(bed, { d: rect(x - gw, beltY + belt + 2, 2 * gw, bedH) });
  }

  function drawQuench(f: number, active: boolean, bw: number) {
    const { slots, beltY, hb, pitch, narrow, tankY, tank: tankH, hoodBottom, hoodH, maxW } = geo;
    const x = slots[2];
    const top = beltY - hb;
    const half = maxW / 2 + (narrow ? 8 : 12);
    const neck = narrow ? 8 : 12;
    const pipe = narrow ? 4 : 6;
    const barH = narrow ? 4 : 6;
    set(hood, {
      d:
        rect(x - pipe, -2, 2 * pipe, hoodBottom - hoodH + 2) +
        `M${f1(x - neck)} ${f1(hoodBottom - hoodH)}H${f1(x + neck)}L${f1(x + half)} ${f1(hoodBottom)}H${f1(x - half)}Z`,
    });
    const spread = half - (narrow ? 8 : 12);
    const xs = Array.from({ length: NOZZLES }, (_, i) => x + lerp(-spread, spread, i / (NOZZLES - 1)));
    const nz = narrow ? 3 : 5;
    const barY = hoodBottom;
    set(nozzles, {
      d:
        rect(x - half + 4, barY, 2 * half - 8, barH) +
        xs.map((nx) => `M${f1(nx - nz)} ${f1(barY + barH)}h${2 * nz}l${-nz} ${nz}Z`).join(""),
    });
    const spout = barY + barH + nz;

    const pour = active ? span(f, 0.66, 0.72) * (1 - span(f, 0.8, 0.86)) : 0;
    show(water, pour > 0);
    if (pour > 0) {
      const floorAt = (nx: number) => (Math.abs(nx - x) <= bw / 2 ? top : beltY);
      const d = xs
        .map((nx) => {
          const end = floorAt(nx);
          const head = lerp(spout, end, span(f, 0.66, 0.72));
          const tail = lerp(spout, end, span(f, 0.8, 0.86));
          return `M${f1(nx)} ${f1(tail)}V${f1(head)}`;
        })
        .join("");
      set(water, { d, "stroke-dashoffset": f1(-f * CYCLE * 120) });
    }

    wisps.forEach((wisp, j) => {
      const q = active ? span(f, 0.72 + j * 0.03, 0.99) : 0;
      show(wisp, q > 0 && q < 1);
      if (q <= 0 || q >= 1) return;
      const rise = (narrow ? 44 : 80) * (0.8 + 0.2 * j);
      const x0 = x + (j - 1) * Math.max(bw * 0.32, narrow ? 8 : 14);
      const head = rise * outCubic(q);
      const tail = rise * inCubic(q);
      const amp = narrow ? 3 : 5;
      let d = "";
      for (let s = 0; s <= 10; s++) {
        const h = lerp(tail, head, s / 10);
        d += `${s ? "L" : "M"}${f1(x0 + amp * Math.sin(h / (narrow ? 9 : 14) + j * 2))} ${f1(top - 4 - h)}`;
      }
      set(wisp, { d, opacity: (1 - q).toFixed(3) });
    });

    const tw = pitch * 0.32;
    set(tank, { d: `M${f1(x - tw)} ${f1(tankY)}V${f1(tankY + tankH)}H${f1(x + tw)}V${f1(tankY)}` });
    const ripple = active ? span(f, 0.7, 0.74) * (1 - span(f, 0.8, 1)) : 0;
    const level = tankY + tankH * 0.4;
    let surface = "";
    for (let i = 0; i <= 16; i++) {
      const xx = x - tw + 2 + ((2 * tw - 4) * i) / 16;
      surface += `${i ? "L" : "M"}${f1(xx)} ${f1(level + (narrow ? 1.5 : 2.5) * ripple * Math.sin(i * 1.4 - f * 40))}`;
    }
    set(tankSurface, { d: surface });
    set(tankWater, { d: `${surface}V${f1(tankY + tankH - 1)}H${f1(x - tw + 2)}Z` });
  }

  function drawHopper() {
    const { slots, pitch, R, hopY, narrow } = geo;
    const x = slots[0];
    const mouth = R * 1.04 + 2;
    const lip = Math.min(pitch * 0.44, mouth * 1.45);
    const shoulder = hopY * 0.38;
    const neck = hopY - (narrow ? 8 : 12);
    set(hopper, {
      d: `M${f1(x - lip)} -2V${f1(shoulder)}L${f1(x - mouth)} ${f1(neck)}V${f1(hopY)}H${f1(x + mouth)}V${f1(neck)}L${f1(x + lip)} ${f1(shoulder)}V-2Z`,
    });
  }

  function drawBelt(travel: number) {
    const { beltY, belt, beltR, slots, pitch, floor, narrow } = geo;
    set(beltBody, { x: -20, y: f1(beltY), width: f1(beltR + 20), height: belt, rx: belt / 2 });
    set(tread, {
      x1: -20,
      x2: f1(beltR - belt),
      y1: f1(beltY + belt / 2),
      y2: f1(beltY + belt / 2),
      "stroke-dashoffset": f1(-travel),
    });
    const cx = beltR - belt / 2;
    const cy = beltY + belt / 2;
    const r = belt / 2 - 3;
    set(roller, { cx: f1(cx), cy: f1(cy), r: f1(r) });
    const a = travel / r;
    set(axle, { d: `M${f1(cx - Math.cos(a) * r)} ${f1(cy - Math.sin(a) * r)}L${f1(cx + Math.cos(a) * r)} ${f1(cy + Math.sin(a) * r)}` });
    const legW = narrow ? 5 : 8;
    const foot = narrow ? 5 : 8;
    set(legs, {
      d: [slots[0] - pitch * 0.4, (slots[2] + pitch * 0.32 + beltR) / 2]
        .map((x) => rect(x - legW / 2, beltY + belt, legW, floor - beltY - belt) + rect(x - legW / 2 - foot, floor - 4, legW + 2 * foot, 4))
        .join(""),
    });
  }

  function drawCart(u: number) {
    const { platform: py, bin, binL, binW, postX, narrow, type, inset, wheel, hb } = geo;
    let sum = 0;
    rows.forEach((row, i) => {
      const at = landAt(i);
      const filled = u >= at;
      const waiting = !filled && (i === 0 || u >= landAt(i - 1) + 0.1);
      show(row.tray, filled || waiting);
      show(row.slab, filled);
      show(row.label, filled);
      if (!filled && !waiting) return;
      const bottom = binBottom(i);
      const flare = narrow ? 3 : 4;
      set(row.tray, {
        d: `M${f1(binL - flare)} ${f1(bottom - bin)}L${f1(binL)} ${f1(bottom)}H${f1(binL + binW)}L${f1(binL + binW + flare)} ${f1(bottom - bin)}`,
        opacity: filled ? 1 : span(u, landAt(i - 1) + 0.1, landAt(i - 1) + 0.22).toFixed(3),
      });
      if (!filled) return;
      const tau = (u - at) * CYCLE;
      sum += parts[i].tokens * outCubic(clamp(tau / 0.3));
      const bw = barWidth(parts[i].tokens);
      const x = binL + inset;
      const base = bottom - 3;
      const s = 0.3 * settle(tau, 12, 30);
      set(row.slab, {
        x: f1(x),
        y: f1(base - hb),
        width: f1(bw),
        height: hb,
        transform: `translate(${f1(x + bw / 2)} ${f1(base)}) scale(${(1 + 0.3 * s).toFixed(3)} ${(1 - s).toFixed(3)}) translate(${f1(-x - bw / 2)} ${f1(-base)})`,
      });
      const p = parts[i];
      row.value.textContent = kilo(p.tokens).padStart(5, " ");
      row.name.textContent = p.name;
      row.used.textContent = p.used;
      set(row.name, { dx: type.label * 1.2 });
      set(row.used, { dx: p.used ? type.label * 1.2 : 0 });
      set(row.label, {
        x: f1(geo.labelX),
        y: f1(bottom - bin / 2 + 1),
        "font-size": type.label,
        opacity: span(tau, 0.1, 0.4).toFixed(3),
      });
    });

    const top = binBottom(count) - (narrow ? 2 : 4);
    const postW = narrow ? 5 : 7;
    const grip = narrow ? 8 : 12;
    set(post, { d: rect(postX - postW / 2, top, postW, py - top) + rect(postX - postW / 2, top, grip + postW / 2, postW) });
    const plateH = narrow ? 4 : 5;
    set(platform, { d: rect(binL - 8, py, postX - binL + 8 + postW / 2 + 2, plateH) });
    [binL + wheel + 2, postX - wheel - 2].forEach((cx, j) => {
      const cy = py + plateH + wheel + 1;
      set(wheels[j], { cx: f1(cx), cy: f1(cy), r: f1(wheel) });
      set(hubs[j], { cx: f1(cx), cy: f1(cy), r: narrow ? 1.5 : 2 });
    });

    const x = geo.panelX;
    const capY = geo.panelY;
    const numY = capY + (narrow ? 10 : 16) + type.counter * 0.72;
    set(caption, { x: f1(x), y: f1(capY), "font-size": type.caption });
    set(counter, { x: f1(x), y: f1(numY), "font-size": type.counter });
    counterValue.textContent = u >= END - 0.15 ? copy.total : kilo(sum);
    set(counterUnit, { dx: type.unit * 0.35, "font-size": type.unit });
    const rowsIn = span(u, landAt(count - 1) + 0.15, landAt(count - 1) + 0.4);
    panelRows.forEach((r, i) => {
      show(r, rowsIn > 0);
      set(r, {
        x: f1(x),
        y: f1(numY + (narrow ? 22 : 30) + i * (type.row * 1.35)),
        "font-size": type.row,
        opacity: rowsIn.toFixed(3),
      });
    });
  }

  function frame(u: number) {
    const c = Math.floor(u);
    const f = u - c;
    const loaded = [1, 2, 3].some((a) => present(c - a));
    const moving = loaded && f < MOVE;
    const e = moving ? inOut(f / MOVE) : 1;
    svg!.setAttribute("viewBox", `0 0 ${f1(geo.w)} ${f1(geo.h)}`);

    for (let age = 0; age < 4; age++) drawItem(items[age], c - age, age, f, moving, e);

    drawHopper();
    drawPress(f, present(c - 1) && !moving);
    const q = c - 2;
    drawQuench(f, present(q) && !moving, present(q) ? barWidth(parts[q].tokens) : 0);
    drawBelt((Math.min(c, landAt(count - 1)) + e) * geo.pitch);
    drawCart(u);
  }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let u = BEGIN;
  let last = 0;
  let raf = 0;
  let visible = true;

  const tick = (now: number) => {
    u = Math.min(END, u + (last ? Math.min(0.05, (now - last) / 1000) : 0) / CYCLE);
    last = now;
    frame(u);
    if (u < END) raf = requestAnimationFrame(tick);
  };

  const sync = () => {
    cancelAnimationFrame(raf);
    last = 0;
    if (reduce.matches) u = END;
    frame(u);
    if (visible && u < END) raf = requestAnimationFrame(tick);
  };

  const resize = () => {
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return;
    geo = geometry(box.width, box.height);
    frame(u);
  };

  new ResizeObserver(resize).observe(svg);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(figure);
  reduce.addEventListener("change", sync);
  document.fonts?.ready.then(() => frame(u));
  resize();
  sync();
}
