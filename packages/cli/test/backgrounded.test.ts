import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunsTimeout, lines, quench } from "./run.ts";

test(
  "commands moved to the background after a timeout, and re-runs before they finished",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-background-")));
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    const bash = (id: string, model: string, command: string) => ({
      type: "assistant",
      cwd: project,
      message: {
        id: `m-${id}`,
        model,
        usage: { input_tokens: 10, output_tokens: 1 },
        content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
      },
    });
    const result = (id: string, content: string) => ({
      type: "user",
      cwd: project,
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
    });
    const timedOut = (id: string) =>
      result(
        id,
        `Command did not complete within its 120s timeout and was moved to the background (ID: ${id}x). Output is being written to: /tmp/claude/tasks/${id}x.output. You will be notified when it completes.`,
      );
    const notice = (id: string) =>
      `<task-notification>\n<task-id>${id}x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Background command "secret summary" completed</summary>\n</task-notification>`;
    await Bun.write(
      join(home, ".claude/projects/p/one.jsonl"),
      lines([
        bash("a", "model-a", "cd work && bun run typecheck 2>&1 | tail -20"),
        timedOut("a"),
        bash("b", "model-a", "cd work && bun run typecheck 2>&1 | tail -20"),
        timedOut("b"),
        bash("l", "model-a", "bun run lint"),
        result("l", "ok"),
        {
          type: "attachment",
          cwd: project,
          attachment: {
            type: "queued_command",
            commandMode: "task-notification",
            prompt: notice("a"),
          },
        },
        { type: "user", cwd: project, message: { content: notice("b") } },
        bash("c", "model-a", "bun run typecheck"),
        result("c", "ok"),
        bash("d", "model-a", "sleep 999"),
        result(
          "d",
          "Command running in background with ID: dx. Output is being written to: /tmp/d",
        ),
      ]),
    );
    await Bun.write(
      join(home, ".claude/projects/p/two.jsonl"),
      lines([
        bash("e", "model-b", "git commit -m 'secret words'"),
        timedOut("e"),
        bash("f", "model-b", "git commit -m 'secret words'"),
        result("f", "done"),
        {
          type: "assistant",
          cwd: project,
          message: {
            content: [{ type: "tool_use", id: "s", name: "TaskStop", input: { task_id: "ex" } }],
          },
        },
        bash("g", "model-b", "git commit -m 'secret words'"),
        result("g", "done"),
      ]),
    );

    const section = await quench(home, "profile", "failures");
    expect(section.code).toBe(0);
    expect(section.stdout).toContain(
      [
        "▍Kept running after a timeout · moved to the background, then re-run · last 30 days",
        "  Command     Backgrounded  Re-run before done  Sessions  Example session",
        "  bun run                2                   1         1  one",
        "  git commit             1                   1         1  two",
        "",
        "  Model    Agent        Backgrounded  Re-run before done  Sessions",
        "  model-a  Claude Code             2                   1         1",
        "  model-b  Claude Code             1                   1         1",
        "  3 commands hit their timeout and kept running in the background.",
      ].join("\n"),
    );
    const summary = await quench(home);
    expect(summary.stdout).toContain(
      [
        "  1. 3 commands kept running after a timeout",
        "     2 re-run before done · bun run 2, git commit 1 · model-a on Claude Code 2, model-b on Claude Code 1",
        "     → quench profile failures",
      ].join("\n"),
    );
    for (const out of [section.stdout, summary.stdout])
      for (const text of ["secret", "typecheck", "/tmp", "sleep", "words"])
        expect(out).not.toContain(text);
  },
  cliRunsTimeout,
);

test(
  "kept running, a bare Claude home and stored credentials share Worth a look",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-background-")));
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    const token = "ghp_" + "FakeQuenchTestValue0123456789abcdefg";
    await Bun.write(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_TOKEN: token } } } }),
    );
    await Bun.write(join(home, ".claude/CLAUDE.md"), "x".repeat(3100));
    await Bun.write(
      join(home, ".claude/projects/p/one.jsonl"),
      lines([
        {
          type: "assistant",
          cwd: project,
          message: {
            id: "m",
            model: "model-a",
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "bun test" } }],
          },
        },
        {
          type: "user",
          cwd: project,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "a",
                content:
                  "Command did not complete within its 120s timeout and was moved to the background (ID: ax). Output is being written to: /tmp/ax.output.",
              },
            ],
          },
        },
      ]),
    );
    for (const id of ["b", "c"])
      await Bun.write(
        join(home, ".claude-proxy/projects/p", `${id}.jsonl`),
        lines([{ type: "user", cwd: project, message: { content: "hi" } }]),
      );

    const { stdout, code } = await quench(home);
    expect(code).toBe(0);
    const worth = stdout.slice(stdout.indexOf("▍Worth a look"));
    for (const item of [
      "1 credential stored in plaintext in MCP config",
      "1 command kept running after a timeout",
      `.claude-proxy ran 2 sessions with no instructions or hooks`,
    ])
      expect(worth).toContain(item);
    expect(stdout).not.toContain(token);
  },
  cliRunsTimeout,
);
