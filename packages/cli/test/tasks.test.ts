import { expect, test } from "bun:test";
import { mkdtemp, readdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home } from "@quench/history";
import { tasksLoader } from "../src/commands/tasks.ts";
import { lines } from "./run.ts";

test("GitHub PR state arrives after the first answer, then the task on its branch is Landed with that PR, and unchanged sessions come from the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-cli-tasks-"));
  const work = join(dir, "work");
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const entry = { sessionId: "s1", cwd: work, gitBranch: "t3/widget", timestamp: at };
  const transcript = join(dir, ".claude/projects/-work/s1.jsonl");
  await Bun.write(
    transcript,
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
  const github = Promise.withResolvers<void>();
  const exec = async (command: string[]) => {
    asked.push(command);
    if (command[0] === "git") return "git@github.com:acme/widget.git\n";
    await github.promise;
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
  const stamp = new Date(Math.floor(Date.now() / 1000 - 600) * 1000);
  await utimes(transcript, stamp, stamp);
  const changed = Promise.withResolvers<void>();
  const load = tasksLoader(new Home(dir), { days: 30 }, changed.resolve, exec);
  const first = await load();
  expect(first.tasks.map((t) => t.landed.reason)).toEqual(["not-seen"]);
  github.resolve();
  await changed.promise;
  expect(asked.some((c) => c[0] === "gh" && c.includes("acme/widget"))).toBe(true);
  await Bun.write(transcript, "x".repeat((await stat(transcript)).size));
  await utimes(transcript, stamp, stamp);
  const report = await load();
  expect(report.tasks).toHaveLength(1);
  expect(report.tasks[0]!.landed).toEqual({
    verdict: "pass",
    reason: "merged",
    evidence: ["github:acme/widget#7"],
  });
  expect(await readdir(join(dir, ".quench"))).toEqual(["local"]);
  expect((await readdir(join(dir, ".quench/local"))).sort()).toEqual([
    "pulls.json",
    "task-segments.json",
  ]);
  expect(JSON.stringify(report)).not.toContain("ship the widget");
});
