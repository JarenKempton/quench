import * as THREE from "three";

export const BELT_Y = 1.35;
export const PLINTH_Y = 0.24;
export const SLOT = 2.75;
export const slotX = (s: number) => -4.1 + s * SLOT;
export const STACK_X = 6.75;
export const TABLE_Y = BELT_Y - 0.55;
export const SLAB = 1.4;
export const PLATEN_REST = BELT_Y + 2.1;
export const HOPPER_BOTTOM = BELT_Y + 2.0;
export const HOPPER_TOP = BELT_Y + 3.0;
export const HOPPER_HALF = { top: 1.1, bottom: 0.64 };
export const BELT = { from: -5.4, to: slotX(3) + 0.8 };
export const TANK = { half: 0.95, depth: 1.15, water: BELT_Y - 0.14, floor: PLINTH_Y + 0.04 };
export const LIFT = { up: BELT_Y, down: PLINTH_Y + 0.1 };

export const mats = {
  steel: new THREE.MeshStandardMaterial({ color: "#2b5f8b", roughness: 0.62, metalness: 0.18, flatShading: true }),
  dark: new THREE.MeshStandardMaterial({ color: "#163c60", roughness: 0.7, metalness: 0.12, flatShading: true }),
  trim: new THREE.MeshStandardMaterial({ color: "#3f78a6", roughness: 0.5, metalness: 0.25, flatShading: true }),
  belt: new THREE.MeshStandardMaterial({ color: "#0a2340", roughness: 0.95, metalness: 0 }),
  plinth: new THREE.MeshStandardMaterial({ color: "#0f3a60", roughness: 0.85, metalness: 0.05 }),
  edge: new THREE.LineBasicMaterial({ color: "#9fdcfa", transparent: true, opacity: 0.3 }),
};

export function outline(mesh: THREE.Mesh, material: THREE.LineBasicMaterial = mats.edge, angle = 30) {
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, angle), material);
  lines.raycast = () => {};
  mesh.add(lines);
  return lines;
}

export function block(
  parent: THREE.Object3D,
  size: [number, number, number],
  at: [number, number, number],
  material: THREE.Material = mats.steel,
  edges: THREE.LineBasicMaterial | null = mats.edge,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (edges) outline(mesh, edges);
  parent.add(mesh);
  return mesh;
}

const seeded = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export function steamTexture(seed: number) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  const rnd = seeded(seed * 7919 + 13);
  const grid = 6;
  const lattice = Array.from({ length: (grid + 1) * (grid + 1) }, rnd);
  const at = (x: number, y: number) => lattice[y * (grid + 1) + x];
  const noise = (u: number, v: number) => {
    const x = u * grid;
    const y = v * grid;
    const x0 = Math.min(grid - 1, Math.floor(x));
    const y0 = Math.min(grid - 1, Math.floor(y));
    const fx = (x - x0) * (x - x0) * (3 - 2 * (x - x0));
    const fy = (y - y0) * (y - y0) * (3 - 2 * (y - y0));
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
  };
  const image = g.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = 0.55 * noise(u, v) + 0.45 * noise((u * 2.3) % 1, (v * 2.3) % 1);
      const edge = Math.max(0, 1 - r / (0.7 + 0.3 * n));
      const alpha = Math.pow(edge, 1.6) * (0.55 + 0.45 * n);
      const i = (y * size + x) * 4;
      image.data[i] = 238;
      image.data[i + 1] = 246;
      image.data[i + 2] = 251;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  g.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function squareTube(top: number, bottom: number, height: number, material: THREE.Material) {
  const geometry = new THREE.CylinderGeometry(top * Math.SQRT2, bottom * Math.SQRT2, height, 4, 1, true);
  geometry.rotateY(Math.PI / 4);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  outline(mesh);
  return mesh;
}

export function lump(seed: number) {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const p = geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
    const r =
      1 +
      0.14 * Math.sin(3.1 * x + seed) * Math.sin(2.6 * y + seed * 0.6) +
      0.1 * Math.sin(4.4 * z + seed * 2.1) +
      0.06 * Math.sin(6.3 * (x + y) + seed * 0.7);
    p[i] = x * r;
    p[i + 1] = y * r;
    p[i + 2] = z * r;
  }
  geometry.computeVertexNormals();
  return geometry;
}
