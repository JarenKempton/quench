import * as THREE from "three";
import {
  BELT,
  BELT_Y,
  HOPPER_BOTTOM,
  HOPPER_HALF,
  HOPPER_TOP,
  PLINTH_Y,
  SLAB,
  TABLE_Y,
  TANK,
  block,
  floorGrid,
  hazard,
  mats,
  outline,
  slotX,
  squareTube,
} from "./parts.ts";

const SLAT_GAP = 0.31;
const ROLLER_R = 0.21;
const WHEEL_R = 0.2;

function lamp(parent: THREE.Object3D, at: [number, number, number]) {
  const material = new THREE.MeshStandardMaterial({ color: "#20405c", emissive: "#000000", roughness: 0.3 });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 16), material);
  mesh.position.set(...at);
  parent.add(mesh);
  return material;
}

function plinth(scene: THREE.Scene) {
  scene.add(floorGrid());
  const base = block(scene, [14.6, PLINTH_Y, 4.6], [1.1, PLINTH_Y / 2, 0], mats.plinth);
  base.castShadow = false;
  for (let x = -6; x <= 8.2; x += 0.5) {
    const major = Math.abs((x * 2) % 4) < 0.01;
    block(scene, [0.02, 0.01, major ? 0.3 : 0.14], [x, PLINTH_Y + 0.006, 2.3 - (major ? 0.15 : 0.07)], mats.trim, null).castShadow = false;
  }
}

function belt(scene: THREE.Scene, from: number, to: number) {
  const length = to - from;
  const mid = (from + to) / 2;
  block(scene, [length, 0.1, 1.74], [mid, BELT_Y - 0.05, 0], mats.belt, mats.faint);
  for (const z of [-1, 1]) block(scene, [length + 0.3, 0.32, 0.1], [mid, BELT_Y - 0.12, z * 0.92], mats.trim);
  for (const x of [from + 0.3, to - 0.3])
    for (const z of [-0.8, 0.8]) block(scene, [0.15, BELT_Y - 0.3 - PLINTH_Y, 0.15], [x, (BELT_Y - 0.3 + PLINTH_Y) / 2, z], mats.dark);

  const count = Math.ceil(length / SLAT_GAP);
  const slats = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.045, 0.012, 1.62),
    new THREE.MeshBasicMaterial({ color: "#5aa9d2", transparent: true, opacity: 0.55 }),
    count,
  );
  slats.position.y = BELT_Y + 0.004;
  scene.add(slats);

  const rollers = [from, to].map((x) => {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, 1.9, 12), mats.steel);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, BELT_Y - ROLLER_R + 0.02, 0);
    outline(roller, mats.edge, 20);
    scene.add(roller);
    return roller;
  });

  const matrix = new THREE.Matrix4();
  return (travel: number) => {
    for (let i = 0; i < count; i++) {
      const x = from + ((((i * SLAT_GAP + travel) % length) + length) % length);
      slats.setMatrixAt(i, matrix.makeTranslation(x, 0, 0));
    }
    slats.instanceMatrix.needsUpdate = true;
    for (const r of rollers) r.rotation.y = -travel / ROLLER_R;
  };
}

function hopper(scene: THREE.Scene) {
  const x = slotX(0);
  const funnel = squareTube(HOPPER_HALF.top, HOPPER_HALF.bottom, HOPPER_TOP - HOPPER_BOTTOM, mats.steel);
  funnel.material = mats.steel.clone();
  (funnel.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  funnel.position.set(x, (HOPPER_TOP + HOPPER_BOTTOM) / 2, 0);
  scene.add(funnel);
  const lip = squareTube(HOPPER_HALF.top + 0.06, HOPPER_HALF.top + 0.06, 0.14, mats.trim);
  lip.position.set(x, HOPPER_TOP + 0.07, 0);
  scene.add(lip);
  for (const z of [-1, 1]) {
    block(scene, [0.16, HOPPER_TOP - PLINTH_Y, 0.16], [x, (HOPPER_TOP + PLINTH_Y) / 2, z * 1.32], mats.dark);
    block(scene, [0.1, 0.1, 0.26], [x, HOPPER_TOP - 0.3, z * 1.16], mats.trim);
  }
  return lamp(scene, [x, HOPPER_TOP + 0.25, -1.32]);
}

function press(scene: THREE.Scene) {
  const x = slotX(1);
  const crownY = BELT_Y + 3.9;
  const back = -1.3;
  block(scene, [0.62, crownY + 0.5 - PLINTH_Y, 0.5], [x, (crownY + 0.5 + PLINTH_Y) / 2, back]);
  block(scene, [0.9, 0.6, 1.75], [x, crownY + 0.2, back / 2 + 0.25]);
  block(scene, [0.56, 0.26, 0.56], [x, crownY + 0.63, 0], mats.trim);
  block(scene, [1.75, 0.16, 2.0], [x, BELT_Y - 0.26, 0], mats.dark);
  for (const z of [back + 0.25, 0.75]) block(scene, [0.14, 0.14, 0.14], [x + 0.4, crownY - 0.05, z], mats.trim, null);

  const ram = block(scene, [0.3, 1, 0.3], [x, 0, 0], mats.trim);
  const side = new THREE.MeshStandardMaterial({ map: hazard(), roughness: 0.6, metalness: 0.1 });
  const platen = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.4, 1.62), [side, side, mats.steel, mats.steel, side, side]);
  platen.castShadow = true;
  outline(platen);
  scene.add(platen);

  const light = lamp(scene, [x + 0.3, crownY + 0.55, 0.75]);
  return {
    light,
    set(bottom: number) {
      platen.position.set(x, bottom + 0.2, 0);
      const top = bottom + 0.4;
      ram.scale.y = crownY - 0.13 - top;
      ram.position.y = (crownY - 0.13 + top) / 2;
    },
  };
}

function tank(scene: THREE.Scene) {
  const x = slotX(2);
  const h = TANK.water + 0.12 - PLINTH_Y;
  const midY = PLINTH_Y + h / 2;
  const wall = 0.08;
  block(scene, [TANK.half * 2 + wall * 2, wall, TANK.depth * 2 + wall * 2], [x, PLINTH_Y + wall / 2, 0], mats.dark);
  block(scene, [TANK.half * 2 + wall * 2, h, wall], [x, midY, -TANK.depth - wall / 2], mats.steel);
  for (const side of [-1, 1]) block(scene, [wall, h, TANK.depth * 2 + wall * 2], [x + side * (TANK.half + wall / 2), midY, 0], mats.steel);
  const glass = new THREE.MeshStandardMaterial({ color: "#9fdcfa", transparent: true, opacity: 0.12, roughness: 0.1, depthWrite: false });
  block(scene, [TANK.half * 2 + wall * 2, h, 0.03], [x, midY, TANK.depth + 0.015], glass, mats.edge).castShadow = false;
  block(scene, [TANK.half * 2 + wall * 2, 0.08, 0.1], [x, PLINTH_Y + h - 0.04, TANK.depth + 0.05], mats.trim);

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: "#2f8fc6",
    emissive: "#0d4f7c",
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.5,
    roughness: 0.15,
    metalness: 0.1,
    depthWrite: false,
  });
  const waterH = TANK.water - TANK.floor;
  const water = new THREE.Mesh(new THREE.BoxGeometry(TANK.half * 2, waterH, TANK.depth * 2), waterMaterial);
  water.position.set(x, TANK.floor + waterH / 2, 0);
  water.renderOrder = 2;
  scene.add(water);

  const surfaceMaterial = new THREE.MeshBasicMaterial({ color: "#bfe9ff", transparent: true, opacity: 0.18, depthWrite: false });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(TANK.half * 2, TANK.depth * 2), surfaceMaterial);
  surface.rotation.x = -Math.PI / 2;
  surface.position.set(x, TANK.water + 0.002, 0);
  surface.renderOrder = 3;
  scene.add(surface);

  const rings = [0, 1].map(() => {
    const material = new THREE.MeshBasicMaterial({ color: "#eef8ff", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 4, 1, Math.PI / 4), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, TANK.water + 0.01, 0);
    ring.renderOrder = 4;
    scene.add(ring);
    return { ring, material };
  });

  const beamY = BELT_Y + 2.45;
  const back = -(TANK.depth + 0.26);
  block(scene, [0.5, beamY + 0.32 - PLINTH_Y, 0.36], [x, (beamY + 0.32 + PLINTH_Y) / 2, back], mats.dark);
  block(scene, [0.7, 0.32, -back + 0.2], [x, beamY + 0.16, back / 2 + 0.1]);
  block(scene, [0.46, 0.22, 0.46], [x, beamY + 0.43, 0], mats.trim);

  const grate = new THREE.Group();
  block(grate, [SLAB + 0.1, 0.05, SLAB + 0.1], [0, -0.025, 0], mats.trim);
  for (let i = -2; i <= 2; i++) block(grate, [0.03, 0.02, SLAB + 0.1], [i * 0.3, 0.01, 0], mats.dark, null);
  const rods = [-0.4, 0.4].map((dx) => block(grate, [0.07, 1, 0.07], [dx, 0.5, -(SLAB / 2 + 0.12)], mats.dark, null));
  scene.add(grate);

  const light = lamp(scene, [x + 0.24, beamY + 0.38, -0.5]);
  return {
    light,
    water: waterMaterial,
    surface: surfaceMaterial,
    rings,
    set(top: number) {
      grate.position.set(x, top, 0);
      for (const rod of rods) {
        rod.scale.y = beamY - top;
        rod.position.y = (beamY - top) / 2;
      }
    },
  };
}

function cart(scene: THREE.Scene) {
  const group = new THREE.Group();
  const deck = 0.1;
  block(group, [2.0, deck, 1.8], [0, TABLE_Y - deck / 2, 0], mats.trim);
  block(group, [2.0, 0.12, 1.6], [0, TABLE_Y - deck - 0.06, 0], mats.dark, null);
  const wheels: THREE.Mesh[] = [];
  for (const dx of [-0.72, 0.72])
    for (const z of [-0.7, 0.7]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.12, 14), mats.dark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(dx, PLINTH_Y + WHEEL_R, z);
      wheel.castShadow = true;
      outline(wheel, mats.edge, 20);
      group.add(wheel);
      wheels.push(wheel);
      block(group, [0.08, TABLE_Y - deck - PLINTH_Y - WHEEL_R - 0.1, 0.08], [dx, (TABLE_Y - deck + PLINTH_Y + WHEEL_R) / 2, z], mats.dark, null);
    }
  const handleTop = TABLE_Y + 2.35;
  for (const z of [-0.78, 0.78]) block(group, [0.07, handleTop - TABLE_Y, 0.07], [1.0, (handleTop + TABLE_Y) / 2, z], mats.trim, null);
  block(group, [0.07, 0.07, 1.63], [1.0, handleTop, 0], mats.trim, null);
  scene.add(group);
  return {
    group,
    set(x: number, z: number, rolled: number) {
      group.position.set(x, 0, z);
      group.visible = Math.abs(z) < 30;
      for (const w of wheels) w.rotation.y = -rolled / WHEEL_R;
    },
  };
}

export function machines(scene: THREE.Scene) {
  plinth(scene);
  const inBelt = belt(scene, BELT.from, slotX(2) - TANK.half - 0.12);
  const outBelt = belt(scene, slotX(2) + TANK.half + 0.12, BELT.to);
  const carts = [cart(scene), cart(scene)];
  return {
    belt: (travel: number) => {
      inBelt(travel);
      outBelt(travel);
    },
    hopperLight: hopper(scene),
    press: press(scene),
    tank: tank(scene),
    carts,
  };
}
