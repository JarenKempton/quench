import * as THREE from "three";
import { machines } from "./machines.ts";
import {
  BELT_Y,
  HOPPER_BOTTOM,
  HOPPER_HALF,
  HOPPER_TOP,
  LIFT,
  PLATEN_REST,
  SLAB,
  SLOT,
  STACK_X,
  TABLE_Y,
  TANK,
  lump,
  outline,
  slotX,
  steamTexture,
} from "./parts.ts";

export type Layer = { share: number; name: string; tokens: string; used: string };

export type Tags = {
  press: { el: HTMLElement; name: HTMLElement; value: HTMLElement };
  quench: { el: HTMLElement; name: HTMLElement; value: HTMLElement };
  counter: HTMLElement;
};

const STEP = 2.1;
const MOVE = 0.3;
const COLUMN = 1.6;
const DWELL = (1 - MOVE) * STEP;
const PRESS = { lift: 0.1, top: 0.24, contact: 0.36, hold: 0.62 };
const DUNK = { down: [0.04, 0.3], up: [0.62, 0.88] } as const;
const LAND = 0.5;
const PUFFS = 96;
const STEAM = { burst: 1.6, life: 3.2 };
const COOL = new THREE.Color("#9fdcfa");
const HOT = new THREE.Color("#ffd2a0");
const GLOW = new THREE.Color("#ff5a0a");
const BLACK = new THREE.Color("#000000");

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeIn = (x: number) => x * x * x;
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const rand = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const lift = (d: number) =>
  lerp(LIFT.up, LIFT.down, inOut(smooth(DUNK.down[0], DUNK.down[1], d)) - inOut(smooth(DUNK.up[0], DUNK.up[1], d)));

const CONTACT = (() => {
  let d = 0;
  while (lift(d) > TANK.water && d < 0.5) d += 0.002;
  return d;
})();

const quenchAt = (k: number) => (k + 2 + MOVE) * STEP + CONTACT * DWELL;

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
  sun.target.position.set(1.2, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 8, bottom: -8, near: 1, far: 40 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const forge = new THREE.PointLight("#ff7a2a", 0, 4, 1.8);
  scene.add(forge);

  const rig = machines(scene);
  const last = layers.length - 1;
  const heights = layers.map((l) => Math.max(0.06, l.share * COLUMN));
  const bases = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
  const tokens = layers.map((l) => l.share * startTokens);
  const biggest = Math.max(...layers.map((l) => l.share));

  const lumpMaterial = new THREE.MeshStandardMaterial({ color: "#7aa3c4", roughness: 0.6, metalness: 0.05, flatShading: true });
  const lumps = layers.map((l, k) => {
    const mesh = new THREE.Mesh(lump(k * 1.7 + 0.4), lumpMaterial);
    mesh.castShadow = true;
    mesh.rotation.y = k * 1.3;
    scene.add(mesh);
    return { mesh, radius: 0.46 + 0.6 * Math.sqrt(l.share) };
  });

  const seam = new THREE.LineBasicMaterial({ color: "#0c3253", transparent: true, opacity: 0.55 });
  const slabs = layers.map((_, k) => {
    const material = new THREE.MeshStandardMaterial({ color: COOL, roughness: 0.42, metalness: 0.12, emissiveIntensity: 1.3 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(SLAB, heights[k], SLAB), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    outline(mesh, seam);
    scene.add(mesh);
    return { mesh, material };
  });

  const textures = [1, 2, 3, 4].map(steamTexture);
  const plumes = [0, 1].map(() =>
    Array.from({ length: PUFFS }, (_, i) => {
      const material = new THREE.SpriteMaterial({ map: textures[i % textures.length], transparent: true, depthWrite: false, opacity: 0 });
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 5;
      scene.add(sprite);
      return sprite;
    }),
  );

  const target = new THREE.Vector3(1.2, 1.6, 0);
  const view = { width: 1, height: 1, wide: true };
  const scratch = new THREE.Vector3();

  const bounds: [number, number, number][] = [];
  for (const [x, half, y0, y1, depth] of [
    [slotX(0), 1.2, 0, HOPPER_TOP + 0.2, 1.4],
    [slotX(1), 0.6, 0, BELT_Y + 4.4, 1.5],
    [slotX(2), 1.0, 0, BELT_Y + 4.6, 1.45],
    [STACK_X, 1.1, 0, TABLE_Y + 2.2, 0.95],
  ])
    for (const dx of [-half, half]) for (const z of [-depth, depth]) for (const y of [y0, y1]) bounds.push([x + dx, y, z]);

  function fit() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    view.width = width;
    view.height = height;
    view.wide = width >= 720;
    renderer.setSize(width, height, false);
    const azimuth = THREE.MathUtils.degToRad(view.wide ? -27 : -32);
    const elevation = THREE.MathUtils.degToRad(view.wide ? 27 : 30);
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
    const rect = view.wide ? { x0: 0.02, x1: 0.76, y0: 0.04, y1: 0.84 } : { x0: 0.02, x1: 0.98, y0: 0.37, y1: 0.86 };
    const s = Math.max((maxX - minX) / (width * (rect.x1 - rect.x0)), (maxY - minY) / (height * (rect.y1 - rect.y0)));
    const fw = width * s;
    const fh = height * s;
    const left = (minX + maxX) / 2 - ((rect.x0 + rect.x1) / 2) * fw;
    const top = (minY + maxY) / 2 + ((rect.y0 + rect.y1) / 2) * fh;
    Object.assign(camera, { left, right: left + fw, top, bottom: top - fh });
    camera.updateProjectionMatrix();
  }

  function place(el: HTMLElement, x: number, y: number, z: number, visible: number, align: number) {
    scratch.set(x, y, z).project(camera);
    const w = el.offsetWidth;
    const sx = Math.min(view.width - w - 8, Math.max(8, ((scratch.x + 1) / 2) * view.width - w * align));
    const sy = ((1 - scratch.y) / 2) * view.height;
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    el.style.opacity = visible.toFixed(3);
  }

  const shown = { counter: "" };
  const label = (tag: Tags["press"], name: string, value: string) => {
    const key = `${name}|${value}`;
    if (tag.el.dataset.key === key) return;
    tag.el.dataset.key = key;
    tag.name.textContent = name;
    tag.value.textContent = value;
  };

  function steam(t: number) {
    let froth = 0;
    plumes.forEach((plume, p) => {
      let k = -1;
      for (let j = p; j <= last; j += 2) if (t >= quenchAt(j)) k = j;
      const age = k < 0 ? -1 : t - quenchAt(k);
      if (age >= 0 && age < 0.9) froth = Math.max(froth, 1 - age / 0.9);
      const strength = k < 0 ? 0 : 0.6 + 0.4 * Math.sqrt(layers[k].share / biggest);
      plume.forEach((sprite, i) => {
        const born = STEAM.burst * Math.pow(i / PUFFS, 1.8);
        const life = STEAM.life * (0.75 + rand(i * 1.9) * 0.25);
        const a = age - born;
        if (k < 0 || a < 0 || a > life) {
          sprite.visible = false;
          return;
        }
        sprite.visible = true;
        const phase = rand(i * 5.1) * Math.PI * 2;
        const vigor = (1 - 0.5 * (born / STEAM.burst)) * strength;
        const hug = i < PUFFS * 0.3;
        const x0 = (rand(i * 3.7 + p) - 0.5) * TANK.half * 2 * (hug ? 1.1 : 0.75);
        const z0 = (rand(i * 4.4 + p) - 0.5) * TANK.depth * 2 * (hug ? 1.1 : 0.75);
        const rise = (hug ? 0.7 : 2.8) * vigor * (1 - Math.exp(-a / 0.8)) + (hug ? 0.35 : 0.25) * a;
        const spread = 0.75 + (hug ? 0.5 : 0.16) * rise + (hug ? 0.25 * a : 0);
        const sway = Math.sin(a * 1.4 + phase) * 0.12 * rise;
        sprite.position.set(
          slotX(2) + x0 * spread + 0.14 * rise * rise + sway,
          TANK.water + 0.08 + rise,
          z0 * spread - 0.1 * rise * rise + Math.cos(a * 1.1 + phase) * 0.08 * rise,
        );
        sprite.scale.setScalar((hug ? 0.8 + 0.9 * a : 0.65 + 0.7 * rise) * (0.85 + rand(i * 3.3) * 0.3));
        sprite.material.opacity = (hug ? 0.5 : 0.46) * smooth(0, 0.15, a) * Math.pow(1 - a / life, 1.4) * vigor;
        sprite.material.rotation = phase + a * 0.25 * (rand(i * 7.7) > 0.5 ? 1 : -1);
      });
    });
    rig.tank.surface.opacity = 0.16 + 0.22 * froth;
  }

  function frame(t: number) {
    const step = Math.floor(t / STEP);
    const ph = t / STEP - step;
    const moving = ph < MOVE;
    const move = moving ? inOut(ph / MOVE) : 1;
    const dwell = moving ? 0 : (ph - MOVE) / (1 - MOVE);

    rig.belt(Math.min(step + move, last + 4) * SLOT);

    const pressed = step - 1;
    const pressing = pressed >= 0 && pressed <= last && !moving;
    let platen = PLATEN_REST;
    if (pressing) {
      const flat = BELT_Y + heights[pressed];
      const raised = PLATEN_REST + 0.3;
      if (dwell < PRESS.lift) platen = PLATEN_REST;
      else if (dwell < PRESS.top) platen = lerp(PLATEN_REST, raised, easeOut((dwell - PRESS.lift) / (PRESS.top - PRESS.lift)));
      else if (dwell < PRESS.contact) platen = lerp(raised, flat, easeIn((dwell - PRESS.top) / (PRESS.contact - PRESS.top)));
      else if (dwell < PRESS.hold) platen = flat;
      else platen = lerp(flat, PLATEN_REST, inOut((dwell - PRESS.hold) / (1 - PRESS.hold)));
    }
    rig.press.set(platen);

    const dunked = step - 2;
    const dunking = dunked >= 0 && dunked <= last && !moving;
    const level = dunking ? lift(dwell) : LIFT.up;
    rig.tank.set(level);

    steam(t);

    let landed = 0;
    let glow = 0;
    let pressTag = 0;
    let quenchTag = 0;

    layers.forEach((layer, k) => {
      const s = step - k;
      const { mesh, radius } = lumps[k];
      const slab = slabs[k];
      mesh.visible = false;
      slab.mesh.visible = false;
      const peekY = HOPPER_TOP + radius * 0.3;

      if (s === -1 || s === 0 || (s === 1 && (moving || dwell < PRESS.contact))) {
        let x = slotX(0);
        let y = peekY;
        let sxz = 1;
        let sy = 1;
        if (s === -1) {
          if (moving || dwell < 0.25) return;
          const fall = clamp((dwell - 0.25) / 0.3);
          y = lerp(peekY + 4, peekY, fall * fall);
          const q = clamp((dwell - 0.55) / 0.3);
          if (q > 0) {
            sy = 1 - 0.16 * Math.sin(q * Math.PI * 2) * (1 - q);
            sxz = 1 / Math.sqrt(sy);
          }
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
            sy = 1 - 0.26 * Math.sin(q * Math.PI * 2) * (1 - q);
            sxz = 1 / Math.sqrt(sy);
            y = BELT_Y + radius * sy;
          }
        } else if (s === 1) {
          x = lerp(slotX(0), slotX(1), move);
          y = BELT_Y + radius;
          if (!moving) {
            pressTag = smooth(0, 0.08, dwell);
            label(tags.press, layer.name, "");
            if (platen < BELT_Y + radius * 2) {
              sy = Math.max(0.04, (platen - BELT_Y) / (radius * 2));
              sxz = Math.min(1 / Math.sqrt(sy), (SLAB * 0.62) / radius);
              y = BELT_Y + radius * sy;
            }
          }
        }
        mesh.visible = true;
        mesh.position.set(x, y, 0);
        mesh.scale.set(sxz * radius, sy * radius, sxz * radius);
        return;
      }

      if (s < 1) return;
      const h = heights[k];
      let x = slotX(1);
      let base = BELT_Y;
      let heat = 1;
      let tilt = 0;
      let spread = 1;
      if (s === 1) {
        pressTag = 1 - smooth(0.9, 1, dwell);
        label(tags.press, layer.name, layer.tokens);
        const settle = clamp((dwell - PRESS.contact) / 0.2);
        spread = 1 + 0.06 * Math.sin(settle * Math.PI) * (1 - settle);
      } else if (s === 2) {
        x = lerp(slotX(1), slotX(2), move);
        if (!moving) {
          base = level;
          heat = 1 - smooth(CONTACT, 0.55, dwell);
          if (layer.used) {
            quenchTag = smooth(0.4, 0.5, dwell) * (1 - smooth(0.92, 1, dwell));
            label(tags.quench, layer.name, layer.used);
          }
        }
      } else if (s === 3) {
        heat = 0;
        x = lerp(slotX(2), slotX(3), move);
        if (!moving) {
          const u = clamp(dwell / LAND);
          const e = inOut(u);
          x = lerp(slotX(3), STACK_X, e);
          base = lerp(BELT_Y, TABLE_Y + bases[k], e) + 0.55 * Math.sin(Math.PI * e);
          tilt = -0.22 * Math.sin(Math.PI * e);
          if (u >= 1) landed = k + 1;
        }
      } else {
        heat = 0;
        x = STACK_X;
        base = TABLE_Y + bases[k];
        landed = Math.max(landed, k + 1);
      }
      slab.mesh.visible = true;
      slab.mesh.position.set(x, base + h / 2, 0);
      slab.mesh.rotation.z = tilt;
      slab.mesh.scale.set(spread, 1, spread);
      slab.material.color.copy(COOL).lerp(HOT, heat * 0.9);
      slab.material.emissive.copy(BLACK).lerp(GLOW, heat);
      if (heat > glow) {
        glow = heat;
        forge.position.set(x, base + h + 0.5, 0.8);
      }
    });

    forge.intensity = glow * 9;

    place(tags.press.el, slotX(1) + 0.3, 0, 2.3, pressTag, 1);
    place(tags.quench.el, slotX(2) - 0.3, 0, 2.3, quenchTag, 0);

    const total = tokens.slice(0, landed).reduce((a, b) => a + b, 0);
    const count = `${((landed > last ? startTokens : total) / 1000).toFixed(1)}k`;
    if (shown.counter !== count) {
      tags.counter.textContent = count;
      tags.counter.classList.toggle("is-done", landed > last);
      shown.counter = count;
    }

    renderer.render(scene, camera);
  }

  return { fit, frame, start: -STEP, end: Math.max((last + 4) * STEP, quenchAt(last) + STEAM.burst + STEAM.life), dispose: () => renderer.dispose() };
}
