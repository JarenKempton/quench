import type { HarnessId, MachineState, TreeHash, VersionCounts } from "@quench/fleet";

export const SAMPLE_FLOOR = 10;

export type Reporting = { name: string; state: MachineState | null };

export type Side = { loaded: VersionCounts; without: VersionCounts };

export type Card = {
  skill: string;
  before: TreeHash;
  after: TreeHash;
  places: { machine: string; harness: HarnessId }[];
  sides: { before: Side; after: Side };
  sessions: number;
  shown: boolean;
};

const zero = (): VersionCounts => ({
  sessions: 0,
  judged: 0,
  withHumanCorrection: 0,
  unjudged: 0,
  noFollowUp: 0,
});

const add = (into: VersionCounts, more: VersionCounts) => {
  for (const key of Object.keys(into) as (keyof VersionCounts)[]) into[key] += more[key];
};

export function versionCards(machines: readonly Reporting[]): Card[] {
  const cards = new Map<string, Card>();
  for (const { name, state } of machines)
    for (const record of state?.skills?.records ?? []) {
      const versions = [...(record.versions ?? [])].sort((a, b) => a.from.localeCompare(b.from));
      for (let i = 1; i < versions.length; i++) {
        const [was, now] = [versions[i - 1]!, versions[i]!];
        if (was.treeHash === now.treeHash) continue;
        const key = `${record.skill}\0${was.treeHash}\0${now.treeHash}`;
        const card = cards.get(key) ?? {
          skill: record.skill,
          before: was.treeHash,
          after: now.treeHash,
          places: [],
          sides: {
            before: { loaded: zero(), without: zero() },
            after: { loaded: zero(), without: zero() },
          },
          sessions: 0,
          shown: false,
        };
        cards.set(key, card);
        add(card.sides.before.loaded, was.loaded);
        add(card.sides.before.without, was.without);
        add(card.sides.after.loaded, now.loaded);
        add(card.sides.after.without, now.without);
        const seen = was.loaded.sessions + now.loaded.sessions > 0;
        if (seen && !card.places.some((p) => p.machine === name && p.harness === record.harness))
          card.places.push({ machine: name, harness: record.harness });
      }
    }
  return [...cards.values()]
    .map((card) => {
      const sessions = Math.min(
        card.sides.before.loaded.sessions,
        card.sides.after.loaded.sessions,
      );
      return { ...card, sessions, shown: sessions >= SAMPLE_FLOOR };
    })
    .sort((a, b) => a.skill.localeCompare(b.skill) || a.after.localeCompare(b.after));
}

export type SkillCounts = {
  sessionsListed: number | null;
  used: number | null;
  sessionsLoaded: number | null;
  withHumanCorrection: number | null;
};

const sum = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;

export function skillCounts(state: MachineState | null, skill: string): SkillCounts | null {
  const records = state?.skills?.records.filter((r) => r.skill === skill) ?? [];
  if (!records.length) return null;
  return {
    sessionsListed: sum(records.map((r) => r.use.sessionsListed)),
    used: sum(records.map((r) => r.use.used)),
    sessionsLoaded: sum(records.map((r) => r.coOccurrence.sessionsLoaded)),
    withHumanCorrection: sum(records.map((r) => r.coOccurrence.withHumanCorrection)),
  };
}
