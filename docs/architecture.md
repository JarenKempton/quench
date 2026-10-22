# Architecture

Quench is a TypeScript monorepo on Bun. Each package depends only on the packages above it.

```
packages/history    reads each harness's session files into one Session model
packages/insights   pure functions over sessions: runs, reports, signals
packages/judge      opt-in model judgments about runs, behind the Judge interface
packages/cli        the `quench` command; formatting only
```

## The Session model

A `Session` is an ordered list of typed events:

| Event                       | Fields                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `message`                   | `author` (user, assistant, injected), `origin` (typed, scheduled, host, unknown), `text` |
| `inference`                 | `model`, `effort`, `usage` (input, cacheRead, cacheWrite, output)                        |
| `tool_call` / `tool_result` | ids, name, `isError`, size of the result                                                 |
| `compaction`                | trigger, tokens before                                                                   |

Subagent sessions point at their parent with `parent`.

## Harness adapters

An adapter implements `Harness`: `discover(home)` lists session files and `read(ref)`
turns one into a `Session`. It is the only code that knows a harness's paths and file
format. Rules every adapter follows:

- **Validate each line with zod.** Lines that don't fit are counted in
  `diagnostics.unparsed` and shown in the report, so a format change is visible instead
  of silently wrong.
- **Normalize at the edge.** `usage.input` never includes cached tokens, so context size
  means the same thing for every harness. Harness-added text (instruction files,
  environment blocks, command output) is `author: "injected"`.
- **Unknown stays unknown.** If a harness doesn't record something, the field is `null`.
  It never becomes zero.
- **Honor the harness's own override variable** for its data directory.

Adding a harness starts with one entry in `HarnessId`. The type checker then fails until
`harnessById` has an adapter for it, and that adapter must declare its id and label. Add
fixtures under `packages/history/test/fixtures/home`.

Adapters keep zod schemas because files on disk come from older harness versions and only a
runtime check catches format drift. Where a harness publishes types for its files, they are
dev dependencies and `test/vendor-types.test.ts` fails the type check if a schema reads a
field the vendor doesn't publish or with a different type: Pi (`@earendil-works/pi-coding-agent`)
fully, Claude Code's API message and content blocks (`@anthropic-ai/sdk`). The rest of the
Claude Code line and all of Codex are unpublished, so those fields are documented on the schema.

A new event kind breaks every `switch` that ends in `unhandled(event)` until it is handled.

## Insights

- A **run** is everything the agent did between two user messages: model, effort,
  context at start and peak, tool calls and errors, compactions, subagents, duration, and
  the reply that came next.
- A **report** totals runs and sessions per harness.

Insights never branch on harness and never look at tool or server names, because hosts
rename them.

## Judgments

`history` and `insights` never make a network call. Anything that needs a model goes through
`Judge` in `packages/judge`, which returns typed verdicts, never prose. `Jev` is the only judge
today; it uses `@typesafe-ai/sdk` with the user's key. `VerdictCache` stores each verdict keyed by
judge id plus the exact input, so changing a question (and its id) re-asks cleanly.

Who sent a reply comes from structure first: Claude Code marks typed and scheduled prompts.
Everything else, including prompts an SDK host delivers for people and orchestrator agents
alike, is decided by the judge from the message alone.

## Reading at scale

`readSessions` streams one session at a time with a small concurrency limit, and each
adapter parses its file line by line. Memory stays flat no matter how much history there
is. On the reference machine, 3.6 GB across 1,220 files reads in about 8 s with a 0.5 GB
peak.
