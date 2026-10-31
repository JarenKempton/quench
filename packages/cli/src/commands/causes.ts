import { harnessById, type HarnessId } from "@quench/history";
import { behaviour, behaviourLabel, type BehaviourKind } from "@quench/insights";
import { Cause, total, type Causes, type CauseStatus, type CauseTally } from "@quench/judge";
import { describe, quote } from "../format.ts";

const STATUSES: CauseStatus[] = [...Cause.options, "pending", "failed"];

const label: Record<CauseStatus, string> = {
  misread_instruction: "Misread instruction",
  wrong_assumption: "Wrong assumption",
  ignored_instruction: "Ignored rule or instruction",
  bad_tool_use: "Bad tool use",
  rabbit_hole: "Rabbit hole / over-engineering",
  claimed_done_early: "Claimed done too early",
  steering: "None: steering or preference",
  pending: "Not asked yet",
  failed: "Failed",
};

export function renderCauses(causes: Causes, examples: number): string {
  const lines = [
    "",
    `Correction causes · ${causes.judge}`,
    `${causes.corrections} corrections (${causes.uniqueInputs} unique exchanges): ${causes.cacheHits} cached · ${causes.newlyJudged} new · ${causes.pending} pending · ${causes.failed} failed`,
    "",
    `${"".padEnd(32)}${"people".padStart(8)}${"agents".padStart(8)}${"unresolved".padStart(12)}`,
  ];
  for (const status of STATUSES)
    lines.push(
      `${label[status].padEnd(32)}${cell(causes.fromPeople.causes, status, 8)}${cell(causes.fromAutomation.causes, status, 8)}${cell(causes.fromUnknown, status, 12)}`,
    );
  for (const [who, summary] of [
    ["people", causes.fromPeople],
    ["agents / automation", causes.fromAutomation],
  ] as const) {
    lines.push("", `Behaviour in the run before corrections from ${who}`);
    for (const kind of Object.keys(behaviourLabel) as BehaviourKind[])
      lines.push(`  ${behaviourLabel[kind].padEnd(30)}${top(summary.byBehaviour[kind])}`);
    lines.push(`  ${"None of these".padEnd(30)}${top(summary.withoutBehaviour)}`);
    for (const bucket of summary.byBucket) {
      lines.push(`  ${bucket.name}`);
      for (const b of bucket.buckets.slice(0, 5))
        lines.push(`    ${b.label.padEnd(28)}${top(b.causes)}`);
    }
  }
  lines.push("", "Latest corrections with their cause");
  const latest = [...causes.caused]
    .sort((a, b) => (b.reply.run.replyAt?.getTime() ?? 0) - (a.reply.run.replyAt?.getTime() ?? 0))
    .slice(0, examples);
  for (const { reply, cause } of latest) {
    const found = behaviour(reply.run);
    lines.push(
      `  ${label[cause]} · ${reply.sender ?? "unresolved"} · ${harnessLabel(reply.harness)} · ${reply.path} run ${reply.position}  ${quote(reply.run.reply)}`,
      `      behaviour: ${found.length ? found.map(describe).join(" · ") : "none detected"}`,
    );
  }
  lines.push(
    "",
    "Causes are one Jev choice per correction; behaviour comes from the log. Correlations, not causes of each other.",
  );
  if (causes.pending)
    lines.push(
      `Uncached corrections: ${causes.pending} cause requests; unclassified replies may add more.`,
    );
  for (const warning of causes.warnings) lines.push(`Warning: ${warning}`);
  for (const failure of causes.failures.slice(0, 3)) lines.push(`Cause failure: ${failure}`);
  return `${lines.join("\n")}\n`;
}

const cell = (t: CauseTally, status: CauseStatus, width: number) =>
  String(t[status]).padStart(width);

function top(t: CauseTally): string {
  const n = total(t);
  if (!n) return "0";
  const parts = STATUSES.filter((s) => t[s])
    .sort((a, b) => t[b] - t[a])
    .slice(0, 3)
    .map((s) => `${label[s].toLowerCase()} ${t[s]}`);
  return `${n} · ${parts.join(" · ")}`;
}

const harnessLabel = (id: HarnessId) => harnessById[id].label;
