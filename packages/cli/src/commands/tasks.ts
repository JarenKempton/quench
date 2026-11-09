import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverAll,
  harnessById,
  readSessions,
  type Home,
  type SessionRef,
} from "@quench/history";
import { Jev, JevGuidance, ThemeCache, VerdictCache, type GuidanceInput } from "@quench/judge";
import { replacePrivateFile } from "../private-file.ts";
import { reading } from "../progress.ts";
import { archived, sessionKey, sessionSegments, taskRows, type Shipped } from "./agent-archive.ts";
import { cachedPulls, githubPulls, run, type Run } from "./github-pulls.ts";
import { stateDir } from "./skills.ts";

type Known = Record<string, Shipped[string] & { at?: number }>;

const segmentsFile = (local: string) => join(local, "task-segments.json");

async function readKnown(path: string): Promise<Known> {
  try {
    return JSON.parse(await Bun.file(path).text()) as Known;
  } catch {
    return {};
  }
}

const fresh = (entry: Known[string] | undefined, size: number, mtimeMs: number, judged: number) =>
  !!entry?.segments?.every((s) => s.signals && s.repo !== undefined) &&
  entry.size === size &&
  entry.mtimeMs === mtimeMs &&
  !(
    judged > (entry.at ?? entry.guidedAt ?? 0) &&
    entry.segments.some((s) => !s.guidance || s.guidance.guidance === "pending")
  );

export function tasksLoader(
  home: Home,
  options: { days: number; cache?: boolean },
  onPulls: () => void = () => {},
  exec: Run = run,
) {
  const local = join(home.dir, ".quench/local");
  let fetching: Promise<void> | null = null;
  return async () => {
    const guidanceFile = join(local, "guidance.jsonl");
    const judged = (await stat(guidanceFile).catch(() => null))?.mtimeMs ?? 0;
    const known: Known =
      options.cache === false
        ? {}
        : { ...(await archived(stateDir(home))), ...(await readKnown(segmentsFile(local))) };
    const since = new Date(Date.now() - options.days * 86_400_000);
    const next: Known = {};
    const stale: { ref: SessionRef; key: string; size: number; mtimeMs: number }[] = [];
    const refs = await discoverAll(home, since);
    const infos = await Promise.all(refs.map((ref) => stat(ref.path).catch(() => null)));
    refs.forEach((ref, i) => {
      const info = infos[i];
      if (!info) return;
      const key = sessionKey(home, ref);
      const entry = known[key];
      if (entry && fresh(entry, info.size, info.mtimeMs, judged)) next[key] = entry;
      else stale.push({ ref, key, size: info.size, mtimeMs: info.mtimeMs });
    });
    if (stale.length) {
      const verdicts = await VerdictCache.open(local, Jev.id, true);
      const guide = {
        cache: await ThemeCache.open<GuidanceInput>(guidanceFile, JevGuidance.id),
        judge: null,
      };
      const skills = [join(home.of(harnessById["claude-code"].home), "skills")];
      let i = 0;
      for await (const outcome of readSessions(
        stale.map((s) => s.ref),
        4,
        reading(),
      )) {
        const item = stale[i++]!;
        if (!outcome.ok) continue;
        next[item.key] = {
          sha256: "",
          size: item.size,
          mtimeMs: item.mtimeMs,
          at: Date.now(),
          segments: await sessionSegments(outcome.session, verdicts, guide, skills, exec),
        };
      }
      if (options.cache !== false)
        await replacePrivateFile(segmentsFile(local), `${JSON.stringify(next)}\n`);
    }
    const segments = Object.values(next).flatMap((e) => e.segments ?? []);
    const github = await cachedPulls(local, segments);
    fetching ??= githubPulls(local, segments, Date.now(), exec)
      .then((after) => {
        if (JSON.stringify(after.pulls) !== JSON.stringify(github.pulls)) onPulls();
      })
      .catch(() => {})
      .finally(() => {
        fetching = null;
      });
    return {
      days: options.days,
      offline: github.offline,
      tasks: taskRows(segments, github.pulls)
        .map((t) => ({
          taskId: t.taskId,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          split: t.split,
          markers: t.markers,
          members: t.members,
          harnesses: t.harnesses,
          sessions: t.sessions,
          runs: t.runs,
          tokens: t.tokens,
          seconds: t.seconds,
          landed: t.landed,
          spiral: t.spiral,
          efficiency: t.efficiency,
          guidance: t.guidance === "pending" ? ("unknown" as const) : t.guidance,
          guidanceTurns: t.guidanceTurns,
          guidanceCost: t.guidanceCost,
        }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
  };
}
