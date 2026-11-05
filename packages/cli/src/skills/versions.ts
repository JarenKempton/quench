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
  const liveAt = (i: Installation, harness: string, at: number) =>
    i.harness === harness && at >= Date.parse(i.from) && (i.to === null || at < Date.parse(i.to));
  const covers = (i: Installation, s: Recorded, at: number) =>
    liveAt(i, s.harness, at) &&
    (i.location.scope === "global" ||
      (s.cwd !== null && inside(absolute(i.location.checkout), s.cwd)));
  const boundary = (mine: Installation[], at: number) =>
    mine.some((i) => Date.parse(i.from) === at || (i.to !== null && Date.parse(i.to) === at));

  const attribution = new Map<
    string,
    { loaded: Set<Installation>; without: Installation | null }
  >();
  const attribute = (skill: string, s: Recorded) => {
    const id = `${skill}\0${s.key}`;
    const known = attribution.get(id);
    if (known) return known;
    const mine = intervals.filter((i) => i.skill === skill && i.harness === s.harness);
    const loads = (evidence.contexts.get(s.key)?.loads ?? []).filter((l) => l.name === skill);
    const loaded = new Set<Installation>();
    for (const load of loads) {
      if (load.at === null || boundary(mine, load.at)) continue;
      const at = load.at;
      const folder = load.path === null ? null : slashed(skillFolder(load.path));
      const target = sole(
        folder === null
          ? mine.filter((i) => covers(i, s, at))
          : mine.filter((i) => liveAt(i, s.harness, at) && slashed(absolute(i.path)) === folder),
      );
      if (target) loaded.add(target);
    }
    const clashes = (i: Installation) =>
      [...loaded].some((o) => o.path !== i.path && o.treeHash === i.treeHash);
    for (const i of [...loaded].filter(clashes)) loaded.delete(i);
    const result = {
      loaded,
      without: loads.length ? null : sole(mine.filter((i) => covers(i, s, s.at))),
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
        const loaded = recorded.filter((s) => attribute(record.skill, s).loaded.has(i));
        const without = recorded.filter((s) => attribute(record.skill, s).without === i);
        return {
          treeHash: i.treeHash,
          from: i.from,
          to: i.to,
          loaded: tally(
            loaded.map((s) => s.key),
            outcome,
          ),
          without: tally(
            without.map((s) => s.key),
            outcome,
          ),
        };
      }),
    };
  });
}
