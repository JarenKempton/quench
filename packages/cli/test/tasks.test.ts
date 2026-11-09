import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "@quench/history";
import { tasksJson } from "../src/commands/tasks.ts";
import { lines } from "./run.ts";

test("a task on a branch whose GitHub PR merged is Landed, linked to that PR, with the PR state cached apart from the agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-cli-tasks-"));
  const work = join(dir, "work");
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const entry = { sessionId: "s1", cwd: work, gitBranch: "t3/widget", timestamp: at };
  await Bun.write(
    join(dir, ".claude/projects/-work/s1.jsonl"),
    lines([
      { ...entry, type: "user", message: { role: "user", content: "ship the widget" } },
      {
        ...entry,
        type: "assistant",
        message: {
          id: "m1",
          model: "model-x",
          content: [{ type: "text", text: "shipped" }],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ]),
  );
  const asked: string[][] = [];
  const exec = async (command: string[]) => {
    asked.push(command);
    if (command[0] === "git") return "git@github.com:acme/widget.git\n";
    return JSON.stringify([
      {
        number: 7,
        headRefName: "t3/widget",
        headRepositoryOwner: { login: "acme" },
        isCrossRepository: false,
        state: "MERGED",
        createdAt: at,
        closedAt: new Date().toISOString(),
        mergedAt: new Date().toISOString(),
      },
    ]);
  };
  const report = await tasksJson(new Home(dir), { days: 30 }, exec);
  expect(report.tasks).toHaveLength(1);
  expect(report.tasks[0]!.landed).toEqual({
    verdict: "pass",
    reason: "merged",
    evidence: ["github:acme/widget#7"],
  });
  expect(asked.some((c) => c[0] === "gh" && c.includes("acme/widget"))).toBe(true);
  expect(await readdir(join(dir, ".quench"))).toEqual(["local"]);
  expect(await readdir(join(dir, ".quench/local"))).toContain("pulls.json");
  expect(JSON.stringify(report)).not.toContain("ship the widget");
});
