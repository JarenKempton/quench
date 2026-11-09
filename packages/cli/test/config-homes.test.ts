import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { quoteArg, shellFor } from "@quench/history";
import { cliRunsTimeout, lines, quench } from "./run.ts";

const session = (home: string, cwd: string, id: string) =>
  Bun.write(
    join(home, "projects/p", `${id}.jsonl`),
    lines([{ type: "user", timestamp: "2026-10-20T10:00:00Z", cwd, message: { content: "hi" } }]),
  );

const hook = { type: "command", command: "guard.sh" };

test(
  "the summary flags a Claude home that ran sessions with no instructions or hooks",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-config-homes-")));
    try {
      const work = join(home, "work");
      await mkdir(work);
      const configured = join(home, ".claude");
      const bare = join(home, ".claude-proxy");
      const target = join(home, "dotfiles/claude-proxy");
      const stale = join(home, ".claude-old");
      await Bun.write(join(configured, "CLAUDE.md"), "x".repeat(3100));
      await Bun.write(
        join(configured, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [hook] }],
            Stop: [{ hooks: [hook] }],
          },
        }),
      );
      await session(configured, work, "a");
      await session(target, work, "b");
      await session(target, work, "c");
      await Bun.write(join(target, "projects/p/c/subagents/agent-1.jsonl"), "");
      await symlink(target, bare);
      await symlink(configured, join(home, ".claude-alias"));
      await session(stale, work, "d");
      const old = new Date(Date.now() - 60 * 86_400_000);
      await utimes(join(stale, "projects/p/d.jsonl"), old, old);

      const summary = await quench(home, "--claude-home", `${configured}/`);
      expect(summary.code).toBe(0);
      expect(summary.stdout).toContain(
        [
          `  1. ~${sep}.claude-proxy ran 2 sessions with no instructions or hooks`,
          `     ~${sep}.claude has 3.1 KB of instructions and 2 hooks`,
          `     → quench --claude-home ${quoteArg(bare, shellFor())}`,
        ].join("\n"),
      );
      expect(summary.stdout).not.toContain(".claude-old");
      expect(summary.stdout).not.toContain("guard.sh");
      expect(summary.stdout).not.toContain("xxx");

      const json = JSON.parse((await quench(home, "--json")).stdout);
      expect(json.claudeConfigHomes).toEqual([
        { path: configured, sessions: 1, instructionBytes: 3100, settings: true, hooks: 2 },
        { path: stale, sessions: 0, instructionBytes: 0, settings: false, hooks: 0 },
        { path: bare, sessions: 2, instructionBytes: 0, settings: false, hooks: 0 },
      ]);

      const active = await quench(home, "--claude-home", bare);
      expect(active.stdout).toContain(`~${sep}.claude has 3.1 KB of instructions and 2 hooks`);

      await rm(bare, { recursive: true });
      expect((await quench(home)).stdout).not.toContain("no instructions or hooks");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  cliRunsTimeout,
);
