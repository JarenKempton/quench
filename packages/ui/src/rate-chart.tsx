import { useState } from "react";
import { percent, rate, type Counts, type Week } from "./corrections.ts";

const W = 1080;
const H = 240;
const PAD = { top: 12, right: 96, bottom: 28, left: 44 };

const SERIES = [
  { key: "fromPeople", label: "From people", color: "var(--series-1)" },
  { key: "fromAutomation", label: "From agents / automation", color: "var(--series-2)" },
] as const;

const niceMax = (max: number) => {
  const step = max <= 0.1 ? 0.02 : max <= 0.25 ? 0.05 : 0.1;
  return Math.max(step, Math.ceil(max / step) * step);
};

const short = (week: string) =>
  new Date(`${week}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const of = (c: Counts) => rate(c.corrections, c.judged);

export function RateChart({ weeks }: { weeks: Week[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const rates = weeks.flatMap((w) => SERIES.map((s) => of(w[s.key]) ?? 0));
  const top = niceMax(Math.max(0, ...rates));
  const ticks = Array.from({ length: 5 }, (_, i) => (top * i) / 4);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (weeks.length === 1 ? plotW / 2 : (i * plotW) / (weeks.length - 1));
  const y = (r: number) => PAD.top + plotH - (r / top) * plotH;
  const band = weeks.length === 1 ? plotW : plotW / (weeks.length - 1);
  const shown = hover === null ? null : weeks[hover];

  return (
    <figure className="space-y-3">
      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <svg width="14" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="14" y2="4" stroke={s.color} strokeWidth="2" />
            </svg>
            {s.label}
          </span>
        ))}
        <span className="ml-auto">corrections ÷ judged replies, per week</span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label="Weekly correction rate from people and from agents"
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--border)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[10px]"
              >
                {percent(t)}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => (
            <text
              key={w.week}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground font-mono text-[10px]"
            >
              {short(w.week)}
            </text>
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--ring)"
              strokeWidth="1"
            />
          )}
          {SERIES.map((s) => {
            const points = weeks.map((w, i) => {
              const r = of(w[s.key]);
              return r === null ? null : ([x(i), y(r)] as const);
            });
            const path = points
              .map((p, i) => (p ? `${points[i - 1] ? "L" : "M"}${p[0]},${p[1]}` : ""))
              .join("");
            const end = points.reduce<number | null>((at, p, i) => (p ? i : at), null);
            const last = end === null ? null : points[end];
            return (
              <g key={s.key}>
                <path
                  d={path}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {points.map(
                  (p, i) =>
                    p && (
                      <circle
                        key={weeks[i]!.week}
                        cx={p[0]}
                        cy={p[1]}
                        r={hover === i ? 5 : 4}
                        fill={s.color}
                        stroke="var(--background)"
                        strokeWidth="2"
                      />
                    ),
                )}
                {last && (
                  <text
                    x={last[0] + 10}
                    y={last[1]}
                    dy="0.32em"
                    className="fill-foreground font-mono text-[11px]"
                  >
                    {percent(of(weeks[end!]![s.key]))}
                  </text>
                )}
              </g>
            );
          })}
          {weeks.map((w, i) => (
            <rect
              key={w.week}
              x={x(i) - band / 2}
              y={PAD.top}
              width={band}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {shown && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-56 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 text-xs shadow-sm"
            style={{ left: `${(Math.min(Math.max(x(hover), 120), W - 120) / W) * 100}%` }}
          >
            <p className="mb-1 font-medium">Week of {short(shown.week)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ background: s.color }}
                  />
                  {s.key === "fromPeople" ? "People" : "Agents"}
                </span>
                <span className="font-mono tabular-nums">
                  {percent(of(shown[s.key]))} · {shown[s.key].corrections}/{shown[s.key].judged}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
