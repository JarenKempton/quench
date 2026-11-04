import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessJudge } from "../src/index.ts";

const canaries = [
  "CANARY_USER_MD",
  "CANARY_IMPORT",
  "CANARY_RULES",
  "CANARY_PARENT_MD",
  "CANARY_PROJECT_MD",
];

test.skipIf(!Bun.which("claude"))(
  "installed claude sends no instructions or model override from the parent environment",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "quench-canary-"));
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(join(home, ".claude/rules"), { recursive: true });
    await mkdir(project, { recursive: true });
    await Bun.write(join(home, ".claude/CLAUDE.md"), "CANARY_USER_MD\n@~/imported.md\n");
    await Bun.write(join(home, "imported.md"), "CANARY_IMPORT\n");
    await Bun.write(join(home, ".claude/rules/r.md"), "CANARY_RULES\n");
    await Bun.write(join(project, "CLAUDE.md"), "CANARY_PROJECT_MD\n");
    const parent = join(tmpdir(), "CLAUDE.md");
    await Bun.write(parent, "CANARY_PARENT_MD\n");
    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        bodies.push(await request.text());
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "canary" } },
          { status: 400 },
        );
      },
    });
    try {
      const judge = await HarnessJudge.create(
        {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          ANTHROPIC_API_KEY: "sk-ant-canary",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
          CLAUDE_RELAUNCH_SESSION_ADD_DIRS: JSON.stringify([project]),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "canary-model",
          ANTHROPIC_MODEL: "canary-model",
          ANTHROPIC_SMALL_FAST_MODEL: "canary-model",
        },
        60_000,
      );
      await judge.classify([{ assistantSaid: "done", reply: "CANARY_REPLY" }]);
    } finally {
      await server.stop(true);
      await rm(parent, { force: true });
    }
    const messages = bodies.filter((b) => b.includes("CANARY_REPLY"));
    expect(messages.length).toBeGreaterThan(0);
    for (const body of messages) {
      for (const canary of canaries) expect(body).not.toContain(canary);
      expect(JSON.parse(body).model).toBe(HarnessJudge.model);
    }
  },
  90_000,
);
