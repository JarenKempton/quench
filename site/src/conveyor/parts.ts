import * as THREE from "three";

export const BELT_Y = 1.25;
export const PLINTH_Y = 0.24;
export const SLOT = 3.1;
export const slotX = (s: number) => -4.65 + s * SLOT;
export const STACK_X = 7.7;
export const TABLE_Y = BELT_Y - 0.42;
export const SLAB = 1.5;
export const PLATEN_REST = BELT_Y + 2.35;
export const HOPPER_BOTTOM = BELT_Y + 2.2;
export const HOPPER_TOP = BELT_Y + 3.25;
export const HOPPER_HALF = { top: 1.16, bottom: 0.68 };
export const BELT = { from: -6.5, to: 6.15 };

const edgeColor = new THREE.Color("#9fdcfa");

export const mats = {
  steel: new THREE.MeshStandardMaterial({ color: "#2b5f8b", roughness: 0.62, metalness: 0.18, flatShading: true }),
  dark: new THREE.MeshStandardMaterial({ color: "#163c60", roughness: 0.7, metalness: 0.12, flatShading: true }),
  trim: new THREE.MeshStandardMaterial({ color: "#4a86b5", roughness: 0.5, metalness: 0.25, flatShading: true }),
  belt: new THREE.MeshStandardMaterial({ color: "#0a2340", roughness: 0.95, metalness: 0 }),
  plinth: new THREE.MeshStandardMaterial({ color: "#0f3a60", roughness: 0.85, metalness: 0.05 }),
  edge: new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.4 }),
  faint: new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.18 }),
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

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export const hazard = () =>
  canvasTexture(256, 64, (g) => {
    g.fillStyle = "#0b2a48";
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = "#f3d98b";
    for (let x = -64; x < 320; x += 40) {
      g.beginPath();
      g.moveTo(x, 64);
      g.lineTo(x + 20, 64);
      g.lineTo(x + 84, 0);
      g.lineTo(x + 64, 0);
      g.fill();
    }
  });

export const puff = () =>
  canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(238,248,255,0.9)");
    r.addColorStop(0.45, "rgba(214,238,252,0.35)");
    r.addColorStop(1, "rgba(214,238,252,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  });

export function floorGrid() {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { color: { value: edgeColor } },
    vertexShader: `
      varying vec2 vXZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vXZ = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 color;
      varying vec2 vXZ;
      float line(vec2 p, float size) {
        vec2 g = abs(fract(p / size - 0.5) - 0.5) / fwidth(p / size);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        vec2 c = vXZ - vec2(1.3, 0.0);
        float fade = 1.0 - smoothstep(5.0, 15.0, length(c * vec2(0.62, 1.0)));
        float a = max(line(vXZ, 0.5) * 0.12, line(vXZ, 2.0) * 0.32) * fade;
        gl_FragColor = vec4(color, a);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.001;
  return mesh;
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

export function lumpy(seed: number) {
  const geometry = new THREE.IcosahedronGeometry(1, 3);
  const base = Float32Array.from(geometry.attributes.position.array);
  const wobble = (t: number, amount: number) => {
    const p = geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      const z = base[i + 2];
      const r =
        1 +
        amount *
          (0.13 * Math.sin(3.1 * x + t * 2.3 + seed) * Math.sin(2.6 * y + t * 1.7) +
            0.1 * Math.sin(4.4 * z - t * 2.9 + seed * 2.1) +
            0.07 * Math.sin(6.3 * (x + y) + t * 3.4 + seed * 0.7));
      p[i] = x * r;
      p[i + 1] = y * r;
      p[i + 2] = z * r;
    }
    geometry.attributes.position.needsUpdate = true;
  };
  return { geometry, wobble };
}
