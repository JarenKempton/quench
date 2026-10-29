import * as THREE from "three";
import { machines } from "./machines.ts";
import {
  BELT_Y,
  HOPPER_BOTTOM,
  HOPPER_HALF,
  HOPPER_TOP,
  PLATEN_REST,
  PLINTH_Y,
  SLAB,
  SLOT,
  STACK_X,
  TABLE_Y,
  lumpy,
  outline,
  puff,
  slotX,
} from "./parts.ts";

export type Layer = { share: number; color: string };

const STEP = 2.6;
const MOVE = 0.34;
const PERIOD = 8;
const COLUMN = 1.75;
const IMPACT = 0.3;
const START = 11.62 * STEP;
const STILL = 13.74 * STEP;
const DWELL_SECONDS = (1 - MOVE) * STEP;
const HOT = new THREE.Color("#ffc58a");
const GLOW = new THREE.Color("#ff5f12");
const BLACK = new THREE.Color("#000000");

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeIn = (x: number) => x * x * x;
const rand = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

type Tags = {
  items: HTMLElement[];
  total: HTMLElement;
  totalValue: HTMLElement;
  stations: HTMLElement[];
};

export function line(stage: HTMLElement, canvas: HTMLCanvasElement, layers: Layer[], tags: Tags, startTokens: number) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  scene.add(new THREE.HemisphereLight("#d4eeff", "#0a2846", 1.55));
  const sun = new THREE.DirectionalLight("#ffffff", 2.1);
  sun.position.set(-5, 13, 9);
  sun.target.position.set(1.5, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 9, bottom: -9, near: 1, far: 40 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight("#9fdcfa", 0.6);
  rim.position.set(8, 6, -8);
  scene.add(rim);

  const rig = machines(scene);
  const heights = layers.map((l) => Math.max(0.06, l.share * COLUMN));
  const bases = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
  const columnTop = bases[bases.length - 1] + heights[heights.length - 1];
  const tokens = layers.map((l) => l.share * startTokens);

  const blobs = layers.map((l, k) => {
    const shape = lumpy(k * 1.7 + 0.4);
    const color = new THREE.Color(l.color);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.18),
      roughness: 0.45,
      metalness: 0.05,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(shape.geometry, material);
    mesh.castShadow = true;
    scene.add(mesh);
    return { mesh, wobble: shape.wobble, radius: 0.46 + 0.62 * Math.sqrt(l.share) };
  });

  const slabs = [0, 1].map(() =>
    layers.map((l, k) => {
      const material = new THREE.MeshStandardMaterial({ color: l.color, roughness: 0.42, metalness: 0.12 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(SLAB, heights[k], SLAB), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const edgeMaterial = new THREE.LineBasicMaterial({ color: "#eef8ff", transparent: true, opacity: 0 });
      outline(mesh, edgeMaterial);
      scene.add(mesh);
      return { mesh, material, edgeMaterial, base: new THREE.Color(l.color) };
    }),
  );

  const straps = [0, 1].map(() =>
    [0.28, 0.72].map((at) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(SLAB + 0.1, 0.09, SLAB + 0.1),
        new THREE.MeshStandardMaterial({ color: "#9fdcfa", emissive: "#5aa9d2", emissiveIntensity: 0.6, roughness: 0.3 }),
      );
      mesh.castShadow = true;
      scene.add(mesh);
      return { mesh, at };
    }),
  );

  const FRAGMENTS = 30;
  const shards = new THREE.InstancedMesh(
    new THREE.TetrahedronGeometry(0.075),
    new THREE.MeshStandardMaterial({ roughness: 0.5, flatShading: true }),
    FRAGMENTS,
  );
  shards.castShadow = true;
  for (let i = 0; i < FRAGMENTS; i++) shards.setColorAt(i, new THREE.Color("#ffffff"));
  scene.add(shards);

  const puffTexture = puff();
  const steam = Array.from({ length: 12 }, () => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture, transparent: true, depthWrite: false, opacity: 0 }));
    scene.add(sprite);
    return sprite;
  });

  const target = new THREE.Vector3(1.4, 1.6, 0);
  const view = { width: 1, height: 1, wide: true };
  const shake = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();

  const bounds: [number, number, number][] = [];
  for (const x of [-7.0, 10.1]) for (const z of [-2.6, 2.6]) bounds.push([x, 0, z], [x, PLINTH_Y, z]);
  for (const [x, half, y, depth] of [
    [slotX(0), 1.25, HOPPER_TOP + 1.0, 1.5],
    [slotX(1), 0.6, BELT_Y + 5.1, 1.65],
    [slotX(2), 0.5, BELT_Y + 3.0, 1.6],
    [STACK_X, 0.8, TABLE_Y + COLUMN + 0.5, 0.8],
  ])
    for (const dx of [-half, half]) for (const z of [-depth, depth]) bounds.push([x + dx, y, z]);

  function fit() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    view.width = width;
    view.height = height;
    view.wide = width >= 900;
    renderer.setSize(width, height, false);
    const azimuth = THREE.MathUtils.degToRad(view.wide ? -36 : -47);
    const elevation = THREE.MathUtils.degToRad(view.wide ? 29 : 32);
    const dir = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    camera.position.copy(target).addScaledVector(dir, 40);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld();

    const inverse = camera.matrixWorldInverse;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y, z] of bounds) {
      scratch.set(x, y, z).applyMatrix4(inverse);
      minX = Math.min(minX, scratch.x);
      maxX = Math.max(maxX, scratch.x);
      minY = Math.min(minY, scratch.y);
      maxY = Math.max(maxY, scratch.y);
    }
    const rect = view.wide ? { x0: 0.4, x1: 0.99, y0: 0.06, y1: 1 } : { x0: 0.01, x1: 0.99, y0: 0.03, y1: 0.99 };
    const s = Math.max((maxX - minX) / (width * (rect.x1 - rect.x0)), (maxY - minY) / (height * (rect.y1 - rect.y0)));
    const fw = width * s;
    const fh = height * s;
    const left = (minX + maxX) / 2 - ((rect.x0 + rect.x1) / 2) * fw;
    const top = (minY + maxY) / 2 + ((rect.y0 + rect.y1) / 2) * fh;
    Object.assign(camera, { left, right: left + fw, top, bottom: top - fh });
    camera.updateProjectionMatrix();
  }

  function place(el: HTMLElement, x: number, y: number, z: number, visible: number) {
    scratch.set(x, y, z).project(camera);
    const half = el.offsetWidth / 2 + 6;
    const sx = Math.min(view.width - half, Math.max(half, ((scratch.x + 1) / 2) * view.width));
    const sy = ((1 - scratch.y) / 2) * view.height;
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    el.style.opacity = visible.toFixed(3);
  }

  function frame(t: number) {
    const step = Math.floor(t / STEP);
    const ph = t / STEP - step;
    const moving = ph < MOVE;
    const move = moving ? inOut(ph / MOVE) : 1;
    const dwell = moving ? 0 : (ph - MOVE) / (1 - MOVE);
    const kindAt = (n: number) => ((n % PERIOD) + PERIOD) % PERIOD;

    rig.belt((step + move) * SLOT);

    const pressed = kindAt(step - 1);
    const platenTarget = pressed < layers.length ? BELT_Y + heights[pressed] : PLATEN_REST;
    let platen = PLATEN_REST;
    if (!moving && pressed < layers.length) {
      if (dwell < 0.12) platen = PLATEN_REST;
      else if (dwell < IMPACT) platen = lerp(PLATEN_REST, platenTarget, easeIn((dwell - 0.12) / (IMPACT - 0.12)));
      else if (dwell < 0.44) platen = platenTarget;
      else platen = lerp(platenTarget, PLATEN_REST, inOut((dwell - 0.44) / 0.56));
    }
    rig.press.set(platen);
    const pressing = !moving && pressed < layers.length && dwell > 0.1 && dwell < 0.5;
    rig.press.light.emissive.set(pressing ? "#ff5a3c" : "#000000");

    const locked = kindAt(step - 2);
    const locking = !moving && locked < layers.length;
    const open = locking ? 1 - smooth(0.04, 0.18, dwell) + smooth(0.8, 0.95, dwell) : 1;
    let stampBottom = BELT_Y + 2.2;
    if (locking) {
      const seat = BELT_Y + heights[locked];
      stampBottom = lerp(BELT_Y + 2.2, seat, smooth(0.16, 0.27, dwell) - smooth(0.38, 0.55, dwell));
    }
    rig.lock.set(open, stampBottom);
    rig.lock.light.emissive.set(locking && dwell > 0.27 && dwell < 0.85 ? "#5ee39a" : "#000000");
    rig.hopperLight.emissive.set(!moving && kindAt(step) < layers.length && dwell < 0.45 ? "#f3d98b" : "#000000");

    const impactAge = (dwell - IMPACT) * DWELL_SECONDS;
    shake.set(0, 0, 0);
    if (pressed < layers.length && !moving && impactAge >= 0 && impactAge < 0.32) {
      const a = 0.06 * (1 - impactAge / 0.32) * Math.sin(impactAge * 95);
      shake.set(a * 0.6, a, 0);
    }

    const shardCount = pressed < layers.length ? Math.round(8 + 22 * Math.sqrt(layers[pressed].share)) : 0;
    if (shardCount) shards.material.color.set(layers[pressed].color);
    for (let i = 0; i < FRAGMENTS; i++) {
      let size = 0;
      if (i < shardCount && !moving && impactAge >= 0 && impactAge < 1.4) {
        const angle = rand(i + pressed * 31) * Math.PI * 2;
        const speed = 1.4 + rand(i * 7.3 + 1) * 2.2;
        const lift = 1.2 + rand(i * 3.1 + 2) * 2.6;
        const y0 = BELT_Y + 0.12;
        const land = (lift + Math.sqrt(lift * lift + 2 * 9.8 * (y0 - PLINTH_Y - 0.04))) / 9.8;
        const tt = Math.min(impactAge, land);
        const r = 0.8 + speed * tt;
        pos.set(slotX(1) + Math.cos(angle) * r, y0 + lift * tt - 4.9 * tt * tt, Math.sin(angle) * r);
        size = 1 - smooth(1.0, 1.4, impactAge);
        quat.setFromAxisAngle(scratch.set(1, rand(i) - 0.5, 0.3).normalize(), impactAge * 9 * (0.5 + rand(i + 9)));
      }
      scale.setScalar(Math.max(size, 0.0001));
      shards.setMatrixAt(i, matrix.compose(size ? pos : pos.set(0, -50, 0), quat, scale));
    }
    shards.instanceMatrix.needsUpdate = true;

    const steamAge = (dwell - 0.27) * DWELL_SECONDS;
    steam.forEach((sprite, i) => {
      const age = steamAge - i * 0.06;
      if (!locking || age < 0 || age > 1.1) {
        sprite.material.opacity = 0;
        return;
      }
      const seat = BELT_Y + heights[locked];
      const side = i % 2 ? 1 : -1;
      sprite.position.set(
        slotX(2) + (rand(i * 2.2) - 0.5) * 1.1 + age * 0.25,
        seat + 0.15 + age * (1.1 + rand(i) * 0.6),
        side * (0.55 + age * 0.5) + (rand(i * 4.4) - 0.5) * 0.3,
      );
      sprite.scale.setScalar(0.45 + age * 1.3);
      sprite.material.opacity = 0.7 * Math.sin(Math.PI * clamp(age / 1.1));
    });

    const round = Math.floor(step / PERIOD);
    for (const b of blobs) b.mesh.visible = false;
    for (const set of slabs) for (const s of set) s.mesh.visible = false;
    for (const set of straps) for (const s of set) s.mesh.visible = false;
    tags.items.forEach((el) => (el.style.opacity = "0"));

    let landed = 0;
    let stackX = STACK_X;
    let product = 0;

    for (const r of [round - 1, round, round + 1]) {
      const eject = r * PERIOD + 10;
      const exitX = step === eject ? easeIn(ph) * 12 : 0;
      if (step === eject - 1 || step === eject) {
        product = step === eject ? 1 - smooth(0.0, 0.45, ph) : smooth(0.35, 0.6, ph);
        stackX = STACK_X + exitX;
        straps[r & 1].forEach((strap, i) => {
          const drop = step === eject ? 1 : smooth(0.05 + i * 0.12, 0.3 + i * 0.12, ph);
          strap.mesh.visible = drop > 0;
          strap.mesh.position.set(STACK_X + exitX, TABLE_Y + columnTop * strap.at + (1 - drop) * 1.6, 0);
          strap.mesh.scale.setScalar(lerp(1.3, 1, drop));
        });
      }

      layers.forEach((layer, k) => {
        const n = r * PERIOD + k;
        const s = step - n;
        const blob = blobs[k];
        const radius = blob.radius;
        const peekY = HOPPER_TOP + radius * 0.35;

        if (s === -1 || s === 0 || (s === 1 && (moving || dwell < IMPACT))) {
          let x = slotX(0);
          let y = peekY;
          let sxz = 1;
          let sy = 1;
          let grow = 1;
          let wobble = 1;
          if (s === -1) {
            grow = moving ? 0 : smooth(0.4, 0.75, dwell);
            y = peekY + (1 - grow) * 1.4;
          } else if (s === 0 && !moving) {
            const fall = clamp(dwell / 0.42);
            y = lerp(peekY, BELT_Y + radius, fall * fall);
            const half =
              y > HOPPER_BOTTOM
                ? lerp(HOPPER_HALF.bottom, HOPPER_HALF.top, clamp((y - HOPPER_BOTTOM) / (HOPPER_TOP - HOPPER_BOTTOM)))
                : HOPPER_HALF.bottom + (HOPPER_BOTTOM - y) * 1.6;
            sxz = Math.min(1, (half * 1.08) / radius);
            sy = 1 / Math.pow(sxz, 0.75);
            if (dwell >= 0.42) {
              const q = clamp((dwell - 0.42) / 0.36);
              sy = 1 - 0.28 * Math.sin(q * Math.PI * 2.2) * (1 - q);
              sxz = 1 / Math.sqrt(sy);
              y = BELT_Y + radius * sy;
            }
          } else if (s === 1) {
            x = lerp(slotX(0), slotX(1), move);
            y = BELT_Y + radius;
            if (!moving && platen < BELT_Y + radius * 2) {
              sy = Math.max(0.04, (platen - BELT_Y) / (radius * 2));
              sxz = Math.min(1 / Math.sqrt(sy), (SLAB * 0.62) / radius);
              y = BELT_Y + radius * sy;
              wobble = sy;
            }
          }
          const breathe = 1 + 0.035 * Math.sin(t * 3.2 + k);
          blob.mesh.visible = grow > 0.001;
          blob.mesh.position.set(x, y, 0);
          blob.mesh.scale.set(sxz * radius * breathe * grow, sy * radius * grow, sxz * radius * breathe * grow);
          blob.mesh.rotation.y = t * 0.4 + k;
          blob.wobble(t, wobble);
          if (s === 1) {
            place(tags.items[k], x, y + radius * sy + 0.35, 0, moving ? 0 : smooth(0, 0.12, dwell));
            tags.items[k].classList.remove("is-measured");
          }
          return;
        }

        if (s < 1 || step > eject) return;
        const slab = slabs[r & 1][k];
        const h = heights[k];
        let x = slotX(1);
        let y = BELT_Y + h / 2;
        let heat = 1;
        let edge = 0;
        let tilt = 0;
        let tag = 0;
        if (s === 1) {
          tag = 1;
        } else if (s === 2) {
          x = lerp(slotX(1), slotX(2), move);
          heat = moving ? 1 : 1 - smooth(0.27, 0.85, dwell);
          edge = moving ? 0 : smooth(0.3, 0.6, dwell);
          tag = moving ? 1 : 1 - smooth(0.25, 0.45, dwell);
        } else if (s === 3) {
          heat = 0;
          edge = 1;
          x = lerp(slotX(2), slotX(3), move);
          if (!moving) {
            const u = clamp(dwell / 0.5);
            const e = inOut(u);
            x = lerp(slotX(3), STACK_X, e);
            y = lerp(BELT_Y, TABLE_Y + bases[k], e) + h / 2 + 0.75 * Math.sin(Math.PI * e);
            tilt = -0.35 * Math.sin(Math.PI * e);
            if (u >= 1) landed = Math.max(landed, k + 1);
          }
        } else {
          heat = 0;
          edge = 1;
          x = STACK_X + (step === eject ? exitX : 0);
          y = TABLE_Y + bases[k] + h / 2;
          landed = Math.max(landed, k + 1);
        }
        slab.mesh.visible = true;
        slab.mesh.position.set(x, y, 0);
        slab.mesh.rotation.z = tilt;
        slab.material.color.copy(slab.base).lerp(HOT, heat * 0.85);
        slab.material.emissive.copy(BLACK).lerp(GLOW, heat);
        slab.edgeMaterial.opacity = edge * 0.85;
        if (tag > 0) {
          place(tags.items[k], x, y + h / 2 + 0.35, 0, tag);
          tags.items[k].classList.add("is-measured");
        }
      });
    }

    const total = tokens.slice(0, landed).reduce((a, b) => a + b, 0);
    const shownTotal = product > 0.5 ? startTokens : total;
    tags.totalValue.textContent = `${(shownTotal / 1000).toFixed(1)}k`;
    tags.total.classList.toggle("is-done", product > 0.5);
    const stackTop = landed ? bases[landed - 1] + heights[landed - 1] : 0;
    place(tags.total, stackX, TABLE_Y + stackTop + 0.95, 0, landed ? (product > 0 ? Math.max(product, 0.0) : 1) : 0);

    const stationAnchors: [number, number][] = [
      [slotX(0), 2.6],
      [slotX(1), 2.6],
      [slotX(2), 2.6],
      [STACK_X, 2.6],
    ];
    tags.stations.forEach((el, i) => place(el, stationAnchors[i][0], PLINTH_Y, stationAnchors[i][1], 1));

    camera.position.add(shake);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    camera.position.sub(shake);
  }

  return { fit, frame, start: START, still: STILL, dispose: () => renderer.dispose() };
}
