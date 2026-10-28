export type Point = [number, number, number];

const COS = Math.cos(Math.PI / 6);

export const project = ([x, y, z]: Point): [number, number] => [(x - y) * COS, (x + y) / 2 - z];

const points = (corners: Point[]) =>
  corners
    .map(project)
    .map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`)
    .join(" ");

export function box(x: number, y: number, z: number, w: number, d: number, h: number) {
  const top = z + h;
  return {
    top: points([
      [x, y, top],
      [x + w, y, top],
      [x + w, y + d, top],
      [x, y + d, top],
    ]),
    left: points([
      [x, y + d, z],
      [x + w, y + d, z],
      [x + w, y + d, top],
      [x, y + d, top],
    ]),
    right: points([
      [x + w, y, z],
      [x + w, y + d, z],
      [x + w, y + d, top],
      [x + w, y, top],
    ]),
  };
}

export const leftFace = ([x, y, z]: Point) => {
  const [e, f] = project([x, y, z]);
  return `matrix(${COS.toFixed(3)} 0.5 0 1 ${e.toFixed(1)} ${f.toFixed(1)})`;
};

export const rightFace = ([x, y, z]: Point) => {
  const [e, f] = project([x, y, z]);
  return `matrix(${COS.toFixed(3)} -0.5 0 1 ${e.toFixed(1)} ${f.toFixed(1)})`;
};
