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

function lamp(parent: THREE.Object3D, at: [number, number, number]) {
  const material = new THREE.MeshStandardMaterial({ color: "#20405c", emissive: "#000000", roughness: 0.3 });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 16), material);
  mesh.position.set(...at);
  parent.add(mesh);
  return material;
}

function plinth(scene: THREE.Scene) {
  scene.add(floorGrid());
  const base = block(scene, [17, PLINTH_Y, 5.2], [1.55, PLINTH_Y / 2, 0], mats.plinth);
  base.castShadow = false;
  for (let x = -7; x <= 9.6; x += 0.5) {
    const major = Math.abs((x * 2) % 4) < 0.01;
    block(scene, [0.02, 0.01, major ? 0.34 : 0.16], [x, PLINTH_Y + 0.006, 2.6 - (major ? 0.17 : 0.08)], mats.trim, null).castShadow = false;
  }
}

function conveyor(scene: THREE.Scene) {
  const length = BELT.to - BELT.from;
  const mid = (BELT.from + BELT.to) / 2;
  block(scene, [length, 0.1, 1.84], [mid, BELT_Y - 0.05, 0], mats.belt, mats.faint);
  for (const z of [-1, 1]) block(scene, [length + 0.5, 0.34, 0.12], [mid, BELT_Y - 0.12, z * 0.98], mats.trim);
  for (const x of [BELT.from + 0.3, slotX(0.5), slotX(1.5), slotX(2.5), BELT.to - 0.3])
    for (const z of [-0.86, 0.86]) block(scene, [0.16, BELT_Y - 0.3 - PLINTH_Y, 0.16], [x, (BELT_Y - 0.3 + PLINTH_Y) / 2, z], mats.dark);

  const count = Math.ceil(length / SLAT_GAP);
  const slats = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.045, 0.012, 1.7),
    new THREE.MeshBasicMaterial({ color: "#5aa9d2", transparent: true, opacity: 0.55 }),
    count,
  );
  slats.position.y = BELT_Y + 0.004;
  scene.add(slats);

  const rollers = [BELT.from, BELT.to].map((x) => {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, 2.05, 12), mats.steel);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, BELT_Y - ROLLER_R + 0.02, 0);
    outline(roller, mats.edge, 20);
    scene.add(roller);
    return roller;
  });

  const matrix = new THREE.Matrix4();
  return (travel: number) => {
    for (let i = 0; i < count; i++) {
      const x = BELT.from + ((((i * SLAT_GAP + travel) % length) + length) % length);
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
    block(scene, [0.18, HOPPER_TOP - PLINTH_Y, 0.18], [x, (HOPPER_TOP + PLINTH_Y) / 2, z * 1.42], mats.dark);
    block(scene, [0.1, 0.1, 0.3], [x, HOPPER_TOP - 0.3, z * 1.24], mats.trim);
  }
  return lamp(scene, [x, HOPPER_TOP + 0.25, -1.42]);
}

function press(scene: THREE.Scene) {
  const x = slotX(1);
  const crownY = BELT_Y + 4.35;
  for (const z of [-1, 1]) block(scene, [0.42, crownY - PLINTH_Y, 0.42], [x, (crownY + PLINTH_Y) / 2, z * 1.38]);
  block(scene, [1.1, 0.7, 3.25], [x, crownY + 0.2, 0]);
  block(scene, [0.7, 0.32, 0.7], [x, crownY + 0.71, 0], mats.trim);
  block(scene, [1.9, 0.18, 2.2], [x, BELT_Y - 0.28, 0], mats.dark);

  const ram = block(scene, [0.34, 1, 0.34], [x, 0, 0], mats.trim);
  const side = new THREE.MeshStandardMaterial({ map: hazard(), roughness: 0.6, metalness: 0.1 });
  const platen = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.44, 1.78), [side, side, mats.steel, mats.steel, side, side]);
  platen.castShadow = true;
  outline(platen);
  scene.add(platen);

  const light = lamp(scene, [x + 0.42, crownY + 0.62, 1.2]);
  return {
    light,
    set(bottom: number) {
      platen.position.set(x, bottom + 0.22, 0);
      const top = bottom + 0.44;
      ram.scale.y = crownY - 0.15 - top;
      ram.position.y = (crownY - 0.15 + top) / 2;
    },
  };
}

function lock(scene: THREE.Scene) {
  const x = slotX(2);
  const beamY = BELT_Y + 2.75;
  for (const z of [-1, 1]) block(scene, [0.34, beamY - PLINTH_Y, 0.34], [x, (beamY + PLINTH_Y) / 2, z * 1.38]);
  block(scene, [0.9, 0.36, 3.1], [x, beamY + 0.18, 0]);
  for (const dx of [-0.32, 0.32]) block(scene, [0.12, 0.42, 0.12], [x + dx, beamY - 0.2, 0], mats.trim);

  const jaws = [-1, 1].map((z) => {
    const jaw = new THREE.Group();
    block(jaw, [1.2, 0.5, 0.2], [0, 0, 0], mats.trim);
    block(jaw, [0.16, 0.16, 0.9], [0, 0, z * 0.55], mats.dark);
    jaw.position.set(x, BELT_Y + 0.32, 0);
    scene.add(jaw);
    return { jaw, z };
  });
  const stamp = block(scene, [0.5, 0.18, 0.5], [x, 0, 0], mats.trim);
  const rod = block(scene, [0.12, 1, 0.12], [x, 0, 0], mats.dark, null);
  const light = lamp(scene, [x + 0.28, beamY + 0.42, 1.2]);
  return {
    light,
    set(open: number, stampBottom: number) {
      for (const { jaw, z } of jaws) jaw.position.z = z * (SLAB / 2 + 0.1 + open * 0.5);
      stamp.position.y = stampBottom + 0.09;
      rod.scale.y = beamY - stampBottom - 0.18;
      rod.position.y = (beamY + stampBottom + 0.18) / 2;
    },
  };
}

function table(scene: THREE.Scene) {
  block(scene, [2.3, 0.16, 2.1], [STACK_X, TABLE_Y - 0.14, 0], mats.trim);
  for (const x of [-0.85, 0.85]) for (const z of [-0.8, 0.8]) block(scene, [0.16, TABLE_Y - 0.22 - PLINTH_Y, 0.16], [STACK_X + x, (TABLE_Y - 0.22 + PLINTH_Y) / 2, z], mats.dark);
  for (let i = 0; i < 6; i++) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.9, 10), mats.steel);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(STACK_X - 0.95 + i * 0.38 + 0.02, TABLE_Y - 0.06, 0);
    roller.receiveShadow = true;
    scene.add(roller);
  }
  block(scene, [3.2, 0.06, 0.1], [STACK_X + 2.6, TABLE_Y - 0.1, 0.95], mats.trim, null);
  block(scene, [3.2, 0.06, 0.1], [STACK_X + 2.6, TABLE_Y - 0.1, -0.95], mats.trim, null);
}

export function machines(scene: THREE.Scene) {
  plinth(scene);
  table(scene);
  return { belt: conveyor(scene), hopperLight: hopper(scene), press: press(scene), lock: lock(scene) };
}
