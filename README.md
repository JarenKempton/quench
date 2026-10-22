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
| `quench corrections [--dry-run]`      | How often you corrected the agent, and what came before. Opt-in, see below            |

`quench corrections` asks [Jev](https://typesafe.ai) what each reply to an agent run was doing, using
your own `TYPESAFE_API_KEY`. It sends the reply and the last 1,500 characters of the agent message
before it, and caches each answer in `~/.quench/local/judgments.jsonl` so a reply is paid for once.
`--dry-run` shows how many replies would be sent without sending anything.

Sender attribution uses harness metadata first, optional host evidence second, and Jev's guess
otherwise. The output counts each source separately. `corrections` can read T3 Code's local
`~/.t3/userdata/statev2.sqlite` **read-only** when it exists; T3 is not another harness or a
requirement. Use `--host-history <sqlite-file>` for another location, or `--no-host-history` to
skip it. There is no recursive file search. Missing or incompatible host history leaves the
harness/model fallback intact; incompatible formats produce a warning.

T3 matching requires a strong native session link, unique exact message text in both histories,
and delivery within 60 seconds of host creation. Repeated, edited, delayed or otherwise
unmatched messages fall back to the judge. Imported `user/server` records are not proof of human
authorship. This uses T3's current internal format, not a stable public API. It does not change
cached judgments or send host records to Jev. `report` and `runs` do not read host history.

## Status

Early and changing. Direction and scope: [#45](https://github.com/JarenKempton/quench/issues/45).
No prebuilt releases yet.

## Run from source

Needs [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bunx vp run quench report
bunx vp run compile   # a single binary at dist/quench
```

Checks: `bunx vp check` and `bunx vp run test`. Tasks live in `vite.config.ts`; `vp test` (Vitest on Node) does not apply here because the readers use Bun APIs.

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
