import { tokens } from "../format.ts";
import { heading } from "../style.ts";
import { outcomeOf, type Estimate, type EvalPrompt, type Row, type summarise } from "./eval.ts";
import type { Replay } from "./replay.ts";

const WIDTH = 34;
const TEXT_LINES = 6;

const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

export const short = (hash: string) => hash.slice(7, 19);

const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(4)}`);

export const PROVIDER_WARNING =
  "Replays send each prompt and both skill versions to the model provider through claude -p, under your account's data terms. Nothing else leaves this machine.";

export function renderPreview(
  skill: string,
  prompts: readonly EvalPrompt[],
  cost: Estimate,
  maxCost: number,
): string {
  const spend =
    cost.usd === null
      ? `cost unknown (no list price for ${cost.unpriced.join(", ")}); the ${usd(maxCost)} spend cap still stops the run`
      : `about ${usd(cost.usd)} at list prices, uncached`;
  return [
    heading(
      `skills eval ${skill} · ${prompts.length} first prompts · ${prompts.length * 2} replays`,
    ),
    `Estimate: ~${tokens(cost.tokens)} tokens, ${spend}. Spend cap ${usd(maxCost)}.`,
    PROVIDER_WARNING,
    "",
    ...prompts.map(
      (p, i) =>
        `${i + 1}. ${p.at.toISOString().slice(0, 10)} ${p.session.slice(0, 8)}  ${clip(oneLine(p.text), 100)}`,
    ),
    "",
  ].join("\n");
}

const clip = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

function wrap(text: string, width: number, lines: number): string[] {
  const words = oneLine(text).split(" ");
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      out.push(line);
      line = clip(word, width);
    }
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && words.join(" ").length > out.join(" ").length)
    out[lines - 1] = clip(`${out[lines - 1]}…`, width);
  return out;
}

const column = (r: Replay | null) => {
  if (r === null) return { facts: ["not run"], text: "" };
  if (!r.ok) return { facts: [`failed: ${r.reason}`], text: "" };
  return {
    facts: [
      `triggered ${r.triggered ? "yes" : "no"}`,
      `tokens ${tokens(r.tokens)}`,
      `cost ${usd(r.costUsd)}`,
    ],
    text: r.output,
  };
};

function sideBySide(columns: { facts: string[]; text: string }[]): string[] {
  const cells = columns.map((c) => [
    ...c.facts.flatMap((f) => wrap(f, WIDTH, 2)),
    "",
    ...wrap(c.text, WIDTH, TEXT_LINES),
  ]);
  const height = Math.max(...cells.map((c) => c.length));
  return Array.from({ length: height }, (_, i) =>
    `  ${cells.map((c) => (c[i] ?? "").padEnd(WIDTH)).join(" │ ")}`.trimEnd(),
  );
}

export function renderResults(
  skill: string,
  hashes: { current: string; candidate: string },
  rows: readonly Row[],
  summary: ReturnType<typeof summarise>,
): string {
  const titles = [
    "original (recorded)",
    `current ${short(hashes.current)}`,
    `candidate ${short(hashes.candidate)}`,
  ];
  const blocks = rows.flatMap((row, i) => [
    "",
    `${i + 1}. ${row.prompt.at.toISOString().slice(0, 10)} ${row.prompt.session.slice(0, 8)} · ${outcomeOf(row.current, row.candidate)}`,
    `  prompt: ${clip(oneLine(row.prompt.text), 200)}`,
    `  ${titles.map((t) => t.padEnd(WIDTH)).join(" │ ")}`.trimEnd(),
    ...sideBySide([
      {
        facts: [
          "triggered yes",
          `tokens ${row.prompt.original.tokens === null ? "unknown" : tokens(row.prompt.original.tokens)}`,
          "cost — (not recorded)",
        ],
        text: row.prompt.original.output ?? "",
      },
      column(row.current),
      column(row.candidate),
    ]),
  ]);
  const rate = summary.exclusionRate === null ? "—" : `${Math.round(summary.exclusionRate * 100)}%`;
  return [
    heading(
      `skills eval ${skill} · current ${short(hashes.current)} vs candidate ${short(hashes.candidate)}`,
    ),
    ...blocks,
    "",
    `Wins ${summary.wins} · losses ${summary.losses} · ties ${summary.ties}`,
    `Excluded ${summary.excluded} (current replay did not reproduce the trigger) · exclusion rate ${rate}`,
    ...(summary.failed ? [`Failed ${summary.failed}`] : []),
    ...(summary.notRun ? [`Not run ${summary.notRun} (spend cap reached)`] : []),
    `Spent ${usd(summary.spentUsd)} as reported by claude -p`,
    "Win: the candidate triggers and uses at least 10% fewer tokens than the current version; loss: it does not trigger or uses 10% more; otherwise a tie. No judge reads the answers.",
    "",
  ].join("\n");
}
