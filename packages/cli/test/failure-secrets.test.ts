import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, quench } from "./run.ts";

const token = ["ghp", "R7tK2mQ9xV4bN8cL1zW6yH3jF5dS0aP2eG7u"].join("_");
const hook = "PreToolUse:Bash hook error: [guard.sh]: guard: blocked";

type Case = {
  name: string;
  command: string;
  output: string;
  leaks: string[];
  blocked?: boolean;
  what?: string;
  error?: string;
};

const cases: Case[] = [
  {
    name: "curl -u user:pass",
    command: "curl -u user:review-canary https://example.test",
    output: "Exit code 22\n+ curl -u user:review-canary https://example.test",
    leaks: ["review-canary"],
    what: "curl -u",
  },
  {
    name: "curl -u with a two-letter pair",
    command: "curl -u qa:qb https://example.test",
    output: "Exit code 22\n+ curl -u qa:qb https://example.test",
    leaks: ["qa:qb"],
    what: "curl -u",
  },
  {
    name: "short URL password",
    command: "git clone https://user:qz@example.test/r.git",
    output: "Exit code 128\nremote: auth failed for https://user:qz@example.test",
    leaks: [":qz@", "user:qz"],
    what: "git clone",
  },
  {
    name: "URL with a token as the whole userinfo",
    command: "git clone https://qtokq@example.test/r.git",
    output: "Exit code 128\nremote: auth failed for https://qtokq@example.test",
    leaks: ["qtokq"],
  },
  {
    name: "Bearer header",
    command: "curl -H 'Authorization: Bearer hdr-canary-qwertzuiopasdf' https://example.test",
    output: "Exit code 22\n> Authorization: Bearer hdr-canary-qwertzuiopasdf",
    leaks: ["hdr-canary-qwertzuiopasdf"],
    what: "curl -H",
  },
  {
    name: "Authorization with no space",
    command: "curl -H Authorization:qvzx https://example.test",
    output: "Exit code 22\n> Authorization:qvzx rejected",
    leaks: ["qvzx"],
  },
  {
    name: "KEY=value assignment",
    command: "API_KEY=env-canary-QwertLkzm node run.js",
    output: "Exit code 1\nrefused API_KEY=env-canary-QwertLkzm for this host",
    leaks: ["env-canary-QwertLkzm"],
    what: "node",
  },
  {
    name: "known token prefix",
    command: `gh api user --header "x-token: ${token}"`,
    output: `Exit code 1\ngh: bad credentials for ${token}`,
    leaks: [token],
  },
  {
    name: "--token=value starting with a dash",
    command: "deploy --token=-cnryx",
    output: "Exit code 1\nrejected --token=-cnryx",
    leaks: ["cnryx"],
    what: "deploy --token",
  },
  {
    name: "--token value starting with a dash",
    command: "deploy --token -cnryy",
    output: "Exit code 1\nrejected --token -cnryy",
    leaks: ["cnryy"],
    what: "deploy --token",
  },
  {
    name: "short --password with unrelated text after it",
    command: "deploy --password=pass bypass",
    output: "Exit code 1\nrejected --password=pass bypass",
    leaks: ["=pass"],
    error: "rejected --password=‹secret› bypass",
  },
  {
    name: "mixed credentials on one line",
    command: "curl -u qmqa:qmqb -H 'Authorization: Bearer qmqc' https://qmqd:qmqe@example.test",
    output:
      "Exit code 22\ncurl -u qmqa:qmqb Authorization:qmqc https://qmqd:qmqe@example.test TOKEN=qmqf --api-key -qmqg",
    leaks: ["qmqa", "qmqb", "qmqc", "qmqe", "qmqf", "qmqg"],
    what: "curl -u -H",
  },
  {
    name: "overlapping slots and detectors",
    command: `deploy --password=https://u:qoqa@example.test --header "Authorization: Bearer ${token}"`,
    output: `Exit code 1\n--password=https://u:qoqa@example.test Authorization: Bearer ${token}`,
    leaks: ["qoqa", token],
    what: "deploy --password --header",
  },
  {
    name: "hook refusal naming a user:pass@host URL",
    command: "git push https://user:review-canary@example.test/r.git",
    output: `${hook} https://user:review-canary@example.test`,
    leaks: ["review-canary"],
    blocked: true,
  },
  {
    name: "hook refusal quoting a token",
    command: "gh api user",
    output: `${hook} — refusing ${token}`,
    leaks: [token],
    blocked: true,
  },
  {
    name: "hook refusal with mixed short credentials",
    command: "curl https://example.test",
    output: `${hook} — curl -u qhqa:qhqb Authorization:qhqc --token -qhqd https://u:qhqe@x.test`,
    leaks: ["qhqa", "qhqb", "qhqc", "qhqd", "qhqe"],
    blocked: true,
  },
];

for (const c of cases)
  test(`a ${c.name} never reaches profile, steering, JSON or cache`, async () => {
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
            ...(c.blocked ? { permissionDecision: { decision: "reject", source: "hook" } } : {}),
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
    const failures = JSON.parse(json).recordedFailures;
    const rows = c.blocked ? failures.blocked : failures.repeated;
    expect(rows).toHaveLength(1);
    if (c.what) expect(rows[0].what).toBe(c.what);
    if (c.error) expect(rows[0].error).toBe(c.error);
    const steering = await quench(home, "steering", project);
    const steeringJson = (await quench(home, "steering", project, "--json")).stdout;
    if (c.blocked) expect(steering.stdout).toContain("‹secret›");
    const cache = await Bun.file(join(home, ".quench/local/session-places.json")).text();
    for (const text of [table.stdout, json, steering.stdout, steeringJson, cache])
      for (const leak of c.leaks.flatMap((l) => [l, l.replace(/\d+/g, "N")]))
        expect(text).not.toContain(leak);
  });
