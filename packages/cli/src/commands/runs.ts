import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import {
  discoverAll,
  harnessById,
  isInside,
  readSessions,
  startedAt,
  startingContext,
  Home,
  type Session,
  type SessionRef,
} from "@quench/history";
import { commandRecords, runRecords, runs as runsOf } from "@quench/insights";
import { json, quote, runFacts } from "../format.ts";
import { latestSessionIn } from "../latest.ts";

export async function runs(
  home: Home,
  file: string | undefined,
  options: { json: boolean; session?: string },
): Promise<number> {
  if (options.session) file = (await sessionFile(home, options.session)) ?? undefined;
  else file ??= (await latestSessionIn(home, process.cwd())) ?? undefined;
  if (!file) return 1;
  const path = await realpath(file).catch(() => null);
  if (!path) {
    process.stderr.write(`${file} does not exist\n`);
    return 1;
  }
  const refs = [];
  for (const ref of await discoverAll(home)) {
    const real = await realpath(ref.path).catch(() => ref.path);
    if (real === path || isInside(real, path.replace(/\.jsonl$/, "")))
      refs.push({ ...ref, path: real });
  }
  const sessions: Session[] = [];
  for await (const outcome of readSessions(refs)) if (outcome.ok) sessions.push(outcome.session);
  const session = sessions.find((s) => s.path === path);
  if (!session) {
    process.stderr.write(`${path} is not a session any known harness wrote\n`);
    return 1;
  }
  const list = runsOf(
    session,
    sessions.filter((s) => s.parent === session.id),
  );
  if (options.json) {
    const start = startingContext(session);
    process.stdout.write(
      json(
        list.map((run, i) => ({
          ...run,
          commands: commandRecords(run),
          ...(i === 0 ? { startingContext: start } : {}),
        })),
      ),
    );
    return 0;
  }
  const header = `${harnessById[session.harness].label} session ${session.id} in ${session.cwd ?? "unknown folder"}\n\n`;
  const body = list
    .map(
      (run, i) =>
        `#${String(i + 1).padEnd(3)} ${quote(run.prompt)}\n     ${runFacts(run)}\n  →  ${quote(run.reply)}\n`,
    )
    .join("\n");
  process.stdout.write(header + body);
  return 0;
}

async function sessionFile(home: Home, id: string): Promise<string | null> {
  const refs = (await discoverAll(home)).filter((r) => basename(r.path).includes(id));
  for await (const outcome of readSessions(refs))
    if (outcome.ok && outcome.session.id === id) return outcome.session.path;
  process.stderr.write(`No session with id ${id} in any harness home\n`);
  return null;
}

export async function allRuns(home: Home, history: readonly string[]): Promise<number> {
  const machines = history.length
    ? history.map((dir) => ({ machine: basename(resolve(dir)), home: new Home(resolve(dir)) }))
    : [{ machine: hostname(), home }];
  const now = new Date();
  let failed = 0;
  for (const { machine, home } of machines) {
    const refs = await discoverAll(home);
    const children = refs.filter((r) => r.parent !== null);
    const childStarts = new Map<string, (Date | null)[]>();
    const ordered: SessionRef[] = [...children, ...refs.filter((r) => r.parent === null)];
    for await (const outcome of readSessions(ordered)) {
      if (!outcome.ok) {
        failed++;
        continue;
      }
      const session = outcome.session;
      if (session.parent !== null) {
        const key = `${session.harness}:${session.parent}`;
        childStarts.set(key, [...(childStarts.get(key) ?? []), startedAt(session)]);
      }
      const records = runRecords(
        session,
        childStarts.get(`${session.harness}:${session.id}`) ?? [],
        now,
      );
      if (records.length)
        process.stdout.write(
          records
            .map((r) => JSON.stringify({ machine, ...r, id: `${machine}:${r.harness}:${r.id}` }))
            .join("\n") + "\n",
        );
    }
  }
  if (failed) process.stderr.write(`${failed} session files could not be read\n`);
  return 0;
}
