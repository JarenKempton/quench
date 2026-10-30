import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

type Part = { key: string; share: number; teal: boolean; label: string; kept: string };

const PARTS: Part[] = [
  { key: "system", share: 22, teal: false, label: "system 22%", kept: "system · kept" },
  {
    key: "tools",
    share: 29,
    teal: false,
    label: "built-in tools 29%",
    kept: "built-in tools · kept",
  },
  { key: "mcp", share: 14, teal: true, label: "MCP docs 14%", kept: "MCP docs · 14 calls · kept" },
  {
    key: "deferred",
    share: 8,
    teal: false,
    label: "deferred tools 8%",
    kept: "deferred tools · kept",
  },
  {
    key: "instructions",
    share: 7,
    teal: true,
    label: "instructions 7% · 6.1 KB",
    kept: "instructions · kept",
  },
  {
    key: "skills",
    share: 20,
    teal: true,
    label: "skills 20% · 23 listed",
    kept: "16 skills · kept",
  },
];
const NOT_RECORDED = "not recorded: MCP instructions in 12/48";
const CHIPS = 23;
const DEAD = 7;

const LEN = 4.0;
const BH = 0.44;
const BD = 0.62;
const Y = 1.0;
const SCAN_X = -0.2;
const SPOT_X = 1.6;
const PRESS_X = 3.0;
const TANK_X = 8.4;
const BELT_A: [number, number] = [-1.2, 6.7];
const BELT_B: [number, number] = [7.1, 8.2];
const TANK: [number, number] = [8.2, 12.5];
const WATER_Y = 0.8;
const DIP = 0.82;
const BIN: [number, number] = [6.55, 7.25];

const IMPACT = 7.05;
const SPLASH = 10.2;
const END = 14.6;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const lin = (x: number) => x;
const out = (x: number) => 1 - (1 - x) ** 3;
const cubicIn = (x: number) => x * x * x;
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const back = (s: number) => (x: number) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
type Key = [number, number, ((x: number) => number)?];
const track = (t: number, keys: Key[]) => {
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, curve = inOut] = keys[i]!;
    const [t0, v0] = keys[i - 1]!;
    if (t <= t1) return lerp(v0, v1, curve(span(t, t0, t1)));
  }
  return keys[keys.length - 1]![1];
};
const decay = (t: number, from: number, k: number, w: number) =>
  t < from ? 0 : Math.exp(-(t - from) * k) * Math.sin((t - from) * w);
const rand = (i: number, k: number) => {
  const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

const barX = (t: number) =>
  track(t, [
    [0, -LEN - 2.4],
    [1.0, SCAN_X, out],
    [3.5, SCAN_X],
    [4.4, SPOT_X],
    [5.6, SPOT_X],
    [6.4, PRESS_X],
    [8.0, PRESS_X],
    [9.3, TANK_X],
  ]);
const pressY = (t: number) =>
  track(t, [
    [6.5, 0],
    [6.85, 0.16, out],
    [6.92, 0.16],
    [IMPACT, -0.9, cubicIn],
    [7.18, -0.8, out],
    [7.3, -0.86],
    [7.75, -0.86],
    [8.3, 0],
  ]);
const liftY = (t: number) =>
  track(t, [
    [9.6, 0],
    [SPLASH, -DIP, cubicIn],
    [12.4, -DIP],
    [13.0, 0, out],
  ]);
const heat = (t: number) => {
  const up = inOut(span(t, 8.3, 9.4));
  if (t < SPLASH) return { T: up, q: 0 };
  return { T: up * Math.exp(-(t - SPLASH) * 2.6), q: span(t, SPLASH + 0.3, SPLASH + 1.6) };
};

const HEAT = ["#000000", "#5a1204", "#c43a0c", "#ff7a22", "#ffc266"].map((h) => new THREE.Color(h));
const heatColor = (T: number) => {
  const v = clamp(T) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(v));
  return HEAT[i]!.clone().lerp(HEAT[i + 1]!, v - i);
};

type Label = {
  el: HTMLElement;
  line: HTMLElement;
  anchor: () => THREE.Vector3;
  row: number;
  alpha: (t: number) => number;
};

function softTexture() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function mountForge(root: HTMLElement) {
  const canvas = root.querySelector("canvas")!;
  const overlay = root.querySelector<HTMLElement>(".labels")!;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const narrow = matchMedia("(max-width: 600px)");

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
  } catch {
    root.classList.add("no-gl");
    return;
  }
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x151714);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x151714, 14, 30);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.1, 60);

  const hemi = new THREE.HemisphereLight(0x8a96a2, 0x070807, 0.4);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0x6f8aa0, 0.5);
  fill.position.set(8, 4, -7);
  scene.add(fill);
  const hot = new THREE.PointLight(0xff7a22, 0, 6, 2);
  scene.add(hot);
  const scanLight = new THREE.PointLight(0x2fb3b3, 0, 3, 2);
  scene.add(scanLight);

  const M = {
    steel: new THREE.MeshStandardMaterial({ color: 0x555a61, metalness: 0.9, roughness: 0.32 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2c2f34, metalness: 0.75, roughness: 0.55 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121314, metalness: 0.05, roughness: 0.96 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x121311, metalness: 0.1, roughness: 0.97 }),
    bin: new THREE.MeshStandardMaterial({ color: 0x1f2226, metalness: 0.6, roughness: 0.6 }),
    water: new THREE.MeshPhysicalMaterial({
      color: 0x1f5a6a,
      metalness: 0,
      roughness: 0.06,
      transparent: true,
      opacity: 0.55,
      envMapIntensity: 0.25,
      side: THREE.DoubleSide,
    }),
    coil: new THREE.MeshStandardMaterial({
      color: 0x5a3220,
      metalness: 0.85,
      roughness: 0.35,
      emissive: 0x000000,
    }),
    scan: new THREE.MeshBasicMaterial({ color: 0x5fe0e0, transparent: true, opacity: 0 }),
  };

  const add = <T extends THREE.Object3D>(o: T, parent: THREE.Object3D = scene) => {
    parent.add(o);
    return o;
  };
  const box = (
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent?: THREE.Object3D,
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return add(m, parent);
  };

  const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 30), M.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;

  const belt = (a: number, b: number) => {
    const w = b - a;
    const cx = (a + b) / 2;
    box(w, 0.08, BD + 0.3, M.rubber, cx, Y - 0.04, 0);
    box(w, 0.16, BD + 0.42, M.frame, cx, Y - 0.16, 0);
    for (const x of [a + 0.25, b - 0.25])
      for (const z of [-(BD + 0.42) / 2 + 0.06, (BD + 0.42) / 2 - 0.06])
        box(0.1, Y - 0.24, 0.1, M.frame, x, (Y - 0.24) / 2, z);
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, BD + 0.44, 24), M.steel);
    roller.rotation.x = Math.PI / 2;
    for (const x of [a, b]) {
      const r = roller.clone();
      r.position.set(x, Y - 0.1, 0);
      r.castShadow = true;
      add(r);
    }
  };
  belt(...BELT_A);
  belt(...BELT_B);

  const gantry = new THREE.Group();
  box(0.1, 1.4, 0.1, M.frame, SCAN_X - 0.3, Y + 0.7, BD / 2 + 0.5, gantry);
  box(0.1, 1.4, 0.1, M.frame, SCAN_X + LEN + 0.3, Y + 0.7, BD / 2 + 0.5, gantry);
  box(0.1, 1.4, 0.1, M.frame, SCAN_X - 0.3, Y + 0.7, -BD / 2 - 0.5, gantry);
  box(0.1, 1.4, 0.1, M.frame, SCAN_X + LEN + 0.3, Y + 0.7, -BD / 2 - 0.5, gantry);
  box(LEN + 0.7, 0.12, BD + 1.1, M.frame, SCAN_X + LEN / 2, Y + 1.4, 0, gantry);
  const scanHead = box(0.26, 0.14, BD + 1.0, M.steel, SCAN_X, Y + 1.28, 0, gantry);
  const scanPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.02, BD + 0.9), M.scan);
  scanPlane.rotation.y = Math.PI / 2;
  scanPlane.position.set(SCAN_X, Y + BH / 2 + 0.3, 0);
  add(scanPlane);
  add(gantry);

  const stamp = box(0.6, 0.12, BD + 0.2, M.steel, SPOT_X + LEN - 0.12, Y + 1.0, 0);
  box(0.08, 1.4, 0.08, M.frame, SPOT_X + LEN + 0.35, Y + 1.3, 0);
  box(0.5, 0.08, 0.08, M.frame, SPOT_X + LEN + 0.12, Y + 1.98, 0);

  const pressX = PRESS_X + LEN - 0.12;
  box(0.16, 2.6, 0.16, M.frame, pressX - 0.6, Y + 1.3, BD / 2 + 0.3);
  box(0.16, 2.6, 0.16, M.frame, pressX + 0.6, Y + 1.3, BD / 2 + 0.3);
  box(0.16, 2.6, 0.16, M.frame, pressX - 0.6, Y + 1.3, -BD / 2 - 0.3);
  box(0.16, 2.6, 0.16, M.frame, pressX + 0.6, Y + 1.3, -BD / 2 - 0.3);
  box(1.5, 0.3, BD + 0.9, M.frame, pressX, Y + 2.6, 0);
  const ram = new THREE.Group();
  box(0.22, 1.2, 0.22, M.steel, 0, 0.95, 0, ram);
  box(0.7, 0.5, BD + 0.1, M.steel, 0, 0.1, 0, ram);
  ram.position.set(pressX, Y + 0.9, 0);
  add(ram);

  const binW = BIN[1] - BIN[0];
  const binCx = (BIN[0] + BIN[1]) / 2;
  box(binW + 0.1, 0.06, BD + 0.5, M.bin, binCx, 0.03, 0);
  box(0.05, 0.6, BD + 0.5, M.bin, BIN[0] - 0.03, 0.3, 0);
  box(0.05, 0.6, BD + 0.5, M.bin, BIN[1] + 0.03, 0.3, 0);
  box(binW + 0.1, 0.6, 0.05, M.bin, binCx, 0.3, (BD + 0.5) / 2);
  box(binW + 0.1, 0.6, 0.05, M.bin, binCx, 0.3, -(BD + 0.5) / 2);

  const coilX = 7.75;
  const coils: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.035, 12, 48), M.coil.clone());
    c.rotation.y = Math.PI / 2;
    c.position.set(coilX - 0.3 + i * 0.2, Y + BH / 2 + 0.1, 0);
    c.castShadow = true;
    coils.push(add(c));
  }
  box(0.1, 1.2, 0.1, M.frame, coilX, Y + 1.4, BD / 2 + 0.55);
  box(0.1, 1.2, 0.1, M.frame, coilX, Y + 1.4, -BD / 2 - 0.55);
  box(0.1, 0.1, BD + 1.1, M.frame, coilX, Y + 2.0, 0);

  const tankW = TANK[1] - TANK[0];
  const tankCx = (TANK[0] + TANK[1]) / 2;
  const tankD = BD + 1.0;
  box(tankW, 0.08, tankD, M.frame, tankCx, 0.04, 0);
  box(0.08, 0.92, tankD, M.frame, TANK[0] - 0.04, 0.46, 0);
  box(0.08, 0.92, tankD, M.frame, TANK[1] + 0.04, 0.46, 0);
  box(tankW + 0.16, 0.92, 0.08, M.frame, tankCx, 0.46, tankD / 2 + 0.04);
  box(tankW + 0.16, 0.92, 0.08, M.frame, tankCx, 0.46, -tankD / 2 - 0.04);
  box(tankW + 0.24, 0.05, tankD + 0.16, M.steel, tankCx, 0.94, 0);
  const waterGeo = new THREE.PlaneGeometry(tankW - 0.02, tankD - 0.02, 60, 16);
  const water = new THREE.Mesh(waterGeo, M.water);
  water.rotation.x = -Math.PI / 2;
  water.position.set(tankCx, WATER_Y, 0);
  water.receiveShadow = true;
  add(water);
  const waterBase = (
    waterGeo.attributes.position as THREE.BufferAttribute
  ).array.slice() as Float32Array;
  const waterLight = new THREE.PointLight(0xff7a22, 0, 4, 2);
  waterLight.position.set(TANK_X + LEN / 2, WATER_Y - 0.3, 0);
  add(waterLight);

  const lift = new THREE.Group();
  box(LEN + 0.2, 0.08, BD + 0.1, M.steel, LEN / 2, -0.04, 0, lift);
  box(0.08, 1.2, 0.08, M.frame, 0.3, -0.68, 0, lift);
  box(0.08, 1.2, 0.08, M.frame, LEN - 0.3, -0.68, 0, lift);
  lift.position.set(TANK_X, Y, 0);
  add(lift);

  const clampL = new THREE.Group();
  box(0.12, BH + 0.24, BD + 0.2, M.steel, -0.06, (BH + 0.24) / 2 - 0.1, 0, clampL);
  box(0.3, 0.08, BD + 0.2, M.steel, 0.1, BH + 0.1, 0, clampL);
  const clampR = clampL.clone();
  clampR.scale.x = -1;
  add(clampL);
  add(clampR);

  const piece = new THREE.Group();
  const total = PARTS.reduce((n, p) => n + p.share, 0);
  const segs: {
    part: Part;
    x0: number;
    w: number;
    mesh: THREE.Mesh;
    mat: THREE.MeshStandardMaterial;
  }[] = [];
  const chips: {
    mesh: THREE.Mesh;
    mat: THREE.MeshStandardMaterial;
    x0: number;
    w: number;
    dead: boolean;
    i: number;
  }[] = [];
  let cursor = 0;
  const grey = () =>
    new THREE.MeshStandardMaterial({ color: 0x5c6168, metalness: 0.82, roughness: 0.38 });
  const teal = () =>
    new THREE.MeshStandardMaterial({ color: 0x1e6c6d, metalness: 0.65, roughness: 0.42 });
  for (const part of PARTS) {
    const w = (LEN * part.share) / total;
    if (part.key === "skills") {
      const cw = w / CHIPS;
      for (let i = 0; i < CHIPS; i++) {
        const mat = teal();
        const dead = i >= CHIPS - DEAD;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(cw - 0.006, BH, BD), mat);
        mesh.position.set(cursor + i * cw + cw / 2, BH / 2, 0);
        mesh.castShadow = mesh.receiveShadow = true;
        piece.add(mesh);
        chips.push({ mesh, mat, x0: cursor + i * cw, w: cw, dead, i });
      }
      segs.push({ part, x0: cursor, w, mesh: chips[0]!.mesh, mat: chips[0]!.mat });
    } else {
      const mat = part.teal ? teal() : grey();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w - 0.012, BH, BD), mat);
      mesh.position.set(cursor + w / 2, BH / 2, 0);
      mesh.castShadow = mesh.receiveShadow = true;
      piece.add(mesh);
      segs.push({ part, x0: cursor, w, mesh, mat });
    }
    cursor += w;
  }
  const keptLen = chips.find((c) => c.dead)!.x0;
  add(piece);
  const falling = chips
    .filter((c) => c.dead)
    .map((c, j) => ({
      c,
      vy: 0.3 + rand(j, 1) * 0.6,
      vx: -0.2 + rand(j, 2) * 0.4,
      spin: (rand(j, 3) - 0.5) * 9,
      rest: (rand(j, 4) - 0.5) * 0.6,
      landed: false,
      pos: new THREE.Vector3(),
      rot: 0,
    }));

  const steamTex = softTexture();
  const puffs = Array.from({ length: 56 }, (_, i) => {
    const mat = new THREE.SpriteMaterial({
      map: steamTex,
      color: 0xd5dbe0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.visible = false;
    add(sp);
    return {
      sp,
      mat,
      t0: SPLASH + 0.05 + 2.2 * (i / 56) ** 1.5,
      x: TANK_X + 0.1 + rand(i, 5) * (keptLen - 0.2),
      z: (rand(i, 6) - 0.5) * BD,
      life: 1.6 + rand(i, 7) * 1.1,
      v: 0.5 + rand(i, 8) * 0.5,
      drift: 0.1 + rand(i, 9) * 0.3,
      r0: 0.12 + rand(i, 10) * 0.1,
      r1: 0.55 + rand(i, 11) * 0.5,
      a: 0.28 + rand(i, 12) * 0.2,
    };
  });
  const drops = Array.from({ length: 16 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.018 + rand(i, 13) * 0.014, 8, 8), M.water);
    m.visible = false;
    add(m);
    return {
      m,
      x: TANK_X + rand(i, 14) * keptLen,
      z: (rand(i, 15) - 0.5) * BD,
      vx: (rand(i, 16) - 0.5) * 1.4,
      vz: (rand(i, 17) - 0.5) * 1.0,
      vy: 1.6 + rand(i, 18) * 1.4,
    };
  });

  const mkLabel = (html: string, cls = "") => {
    const el = document.createElement("div");
    el.className = `lbl ${cls}`.trim();
    el.innerHTML = html;
    const line = document.createElement("i");
    line.className = "lead";
    overlay.append(line, el);
    return { el, line };
  };
  const world =
    (dx: number, dy: number, dz = 0) =>
    () =>
      new THREE.Vector3(dx, dy, dz);
  const pieceAnchor =
    (x: number, y = BH + 0.02) =>
    () =>
      piece.localToWorld(new THREE.Vector3(x, y, 0));
  const labels: Label[] = [];
  const scanAlpha = (cx: number) => (t: number) => {
    const scanX = track(t, [
      [1.1, SCAN_X],
      [3.1, SCAN_X + LEN, lin],
    ]);
    return (
      span(scanX, SCAN_X + cx - 0.1, SCAN_X + cx + 0.1) *
      span(t, 1.1, 1.2) *
      (1 - span(t, 3.4, 3.6))
    );
  };
  segs.forEach((s, i) => {
    const cx = s.x0 + s.w / 2;
    const l = mkLabel(s.part.label);
    labels.push({ ...l, anchor: pieceAnchor(cx), row: i % 3, alpha: scanAlpha(cx) });
  });
  {
    const l = mkLabel("", "counter");
    const el = l.el;
    labels.push({
      ...l,
      anchor: world(SCAN_X + LEN / 2, Y + 1.55),
      row: -1,
      alpha: (t) => {
        const p = span(t, 1.1, 3.1);
        el.textContent =
          t >= 3.1
            ? "starting load 21.0k · 61% of tokens processed"
            : `starting load ${((21000 * p) / 1000).toFixed(1)}k`;
        return span(t, 1.0, 1.2) * (1 - span(t, 3.4, 3.6));
      },
    });
    const nr = mkLabel(NOT_RECORDED, "muted");
    labels.push({
      ...nr,
      anchor: world(SCAN_X + LEN / 2, Y - 0.5),
      row: 3,
      alpha: (t) => span(t, 2.9, 3.2) * (1 - span(t, 3.4, 3.6)),
    });
  }
  {
    const never = mkLabel('<b class="bad">7 never used</b>');
    labels.push({
      ...never,
      anchor: pieceAnchor(keptLen + (LEN - keptLen) / 2),
      row: 0,
      alpha: (t) => span(t, 5.0, 5.3) * (1 - span(t, 5.6, 5.8)),
    });
    const mcp = segs.find((s) => s.part.key === "mcp")!;
    const used = mkLabel('MCP docs · 14 calls · <b class="ok">used</b>');
    labels.push({
      ...used,
      anchor: pieceAnchor(mcp.x0 + mcp.w / 2),
      row: 1,
      alpha: (t) => span(t, 4.7, 5.0) * (1 - span(t, 5.6, 5.8)),
    });
    const note = mkLabel("you remove them", "muted");
    labels.push({
      ...note,
      anchor: world(binCx, -0.05),
      row: 4,
      alpha: (t) => span(t, 7.4, 7.8) * (1 - span(t, 9.2, 9.6)),
    });
  }
  segs.forEach((s, i) => {
    const w = s.part.key === "skills" ? keptLen - s.x0 : s.w;
    const l = mkLabel(s.part.kept.replace("kept", '<b class="ok">kept</b>'));
    labels.push({
      ...l,
      anchor: pieceAnchor(s.x0 + w / 2),
      row: i % 3,
      alpha: (t) => span(t, 13.3 + i * 0.18, 13.7 + i * 0.18),
    });
  });

  const target = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let camX = SCAN_X + LEN / 2;
  let shown = 0;
  let raf = 0;
  let w = 1;
  let h = 1;

  function frameCamera(px: number, t: number) {
    const wide = !narrow.matches;
    const focus = wide ? px + (t < IMPACT ? LEN : keptLen) / 2 : (BELT_A[0] + TANK[1]) / 2;
    camX = wide ? lerp(camX, focus, 0.08) : focus;
    target.set(camX, Y + 0.1, 0);
    if (wide) camPos.set(camX + 1.6, Y + 3.2, 6.2);
    else {
      const half = (TANK[1] - BELT_A[0]) / 2 + 0.8;
      const hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
      const d = half / Math.tan(hfov / 2);
      camPos.set(camX + 0.4, Y + d * 0.3, d * 0.95);
    }
    const shake = 0.02 * decay(t, IMPACT, 8, 34);
    camera.position.copy(camPos).add(new THREE.Vector3(0, shake, 0));
    camera.lookAt(target);
    key.position.set(camX - 4, 8, 5);
    key.target.position.set(camX, Y, 0);
  }

  function placeLabels(t: number) {
    const cw = overlay.clientWidth;
    const chh = overlay.clientHeight;
    const rowH = narrow.matches ? 20 : 26;
    const base = narrow.matches ? 30 : 44;
    type Placed = {
      l: Label;
      sx: number;
      sy: number;
      lw: number;
      lh: number;
      left: number;
      top: number;
    };
    const placed: Placed[] = [];
    for (const l of labels) {
      const a = l.alpha(t);
      l.el.style.opacity = a.toFixed(3);
      l.line.style.opacity = (a * 0.7).toFixed(3);
      if (a <= 0.01) {
        l.el.style.display = l.line.style.display = "none";
        continue;
      }
      l.el.style.display = "block";
      const p = l.anchor().project(camera);
      const sx = ((p.x + 1) / 2) * cw;
      const sy = ((1 - p.y) / 2) * chh;
      const lw = l.el.offsetWidth;
      const lh = l.el.offsetHeight;
      let top: number;
      if (l.row === -1) top = 8;
      else if (l.row >= 3) top = Math.min(chh - lh - 4, sy + 10 + (l.row - 3) * rowH);
      else top = base + l.row * rowH;
      placed.push({ l, sx, sy, lw, lh, left: clamp(sx - lw / 2, 4, cw - lw - 4), top });
    }
    const rows = new Map<number, Placed[]>();
    for (const p of placed) rows.set(p.l.row, [...(rows.get(p.l.row) ?? []), p]);
    for (const list of rows.values()) {
      list.sort((a, b) => a.sx - b.sx);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        cur.left = Math.max(cur.left, prev.left + prev.lw + 8);
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const cur = list[i]!;
        const limit = i + 1 < list.length ? list[i + 1]!.left - 8 - cur.lw : cw - cur.lw - 4;
        cur.left = Math.min(cur.left, limit);
      }
    }
    for (const p of placed) {
      const { l, sx, sy, lw, lh, left, top } = p;
      l.el.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
      const above = l.row >= 0 && l.row < 3;
      const show = above && sy > top + lh + 2;
      l.line.style.display = show ? "block" : "none";
      if (show) {
        const cx = clamp(sx, left + 4, left + lw - 4);
        l.line.style.transform = `translate(${cx.toFixed(1)}px, ${(top + lh).toFixed(1)}px)`;
        l.line.style.height = `${(sy - top - lh).toFixed(1)}px`;
      }
    }
  }

  function render(t: number) {
    const px = barX(t);
    const onLift = t >= 9.3;
    const ly = liftY(t);
    const jolt = 0.012 * decay(t, IMPACT, 8, 34);
    piece.position.set(onLift ? TANK_X : px, Y + (onLift ? ly : jolt), 0);

    const { T, q } = heat(t);
    const emis = heatColor(T);
    const setMat = (mat: THREE.MeshStandardMaterial, baseColor: THREE.Color, baseRough: number) => {
      mat.emissive.copy(emis);
      mat.emissiveIntensity = 1.6;
      mat.color.copy(baseColor).lerp(new THREE.Color(0x2a2d31), q * 0.55);
      mat.roughness = lerp(baseRough, 0.3, q);
    };
    const GREY = new THREE.Color(0x5c6168);
    const TEAL = new THREE.Color(0x1e6c6d);
    const DEADC = new THREE.Color(0x3a1f1c);
    segs.forEach(
      (s) =>
        s.part.key !== "skills" &&
        setMat(s.mat, s.part.teal ? TEAL : GREY, s.part.teal ? 0.42 : 0.38),
    );
    const spotting = span(t, 4.6, 5.3);
    chips.forEach((c) => {
      if (c.dead) {
        const d = clamp(spotting * DEAD - (c.i - (CHIPS - DEAD)));
        c.mat.color.copy(TEAL).lerp(DEADC, d);
        c.mat.emissive.set(0xe06c5a);
        c.mat.emissiveIntensity = 0.5 * d;
        c.mat.roughness = 0.5;
      } else setMat(c.mat, TEAL, 0.42);
    });
    hot.position.set(piece.position.x + keptLen / 2, piece.position.y + BH + 0.4, 0.4);
    hot.intensity = 9 * T * T;
    waterLight.intensity = piece.position.y + BH < WATER_Y + 0.2 ? 24 * T : 0;

    if (t >= IMPACT) {
      const u = t - IMPACT;
      falling.forEach((f) => {
        const m = f.c.mesh;
        if (m.parent === piece) {
          const wp = piece.localToWorld(m.position.clone());
          piece.remove(m);
          scene.add(m);
          f.pos.copy(wp);
        }
        const g = 6.5;
        const y = f.pos.y + f.vy * u - 0.5 * g * u * u;
        const floorY = 0.06 + BH * 0.5 * Math.abs(Math.cos(f.rest));
        const landT = (f.vy + Math.sqrt(f.vy * f.vy + 2 * g * (f.pos.y - floorY))) / g;
        const uu = Math.min(u, landT);
        const yy = f.pos.y + f.vy * uu - 0.5 * g * uu * uu;
        const settled = span(u, landT, landT + 0.25);
        m.position.set(
          binCx + (f.c.i - (CHIPS - DEAD) - DEAD / 2 + 0.5) * 0.085 + f.vx * clamp(u / landT) * 0.3,
          Math.max(y, yy),
          (rand(f.c.i, 20) - 0.5) * 0.3,
        );
        m.rotation.z = lerp(f.spin * clamp(u / landT), f.rest, settled);
      });
    }

    const scanX = track(t, [
      [1.1, SCAN_X],
      [3.1, SCAN_X + LEN, lin],
    ]);
    const scanning = span(t, 1.0, 1.15) * (1 - span(t, 3.1, 3.3));
    scanHead.position.x = scanX;
    scanPlane.position.x = scanX;
    M.scan.opacity = 0.9 * scanning;
    scanLight.position.set(scanX, Y + BH + 0.5, 0);
    scanLight.intensity = 2.5 * scanning;

    stamp.position.y =
      Y +
      track(t, [
        [4.4, 1.0],
        [4.6, BH + 0.12, out],
        [5.3, BH + 0.12],
        [5.6, 1.0],
      ]);
    ram.position.y = Y + 0.9 + pressY(t);

    const coilOn = span(t, 8.2, 8.6) * (1 - span(t, 9.6, 10.2));
    coils.forEach((c) => {
      const m = c.material as THREE.MeshStandardMaterial;
      m.emissive.set(0xff6a1a);
      m.emissiveIntensity = 2.2 * coilOn;
    });

    lift.position.y = Y + ly;

    const pos = waterGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = waterBase[i * 3]!;
      const lz = waterBase[i * 3 + 1]!;
      const wx = tankCx + lx;
      let y = 0.004 * Math.sin(wx * 6 + t * 1.6) * Math.cos(lz * 5 + t * 1.1);
      for (const s0 of [SPLASH, 13.0]) {
        const u = t - s0;
        if (u <= 0) continue;
        const dx = Math.max(0, Math.abs(wx - (TANK_X + keptLen / 2)) - keptLen / 2);
        const d = Math.hypot(dx, lz);
        y +=
          0.05 *
          Math.exp(-u * 1.4) *
          Math.sin(d * 9 - u * 10) *
          Math.exp(-Math.max(0, d - 0.3 - u * 1.6) * 3);
      }
      pos.setZ(i, y);
    }
    pos.needsUpdate = true;
    waterGeo.computeVertexNormals();

    puffs.forEach((p) => {
      const a = t - p.t0;
      if (a <= 0 || a >= p.life) {
        p.sp.visible = false;
        return;
      }
      const f = a / p.life;
      p.sp.visible = true;
      const rise = (p.v * (1 - Math.exp(-a * 1.3))) / 1.3 + 0.25 * a;
      p.sp.position.set(p.x + p.drift * a, WATER_Y + 0.05 + rise, p.z + 0.15 * a);
      const r = lerp(p.r0, p.r1, 1 - Math.exp(-a * 1.3));
      p.sp.scale.set(r * 2, r * 2, 1);
      p.mat.opacity = p.a * Math.min(1, f * 6) * (1 - f) ** 1.6;
    });
    drops.forEach((d) => {
      const u = t - SPLASH;
      const y = WATER_Y + d.vy * u - 0.5 * 9 * u * u;
      d.m.visible = u > 0 && y > WATER_Y;
      if (d.m.visible) d.m.position.set(d.x + d.vx * u, y, d.z + d.vz * u);
    });

    const cl = back(1.4)(span(t, 13.1, 13.5));
    clampL.position.set(lerp(TANK[0] - 0.8, TANK_X, cl), Y, 0);
    clampR.position.set(lerp(TANK[1] + 0.8, TANK_X + keptLen, cl), Y, 0);
    clampL.visible = clampR.visible = t > 13.0;

    frameCamera(px, t);
    renderer.render(scene, camera);
    placeLabels(t);
  }

  function size() {
    w = root.clientWidth;
    const aspect = narrow.matches ? 16 / 10 : 16 / 9;
    h = Math.round(w / aspect);
    canvas.style.height = `${h}px`;
    overlay.style.height = `${h}px`;
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function play() {
    cancelAnimationFrame(raf);
    const began = performance.now();
    const frame = (now: number) => {
      shown = Math.min(END, (now - began) / 1000);
      render(shown);
      if (shown < END) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  size();
  camX = narrow.matches ? (BELT_A[0] + TANK[1]) / 2 : SCAN_X + LEN / 2;
  new ResizeObserver(() => {
    if (root.clientWidth === w) return;
    size();
    render(shown);
  }).observe(root);
  narrow.addEventListener("change", () => {
    size();
    render(shown);
  });
  root.classList.add("gl");

  if (still) {
    shown = END;
    for (let i = 0; i < 3; i++) render(END);
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
