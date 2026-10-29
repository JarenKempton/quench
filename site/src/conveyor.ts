export interface Part {
  short: string;
  detail: string;
  label: string;
  tokens: number;
  used: string;
  idle: boolean;
  color: string;
}

export interface Copy {
  resent: string;
  decide: string;
  command: string;
}

const NS = "http://www.w3.org/2000/svg";
const CYCLE = 2.2;
const SEQ = 8;
const MOVE = 0.3;
const LAND = 3.78;
const START = 18.9;
const POSTER = { u: 21, phases: [0.95, 0.75, 0.34, 0.49], stack: 25.8 };
const POINTS = 72;
const SPARKS = 14;
const STEAM = 24;
const DROPS = 3;
const NOZZLES = 5;
const VERBS = ["Bloat", "Forge", "Quench", "Deliver"];
const NOTES = ["read from history", "sized in tokens", "steam locks it in", "tagged: used vs loaded"];

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
  const narrow = w < 900;
  const pitch = narrow ? (w - 12) / 4 : (w * (w < 1200 ? 0.55 : 0.6)) / 4;
  const slots = [0, 1, 2, 3].map((i) => (narrow ? 6 : 0) + pitch * (i + 0.5));
  const R = narrow ? Math.min(42, pitch * 0.4) : Math.min(70, pitch * 0.37);
  const hb = narrow ? 13 : 20;
  const head = narrow ? 18 : 26;
  const slab = narrow ? 16 : 26;
  const beltY = head + slab + 2.2 * R + (narrow ? 26 : 34);
  const belt = narrow ? 9 : 14;
  const tankY = beltY + belt + (narrow ? 4 : 6);
  const tank = narrow ? 14 : 22;
  const numY = tankY + tank + (narrow ? 16 : 22);
  const verb = Math.min(34, pitch * 0.19);
  const notes = pitch >= 120;
  const verbY = numY + verb + 2;
  const beltR = narrow ? slots[3] + pitch * 0.42 : 4 * pitch + 6;
  const maxW = pitch * (narrow ? 0.8 : 0.76);
  const binW = maxW + (narrow ? 12 : 18);
  const binL = narrow ? w - 30 - binW : beltR + 40;
  const postX = binL + binW + (narrow ? 6 : 8);
  return {
    w,
    h,
    narrow,
    pitch,
    slots,
    R,
    hb,
    head,
    slab,
    slabW: maxW + (narrow ? 10 : 22),
    hazard: narrow ? 4 : 6,
    beltY,
    beltL: -20,
    beltR,
    belt,
    tankY,
    tank,
    ramRest: beltY - 2.2 * R - 10,
    hopY: beltY - 2.2 * R - 16,
    hoodBottom: beltY - hb - (narrow ? 40 : 64),
    hoodH: narrow ? 18 : 30,
    stampRest: beltY - hb - (narrow ? 72 : 104),
    tagDy: narrow ? 22 : 34,
    maxW,
    binW,
    binL,
    postX,
    bin: hb + (narrow ? 6 : 8),
    binGap: narrow ? 4 : 5,
    inset: narrow ? 6 : 9,
    wheel: narrow ? 5 : 8,
    floor: h - (narrow ? 22 : 28),
    labelX: narrow ? binL - 10 : postX + 16,
    align: narrow ? -1 : 1,
    panelX: narrow ? 14 : binL,
    panelY: narrow ? verbY + (notes ? 54 : 34) : 30,
    numY,
    verbY,
    noteY: verbY + 20,
    type: {
      name: Math.min(13, R * 0.24),
      detail: pitch >= 130 ? Math.min(11, R * 0.17) : 0,
      note: narrow ? 10 : 12,
      stamp: narrow ? 8.5 : 10.5,
      verb,
      num: narrow ? 9 : 11,
      station: notes ? Math.min(11, pitch / 14) : 0,
      label: narrow ? 10 : 12,
      counter: narrow ? 46 : 92,
      caption: narrow ? 9 : 11,
      line: narrow ? 10 : 12,
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
  const hot = node(g, "path", { class: "qc-hot", filter: "url(#qc-glow)" });
  const words = node(g, "g", { class: "qc-words" });
  const name = node(words, "text", { class: "qc-name", "text-anchor": "middle", "dominant-baseline": "central" });
  const detail = node(words, "text", { class: "qc-detail", "text-anchor": "middle", "dominant-baseline": "central" });
  const note = node(g, "g", { class: "qc-note" });
  const dim = node(note, "path", { class: "qc-dim" });
  const value = node(note, "text", { class: "qc-value", "text-anchor": "middle" });
  const stamp = node(note, "g", { class: "qc-stamp" });
  const stampBox = node(stamp, "rect");
  const stampText = node(stamp, "text", { "text-anchor": "middle", "dominant-baseline": "central" });
  return { g, shadow, body, hot, words, name, detail, note, dim, value, stamp, stampBox, stampText };
}

type Item = ReturnType<typeof makeItem>;

function makeStation(parent: Element, i: number) {
  const g = node(parent, "g", { class: "qc-station" });
  const num = node(g, "text", { class: "qc-num", "text-anchor": "middle" });
  num.textContent = `0${i + 1}`;
  const word = node(g, "g");
  const outline = node(word, "text", { class: "qc-verb qc-verb-line", "text-anchor": "middle" });
  const solid = node(word, "text", { class: "qc-verb", "text-anchor": "middle" });
  outline.textContent = solid.textContent = VERBS[i].toUpperCase();
  const note = node(g, "text", { class: "qc-station-note", "text-anchor": "middle" });
  note.textContent = NOTES[i];
  return { g, num, word, outline, solid, note };
}

function makeRow(parent: Element) {
  const tray = node(parent, "path", { class: "qc-tray" });
  const bar = node(parent, "rect", { class: "qc-bar" });
  const label = node(parent, "text", { class: "qc-label", "dominant-baseline": "central" });
  const value = node(label, "tspan", { class: "qc-label-value" });
  const name = node(label, "tspan", { class: "qc-label-name" });
  const usage = node(label, "tspan", { class: "qc-label-usage" });
  return { tray, bar, label, value, name, usage };
}

export function mountConveyor(figure: HTMLElement) {
  const svg = figure.querySelector("svg");
  if (!svg) return;
  const parts: Part[] = JSON.parse(figure.dataset.parts ?? "[]");
  const copy: Copy = JSON.parse(figure.dataset.copy ?? "{}");
  const maxTokens = Math.max(...parts.map((p) => p.tokens));

  const defs = node(svg, "defs");
  const hazard = node(defs, "pattern", {
    id: "qc-hazard",
    width: 12,
    height: 12,
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  });
  node(hazard, "rect", { width: 12, height: 12, class: "qc-hazard-a" });
  node(hazard, "rect", { width: 6, height: 12, class: "qc-hazard-b" });
  const glow = node(defs, "filter", { id: "qc-glow", x: "-60%", y: "-200%", width: "220%", height: "500%" });
  node(glow, "feGaussianBlur", { in: "SourceGraphic", stdDeviation: 5, result: "blur" });
  const merge = node(glow, "feMerge");
  node(merge, "feMergeNode", { in: "blur" });
  node(merge, "feMergeNode", { in: "SourceGraphic" });

  const scene = node(svg, "g");
  const stations = [0, 1, 2, 3].map((i) => makeStation(scene, i));
  const legs = node(scene, "path", { class: "qc-leg" });
  const tankWater = node(scene, "path", { class: "qc-tank-water" });
  const tankBody = node(scene, "path", { class: "qc-tank" });
  const drops = Array.from({ length: DROPS }, () => node(scene, "circle", { class: "qc-drop" }));
  const rails = node(scene, "path", { class: "qc-rail" });
  const hopper = node(scene, "path", { class: "qc-hopper" });
  const beltBody = node(scene, "rect", { class: "qc-belt" });
  const treadTop = node(scene, "line", { class: "qc-tread" });
  const treadReturn = node(scene, "line", { class: "qc-tread qc-tread-return" });
  const roller = node(scene, "circle", { class: "qc-roller" });
  const spoke = node(scene, "path", { class: "qc-spoke" });

  const cart = node(scene, "g", { class: "qc-cart" });
  const post = node(cart, "path", { class: "qc-post" });
  const platform = node(cart, "rect", { class: "qc-platform" });
  const wheels = [0, 1].map(() => ({
    rim: node(cart, "circle", { class: "qc-wheel" }),
    spoke: node(cart, "path", { class: "qc-spoke" }),
  }));
  const rows = parts.map(() => makeRow(cart));

  const panel = node(scene, "g", { class: "qc-panel" });
  const caption = node(panel, "text", { class: "qc-caption" });
  caption.textContent = "TOKENS BEFORE YOU TYPE";
  const counterBlock = node(panel, "rect", { class: "qc-counter-block" });
  const counter = node(panel, "text", { class: "qc-counter" });
  const resent = node(panel, "text", { class: "qc-line" });
  resent.textContent = copy.resent;
  const decide = node(panel, "text", { class: "qc-line qc-decide" });
  const decideWords = node(decide, "tspan");
  const decideCommand = node(decide, "tspan", { class: "qc-command" });

  const itemLayer = node(scene, "g");
  const items = [0, 1, 2, 3].map(() => makeItem(itemLayer));

  const water = node(scene, "path", { class: "qc-water" });
  const fx = node(scene, "g");
  const sparks = Array.from({ length: SPARKS }, () => node(fx, "circle", { class: "qc-spark" }));
  const streaks = node(fx, "path", { class: "qc-streak" });

  const ram = node(scene, "g", { class: "qc-ram" });
  const rod = node(ram, "rect", { class: "qc-rod" });
  const slab = node(ram, "rect", { class: "qc-slab" });
  const slabStripe = node(ram, "rect", { fill: "url(#qc-hazard)" });
  const headBlock = node(ram, "rect", { class: "qc-head" });

  const hood = node(scene, "g", { class: "qc-hood" });
  const hoodPipe = node(hood, "rect", { class: "qc-rod" });
  const hoodBody = node(hood, "path", { class: "qc-hood-body" });
  const nozzles = node(hood, "path", { class: "qc-nozzle" });

  const steam = Array.from({ length: STEAM }, () => node(scene, "circle", { class: "qc-steam" }));

  const stamper = node(scene, "g", { class: "qc-stamper" });
  const stamperRod = node(stamper, "rect", { class: "qc-rod" });
  const stamperHead = node(stamper, "rect", { class: "qc-head" });
  const stamperPad = node(stamper, "rect", { class: "qc-pad" });

  let geo = geometry(1200, 400);

  const barWidth = (tokens: number) => Math.max(geo.narrow ? 5 : 8, (geo.maxW * tokens) / maxTokens);
  const slotX = (pos: number) => geo.slots[0] + pos * geo.pitch;
  const present = (n: number) => n >= 0 && n % SEQ < parts.length;
  const partAt = (n: number) => (present(n) ? parts[n % SEQ] : undefined);
  const radius = (i: number) => geo.R * (0.6 + 0.4 * Math.sqrt(parts[i].tokens / maxTokens));
  const binBottom = (i: number) => geo.floor - i * (geo.bin + geo.binGap);
  const binBarX = (bw: number) => geo.binL + geo.inset + bw / 2;
  const noteDy = () => -geo.hb - (geo.narrow ? 8 : 12);
  const tagSize = () => {
    const size = geo.type.stamp;
    return { size, h: size * 2, y: noteDy() - geo.tagDy };
  };

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

  const strike = (fs: number) => {
    if (fs < 0.3) return 0;
    if (fs < 0.36) return inCubic(span(fs, 0.3, 0.36));
    if (fs < 0.4) return 1;
    return 1 - inOut(span(fs, 0.4, 0.5));
  };

  function drawItem(it: Item, n: number, age: number, fs: number, moving: boolean, e: number, T: number) {
    const idx = n % SEQ;
    const pos = moving ? age - 1 + e : age;
    const hidden = !present(n) || pos < 0 || (age === 0 && fs < 0.3) || (age === 3 && !moving && fs >= LAND - 3);
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

    const heat = age === 1 ? (!moving && fs >= 0.5 ? 1 : 0) : age === 2 ? (moving ? 1 : 1 - span(fs, 0.2, 0.55)) : 0;
    const measured = (age === 1 && !moving && fs >= 0.66) || age >= 2;
    let noteAlpha = measured ? 1 : 0;

    if (age === 3 && !moving && fs >= 0.5) {
      const q = inOut(span(fs, 0.5, LAND - 3));
      x = lerp(x, binBarX(bw), q);
      y = lerp(beltY, binBottom(idx) - 3, q) - (geo.narrow ? 30 : 56) * Math.sin(Math.PI * q);
      rot = 10 * Math.sin(Math.PI * q);
      noteAlpha = 1 - span(q, 0, 0.3);
    }

    set(it.g, {
      transform: `translate(${f1(x)} ${f1(y)}) rotate(${f1(rot)}) skewX(${f1(skew)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`,
    });
    const d = shape(R, bw, hb, k, T, idx * 1.7);
    it.body.setAttribute("d", d);
    it.shadow.setAttribute("d", d);
    it.body.style.fill = p.color;

    show(it.hot, heat > 0);
    if (heat > 0) {
      it.hot.setAttribute("d", d);
      const flash = age === 1 && fs < 0.54;
      it.hot.classList.toggle("qc-flash", flash);
      it.hot.style.opacity = heat.toFixed(3);
    }

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
    if (noteAlpha <= 0) return;
    const fresh = age === 1;
    const draw = fresh ? outCubic(span(fs, 0.66, 0.76)) : 1;
    const count = fresh ? outCubic(span(fs, 0.66, 0.86)) : 1;
    const dy = noteDy();
    const a = (bw / 2) * draw;
    const tick = geo.narrow ? 3 : 4;
    set(it.note, { opacity: noteAlpha.toFixed(3) });
    set(it.dim, { d: `M${f1(-a)} ${dy - tick}V${dy + tick}M${f1(-a)} ${dy}H${f1(a)}M${f1(a)} ${dy - tick}V${dy + tick}` });
    it.value.textContent = kilo(p.tokens * count);
    it.value.classList.toggle("qc-value-hot", heat > 0.4);
    set(it.value, { y: dy - (geo.narrow ? 6 : 9), "font-size": geo.type.note });

    const stampQ = age === 3 && !moving ? span(fs, 0.36, 0.44) : 0;
    show(it.stamp, !!p.used && stampQ > 0);
    if (!p.used || stampQ <= 0) return;
    const tag = tagSize();
    const text = p.used.toUpperCase();
    const sw = text.length * tag.size * 0.6 + tag.size * 1.4;
    const s = lerp(1.6, 1, outBack(stampQ));
    set(it.stamp, {
      transform: `translate(0 ${f1(tag.y)}) rotate(-5) scale(${s.toFixed(3)})`,
      opacity: stampQ.toFixed(3),
      class: p.idle ? "qc-stamp qc-idle" : "qc-stamp",
    });
    set(it.stampBox, { x: f1(-sw / 2), y: f1(-tag.h / 2), width: f1(sw), height: f1(tag.h) });
    set(it.stampText, { "font-size": tag.size });
    it.stampText.textContent = text;
  }

  function drawPress(pressN: number, fs1: number, pressing: boolean, still: boolean) {
    const { beltY, hb, pitch, narrow } = geo;
    const face = pressing ? ramFace(fs1) : geo.ramRest;
    const x1 = geo.slots[1];
    const impact = pressing && fs1 >= 0.5 ? (fs1 - 0.5) * CYCLE : -1;

    set(headBlock, { x: f1(x1 - pitch * 0.44), y: -1, width: f1(pitch * 0.88), height: geo.head + 1 });
    set(rod, {
      x: f1(x1 - (narrow ? 5 : 8)),
      y: geo.head,
      width: narrow ? 10 : 16,
      height: f1(Math.max(0, face - geo.slab - geo.head)),
    });
    set(slab, { x: f1(x1 - geo.slabW / 2), y: f1(face - geo.slab), width: f1(geo.slabW), height: geo.slab - geo.hazard });
    set(slabStripe, { x: f1(x1 - geo.slabW / 2), y: f1(face - geo.hazard), width: f1(geo.slabW), height: geo.hazard });
    const railX = geo.slabW / 2 + (narrow ? 3 : 6);
    set(rails, { d: `M${f1(x1 - railX)} ${geo.head}V${f1(beltY)}M${f1(x1 + railX)} ${geo.head}V${f1(beltY)}` });

    const p = partAt(pressN);
    const bw = p ? barWidth(p.tokens) : 0;
    const life = 0.6;
    const burst = !still && !!p && impact >= 0 && impact < life;
    sparks.forEach((spark, j) => {
      show(spark, burst);
      if (!burst) return;
      const side = j % 2 ? 1 : -1;
      const speed = narrow ? 0.55 : 1;
      const vx = side * (110 + 280 * noise(pressN, j)) * speed;
      const vy = -(140 + 260 * noise(j, pressN)) * speed;
      const r = (narrow ? 1.5 : 2) + (narrow ? 1.5 : 2.5) * noise(pressN + j, 3);
      set(spark, {
        cx: f1(x1 + side * bw * 0.5 + vx * impact),
        cy: f1(beltY - hb / 2 + vy * impact + 800 * speed * impact * impact),
        r: f1(r * (1 - impact / life) ** 0.5),
      });
    });
    const streak = !still && impact >= 0 && impact < 0.28;
    show(streaks, streak);
    if (streak) {
      const reach = outCubic(impact / 0.28);
      const len = (narrow ? 18 : 34) * (1 - reach);
      let d = "";
      for (const side of [-1, 1]) {
        for (const off of [-1, 0, 1]) {
          const sx0 = x1 + side * (bw / 2 + 8 + reach * (narrow ? 18 : 40));
          const yy = beltY - hb / 2 + off * (narrow ? 5 : 8);
          d += `M${f1(sx0)} ${f1(yy)}h${f1(side * len * (off === 0 ? 1.4 : 1))}`;
        }
      }
      set(streaks, { d });
    }
    return impact;
  }

  function drawQuench(qN: number, fs: number, active: boolean, T: number, still: boolean) {
    const { beltY, hb, pitch, narrow, tankY, tank } = geo;
    const x2 = geo.slots[2];
    const p = partAt(qN);
    const on = active && !!p;
    const bw = p ? barWidth(p.tokens) : 0;
    const top = beltY - hb;

    const hw = pitch * (narrow ? 0.42 : 0.39);
    const y0 = geo.hoodBottom;
    set(hoodPipe, { x: f1(x2 - (narrow ? 4 : 6)), y: -2, width: narrow ? 8 : 12, height: f1(y0 - geo.hoodH + 2) });
    const neck = narrow ? 8 : 14;
    set(hoodBody, {
      d: `M${f1(x2 - neck)} ${f1(y0 - geo.hoodH)}H${f1(x2 + neck)}L${f1(x2 + hw)} ${f1(y0 - 4)}V${f1(y0)}H${f1(x2 - hw)}V${f1(y0 - 4)}Z`,
    });
    const spread = hw * 0.72;
    const nozzleXs = Array.from({ length: NOZZLES }, (_, i) => x2 + lerp(-spread, spread, i / (NOZZLES - 1)));
    const nw = narrow ? 3 : 5;
    const nh = narrow ? 3 : 5;
    set(nozzles, { d: nozzleXs.map((x) => `M${f1(x - nw / 2)} ${f1(y0)}h${nw}v${nh}h${-nw}Z`).join("") });

    const pour = on ? span(fs, 0.1, 0.16) * (1 - span(fs, 0.4, 0.46)) : 0;
    show(water, pour > 0);
    if (pour > 0) {
      const head = lerp(y0 + nh, top, span(fs, 0.1, 0.16));
      const tail = lerp(y0 + nh, top, span(fs, 0.4, 0.46));
      const reach = Math.max(bw / 2 + (narrow ? 4 : 8), narrow ? 12 : 20);
      const d = nozzleXs
        .map((x, i) => {
          const xb = x2 + lerp(-reach, reach, i / (NOZZLES - 1));
          const t0 = (tail - y0) / (top - y0);
          const t1 = (head - y0) / (top - y0);
          return `M${f1(lerp(x, xb, t0))} ${f1(tail)}L${f1(lerp(x, xb, t1))} ${f1(head)}`;
        })
        .join("");
      set(water, { d, "stroke-dashoffset": f1(still ? 0 : -T * 260) });
    }

    const tw = pitch * 0.34;
    set(tankBody, { d: `M${f1(x2 - tw)} ${f1(tankY)}V${f1(tankY + tank)}H${f1(x2 + tw)}V${f1(tankY)}` });
    const ripple = on ? span(fs, 0.14, 0.2) * (1 - span(fs, 0.5, 0.9)) : 0;
    const level = tankY + tank * 0.42;
    let wave = `M${f1(x2 - tw + 1.5)} ${f1(tankY + tank - 1)}`;
    for (let i = 0; i <= 12; i++) {
      const x = x2 - tw + 1.5 + ((2 * tw - 3) * i) / 12;
      const amp = still ? 0 : 0.6 + (narrow ? 1.6 : 2.8) * ripple;
      wave += `L${f1(x)} ${f1(level + amp * Math.sin(i * 1.3 + T * 7))}`;
    }
    set(tankWater, { d: `${wave}L${f1(x2 + tw - 1.5)} ${f1(tankY + tank - 1)}Z` });

    drops.forEach((drop, j) => {
      const q = on ? span(fs, 0.16 + j * 0.09, 0.3 + j * 0.09) : 0;
      show(drop, q > 0 && q < 1);
      if (q <= 0 || q >= 1) return;
      const side = j % 2 ? 1 : -1;
      set(drop, {
        cx: f1(x2 + side * (bw / 2 + (narrow ? 2 : 4)) * (0.6 + 0.3 * j)),
        cy: f1(lerp(beltY, level, q * q)),
        r: narrow ? 1.5 : 2.2,
      });
    });

    steam.forEach((puff, j) => {
      const s = 0.17 + 0.3 * noise(j, 7);
      const life = 0.38 + 0.24 * noise(j, 3);
      const q = on ? (fs - s) / life : -1;
      const alive = q > 0 && q < 1;
      show(puff, alive);
      if (!alive) return;
      const side = noise(j, 11) - 0.5;
      const width = Math.max(bw, narrow ? 24 : 44);
      const rise = (narrow ? 46 : 96) * (0.7 + 0.6 * noise(j, 5)) * outCubic(q);
      set(puff, {
        cx: f1(x2 + side * width * 1.05 + side * (narrow ? 34 : 80) * q),
        cy: f1(top - 3 - rise),
        r: f1((narrow ? 3 : 5) + (narrow ? 10 : 22) * (0.6 + 0.4 * noise(j, 9)) * outCubic(q)),
      });
      puff.style.opacity = (0.72 * span(q, 0, 0.08) * (1 - q) ** 1.2).toFixed(3);
    });

    return on ? bell(fs, 0.14, 0.62) : 0;
  }

  function drawStamper(sN: number, fs: number, active: boolean) {
    const { narrow } = geo;
    const x3 = geo.slots[3];
    const p = partAt(sN);
    const tag = tagSize();
    const tagTop = geo.beltY + tag.y - tag.h / 2 - 1;
    const hit = active && p?.used ? strike(fs) : 0;
    const headH = narrow ? 9 : 14;
    const headW = narrow ? 30 : 48;
    const bottom = lerp(geo.stampRest, tagTop, hit);
    set(stamperRod, { x: f1(x3 - (narrow ? 3 : 4)), y: -2, width: narrow ? 6 : 8, height: f1(bottom - headH + 2) });
    set(stamperHead, { x: f1(x3 - headW / 2), y: f1(bottom - headH), width: headW, height: headH - 3 });
    set(stamperPad, { x: f1(x3 - headW / 2 + 3), y: f1(bottom - 3), width: headW - 6, height: 3 });
    stamperPad.classList.toggle("qc-idle", !!p?.idle);
  }

  function frame(u: number, still?: number[]) {
    const c = Math.floor(u);
    const f = u - c;
    const moving = !still && f < MOVE;
    const e = moving ? inOut(f / MOVE) : 1;
    const T = u * CYCLE;
    const phase = (age: number) => (still ? still[age] : f);
    const { w, h, beltY, pitch, narrow } = geo;

    svg!.setAttribute("viewBox", `0 0 ${f1(w)} ${f1(h)}`);

    for (let age = 0; age < 4; age++) {
      const n = c - age;
      drawItem(items[((n % 4) + 4) % 4], n, age, phase(age), moving, e, T);
    }

    const pressN = c - 1;
    const impact = drawPress(pressN, phase(1), present(pressN) && !moving, !!still);
    const quench = drawQuench(c - 2, phase(2), !moving, T, !!still);
    drawStamper(c - 3, phase(3), !moving);

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

    const foot = geo.tankY + geo.tank + 2;
    const footW = narrow ? 4 : 7;
    set(legs, {
      d: [geo.slots[0] + pitch / 2, geo.slots[1] + pitch / 2, geo.slots[2] + pitch / 2, geo.beltR - pitch * 0.14]
        .map((x) => `M${f1(x)} ${f1(beltY + geo.belt)}V${f1(foot)}M${f1(x - footW)} ${f1(foot)}H${f1(x + footW)}`)
        .join(""),
    });

    const shake = impact >= 0 && impact < 0.4 ? 3.5 * Math.exp(-impact * 16) * Math.cos(impact * 70) : 0;
    set(scene, { transform: still ? "" : `translate(0 ${f1(shake)})` });

    const fs3 = phase(3);
    const acts: [number, string][] = [
      [present(c) ? bell(phase(0), 0.3, 0.66) : 0, partAt(c)?.color ?? ""],
      [impact >= 0 ? 1 - span(impact, 0.3, 0.6) : 0, "var(--hot)"],
      [quench, "var(--cyan)"],
      [present(c - 3) && !moving ? bell(fs3, 0.3, 0.8) : 0, partAt(c - 3)?.color ?? ""],
    ];
    stations.forEach((st, i) => {
      const [a, color] = acts[i];
      const x = geo.slots[i];
      set(st.num, { x: f1(x), y: f1(geo.numY), "font-size": geo.type.num });
      for (const t of [st.outline, st.solid]) set(t, { x: 0, y: 0, "font-size": geo.type.verb });
      st.solid.style.opacity = a.toFixed(3);
      if (a > 0) st.solid.style.fill = color;
      show(st.note, geo.type.station > 0);
      set(st.note, { x: f1(x), y: f1(geo.noteY), "font-size": geo.type.station });
      st.note.classList.toggle("qc-station-note-on", a > 0.5);
      let tf = "";
      if (i === 0) tf = `translate(0 ${f1(-6 * (1 - outCubic(span(phase(0), 0.3, 0.42))) * (a > 0 ? 1 : 0))})`;
      if (i === 1 && impact >= 0) {
        const s = Math.exp(-impact * 9);
        tf = `scale(${(1 + 0.3 * s).toFixed(3)} ${(1 - 0.5 * s).toFixed(3)})`;
      }
      if (i === 2 && a > 0) tf = `translate(0 ${f1(-3 * Math.sin(phase(2) * 40) * (1 - span(phase(2), 0.14, 0.5)))})`;
      if (i === 3 && a > 0) tf = `translate(${f1((narrow ? 4 : 12) * Math.sin(Math.PI * span(fs3, 0.5, LAND - 3)))} 0)`;
      set(st.word, { transform: `translate(${f1(x)} ${f1(geo.verbY)}) ${tf}` });
    });

    drawCart(still ? POSTER.stack : u, !!still);
  }

  function drawCart(u: number, still: boolean) {
    const loop = Math.floor((u - 2.9) / SEQ);
    const base = SEQ * loop;
    const { floor, hb, bin, align, binL, binW, postX, narrow, type, inset, wheel } = geo;
    let sum = 0;
    let landed = 0;
    rows.forEach((row, i) => {
      const p = parts[i];
      const at = base + i + LAND;
      const on = u >= at;
      for (const el of [row.tray, row.bar, row.label]) show(el, on);
      if (!on) return;
      landed++;
      const tau = still ? 9 : (u - at) * CYCLE;
      sum += p.tokens * outCubic(clamp(tau / 0.45));
      const bw = barWidth(p.tokens);
      const bottom = binBottom(i);
      const flare = narrow ? 2 : 3;
      set(row.tray, {
        d: `M${f1(binL - flare)} ${f1(bottom - bin)}L${f1(binL)} ${f1(bottom)}H${f1(binL + binW)}L${f1(binL + binW + flare)} ${f1(bottom - bin)}`,
      });
      const bx = binL + inset;
      const barBottom = bottom - 3;
      const squash = 0.35 * Math.exp(-tau * 14) * Math.cos(tau * 36);
      set(row.bar, {
        x: f1(bx),
        y: f1(barBottom - hb),
        width: f1(bw),
        height: hb,
        transform: `translate(${f1(bx + bw / 2)} ${f1(barBottom)}) scale(${(1 + squash * 0.4).toFixed(3)} ${(1 - squash).toFixed(3)}) translate(${f1(-bx - bw / 2)} ${f1(-barBottom)})`,
      });
      row.bar.style.fill = p.color;

      const value = kilo(p.tokens);
      const room = align === 1 ? geo.w - geo.labelX - 8 : geo.labelX - 8;
      const width = (s: string) => s.length * type.label * 0.6;
      const full = `${value}  ${p.label}  ${p.used}`;
      const mid = `${value}  ${p.label}`;
      const pieces =
        p.used && width(full) <= room ? [value, p.label, p.used] : width(mid) <= room ? [value, p.label, ""] : [value, "", ""];
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
        x: f1(geo.labelX),
        y: f1(bottom - bin / 2 + 1),
        "text-anchor": align === 1 ? "start" : "end",
        "font-size": type.label,
      });
    });

    const top = binBottom(parts.length) - (narrow ? 4 : 8);
    const grip = narrow ? 8 : 14;
    set(post, { d: `M${f1(postX)} ${f1(floor)}V${f1(top)}h${f1(-grip)}` });
    set(platform, { x: f1(binL - 6), y: f1(floor), width: f1(postX - binL + 10), height: narrow ? 3 : 4 });

    const arrive = span(u, base + 2.9, base + 3.5);
    const leave = span(u, base + 10.4, base + 10.85);
    const away = geo.w - binL + 30;
    const off = still ? 0 : away * (1 - outCubic(arrive)) + away * inCubic(leave);
    set(cart, { transform: `translate(${f1(off)} 0)` });
    const turn = off / wheel;
    [binL + wheel + 4, postX - wheel - 2].forEach((cx, j) => {
      const cy = floor + (narrow ? 3 : 4) + wheel;
      const r = wheel - 1;
      set(wheels[j].rim, { cx: f1(cx), cy: f1(cy), r: f1(r) });
      set(wheels[j].spoke, {
        d: `M${f1(cx - Math.cos(turn) * r)} ${f1(cy - Math.sin(turn) * r)}L${f1(cx + Math.cos(turn) * r)} ${f1(cy + Math.sin(turn) * r)}`,
      });
    });

    const cx = geo.panelX;
    const capY = geo.panelY;
    const cy = capY + (narrow ? 10 : 14) + type.counter * 0.74;
    set(caption, { x: f1(cx), y: f1(capY), "font-size": type.caption });
    set(counter, { x: f1(cx), y: f1(cy), "font-size": type.counter });
    counter.textContent = kilo(sum);
    set(resent, { x: f1(cx), y: f1(cy + (narrow ? 20 : 26)), "font-size": type.line });

    const done = landed === parts.length ? (u - (base + parts.length - 1 + LAND)) * CYCLE : -1;
    const wipe = done >= 0.45 ? outCubic(clamp((done - 0.45) / 0.3)) : 0;
    show(counterBlock, wipe > 0);
    if (wipe > 0) {
      const bbox = counter.getBBox();
      const padX = narrow ? 6 : 10;
      const top = cy - type.counter * 0.74 - (narrow ? 3 : 5);
      set(counterBlock, {
        x: f1(bbox.x - padX),
        y: f1(top),
        width: f1((bbox.width + padX * 2) * wipe),
        height: f1(cy + (narrow ? 4 : 7) - top),
      });
    }
    counter.classList.toggle("qc-counter-done", done >= 0.6);

    const typed = done >= 0.8 ? Math.round(span(done, 0.8, 1.6) * (copy.decide.length + copy.command.length + 2)) : 0;
    show(decide, typed > 0);
    if (typed > 0) {
      decideWords.textContent = copy.decide.slice(0, typed);
      decideCommand.textContent = copy.command.slice(0, Math.max(0, typed - copy.decide.length - 2));
      set(decideCommand, { dx: type.line * 1.2 });
      set(decide, { x: f1(cx), y: f1(cy + (narrow ? 36 : 46)), "font-size": type.line, opacity: (1 - leave).toFixed(3) });
    }
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
