import { harnessById, type HarnessId } from "@quench/history";
import { behaviour, behaviourLabel, type BehaviourKind } from "./behaviour.ts";
import { durationSeconds, type Run } from "./run.ts";

export type Sample = { harness: HarnessId; position: number; run: Run; corrected: boolean };

export type Bucket = { label: string; replies: number; corrections: number };

export type Signal = { name: string; buckets: Bucket[] };

type Placed = [order: number, label: string];

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const SIGNALS: [string, (s: Sample) => Placed | null][] = [
  [
    "Context when the reply came",
    (s) =>
      range(
        s.run.contextPeak,
        [
          [50_000, "under 50k"],
          [150_000, "50k–150k"],
          [250_000, "150k–250k"],
          [400_000, "250k–400k"],
        ],
        "400k and up",
      ),
  ],
  [
    "Reply number in the session",
    (s) =>
      range(
        s.position,
        [
          [3, "1–2"],
          [10, "3–9"],
          [30, "10–29"],
        ],
        "30 and later",
      ),
  ],
  [
    "Agent time before the reply",
    (s) => {
      const secs = durationSeconds(s.run);
      return secs === null
        ? null
        : range(
            secs,
            [
              [60, "under 1 min"],
              [300, "1–5 min"],
              [900, "5–15 min"],
            ],
            "15 min and up",
          );
    },
  ],
  [
    "Effort",
    (s) => {
      if (s.run.effort === null) return null;
      const order = EFFORTS.indexOf(s.run.effort);
      return [order === -1 ? EFFORTS.length : order, s.run.effort];
    },
  ],
  ["Model", (s) => (s.run.model === null ? null : [0, s.run.model])],
  ["Harness", (s) => [0, harnessById[s.harness].label]],
  ...(Object.keys(behaviourLabel) as BehaviourKind[]).map(
    (kind): [string, (s: Sample) => Placed] => [
      behaviourLabel[kind],
      (s) => (behaviour(s.run).some((b) => b.kind === kind) ? [0, "yes"] : [1, "no"]),
    ],
  ),
];

export const labelIn = (name: string, sample: Sample): string | null =>
  SIGNALS.find(([n]) => n === name)?.[1](sample)?.[1] ?? null;

export const signals = (samples: readonly Sample[]): Signal[] =>
  SIGNALS.map(([name, place]) => ({ name, buckets: bucket(samples, place) }));

function bucket(samples: readonly Sample[], place: (s: Sample) => Placed | null): Bucket[] {
  const found = new Map<string, Bucket & { order: number }>();
  for (const sample of samples) {
    const placed = place(sample);
    if (!placed) continue;
    const [order, label] = placed;
    const b = found.get(label) ?? { order, label, replies: 0, corrections: 0 };
    b.replies += 1;
    b.corrections += sample.corrected ? 1 : 0;
    found.set(label, b);
  }
  return [...found.values()]
    .sort((a, b) => a.order - b.order || b.replies - a.replies)
    .map(({ label, replies, corrections }) => ({ label, replies, corrections }));
}

function range(value: number, edges: [number, string][], last: string): Placed {
  const at = edges.findIndex(([edge]) => value < edge);
  const edge = edges[at];
  return edge ? [at, edge[1]] : [edges.length, last];
}
