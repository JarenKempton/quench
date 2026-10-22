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

| Command                                  | What it shows                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `quench report [--days 30] [--json]`     | Per harness: starting load, peak context, compactions, tool errors, models and effort |
| `quench runs <session-file> [--json]`    | One session as prompt → what the agent did → your reply                               |
| `quench corrections [--dry-run]`         | How often you corrected the agent, and what came before. Opt-in, see below            |
| `quench steering <project-dir> [--json]` | Current instruction-file inventory and source rule candidates; offline                |
| `quench sources <session-file> [--json]` | Recorded file reads, returned ranges and explicit source-coverage gaps; offline       |

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

## Recurring correction themes

```sh
quench corrections --themes --dry-run --json
quench corrections --themes --theme-limit 20
```

`--themes` adds grouping to the normal corrections pipeline: reuse cached verdicts, classify
missing replies with Jev, resolve sender attribution, then group person-attributed corrections.
T3 evidence can establish who sent a reply, not whether it is a correction; Jev still determines
reply kind. Automation corrections, unresolved senders and failed or pending classifications
are counted separately in the theme coverage.

Grouping is a separate opt-in Jev choice question using `TYPESAFE_API_KEY`. Each exchange
is compared with earlier representative exchanges for the **same specific corrective intent**,
not just a shared topic. The output quotes a representative correction; it does not generate a
rule or infer which instructions existed. Counts, distinct sessions, preceding-run model labels,
sender-attribution sources and source examples are computed locally. Model-inferred people
remain labeled as such. A group is labeled recurring only across at least two distinct sessions;
single-session groups remain available in JSON. A run's model is its last recorded model, not
necessarily every model used in that run.

The grouping default is the oldest **20 unique exchanges** in the selected period; `--theme-limit`
accepts 1–50. This limits grouping, not the preceding reply classification: each uncached reply
uses two classification requests, just as ordinary `corrections` does. Preview that workload
with `--dry-run` before a paid run; additional grouping work cannot be known until those replies
are classified. Exact duplicate exchanges share a grouping decision but retain their separate
evidence occurrences.
The window uses the correction message's own timestamp, not file modification or preceding-run
end time; corrections with unknown timestamps are excluded and counted separately. Coverage and
omitted counts are always shown. Each model-visible exchange is clipped to the
last 500 assistant characters and first 1,000 correction characters (Unicode code points),
including exemplars. Session paths, IDs, model labels and host records are not sent. At most one
request is made per selected unique exchange, with no retries, a 10-second per-request timeout
and a 60-second total grouping budget. `--examples` limits source examples, not analysis inputs.

Decisions have a separate cache at `~/.quench/local/themes.jsonl`, keyed by grouping version and
exact question, choices and ordered bounded exchanges. Counts are rebuilt from current evidence;
reply classifications retain their existing cache and grouping has its own. Fully cached results
need no key; without a key, missing work is reported with exit code 2. `--dry-run` makes no model
calls and writes neither cache. It reports pending classification requests and groups only known
person corrections, replaying the cached grouping prefix before marking the first missing decision
pending and later inputs blocked. Their exemplar lists are not yet known. Failed assignments stop
the sequence without guessing later memberships; unclear assignments remain ungrouped. A failure
in either stage returns exit code 1, even if other known corrections can still be grouped.

These are exploratory, order-dependent representative matches—not proof that all group members
are equivalent, that a rule was ignored, or that the selected window covers every recurring issue.
Session counts are distinct native IDs, **not independent occurrences**: copied history in forks
can inflate both correction and session evidence. Inherited fork messages are not identified yet;
this limitation is also shown in terminal and JSON output.
Changing the window or earlier representatives can require new grouping decisions. Cached model
outputs are reproducible; the moving `jev-latest` alias is not an accuracy guarantee. No steering
files or histories are edited, no prose drafts are generated, and no live semantic-accuracy claim
is implied by local replay tests.

## Current steering inventory

```sh
quench steering /path/to/project --json
```

Requires an explicit existing directory. The Claude Code, Codex and Pi adapters enumerate
built-in instruction filenames in their user locations and the directory's ancestor chain;
Codex stops at the nearest `.git` directory or worktree marker, or checks only the selected
directory outside a repository. Claude Code also scans ancestor/user `.claude/rules` trees.
Harness directory environment overrides work just as they do for session discovery.
Candidate names follow [Claude Code's memory docs](https://code.claude.com/docs/en/memory),
[Codex's AGENTS.md docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and
Pi's installed `loadProjectContextFiles` implementation. Their effective-loading behavior
is deliberately not reproduced by this inventory.

The report merges byte-identical files by SHA-256 while retaining each harness, encountered
path, canonical path and user/ancestor/project scope. The same bytes have the same identity
across worktree paths; other worktrees are not searched. Rule candidates are original bullets
or paragraphs with line ranges, not semantic judgments. Headings, frontmatter and fenced code
are omitted; scope conditions remain in the source file and are not interpreted.

**This is current-disk evidence, not an effective or historical load report.** Both ordinary
and override candidates remain visible: precedence, settings, imports, custom fallback names,
managed policy, auto memory and runtime overrides are not resolved. Descendant instruction
files are not searched. No result establishes an ignored rule or a preference never written.
Unreadable/oversized sources, cycles and exhausted limits produce warnings. Reads are bounded
to 256 KiB per file, 256 files, 256 physical rule directories and 1,024 directory paths
(including symlink aliases). The command makes no model calls,
reads no session/host history, and writes no files or caches, even when a key is configured.

## Recorded session sources

```sh
quench sources /path/to/discovered/session.jsonl --json
```

Reads one session found in the configured harness history directories. Claude Code's adapter
traces native `Read` calls when the transcript retains structured text-file results. Pi's adapter
traces native `read` requests and successful text-only results.
Any filename can appear, including README files, arbitrary documentation and skill references;
current copies of those source files are never opened. Codex explicitly reports that
source tracing is not yet supported, rather than treating empty output as no loaded sources.

Each attempt retains its call ID, request timestamp/path/offset/limit, result timestamp and
status: returned, failed, missing result or unknown. Returned evidence includes the recorded
path, reported line range and total lines when available, plus a SHA-256 of returned tool text
(including wrappers, not source-file bytes). Pi does not record result paths or reliable line
ranges; those fields stay unknown. Requested paths remain verbatim, without resolving them
against today's filesystem or assuming they identify local files. Text can include tool notices
instead of file content. Normalized events retain the fingerprint instead of the text.
Duplicate or out-of-order call/result IDs and malformed metadata remain uncertain. Parse gaps
and unmatched file results warn; other tool calls remain visible as an unattributed count.

This is partial session evidence. Shell/MCP reads, injected instructions, automatic imports,
skill loading, images and unchanged-file references are not reconstructed. A recorded text
result does not prove the model used or obeyed it, retained it after compaction, or received
the complete file. Reported ranges are metadata, not a completeness guarantee. The command
makes no model calls, reads no host database and writes no files or caches.

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
