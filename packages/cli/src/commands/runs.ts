import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  discoverAll,
  harnessById,
  isInside,
  readSessions,
  startingContext,
  type Home,
  type Session,
} from "@quench/history";
import { runs as runsOf } from "@quench/insights";
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
      json(list.map((run, i) => (i === 0 ? { ...run, startingContext: start } : run))),
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
