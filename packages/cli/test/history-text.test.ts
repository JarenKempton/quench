import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jev, VerdictCache } from "@quench/judge";
import { lines, quench } from "./run.ts";

type Repro = { command: string; output: string; leaks: string[] };

const repros: Repro[] = [
  {
    command: "curl -u qua:qub https://example.test",
    output: "Exit code 22\n+ curl -u qua:qub https://example.test",
    leaks: ["qua", "qub"],
  },
  {
    command: "git clone https://user:qpwq@example.test/r.git",
    output: "Exit code 128\nremote: auth failed for https://user:qpwq@example.test",
    leaks: ["qpwq"],
  },
  {
    command: 'curl -H "Authorization: Bearer \\"qescq\\"" https://example.test',
    output: 'Exit code 22\n> Authorization: Bearer \\"qescq\\"',
    leaks: ["qescq"],
  },
  {
    command: `curl -d '{"password":"qjsq"}' https://example.test`,
    output: 'Exit code 22\n{"password":"qjsq"} rejected',
    leaks: ["qjsq"],
  },
  {
    command: "curl -H 'Cookie: session=qckq' -H 'X-Api-Key: qxakq' https://example.test",
    output: "Exit code 22\n> Cookie: session=qckq\n> X-Api-Key: qxakq",
    leaks: ["qckq", "qxakq"],
  },
  {
    command: "git push https://qutokq:x-oauth-basic@example.test/r.git",
    output: "Exit code 128\nfatal: https://qutokq:x-oauth-basic@example.test denied",
    leaks: ["qutokq"],
  },
  {
    command: "/opt/qexecq --run",
    output: "Exit code 1\nqexecq: failed",
    leaks: ["qexecq"],
  },
  {
    command: "oathtool deadbeefqdbq",
    output: "Exit code 1\noathtool: deadbeefqdbq: invalid",
    leaks: ["qdbq"],
  },
  {
    command: "deploy --token --qsecretq",
    output: "Exit code 1\nrejected --qsecretq",
    leaks: ["qsecretq"],
  },
];

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();
const replyTo = (r: Repro) => `No, run ${r.command} again: ${r.output}`;

function session(): string {
  return lines([
    { type: "user", timestamp: at(0), message: { role: "user", content: "fix the build" } },
    ...repros.flatMap((r, n) => [
      {
        type: "assistant",
        timestamp: at(10 * n + 1),
        message: {
          id: `m${n}`,
          model: "model-x",
          content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: r.command } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "user",
        timestamp: at(10 * n + 2),
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `t${n}`, content: r.output, is_error: true },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: at(10 * n + 3),
        message: {
          id: `d${n}`,
          model: "model-x",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      { type: "user", timestamp: at(10 * n + 4), message: { role: "user", content: replyTo(r) } },
    ]),
  ]);
}

const leaked = (outputs: Record<string, string>) =>
  Object.entries(outputs).flatMap(([where, text]) =>
    repros.flatMap((r) => r.leaks.filter((l) => text.includes(l)).map((l) => `${where}: ${l}`)),
  );

test("corrections and runs --json render no reply or command text from history", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-history-text-")));
  const file = join(home, ".claude/projects/demo/s.jsonl");
  await Bun.write(file, session());
  const cache = await VerdictCache.open(join(home, ".quench/local/judgments.jsonl"), Jev.id);
  await cache.remember(
    repros.map((r, n) => [
      { assistantSaid: "done", reply: replyTo(r) },
      { kind: "correction", sender: n % 2 ? "automation" : "person", confidence: 1 },
    ]),
  );
  const window = ["--days", "36500", "--examples", "100"];
  const corrections = ["corrections", "--cached-only", "--context", ...window];
  const causes = ["corrections", "--causes", "--dry-run", ...window];
  const outputs = {
    corrections: (await quench(home, ...corrections)).stdout,
    correctionsJson: (await quench(home, ...corrections, "--json")).stdout,
    causes: (await quench(home, ...causes)).stdout,
    causesJson: (await quench(home, ...causes, "--json")).stdout,
  };
  expect(outputs.corrections).toContain("Latest corrections from people");
  expect(JSON.parse(outputs.correctionsJson).latest).toHaveLength(5);
  expect(JSON.parse(outputs.causesJson).causes.caused).toHaveLength(9);

  const runs = JSON.parse((await quench(home, "runs", file, "--json")).stdout);
  const records = (await quench(home, "runs", "--all", "--json")).stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const structural = (list: { commands: unknown; calls?: unknown; failures?: unknown }[]) =>
    JSON.stringify(list.map((r) => [r.commands, r.calls, r.failures]));
  expect(runs.flatMap((r: { commands: object[] }) => r.commands)).toContainEqual({
    program: "curl",
    subcommand: null,
    error: "exit code 22",
  });
  expect(records.flatMap((r: { commands: object[] }) => r.commands)).toContainEqual({
    program: "git",
    subcommand: "push",
    error: "exit code 128",
  });

  expect(leaked({ ...outputs, runs: structural(runs), records: structural(records) })).toEqual([]);
});
