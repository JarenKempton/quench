export type Distribution = {
  n: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
};

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, p10: null, p50: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.round((sorted.length - 1) * q)]!;
  return { n: sorted.length, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}
