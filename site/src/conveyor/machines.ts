import * as THREE from "three";
import {
  BELT,
  BELT_Y,
  HOPPER_BOTTOM,
  HOPPER_HALF,
  HOPPER_TOP,
  PLINTH_Y,
  SLAB,
  STACK_X,
  TABLE_Y,
  TANK,
  block,
  mats,
  outline,
  slotX,
  squareTube,
} from "./parts.ts";

const SLAT_GAP = 0.31;
const ROLLER_R = 0.21;
const WHEEL_R = 0.2;

function plinth(scene: THREE.Scene) {
  block(scene, [14.6, PLINTH_Y, 4.6], [1.1, PLINTH_Y / 2, 0], mats.plinth).castShadow = false;
}

function belt(scene: THREE.Scene, from: number, to: number) {
  const length = to - from;
  const mid = (from + to) / 2;
  block(scene, [length, 0.1, 1.74], [mid, BELT_Y - 0.05, 0], mats.belt, null);
  for (const z of [-1, 1]) block(scene, [length + 0.3, 0.32, 0.1], [mid, BELT_Y - 0.12, z * 0.92], mats.trim);
  for (const x of [from + 0.3, to - 0.3])
    for (const z of [-0.8, 0.8]) block(scene, [0.15, BELT_Y - 0.3 - PLINTH_Y, 0.15], [x, (BELT_Y - 0.3 + PLINTH_Y) / 2, z], mats.dark);

  const count = Math.ceil(length / SLAT_GAP);
  const slats = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.045, 0.012, 1.62),
    new THREE.MeshBasicMaterial({ color: "#2b5f8b" }),
    count,
  );
  slats.position.y = BELT_Y + 0.004;
  scene.add(slats);

  const rollers = [from, to].map((x) => {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, 1.9, 12), mats.steel);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, BELT_Y - ROLLER_R + 0.02, 0);
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
  const material = mats.steel.clone();
  material.side = THREE.DoubleSide;
  const funnel = squareTube(HOPPER_HALF.top, HOPPER_HALF.bottom, HOPPER_TOP - HOPPER_BOTTOM, material);
  funnel.position.set(x, (HOPPER_TOP + HOPPER_BOTTOM) / 2, 0);
  scene.add(funnel);
  for (const z of [-1, 1]) block(scene, [0.16, HOPPER_TOP - PLINTH_Y, 0.16], [x, (HOPPER_TOP + PLINTH_Y) / 2, z * 1.32], mats.dark);
  block(scene, [0.12, 0.12, 2.64], [x, HOPPER_TOP - 0.3, 0], mats.dark);
}

function press(scene: THREE.Scene) {
  const x = slotX(1);
  const crownY = BELT_Y + 3.9;
  const back = -1.3;
  block(scene, [0.62, crownY + 0.5 - PLINTH_Y, 0.5], [x, (crownY + 0.5 + PLINTH_Y) / 2, back]);
  block(scene, [0.9, 0.6, 1.75], [x, crownY + 0.2, back / 2 + 0.25]);
  block(scene, [1.75, 0.16, 2.0], [x, BELT_Y - 0.26, 0], mats.dark);

  const ram = block(scene, [0.3, 1, 0.3], [x, 0, 0], mats.trim);
  const platen = block(scene, [1.62, 0.4, 1.62], [x, 0, 0], mats.trim);
  return {
    set(bottom: number) {
      platen.position.set(x, bottom + 0.2, 0);
      const top = bottom + 0.4;
      ram.scale.y = crownY - 0.1 - top;
      ram.position.y = (crownY - 0.1 + top) / 2;
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
  const glass = new THREE.MeshStandardMaterial({ color: "#9fdcfa", transparent: true, opacity: 0.1, roughness: 0.1, depthWrite: false });
  block(scene, [TANK.half * 2 + wall * 2, h, 0.03], [x, midY, TANK.depth + 0.015], glass).castShadow = false;

  const water = new THREE.MeshStandardMaterial({
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
  const body = new THREE.Mesh(new THREE.BoxGeometry(TANK.half * 2, waterH, TANK.depth * 2), water);
  body.position.set(x, TANK.floor + waterH / 2, 0);
  body.renderOrder = 2;
  scene.add(body);

  const surface = new THREE.MeshBasicMaterial({ color: "#bfe9ff", transparent: true, opacity: 0.16, depthWrite: false });
  const top = new THREE.Mesh(new THREE.PlaneGeometry(TANK.half * 2, TANK.depth * 2), surface);
  top.rotation.x = -Math.PI / 2;
  top.position.set(x, TANK.water + 0.002, 0);
  top.renderOrder = 3;
  scene.add(top);

  const beamY = BELT_Y + 2.45;
  const back = -(TANK.depth + 0.26);
  block(scene, [0.5, beamY + 0.32 - PLINTH_Y, 0.36], [x, (beamY + 0.32 + PLINTH_Y) / 2, back], mats.dark);
  block(scene, [0.7, 0.32, -back + 0.2], [x, beamY + 0.16, back / 2 + 0.1]);

  const grate = new THREE.Group();
  block(grate, [SLAB + 0.1, 0.05, SLAB + 0.1], [0, -0.025, 0], mats.trim);
  const rods = [-0.4, 0.4].map((dx) => block(grate, [0.07, 1, 0.07], [dx, 0.5, -(SLAB / 2 + 0.12)], mats.dark, null));
  scene.add(grate);

  return {
    surface,
    set(level: number) {
      grate.position.set(x, level, 0);
      for (const rod of rods) {
        rod.scale.y = beamY - level;
        rod.position.y = (beamY - level) / 2;
      }
    },
  };
}

function cart(scene: THREE.Scene) {
  const group = new THREE.Group();
  const deck = 0.1;
  block(group, [2.0, deck, 1.8], [0, TABLE_Y - deck / 2, 0], mats.trim);
  for (const dx of [-0.72, 0.72])
    for (const z of [-0.7, 0.7]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.12, 14), mats.dark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(dx, PLINTH_Y + WHEEL_R, z);
      wheel.castShadow = true;
      outline(wheel, mats.edge, 40);
      group.add(wheel);
      block(group, [0.08, TABLE_Y - deck - PLINTH_Y - WHEEL_R, 0.08], [dx, (TABLE_Y - deck + PLINTH_Y + WHEEL_R) / 2, z], mats.dark, null);
    }
  const handleTop = TABLE_Y + 2.1;
  for (const z of [-0.78, 0.78]) block(group, [0.07, handleTop - TABLE_Y, 0.07], [1.0, (handleTop + TABLE_Y) / 2, z], mats.trim, null);
  block(group, [0.07, 0.07, 1.63], [1.0, handleTop, 0], mats.trim, null);
  group.position.x = STACK_X;
  scene.add(group);
}

export function machines(scene: THREE.Scene) {
  plinth(scene);
  const inBelt = belt(scene, BELT.from, slotX(2) - TANK.half - 0.12);
  const outBelt = belt(scene, slotX(2) + TANK.half + 0.12, BELT.to);
  hopper(scene);
  cart(scene);
  return {
    belt: (travel: number) => {
      inBelt(travel);
      outBelt(travel);
    },
    press: press(scene),
    tank: tank(scene),
  };
}
