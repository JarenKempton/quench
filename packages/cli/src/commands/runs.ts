import { realpath } from "node:fs/promises";
import { discoverAll, harnessLabel, readSessions, type Home, type Session } from "@quench/history";
import { runs as runsOf } from "@quench/insights";
import { json, quote, runFacts } from "../format.ts";

export async function runs(
  home: Home,
  file: string | undefined,
  options: { json: boolean },
): Promise<number> {
  if (!file) {
    process.stderr.write("usage: quench runs <session-file>\n");
    return 1;
  }
  const path = await realpath(file).catch(() => null);
  if (!path) {
    process.stderr.write(`${file} does not exist\n`);
    return 1;
  }
  const refs = (await discoverAll(home)).filter(
    (r) => r.path === path || r.path.startsWith(`${path.replace(/\.jsonl$/, "")}/`),
  );
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
    process.stdout.write(json(list));
    return 0;
  }
  const header = `${harnessLabel[session.harness]} session ${session.id} in ${session.cwd ?? "unknown folder"}\n\n`;
  const body = list
    .map(
      (run, i) =>
        `#${String(i + 1).padEnd(3)} ${quote(run.prompt)}\n     ${runFacts(run)}\n  →  ${quote(run.reply)}\n`,
    )
    .join("\n");
  process.stdout.write(header + body);
  return 0;
}
