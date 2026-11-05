import { installations, type LedgerEntry, type SkillVersion } from "@quench/fleet";
import type { SkillEvidence } from "../commands/skills.ts";
import { loadedAnywhere, loadedFrom, sessionOutcomes, tally } from "./co-occurrence.ts";
import type { SkillRecord } from "./records.ts";

export function withVersions<R extends Pick<SkillRecord, "skill" | "harness" | "location">>(
  records: readonly R[],
  ledger: readonly LedgerEntry[],
  evidence: SkillEvidence,
  absolute: (path: string) => string,
): (R & { versions?: SkillVersion[] })[] {
  const outcome = sessionOutcomes(evidence.replies, evidence.since);
  const recorded = [...evidence.started]
    .filter(([key]) => evidence.contexts.get(key)?.skills)
    .map(([key, s]) => ({ key, ...s }));
  const intervals = installations([...ledger]).sort((a, b) => a.from.localeCompare(b.from));
  return records.map((record) => {
    const mine = intervals.filter(
      (i) => i.skill === record.skill && i.harness === record.harness && i.path === record.location,
    );
    if (!mine.length) return record;
    const anywhere = loadedAnywhere(evidence.contexts, record.skill);
    return {
      ...record,
      versions: mine.map((i) => {
        const from = Date.parse(i.from);
        const to = i.to === null ? Infinity : Date.parse(i.to);
        const during = recorded
          .filter((s) => s.harness === i.harness && s.at >= from && s.at < to)
          .map((s) => s.key);
        const here = loadedFrom(evidence.contexts, record.skill, [absolute(i.path)]);
        return {
          treeHash: i.treeHash,
          from: i.from,
          to: i.to,
          loaded: tally(during.filter(here), outcome),
          without: tally(
            during.filter((key) => !anywhere(key)),
            outcome,
          ),
        };
      }),
    };
  });
}
