import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { cliRunsTimeout, lines, quench } from "./run.ts";

test(
  "the summary splits MCP servers into failing, needs login and unused, and flags outdated pinned models",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-mcp-models-")));
    try {
      const work = join(home, "work");
      await mkdir(work);
      const http = (name: string) => ({ type: "http", url: `https://${name}.example.com/mcp` });
      await Bun.write(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: Object.fromEntries(
            ["busy", "down", "locked", "quiet"].map((n) => [n, http(n)]),
          ),
        }),
      );
      await Bun.write(
        join(home, ".claude/settings.json"),
        JSON.stringify({ model: "claude-opus-4-8" }),
      );
      await Bun.write(join(home, ".claude/CLAUDE.md"), "Review with claude-sonnet-5-5.\n");
      const usage = { input_tokens: 10, output_tokens: 5 };
      const at = { cwd: work, timestamp: "2026-10-20T10:00:00Z" };
      for (const id of ["one", "two"])
        await Bun.write(
          join(home, `.claude/projects/p/${id}.jsonl`),
          lines([
            { type: "user", ...at, message: { content: "hi" } },
            {
              type: "attachment",
              ...at,
              attachment: {
                type: "deferred_tools_delta",
                addedNames: ["mcp__busy__ping"],
                addedLines: ["mcp__busy__ping"],
                failedMcpServers: [
                  { name: "down", errorCode: "CONNECTION_CLOSED", error: "qerrorq at 10.0.0.1" },
                ],
                needsAuthMcpServers: ["locked"],
              },
            },
            {
              type: "assistant",
              ...at,
              error: "model_not_found",
              isApiErrorMessage: true,
              message: {
                model: "<synthetic>",
                content: [
                  {
                    type: "text",
                    text: "There's an issue with the selected model (claude-opus-4-8). qsecretq",
                  },
                ],
              },
            },
            {
              type: "assistant",
              ...at,
              message: {
                model: "claude-opus-5-5",
                usage,
                content: [{ type: "tool_use", id: `c-${id}`, name: "mcp__busy__ping", input: {} }],
              },
            },
          ]),
        );

      const summary = await quench(home);
      expect(summary.code).toBe(0);
      expect(summary.stdout).toContain(
        [
          "  1. 1 pinned model name looks outdated",
          `     claude-opus-4-8 in ~${sep}.claude${sep}settings.json, failed as unknown model in 2 sessions`,
          "     → quench profile instructions",
          "",
          "  2. 1 MCP server failed to connect",
          "     down on Claude Code 2 sessions (CONNECTION_CLOSED)",
          "     → quench profile mcp",
          "",
          "  3. 1 MCP server waiting for login",
          "     locked on Claude Code 2 sessions",
          "     → quench profile mcp",
          "",
          "  4. 1 MCP server on but never called",
          "     quiet on Claude Code",
          "     → quench profile mcp",
        ].join("\n"),
      );
      expect(summary.stdout).not.toContain("busy on");
      expect(summary.stdout).not.toContain("claude-sonnet-5-5 in");

      const mcp = await quench(home, "profile", "mcp");
      expect(mcp.stdout).toContain(
        [
          "  Server  Agent        State        Sessions  Error code",
          "  down    Claude Code  failing             2  CONNECTION_CLOSED",
          "  locked  Claude Code  needs login         2",
          "  quiet   Claude Code  unused              —",
        ].join("\n"),
      );
      const instructions = await quench(home, "profile", "instructions");
      expect(instructions.stdout).toContain(
        `  claude-opus-4-8  failed as unknown model in 2 sessions  ~${sep}.claude${sep}settings.json`,
      );
      for (const out of [summary.stdout, mcp.stdout, instructions.stdout])
        for (const leak of ["qerrorq", "qsecretq", "10.0.0.1"]) expect(out).not.toContain(leak);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  cliRunsTimeout,
);

test(
  "a pinned model is outdated when sessions used a newer one of the same family",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-pinned-")));
    try {
      const work = join(home, "work");
      await mkdir(work);
      await Bun.write(join(home, ".claude/CLAUDE.md"), "Delegate reviews to claude-sonnet-4-5.\n");
      await Bun.write(
        join(home, ".claude/projects/p/one.jsonl"),
        lines([
          { type: "user", cwd: work, message: { content: "hi" } },
          {
            type: "assistant",
            cwd: work,
            message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
      );
      expect((await quench(home)).stdout).toContain(
        `     claude-sonnet-4-5 in ~${sep}.claude${sep}CLAUDE.md, sessions used claude-sonnet-5-5`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  cliRunsTimeout,
);
