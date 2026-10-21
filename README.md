# Quench

See what your coding agents load, what it costs, and where they go wrong.

Quench reads the session history that Claude Code, Codex and Pi already keep on your
machine. It shows how much context each session starts with, how that grows, which models
and effort levels you use, and how each agent run went. Nothing leaves your machine
unless you opt in.

```
$ quench report
Claude Code
  Sessions          522 (+173 subagent)
  Tokens processed  30.5B
  Starting load     median 193.8k  (p10 63.1k, p90 214.9k)  (49% of tokens processed)
  Compactions       378 in 100 sessions
  Effort            medium 65%, high 33%, xhigh 1%
```

## Commands

| Command                               | What it shows                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `quench report [--days 30] [--json]`  | Per harness: starting load, peak context, compactions, tool errors, models and effort |
| `quench runs <session-file> [--json]` | One session as prompt → what the agent did → your reply                               |

## Status

Early and changing. Direction and scope: [#45](https://github.com/JarenKempton/quench/issues/45).
No prebuilt releases yet.

## Run from source

Needs [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun quench report
bun build --compile packages/cli/src/main.ts --outfile quench   # a single binary
```

Checks: `bun test` and `bun run check`.

## Supported harnesses

| Harness                               | Reads from             | Override              |
| ------------------------------------- | ---------------------- | --------------------- |
| Claude Code (CLI, desktop, Agent SDK) | `~/.claude/projects`   | `CLAUDE_CONFIG_DIR`   |
| Codex (CLI, app)                      | `~/.codex/sessions`    | `CODEX_HOME`          |
| Pi                                    | `~/.pi/agent/sessions` | `PI_CODING_AGENT_DIR` |

Adding one is a single file in `packages/history/src/harnesses/`. See
[docs/architecture.md](docs/architecture.md).

## License

MIT
