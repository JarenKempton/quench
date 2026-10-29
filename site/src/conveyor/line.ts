import * as THREE from "three";
import { machines } from "./machines.ts";
import {
  BELT_Y,
  BIN,
  HOPPER_BOTTOM,
  HOPPER_HALF,
  HOPPER_TOP,
  LIFT,
  PLATEN_REST,
  SLAB,
  STACK_X,
  TABLE_Y,
  TANK,
  bin,
  lumpy,
  outline,
  puff,
  slotX,
} from "./parts.ts";

export type Layer = { share: number; color: string; name: string; tokens: string; used: string };

export type Tags = {
  press: { el: HTMLElement; name: HTMLElement; value: HTMLElement };
  quench: { el: HTMLElement; name: HTMLElement; value: HTMLElement };
  stations: HTMLElement[];
  rows: HTMLElement[];
  counter: HTMLElement;
  panel: HTMLElement;
};

const STEP = 2.6;
const MOVE = 0.34;
const PERIOD = 8;
const COLUMN = 1.6;
const IMPACT = 0.3;
const CONTACT = 0.09;
const DWELL_SECONDS = (1 - MOVE) * STEP;
const START = (PERIOD + 4) * STEP + MOVE * STEP + 0.1 * DWELL_SECONDS;
const STILL = (PERIOD + 8) * STEP + 0.9 * STEP;
const PUFF_LIFE = 1.9;
const STEAM_LIFE = PUFF_LIFE + 1.5;
const PUFFS = 40;
const HOT = new THREE.Color("#ffd2a0");
const GLOW = new THREE.Color("#ff5a0a");
const BLACK = new THREE.Color("#000000");
const WATER = new THREE.Color("#0d4f7c");
const WATER_HOT = new THREE.Color("#ff7a2a");

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
  const rim = new THREE.DirectionalLight("#9fdcfa", 0.6);
  rim.position.set(8, 6, -8);
  scene.add(rim);
  const forge = new THREE.PointLight("#ff7a2a", 0, 5, 1.6);
  scene.add(forge);

  const rig = machines(scene);
  const heights = layers.map((l) => Math.max(0.06, l.share * COLUMN));
  const pitches = heights.map((h) => h + BIN.floor);
  const bases = pitches.map((_, i) => pitches.slice(0, i).reduce((a, b) => a + b, 0));
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
    return { mesh, wobble: shape.wobble, radius: 0.46 + 0.6 * Math.sqrt(l.share) };
  });

  const binMaterial = new THREE.MeshStandardMaterial({ color: "#36628a", roughness: 0.55, metalness: 0.2, flatShading: true });
  const slabs = [0, 1].map(() =>
    layers.map((l, k) => {
      const material = new THREE.MeshStandardMaterial({ color: l.color, roughness: 0.42, metalness: 0.12 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(SLAB, heights[k], SLAB), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const edgeMaterial = new THREE.LineBasicMaterial({ color: "#eef8ff", transparent: true, opacity: 0 });
      outline(mesh, edgeMaterial);
      scene.add(mesh);
      const tray = bin(heights[k], binMaterial);
      scene.add(tray);
      return { mesh, material, edgeMaterial, tray, base: new THREE.Color(l.color) };
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
  const plumes = [0, 1].map(() =>
    Array.from({ length: PUFFS }, () => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture, transparent: true, depthWrite: false, opacity: 0 }));
      sprite.renderOrder = 5;
      scene.add(sprite);
      return sprite;
    }),
  );

  const target = new THREE.Vector3(1.2, 1.6, 0);
  const view = { width: 1, height: 1, wide: true };
  const shake = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();

  const bounds: [number, number, number][] = [];
  for (const [x, half, y0, y1, depth] of [
    [slotX(0), 1.2, 0, HOPPER_TOP + 0.9, 1.4],
    [slotX(1), 0.6, 0, BELT_Y + 4.7, 1.5],
    [slotX(2), 1.0, 0, BELT_Y + 3.4, 1.45],
    [STACK_X, 1.1, 0, TABLE_Y + 2.5, 0.95],
  ])
    for (const dx of [-half, half]) for (const z of [-depth, depth]) for (const y of [y0, y1]) bounds.push([x + dx, y, z]);

  function fit() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    view.width = width;
    view.height = height;
    view.wide = width >= 640;
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
    const rect = view.wide ? { x0: 0.03, x1: 0.97, y0: 0.1, y1: 0.98 } : { x0: 0.02, x1: 0.98, y0: 0.26, y1: 0.99 };
    const s = Math.max((maxX - minX) / (width * (rect.x1 - rect.x0)), (maxY - minY) / (height * (rect.y1 - rect.y0)));
    const fw = width * s;
    const fh = height * s;
    const left = (minX + maxX) / 2 - ((rect.x0 + rect.x1) / 2) * fw;
    const top = (minY + maxY) / 2 + ((rect.y0 + rect.y1) / 2) * fh;
    Object.assign(camera, { left, right: left + fw, top, bottom: top - fh });
    camera.updateProjectionMatrix();
  }

  function place(el: HTMLElement, x: number, y: number, z: number, visible: number, align = 0.5) {
    scratch.set(x, y, z).project(camera);
    const sx = Math.min(view.width - el.offsetWidth * (1 - align) - 8, Math.max(el.offsetWidth * align + 8, ((scratch.x + 1) / 2) * view.width));
    const sy = Math.max(el.offsetHeight + 6, ((1 - scratch.y) / 2) * view.height);
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    el.style.opacity = visible.toFixed(3);
  }

  const shown = { press: -1, quench: -1, rows: -1, full: false };
  const label = (tag: Tags["press"], k: number, value: string) => {
    tag.name.textContent = layers[k].name;
    tag.value.textContent = value;
    tag.el.style.setProperty("--tint", layers[k].color);
  };

  function frame(t: number) {
    const step = Math.floor(t / STEP);
    const ph = t / STEP - step;
    const moving = ph < MOVE;
    const move = moving ? inOut(ph / MOVE) : 1;
    const dwell = moving ? 0 : (ph - MOVE) / (1 - MOVE);
    const kindAt = (n: number) => ((n % PERIOD) + PERIOD) % PERIOD;
    const on = { bloat: 0, press: 0, quench: 0, deliver: 0 };

    rig.belt((step + move) * 2.75);

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
    const pressing = !moving && pressed < layers.length && dwell > 0.1 && dwell < 0.6;
    if (pressing) on.press = 1;
    rig.press.light.emissive.set(pressing ? "#ff5a3c" : "#000000");

    const dunked = kindAt(step - 2);
    const dunking = !moving && dunked < layers.length;
    let lift = LIFT.up;
    if (dunking) {
      lift = lerp(LIFT.up, LIFT.down, inOut(smooth(0.04, 0.3, dwell)) - inOut(smooth(0.58, 0.84, dwell)));
      if (dwell > CONTACT && dwell < 0.9) on.quench = 1;
    }
    rig.tank.set(lift);
    rig.tank.light.emissive.set(dunking && dwell > CONTACT && dwell < 0.9 ? "#9fdcfa" : "#000000");

    const hopperBusy = !moving && kindAt(step) < layers.length && dwell < 0.45;
    if (hopperBusy) on.bloat = 1;
    rig.hopperLight.emissive.set(hopperBusy ? "#f3d98b" : "#000000");

    const impactAge = (dwell - IMPACT) * DWELL_SECONDS;
    shake.set(0, 0, 0);
    if (pressed < layers.length && !moving && impactAge >= 0 && impactAge < 0.32) {
      const a = 0.05 * (1 - impactAge / 0.32) * Math.sin(impactAge * 95);
      shake.set(a * 0.6, a, 0);
    }

    const shardCount = pressed < layers.length ? Math.round(8 + 22 * Math.sqrt(layers[pressed].share)) : 0;
    if (shardCount) shards.material.color.set(layers[pressed].color);
    for (let i = 0; i < FRAGMENTS; i++) {
      let size = 0;
      if (i < shardCount && !moving && impactAge >= 0 && impactAge < 1.4) {
        const angle = rand(i + pressed * 31) * Math.PI * 2;
        const speed = 1.4 + rand(i * 7.3 + 1) * 2.0;
        const lift0 = 1.2 + rand(i * 3.1 + 2) * 2.4;
        const y0 = BELT_Y + 0.12;
        const floor = 0.28;
        const land = (lift0 + Math.sqrt(lift0 * lift0 + 2 * 9.8 * (y0 - floor))) / 9.8;
        const tt = Math.min(impactAge, land);
        const r = 0.75 + speed * tt;
        pos.set(slotX(1) + Math.cos(angle) * r, y0 + lift0 * tt - 4.9 * tt * tt, Math.sin(angle) * Math.min(r, 2.1));
        size = 1 - smooth(1.0, 1.4, impactAge);
        quat.setFromAxisAngle(scratch.set(1, rand(i) - 0.5, 0.3).normalize(), impactAge * 9 * (0.5 + rand(i + 9)));
      }
      scale.setScalar(Math.max(size, 0.0001));
      shards.setMatrixAt(i, matrix.compose(size ? pos : pos.set(0, -50, 0), quat, scale));
    }
    shards.instanceMatrix.needsUpdate = true;

    let boil = 0;
    plumes.forEach((plume, p) => {
      const n = step - p;
      const k = kindAt(n - 2);
      const age = t - (n * STEP + MOVE * STEP + CONTACT * DWELL_SECONDS);
      const live = k < layers.length && age >= 0 && age < STEAM_LIFE;
      if (live && age < 1.2) boil = Math.max(boil, 1 - age / 1.2);
      const strength = live ? 0.55 + 0.45 * Math.sqrt(layers[k].share / 0.47) : 0;
      plume.forEach((sprite, i) => {
        const a = age - Math.pow(i / PUFFS, 1.5) * 1.5;
        if (!live || a < 0 || a > PUFF_LIFE) {
          sprite.material.opacity = 0;
          return;
        }
        const u = a / PUFF_LIFE;
        const early = i < PUFFS * 0.35 ? 1.35 : 1;
        sprite.position.set(
          slotX(2) + (rand(i * 2.2 + p) - 0.5) * TANK.half * 1.6 + u * (0.5 + rand(i * 1.3) * 0.5),
          TANK.water + 0.05 + easeOut(u) * (2.2 + rand(i) * 2.0) * strength * early,
          (rand(i * 4.4 + p) - 0.5) * TANK.depth * 1.5 + u * 0.3,
        );
        sprite.scale.setScalar((0.45 + u * 2.1) * (0.7 + rand(i * 3.3) * 0.6) * (0.6 + 0.4 * strength) * early);
        sprite.material.opacity = 0.8 * Math.sin(Math.PI * Math.pow(u, 0.5)) * strength;
      });
    });

    rig.tank.rings.forEach((ring, p) => {
      const n = step - p;
      const age = t - (n * STEP + MOVE * STEP + CONTACT * DWELL_SECONDS);
      const live = kindAt(n - 2) < layers.length && age >= 0 && age < 1.1;
      const u = clamp(age / 1.1);
      ring.ring.scale.setScalar(0.25 + 0.75 * easeOut(u));
      ring.material.opacity = live ? 0.55 * (1 - u) : 0;
    });

    const round = Math.floor(step / PERIOD);
    for (const b of blobs) b.mesh.visible = false;
    for (const set of slabs)
      for (const s of set) {
        s.mesh.visible = false;
        s.tray.visible = false;
      }

    let landed = 0;
    let full = false;
    let glow = 0;
    const glowAt = new THREE.Vector3();
    let pressTag = 0;
    let quenchTag = 0;

    for (const c of rig.carts) c.set(STACK_X, 99, 0);

    for (const r of [round - 1, round, round + 1]) {
      const eject = r * PERIOD + 9;
      const cart = rig.carts[r & 1];
      let cartX = STACK_X;
      let cartZ = 0;
      if (step === eject) {
        cartX = STACK_X + easeIn(smooth(0.1, 0.75, ph)) * 11;
        if (ph > 0.12) on.deliver = 1;
      } else if (step === r * PERIOD + 2) {
        cartZ = (1 - easeOut(smooth(0.05, 0.75, ph))) * 7;
      }
      const cartLive = step > r * PERIOD + 1 && step <= eject && !(step === eject && ph > 0.8);
      if (cartLive) cart.set(cartX, cartZ, cartX - STACK_X - cartZ);
      if (step === eject - 1 && ph > 0.6) full = true;
      if (step === eject && ph < 0.6) full = true;

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
            if (!moving) {
              pressTag = smooth(0, 0.1, dwell);
              if (shown.press !== k) label(tags.press, k, "");
              shown.press = k;
              tags.press.el.classList.remove("is-measured");
            }
          }
          const breathe = 1 + 0.035 * Math.sin(t * 3.2 + k);
          blob.mesh.visible = grow > 0.001;
          blob.mesh.position.set(x, y, 0);
          blob.mesh.scale.set(sxz * radius * breathe * grow, sy * radius * grow, sxz * radius * breathe * grow);
          blob.mesh.rotation.y = t * 0.4 + k;
          blob.wobble(t, wobble);
          return;
        }

        if (s < 1 || step > eject || (step === eject && ph > 0.8)) return;
        const slab = slabs[r & 1][k];
        const h = heights[k];
        let x = slotX(1);
        let y = BELT_Y + h / 2;
        let heat = 1;
        let edge = 0;
        let tilt = 0;
        let tray = false;
        let trayY = 0;
        if (s === 1) {
          pressTag = 1;
          if (shown.press !== k || !tags.press.el.classList.contains("is-measured")) {
            label(tags.press, k, layer.tokens);
            tags.press.el.classList.add("is-measured");
          }
          shown.press = k;
        } else if (s === 2) {
          x = lerp(slotX(1), slotX(2), move);
          if (!moving) {
            tray = dwell > 0.3;
            trayY = lift;
            y = lift + (tray ? BIN.floor : 0) + h / 2;
            heat = 1 - smooth(CONTACT, 0.5, dwell);
            edge = smooth(0.35, 0.7, dwell);
            quenchTag = smooth(0.5, 0.62, dwell);
            if (quenchTag > 0 && shown.quench !== k) {
              label(tags.quench, k, layer.used);
              shown.quench = k;
            }
          }
        } else if (s === 3) {
          heat = 0;
          edge = 1;
          tray = true;
          x = lerp(slotX(2), slotX(3), move);
          trayY = BELT_Y;
          if (moving) {
            quenchTag = 1 - smooth(0.4, 1, ph / MOVE);
          } else {
            const u = clamp(dwell / 0.5);
            const e = inOut(u);
            x = lerp(slotX(3), STACK_X, e);
            trayY = lerp(BELT_Y, TABLE_Y + bases[k], e) + 0.7 * Math.sin(Math.PI * e);
            tilt = -0.3 * Math.sin(Math.PI * e);
            if (u > 0.2 && u < 1) on.deliver = 1;
            if (u >= 1) landed = Math.max(landed, k + 1);
          }
          y = trayY + BIN.floor + h / 2;
        } else {
          heat = 0;
          edge = 1;
          tray = true;
          x = cartX;
          trayY = TABLE_Y + bases[k];
          y = trayY + BIN.floor + h / 2;
          landed = Math.max(landed, k + 1);
        }
        slab.mesh.visible = true;
        slab.mesh.position.set(x, y, 0);
        slab.mesh.rotation.z = tilt;
        slab.material.color.copy(slab.base).lerp(HOT, heat * 0.85);
        slab.material.emissive.copy(BLACK).lerp(GLOW, heat);
        slab.material.emissiveIntensity = 1.3;
        slab.edgeMaterial.opacity = edge * 0.85;
        if (heat > glow) {
          glow = heat;
          glowAt.set(x, y + 0.6, 0.9);
        }
        slab.tray.visible = tray;
        if (tray) {
          slab.tray.position.set(x, trayY, 0);
          slab.tray.rotation.z = tilt;
        }
      });
    }

    forge.intensity = glow * 14;
    forge.position.copy(glowAt);
    rig.tank.water.emissive.copy(WATER).lerp(WATER_HOT, boil * 0.7);
    rig.tank.water.emissiveIntensity = 0.6 + boil * 0.9;
    rig.tank.surface.opacity = 0.18 + boil * 0.5;

    place(tags.press.el, slotX(1) + 0.3, BELT_Y + 4.3, 0, pressTag, 1);
    place(tags.quench.el, slotX(2) + 0.5, BELT_Y + 2.85, 0, quenchTag, 0);

    const total = tokens.slice(0, landed).reduce((a, b) => a + b, 0);
    const value = full ? startTokens : total;
    tags.counter.textContent = `${(value / 1000).toFixed(1)}k`;
    if (shown.rows !== landed || shown.full !== full) {
      tags.rows.forEach((row, k) => row.classList.toggle("is-in", full || k < landed));
      tags.panel.classList.toggle("is-full", full);
      shown.rows = landed;
      shown.full = full;
    }
    const lit = [on.bloat, on.press, on.quench, on.deliver];
    tags.stations.forEach((el, i) => el.classList.toggle("is-on", lit[i] > 0));

    camera.position.add(shake);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    camera.position.sub(shake);
  }

  return { fit, frame, start: START, still: STILL, dispose: () => renderer.dispose() };
}
