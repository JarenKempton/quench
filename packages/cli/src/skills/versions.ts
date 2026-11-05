import {
  installations,
  type Installation,
  type LedgerEntry,
  type SkillVersion,
} from "@quench/fleet";
import { inside } from "@quench/fleet/disk";
import { skillFolder } from "@quench/history";
import type { SkillEvidence } from "../commands/skills.ts";
import { sessionOutcomes, tally } from "./co-occurrence.ts";
import type { SkillRecord } from "./records.ts";

type Recorded = { key: string; harness: string; at: number; cwd: string | null };

const slashed = (path: string) => path.replaceAll("\\", "/");

const sole = (candidates: Installation[]) => (candidates.length === 1 ? candidates[0]! : null);

export function withVersions<R extends Pick<SkillRecord, "skill" | "harness" | "location">>(
  records: readonly R[],
  ledger: readonly LedgerEntry[],
  evidence: SkillEvidence,
  absolute: (path: string) => string,
): (R & { versions?: SkillVersion[] })[] {
  const outcome = sessionOutcomes(evidence.replies, evidence.since);
  const recorded: Recorded[] = [...evidence.started]
    .filter(([key]) => evidence.contexts.get(key)?.skills)
    .map(([key, s]) => ({ key, ...s }));
  const intervals = installations([...ledger]).sort((a, b) => a.from.localeCompare(b.from));
  const live = (i: Installation, s: Recorded) =>
    i.harness === s.harness &&
    s.at >= Date.parse(i.from) &&
    (i.to === null || s.at < Date.parse(i.to));
  const covers = (i: Installation, s: Recorded) =>
    live(i, s) &&
    (i.location.scope === "global" ||
      (s.cwd !== null && inside(absolute(i.location.checkout), s.cwd)));

  const attribution = new Map<
    string,
    { loaded: Installation | null; without: Installation | null }
  >();
  const attribute = (skill: string, s: Recorded) => {
    const id = `${skill}\0${s.key}`;
    const known = attribution.get(id);
    if (known) return known;
    const mine = intervals.filter((i) => i.skill === skill);
    const scope = sole(mine.filter((i) => covers(i, s)));
    const loads = (evidence.contexts.get(s.key)?.loads ?? []).filter((l) => l.name === skill);
    const folders = new Set(
      loads.flatMap((l) => (l.path === null ? [] : [slashed(skillFolder(l.path))])),
    );
    const byPath = mine.filter((i) => live(i, s) && folders.has(slashed(absolute(i.path))));
    const result = {
      loaded: byPath.length ? sole(byPath) : loads.some((l) => l.path === null) ? scope : null,
      without: loads.length ? null : scope,
    };
    attribution.set(id, result);
    return result;
  };

  return records.map((record) => {
    const mine = intervals.filter(
      (i) => i.skill === record.skill && i.harness === record.harness && i.path === record.location,
    );
    if (!mine.length) return record;
    return {
      ...record,
      versions: mine.map((i) => {
        const keys = (side: "loaded" | "without") =>
          recorded.filter((s) => attribute(record.skill, s)[side] === i).map((s) => s.key);
        return {
          treeHash: i.treeHash,
          from: i.from,
          to: i.to,
          loaded: tally(keys("loaded"), outcome),
          without: tally(keys("without"), outcome),
        };
      }),
    };
  });
}
