export type Distribution = { n: number; p10: number; p50: number; p90: number };

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, p10: 0, p50: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.round((sorted.length - 1) * q)] ?? 0;
  return { n: sorted.length, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}
