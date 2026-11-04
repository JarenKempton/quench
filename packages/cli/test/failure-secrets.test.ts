import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, quench } from "./run.ts";

const token = ["ghp", "R7tK2mQ9xV4bN8cL1zW6yH3jF5dS0aP2eG7u"].join("_");

const cases = [
  {
    name: "curl -u user:pass",
    canary: "review-canary",
    command: "curl -u user:review-canary https://example.test",
    output: "Exit code 22\n+ curl -u user:review-canary https://example.test",
  },
  {
    name: "user:pass@host URL",
    canary: "url-canary-pw",
    command: "git clone https://bob:url-canary-pw@example.test/r.git",
    output: "Exit code 128\nremote: auth failed for https://bob:url-canary-pw@example.test",
  },
  {
    name: "Authorization: Bearer header",
    canary: "hdr-canary-qwertzuiopasdf",
    command: "curl -H 'Authorization: Bearer hdr-canary-qwertzuiopasdf' https://example.test",
    output: "Exit code 22\n> Authorization: Bearer hdr-canary-qwertzuiopasdf",
  },
  {
    name: "KEY=value assignment",
    canary: "env-canary-QwertLkzm",
    command: "API_KEY=env-canary-QwertLkzm node run.js",
    output: "Exit code 1\nrefused API_KEY=env-canary-QwertLkzm for this host",
  },
  {
    name: "known token prefix",
    canary: token,
    command: `gh api user --header "x-token: ${token}"`,
    output: `Exit code 1\ngh: bad credentials for ${token}`,
  },
];

for (const c of cases)
  test(`a ${c.name} never reaches the failure table, JSON or cache`, async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-failure-secrets-")));
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    const session = (id: string) =>
      Bun.write(
        join(home, `.claude/projects/p/${id}.jsonl`),
        lines([
          {
            type: "assistant",
            cwd: project,
            message: {
              content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: c.command } }],
            },
          },
          {
            type: "user",
            cwd: project,
            message: {
              content: [
                { type: "tool_result", tool_use_id: "t", content: c.output, is_error: true },
              ],
            },
          },
        ]),
      );
    await session("one");
    await session("two");
    const table = await quench(home, "profile", "failures");
    expect(table.code).toBe(0);
    const json = (await quench(home, "profile", "--json")).stdout;
    const cache = await Bun.file(join(home, ".quench/local/session-places.json")).text();
    expect(JSON.parse(json).recordedFailures.repeated).toHaveLength(1);
    for (const text of [table.stdout, json, cache])
      for (const leak of [c.canary, c.canary.replace(/\d+/g, "N")])
        expect(text).not.toContain(leak);
  });
