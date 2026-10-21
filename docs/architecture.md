# Architecture

Quench is a TypeScript monorepo on Bun. Each package depends only on the packages above it.

```
packages/history    reads each harness's session files into one Session model
packages/insights   pure functions over sessions: runs, reports
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

Adding a harness: one file in `packages/history/src/harnesses/`, one line in
`harnesses/index.ts`, one entry in `HarnessId`, and fixtures under
`packages/history/test/fixtures/home`.

## Insights

- A **run** is everything the agent did between two user messages: model, effort,
  context at start and peak, tool calls and errors, compactions, subagents, duration, and
  the reply that came next.
- A **report** totals runs and sessions per harness.

Insights never branch on harness and never look at tool or server names, because hosts
rename them.

## Reading at scale

`readSessions` streams one session at a time with a small concurrency limit, and each
adapter parses its file line by line. Memory stays flat no matter how much history there
is. On the reference machine, 3.6 GB across 1,220 files reads in about 8 s with a 0.5 GB
peak.
