import { join } from "node:path";
import { discoverAll, harnessById, readSessions, type Home } from "@quench/history";
import { Jev, JevGuidance, ThemeCache, VerdictCache, type GuidanceInput } from "@quench/judge";
import { reading } from "../progress.ts";
import { sessionSegments, taskRows } from "./agent-archive.ts";
import { githubPulls, run, type Run } from "./github-pulls.ts";
import { stateDir } from "./skills.ts";

export async function tasksJson(home: Home, options: { days: number }, exec: Run = run) {
  const local = join(home.dir, ".quench/local");
  const verdicts = await VerdictCache.open(local, Jev.id, true);
  const guide = {
    cache: await ThemeCache.open<GuidanceInput>(join(local, "guidance.jsonl"), JevGuidance.id),
    judge: null,
  };
  const skills = [join(home.of(harnessById["claude-code"].home), "skills")];
  const since = new Date(Date.now() - options.days * 86_400_000);
  const segments = [];
  for await (const outcome of readSessions(await discoverAll(home, since), 4, reading()))
    if (outcome.ok)
      segments.push(...(await sessionSegments(outcome.session, verdicts, guide, skills, exec)));
  const github = await githubPulls(stateDir(home), segments, Date.now(), exec);
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
}
