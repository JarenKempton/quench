import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { cliRunsTimeout, lines, quench } from "./run.ts";

test(
  "the summary names dead hooks, the hook script that blocked, and the commands in a chain",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-hook-labels-")));
    try {
      const project = join(home, "work");
      await mkdir(project);
      const guard = join(home, "hooks/guard.sh");
      await Bun.write(guard, "#!/bin/sh\n");
      await Bun.write(
        join(home, ".claude/settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: `${guard} --strict` }] },
            ],
            Stop: [{ hooks: [{ type: "command", command: "bash ~/hooks/gone.sh" }] }],
          },
          statusLine: { type: "command", command: "# ~/bin/status.sh" },
        }),
      );
      const call = (id: string, command: string) => ({
        type: "assistant",
        cwd: project,
        message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
      });
      const result = (id: string, content: string, extra: object = {}) => ({
        type: "user",
        cwd: project,
        ...extra,
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }],
        },
      });
      const block = {
        permissionDecision: { decision: "reject", source: "hook", reasonCode: "hook:PreToolUse" },
      };
      await Bun.write(
        join(home, ".claude/projects/p/one.jsonl"),
        lines([
          ...[1, 2].flatMap((n) => [
            call(`b${n}`, "git push --force && gh pr create --token qsecretq"),
            result(
              `b${n}`,
              `PreToolUse:Bash hook error: [${guard} --strict]: blocked qreasonq`,
              block,
            ),
          ]),
          ...[1, 2, 3].flatMap((n) => [
            call(`f${n}`, "cd app && bun test --bail qsecretq | tail -5 && git status"),
            result(`f${n}`, "Exit code 1\nqerrorq"),
          ]),
        ]),
      );

      const summary = await quench(home);
      expect(summary.code).toBe(0);
      expect(summary.stdout).toContain(
        [
          "  1. 2 hooks or status lines can't run",
          `     Stop ~${sep}hooks${sep}gone.sh missing · statusLine commented out`,
          `     → edit ~${sep}.claude${sep}settings.json`,
          "",
          '  2. PreToolUse hook guard.sh blocked "chained: gh pr, git push" 2×',
        ].join("\n"),
      );
      expect(summary.stdout).toContain('"chained: bun test, git status" failed 3× in work');

      const failures = await quench(home, "profile", "failures");
      expect(failures.stdout).toContain(
        "  PreToolUse hook (guard.sh)  chained: gh pr, git push       2",
      );
      for (const out of [summary.stdout, failures.stdout])
        for (const leak of ["qsecretq", "qreasonq", "qerrorq", "--strict", "--force"])
          expect(out).not.toContain(leak);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  cliRunsTimeout,
);
